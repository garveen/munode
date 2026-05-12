//! Standalone helper functions shared across the connection submodules.
use std::sync::Arc;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use crate::hub_client::HubClient;
use crate::state::EdgeState;

/// Maximum time allowed for the writer task to drain and flush its queue
/// after the read loop exits.
const WRITER_DRAIN_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(5);

/// Wait for the writer task to finish, aborting it if it takes too long.
pub(super) async fn drain_writer(mut writer_handle: tokio::task::JoinHandle<()>) {
    tokio::select! {
        _ = &mut writer_handle => {
            // Writer exited cleanly within the drain window.
        }
        _ = tokio::time::sleep(WRITER_DRAIN_TIMEOUT) => {
            // Timed out — abort the task and wait for the cancellation to land.
            // Awaiting after abort() guarantees the task's Drop glue has run
            // (TLS WriteHalf dropped → FD released) before we return.
            writer_handle.abort();
            let _ = writer_handle.await;
        }
    }
}

/// Broadcast a text message to local clients.
pub(super) async fn broadcast_text_message(
    edge_state: &Arc<EdgeState>,
    sender_session: u32,
    text_msg: &mumbleproto::TextMessage,
) {
    // Route based on target: channel, tree, or specific sessions
    let mut msg = text_msg.clone();
    msg.actor = Some(sender_session);

    if !text_msg.channel_id.is_empty() {
        // Send to users in specified channels
        for &channel_id in &text_msg.channel_id {
            edge_state.client_manager.broadcast_to_channel(
                channel_id,
                MessageType::TextMessage,
                &msg,
                Some(sender_session),
            ).await;
        }
    } else if !text_msg.session.is_empty() {
        // Send to specific sessions
        for &target_session in &text_msg.session {
            edge_state.client_manager.send_to(target_session, MessageType::TextMessage, &msg).await;
        }
    } else if !text_msg.tree_id.is_empty() {
        // Collect all channels in the tree (including sub-channels recursively)
        let mut all_channel_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();
        let mut to_visit: std::collections::VecDeque<u32> = text_msg.tree_id.iter().copied().collect();
        while let Some(ch_id) = to_visit.pop_front() {
            if all_channel_ids.insert(ch_id) {
                let children = edge_state.channel_manager.get_children(ch_id).await;
                for child in children {
                    to_visit.push_back(child);
                }
            }
        }
        for ch_id in all_channel_ids {
            edge_state.client_manager.broadcast_to_channel(
                ch_id,
                MessageType::TextMessage,
                &msg,
                Some(sender_session),
            ).await;
        }
    }
}

/// Broadcast CodecVersion (Opus-only) to all clients.
/// This server only supports Opus; CELT is not supported.
pub(crate) async fn broadcast_codec_version(edge_state: &Arc<EdgeState>) {
    let msg = mumbleproto::CodecVersion {
        alpha: 0,
        beta: 0,
        prefer_alpha: false,
        opus: Some(true),
    };
    edge_state.client_manager.broadcast(MessageType::CodecVersion, &msg, None).await;
}

/// Strip HTML tags from a string (simple tag removal for Mumble text messages).
pub(super) fn strip_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

/// Decode a hex string into bytes.  Returns `None` if the string is not valid hex.
pub(crate) fn hex_to_bytes(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect();
    bytes
}

/// Convert a `HashMap<u32, VoiceTargetConfig>` to a `HotVoiceTargetMap` for storage in
/// `HotSlot::voice_targets`.  Called after every VoiceTarget cache write so the routing
/// hot path can read voice-target configs without holding `EdgeState::voice_targets`.
pub(super) fn build_hot_vt_map(
    session_vts: &std::collections::HashMap<u32, crate::state::VoiceTargetConfig>,
) -> crate::hot_slot::HotVoiceTargetMap {
    session_vts
        .iter()
        .map(|(&tid, vt)| {
            (tid, std::sync::Arc::new(crate::hot_slot::HotVoiceTarget {
                sessions: vt.sessions.clone(),
                resolved_channels: vt.resolved_channels.clone(),
            }))
        })
        .collect()
}

/// Query Hub for a permission bitmask with a local DashMap cache.
///
/// Returns the cached value if present; otherwise calls `handle_permission_query`
/// and stores the result.  On Hub error the result is **not cached** so the next
/// call retries; the caller receives `fail_open` (all bits set for open, 0 for closed).
pub(crate) async fn get_perm_cached(
    hub_client: &HubClient,
    edge_state: &EdgeState,
    session: u32,
    channel: u32,
    fail_open: bool,
) -> u32 {
    if let Some(v) = edge_state.permission_cache.get(&(session, channel)) {
        return *v;
    }
    match hub_client.handle_permission_query(session, channel).await {
        Ok(r) => {
            let bitmask = r.permissions.unwrap_or(if fail_open { u32::MAX } else { 0 });
            edge_state.permission_cache.insert((session, channel), bitmask);
            bitmask
        }
        Err(_) => {
            if fail_open { u32::MAX } else { 0 }
        }
    }
}

/// Warm the permission cache for whisper routing on the supplied channels.
/// This keeps the voice packet path off the Hub RPC round-trip after topology changes.
pub(crate) async fn prefetch_whisper_permissions(
    hub_client: &HubClient,
    edge_state: &EdgeState,
    session: u32,
    channels: &[u32],
) {
    let mut seen = std::collections::HashSet::new();
    for &channel in channels {
        if !seen.insert(channel) {
            continue;
        }
        if edge_state.permission_cache.get(&(session, channel)).is_some() {
            continue;
        }
        let _ = get_perm_cached(hub_client, edge_state, session, channel, false).await;
    }
}

/// Encode an IP address string into bytes (4 bytes for IPv4, 16 bytes for IPv6).
pub(super) fn encode_ip_address(addr: &str) -> Vec<u8> {
    if let Ok(ip) = addr.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => v4.octets().to_vec(),
            std::net::IpAddr::V6(v6) => v6.octets().to_vec(),
        }
    } else {
        // Fallback: encode as UTF-8 bytes
        addr.as_bytes().to_vec()
    }
}
