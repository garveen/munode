use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bytes::Bytes;
use flate2::read::ZlibDecoder;
use futures_util::StreamExt;
use prost::Message;
use tokio::sync::{Mutex, RwLock, mpsc, oneshot};
use tokio::time;
use tokio_tungstenite::tungstenite;
use tracing::{debug, error, info, warn};

use munode_common::config::{EdgeConfig, HubServerConfig};
use munode_protocol::hubedge::{
    self, EdgeFullSyncParams, EdgeHubPacket, EdgeJoinCompleteParams, EdgeJoinParams,
    EdgeRegisterParams, EdgeReportSessionParams, GlobalSessionProto, PacketType,
    TypedRpcNotification, TypedRpcRequest, TypedRpcResponse,
};

use crate::peer_registry::PeerEdgeInfo;
use crate::state::{EdgeEvent, EdgeState};
use crate::voice_target::{apply_voice_target_proto_batch, voice_target_config_to_proto};

mod notification;
mod rpc;

/// Exponential backoff helper for reconnection loops.
///
/// Starts at `base_ms` milliseconds and doubles on each failed attempt, up to
/// a maximum of 30 seconds.  A successful connection resets the counter to zero.
/// Minimum allowed base delay in milliseconds.  Prevents accidentally-zero intervals
/// (e.g. when `reconnect_interval = 0` is set in config) from causing a tight reconnect loop.
const MIN_BACKOFF_MS: u64 = 100;

/// Duration without a successful Hub connection before all local Mumble clients are
/// disconnected and new connections are refused.
const UNREACHABLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

struct ExponentialBackoff {
    base_ms: u64,
    current_ms: u64,
    attempt: u32,
}

impl ExponentialBackoff {
    const MAX_DELAY_MS: u64 = 30_000;

    fn new(base_ms: u64) -> Self {
        let base_ms = base_ms.max(MIN_BACKOFF_MS); // enforce minimum
        Self {
            base_ms,
            current_ms: base_ms,
            attempt: 0,
        }
    }

    /// Return the delay for the next reconnect attempt and advance the counter.
    fn next_delay(&mut self) -> Duration {
        let delay = self.current_ms;
        self.attempt += 1;
        // Double the delay on every failure, capped at MAX_DELAY_MS.
        self.current_ms = (self.current_ms.saturating_mul(2)).min(Self::MAX_DELAY_MS);
        Duration::from_millis(delay)
    }

    /// Reset the backoff after a successful connection.
    fn reset(&mut self) {
        self.attempt = 0;
        self.current_ms = self.base_ms;
    }
}

/// Notification with its optional Hub-assigned sequence number.
struct SequencedNotification {
    seq: Option<u64>,
    notification: TypedRpcNotification,
}

#[derive(Debug)]
pub(crate) struct RuntimeFullSyncOutcome {
    pub disappeared_session_ids: Vec<u32>,
    pub hub_seq: u64,
}

enum NotificationProcessorInput {
    HubNotification(SequencedNotification),
    RuntimeFullSync(RuntimeFullSyncRequest),
}

struct RuntimeFullSyncRequest {
    reason: String,
    trigger_seq: Option<u64>,
    emit_hub_registered: bool,
    completion: Option<oneshot::Sender<Result<RuntimeFullSyncOutcome>>>,
}

/// Maximum time to wait for a missing (skipped) sequenced notification before
/// declaring the connection stale and triggering a reconnect + fullsync.
const NOTIFICATION_GAP_TIMEOUT: Duration = Duration::from_secs(10);

/// Grace period after a Hub cold-restart before sending `UserRemove` for
/// sessions that disappeared from the empty fullsync snapshot.
///
/// During this window, peer Edges reconnect and re-report their sessions via
/// `hub.userJoined`.  Sessions that are still absent after the window closes
/// are considered truly gone and `HubReconcileDisappeared` is emitted.
const HUB_RESTART_GRACE_SECS: u64 = 10;
const HUB_RESTART_GRACE_DURATION: Duration = Duration::from_secs(HUB_RESTART_GRACE_SECS);

/// Maximum size of the [`HubClient::pending_notifications`] FIFO queue.
///
/// When Hub is unreachable the Edge buffers recoverable control notifications
/// (`UserLeft`, `ChannelLinksChanged`, `ChannelRemoved`) so the reconnect
/// handshake can replay them.  A bounded cap prevents OOM on long Hub outages
/// — every kind queued here is _also_ recovered by the reconnect handshake
/// itself, so dropping the oldest entries only produces a transient visibility
/// gap on other edges.
const MAX_PENDING_NOTIFICATIONS: usize = 4096;

/// Tracks notification sequence state and reorders out-of-order messages.
///
/// When a gap is detected (i.e. the Edge receives seq N+2 before N+1), the
/// out-of-order notification is buffered.  If the gap is not resolved within
/// [`NOTIFICATION_GAP_TIMEOUT`], the connection is torn down and a full
/// resync is triggered.
struct NotificationSequencer {
    expected_seq: u64,
    reorder_buffer: BTreeMap<u64, TypedRpcNotification>,
    /// Instant when the first unresolved gap was detected.
    gap_since: Option<Instant>,
}

enum SequenceAction {
    /// Process this notification immediately; it arrived in order.
    ProcessNow(SequencedNotification),
    /// Notification was buffered because it arrived out of order.
    Buffered,
    /// Duplicate notification (seq already processed); discard silently.
    Duplicate,
    /// Notification has no sequence number; process immediately (unsequenced).
    Unsequenced(TypedRpcNotification),
}

impl NotificationSequencer {
    fn new(expected_seq: u64) -> Self {
        Self {
            expected_seq,
            reorder_buffer: BTreeMap::new(),
            gap_since: None,
        }
    }

    /// Feed a notification into the sequencer and get the action to take.
    fn feed(&mut self, sn: SequencedNotification) -> SequenceAction {
        let seq = match sn.seq {
            None => return SequenceAction::Unsequenced(sn.notification),
            Some(s) => s,
        };

        if seq < self.expected_seq {
            debug!(
                seq,
                expected = self.expected_seq,
                "Duplicate notification seq — discarding"
            );
            return SequenceAction::Duplicate;
        }

        if seq == self.expected_seq {
            self.expected_seq += 1;
            self.refresh_gap_state();
            return SequenceAction::ProcessNow(SequencedNotification {
                seq: Some(seq),
                notification: sn.notification,
            });
        }

        // seq > expected_seq → gap detected.
        warn!(
            seq,
            expected = self.expected_seq,
            "Notification gap detected — buffering"
        );
        self.reorder_buffer.insert(seq, sn.notification);
        if self.gap_since.is_none() {
            self.gap_since = Some(Instant::now());
        }
        SequenceAction::Buffered
    }

    /// Drain any buffered notifications that became contiguous after the last processed one.
    fn drain_ready(&mut self) -> Vec<SequencedNotification> {
        let mut batch = Vec::new();
        while let Some(notification) = self.reorder_buffer.remove(&self.expected_seq) {
            let seq = self.expected_seq;
            self.expected_seq += 1;
            batch.push(SequencedNotification {
                seq: Some(seq),
                notification,
            });
        }
        self.refresh_gap_state();
        batch
    }

    /// Re-anchor the live sequencer to a fresh full-sync fence.
    fn reset_after_full_sync(&mut self, fence_seq: u64) {
        self.expected_seq = fence_seq + 1;
        self.reorder_buffer
            .retain(|&seq, _| seq >= self.expected_seq);
        self.refresh_gap_state();
    }

    fn refresh_gap_state(&mut self) {
        match self.reorder_buffer.first_key_value().map(|(&seq, _)| seq) {
            None => {
                self.gap_since = None;
            }
            Some(next_seq) if next_seq == self.expected_seq => {
                self.gap_since = None;
            }
            Some(_) => {
                if self.gap_since.is_none() {
                    self.gap_since = Some(Instant::now());
                }
            }
        }
    }

    /// Returns true if there is an unresolved gap that has exceeded the timeout.
    fn is_gap_expired(&self) -> bool {
        self.gap_since
            .map(|t| t.elapsed() >= NOTIFICATION_GAP_TIMEOUT)
            .unwrap_or(false)
    }

    /// Returns the remaining time before the gap timeout fires, or None if no gap.
    fn gap_remaining(&self) -> Option<Duration> {
        self.gap_since
            .map(|t| NOTIFICATION_GAP_TIMEOUT.saturating_sub(t.elapsed()))
    }
}

/// Connection state for the Hub client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HubConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Registered,
}

/// Pending RPC request waiting for response.
struct PendingRequest {
    tx: oneshot::Sender<Result<TypedRpcResponse, String>>,
    /// Which pool slot this RPC was sent through.  Used to cancel in-flight
    /// requests when a specific slot disconnects, so the caller sees an
    /// immediate error instead of hanging for the 30-second timeout.
    slot: usize,
}

/// A control notification that failed to reach Hub and must be replayed after
/// the next successful reconnect.
///
/// Only notifications representing **persistent cluster state mutations** that
/// are NOT already recovered by the reconnect sequence belong here.  Specifically:
///
/// | Notification              | Why queued?                                                   |
/// |---------------------------|---------------------------------------------------------------|
/// | `UserLeft`                | Disconnected users are absent from `do_report_local_users`   |
/// | `ChannelLinksChanged`     | `do_full_sync` pulls channels FROM Hub — push is not replayed |
/// | `ChannelRemoved`          | Hub would re-sync the deleted channel back on next FullSync   |
///
/// The following are deliberately **excluded** because they are already covered
/// by the reconnect sequence or are unsafe/meaningless to replay:
///
/// * `notify_user_moved` / `notify_user_state_changed` — fully re-reported by
///   `do_report_local_users` (includes `channel_id`, mute, deaf, etc.)
/// * `notify_user_remove` — ban replay is unsafe because session IDs may be
///   reused; use the Hub web API to persist bans independently
/// * `notify_text_message` / `notify_context_action` / `notify_plugin_data` —
///   ephemeral; stale delivery after reconnect would be confusing
#[derive(Debug)]
pub(super) enum PendingControlNotification {
    /// A local user disconnected while Hub was unreachable.
    UserLeft {
        session_id: u32,
        reason: Option<String>,
    },
    /// A client modified channel links (add or remove) while Hub was unreachable.
    ChannelLinksChanged {
        channel_id: u32,
        links_add: Vec<u32>,
        links_remove: Vec<u32>,
    },
    /// A client deleted a channel while Hub was unreachable.
    ChannelRemoved { channel_id: u32 },
}

/// Client for communicating with the Hub server via WebSocket + protobuf.
///
/// When `pool_size > 1`, multiple parallel WebSocket connections are maintained.
/// All connections are peer-equal: each one registers with the Hub, and any one
/// can carry RPC requests (distributed round-robin) or receive notifications.
/// The sync sequence (fullSync, cluster join, etc.) runs exactly once, protected
/// by an atomic flag.
pub struct HubClient {
    config: HubServerConfig,
    server_id: u32,
    server_name: String,
    /// External host advertised to Hub and broadcast to peer Edges.
    external_host: String,
    /// Effective external port for Mumble client connections (NAT-mapped).
    external_port: u16,
    /// Effective port for Edge-to-Edge TLS connections.
    edge_port: u16,
    /// Geographic region identifier.
    region: Option<String>,
    /// Maximum number of users for this Edge.
    capacity: u32,
    /// Statically configured peers for bootstrap relay (from config).
    /// These are tried first before dynamically-discovered peers.
    static_relay_peers: Vec<(String, u16)>,
    state: RwLock<HubConnectionState>,
    edge_state: Arc<EdgeState>,
    /// Pending RPC requests awaiting responses (shared across all pool slots).
    pending: Mutex<HashMap<String, PendingRequest>>,
    /// Number of pool connections to maintain (1 = no pool, >1 = pool mode).
    pool_size: usize,
    /// Per-slot send channels.
    pool_senders: Vec<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    /// Round-robin index for distributing sends across pool slots.
    pool_rr: AtomicUsize,
    /// Counter for generating unique request IDs.
    request_counter: AtomicU64,
    /// Time when this HubClient was created (for uptime reporting).
    start_time: Instant,
    /// Sender for the serial notification processor task.
    /// Any slot receiving a Hub notification, plus any local runtime resync
    /// request, feeds it into this channel.
    notification_tx: Mutex<Option<mpsc::UnboundedSender<NotificationProcessorInput>>>,
    /// Expected next notification sequence number, set after fullsync.
    notification_expected_seq: AtomicU64,
    /// Serializes runtime full-sync requests so periodic reconciliation,
    /// lag recovery, and any future manual triggers do not overlap.
    full_sync_lock: Mutex<()>,
    /// Guards the post-register sync sequence (fullSync, joinCluster,
    /// reportLocalUsers, etc.) so it runs exactly once across all pool slots.
    /// CAS from false→true to claim the sync.
    sync_done: AtomicBool,
    /// Notified once after the sync sequence completes.  All slots wait on
    /// this before forwarding notifications to the processor, ensuring the
    /// caches are populated first.
    sync_notify: tokio::sync::Notify,
    /// Control notifications that failed to reach Hub while the connection was
    /// down.  Replayed in order after the next successful `do_register()`.
    /// See [`PendingControlNotification`] for the rationale of which notifications
    /// are included.
    pending_notifications: tokio::sync::Mutex<Vec<PendingControlNotification>>,
    /// Monotonically increasing sequence counter for outbound Edge→Hub notifications.
    /// Hub’s per-edge reorder buffer handles any delivery ordering across pool slots.
    outbound_notif_seq: AtomicU64,
    /// Dedicated channel for voice relay packets received from Hub.
    ///
    /// `hub.relayVoicePacket` notifications are short-circuited here in
    /// `handle_incoming_slot` before they reach the control notification
    /// processor or the broadcast channel, preventing high-frequency voice
    /// frames from causing `Lagged` errors on the event bus.
    /// Bounded at 512: best-effort delivery, drop on overflow (voice is lossy).
    voice_relay_tx: mpsc::Sender<(u32, bytes::Bytes)>,
}

impl HubClient {
    pub fn new(config: &EdgeConfig, edge_state: Arc<EdgeState>) -> Arc<Self> {
        let external_port = config.network.external_port.unwrap_or(config.network.port);
        let edge_port = config.network.edge_port.unwrap_or(config.network.port + 1);
        let pool_size = config.hub_server.pool_size.max(1) as usize;
        let pool_senders = (0..pool_size).map(|_| Mutex::new(None)).collect();
        // Static peers from config (for bootstrap before Hub connection).
        let static_relay_peers: Vec<(String, u16)> = config
            .hub_server
            .static_peers
            .iter()
            .map(|p| (p.host.clone(), p.relay_port))
            .collect();
        let (voice_relay_tx, voice_relay_rx) = mpsc::channel::<(u32, bytes::Bytes)>(512);
        let hub = Arc::new(Self {
            config: config.hub_server.clone(),
            server_id: config.server_id,
            server_name: config.name.clone(),
            external_host: config.network.external_host.clone(),
            external_port,
            edge_port,
            region: config.network.region.clone(),
            capacity: config.server.capacity,
            static_relay_peers,
            state: RwLock::new(HubConnectionState::Disconnected),
            edge_state,
            pending: Mutex::new(HashMap::new()),
            pool_size,
            pool_senders,
            pool_rr: AtomicUsize::new(0),
            request_counter: AtomicU64::new(0),
            start_time: Instant::now(),
            notification_tx: Mutex::new(None),
            notification_expected_seq: AtomicU64::new(1),
            full_sync_lock: Mutex::new(()),
            sync_done: AtomicBool::new(false),
            sync_notify: tokio::sync::Notify::new(),
            pending_notifications: tokio::sync::Mutex::new(Vec::new()),
            outbound_notif_seq: AtomicU64::new(0),
            voice_relay_tx,
        });
        let vr_state = hub.edge_state.clone();
        let vr_hub = hub.clone();
        tokio::spawn(async move {
            let mut rx = voice_relay_rx;
            while let Some((from_edge_id, pkt)) = rx.recv().await {
                crate::cluster_voice::handle_incoming_logical_frame(
                    pkt,
                    Some(from_edge_id),
                    &vr_state,
                    &vr_hub,
                )
                .await;
            }
        });

        hub
    }

    pub async fn state(&self) -> HubConnectionState {
        *self.state.read().await
    }

    async fn enqueue_runtime_full_sync_request(
        &self,
        reason: &str,
        emit_hub_registered: bool,
    ) -> Result<RuntimeFullSyncOutcome> {
        let (completion_tx, completion_rx) = oneshot::channel();
        let send_result = {
            let tx_guard = self.notification_tx.lock().await;
            tx_guard
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("notification processor unavailable"))?
                .send(NotificationProcessorInput::RuntimeFullSync(
                    RuntimeFullSyncRequest {
                        reason: reason.to_string(),
                        trigger_seq: None,
                        emit_hub_registered,
                        completion: Some(completion_tx),
                    },
                ))
        };

        send_result.map_err(|_| anyhow::anyhow!("notification processor channel closed"))?;

        completion_rx
            .await
            .context("runtime full-sync completion dropped")?
    }

    async fn process_sequenced_notification(
        self: &Arc<Self>,
        sequencer: &mut NotificationSequencer,
        notification: SequencedNotification,
    ) {
        match notification.notification.method.as_str() {
            "hub.periodicFullSync" => {
                self.handle_runtime_full_sync_request(
                    sequencer,
                    RuntimeFullSyncRequest {
                        reason: "hub periodic refresh".to_string(),
                        trigger_seq: notification.seq,
                        emit_hub_registered: true,
                        completion: None,
                    },
                )
                .await;
            }
            "hub.forceFullSync" => {
                self.handle_runtime_full_sync_request(
                    sequencer,
                    RuntimeFullSyncRequest {
                        reason: "hub forced refresh".to_string(),
                        trigger_seq: notification.seq,
                        emit_hub_registered: true,
                        completion: None,
                    },
                )
                .await;
            }
            _ => {
                self.handle_notification(notification.notification).await;
            }
        }
    }

    async fn handle_runtime_full_sync_request(
        self: &Arc<Self>,
        sequencer: &mut NotificationSequencer,
        request: RuntimeFullSyncRequest,
    ) {
        let _full_sync_guard = self.full_sync_lock.lock().await;

        info!(
            reason = %request.reason,
            trigger_seq = request.trigger_seq.unwrap_or(0),
            "Starting runtime full-sync request"
        );

        match self.do_full_sync().await {
            Ok((disappeared, _hub_was_empty, _old_session_ids, hub_seq)) => {
                sequencer.reset_after_full_sync(hub_seq);
                self.edge_state
                    .accepting_connections
                    .store(true, Ordering::Relaxed);
                let outcome = RuntimeFullSyncOutcome {
                    disappeared_session_ids: disappeared,
                    hub_seq,
                };
                if request.emit_hub_registered {
                    self.edge_state.emit(EdgeEvent::HubRegistered {
                        disappeared_session_ids: outcome.disappeared_session_ids.clone(),
                    });
                }
                info!(
                    reason = %request.reason,
                    trigger_seq = request.trigger_seq.unwrap_or(0),
                    hub_seq = outcome.hub_seq,
                    expected_next = outcome.hub_seq + 1,
                    emit_hub_registered = request.emit_hub_registered,
                    "Runtime full-sync completed and live notification sequencer reset"
                );
                if let Some(completion) = request.completion {
                    let _ = completion.send(Ok(outcome));
                }
            }
            Err(e) => {
                warn!(
                    reason = %request.reason,
                    trigger_seq = request.trigger_seq.unwrap_or(0),
                    "Runtime full-sync failed: {:#}",
                    e
                );
                if let Some(completion) = request.completion {
                    let _ = completion.send(Err(e));
                }
            }
        }
    }

    /// Queue a control notification that failed to reach Hub.
    ///
    /// Called by the `notify_*` methods when `send_packet` returns an error so
    /// the notification can be replayed after the next successful reconnect.
    ///
    /// The queue is bounded at [`MAX_PENDING_NOTIFICATIONS`] — the oldest entry
    /// is evicted FIFO when the cap is reached.  This is safe because every
    /// kind queued here is also recovered by the reconnect handshake
    /// (`do_full_sync` + `do_report_local_users` +
    /// `do_report_local_voice_targets`); the replay is only an optimisation to
    /// keep peer edges consistent across the reconnect window.
    /// See audit C3 in `docs/edge-hub-consistency-audit.md`.
    pub(super) async fn enqueue_pending_notification(&self, n: PendingControlNotification) {
        let mut queue = self.pending_notifications.lock().await;
        if queue.len() >= MAX_PENDING_NOTIFICATIONS {
            let dropped = queue.remove(0);
            warn!(
                pending_len = queue.len() + 1,
                max = MAX_PENDING_NOTIFICATIONS,
                "pending_notifications capacity reached — dropping oldest entry: {:?}",
                dropped
            );
        }
        queue.push(n);
    }

    /// Drain and replay all queued control notifications.
    ///
    /// Called inside the `sync_done` CAS block, **before** `do_full_sync`, so
    /// that any ghost sessions and structural mutations are visible to the Hub
    /// before a new snapshot is taken.
    ///
    /// Hub handlers are idempotent for unknown/already-removed entities, so
    /// replaying a notification whose effect was already cleaned up by
    /// `cleanup_edge` is safe.
    async fn flush_pending_notifications(&self) {
        let pending: Vec<PendingControlNotification> = {
            let mut queue = self.pending_notifications.lock().await;
            std::mem::take(&mut *queue)
        };
        if pending.is_empty() {
            return;
        }
        info!(
            "Replaying {} deferred control notifications after Hub reconnect",
            pending.len()
        );
        for n in pending {
            match n {
                PendingControlNotification::UserLeft {
                    session_id,
                    ref reason,
                } => {
                    self.rpc_user_left(session_id, reason.as_deref()).await;
                }
                PendingControlNotification::ChannelLinksChanged {
                    channel_id,
                    links_add,
                    links_remove,
                } => {
                    self.rpc_channel_state(channel_id, links_add, links_remove)
                        .await;
                }
                PendingControlNotification::ChannelRemoved { channel_id } => {
                    self.rpc_channel_remove(channel_id).await;
                }
            }
        }
    }

    /// Get the current edge ID (our registered ID from Hub, or fallback to server_id).
    fn edge_id(&self) -> u32 {
        let id = self.edge_state.get_edge_id();
        if id != 0 { id } else { self.server_id }
    }

    /// Generate a unique request ID.
    fn next_request_id(&self) -> String {
        let counter = self.request_counter.fetch_add(1, Ordering::Relaxed);
        format!("{}-{}", rpc::current_millis(), counter)
    }

    /// Connect to the Hub and run the main communication loop with reconnection.
    ///
    /// All pool slots are peer-equal: each independently connects, registers with
    /// the Hub, and can carry RPC traffic or receive notifications.  The sync
    /// sequence (fullSync, cluster join, etc.) runs exactly once across all slots.
    pub async fn connect_and_run(self: &Arc<Self>) -> Result<()> {
        if self.pool_size == 1 {
            // Single-connection mode: original behaviour.
            self.run_single_slot(0).await;
        } else {
            info!(
                "Hub connection pool mode: {} slots (peer-equal)",
                self.pool_size
            );

            let mut slot_handles = Vec::with_capacity(self.pool_size);
            for slot in 0..self.pool_size {
                let me = self.clone();
                slot_handles.push(tokio::spawn(async move {
                    me.run_single_slot(slot).await;
                }));
            }

            // Keep this future alive until all slot tasks complete (they loop
            // forever under normal operation).  When this task is aborted
            // (server shutdown via hub_handle.abort()), explicitly abort every
            // slot task so they don't keep reconnecting during shutdown.
            // A struct wrapper with Drop is used because Rust doesn't guarantee
            // that code after the cancelled await point runs.
            struct AbortOnDrop(Vec<tokio::task::JoinHandle<()>>);
            impl Drop for AbortOnDrop {
                fn drop(&mut self) {
                    for h in &self.0 {
                        h.abort();
                    }
                }
            }
            let _guard = AbortOnDrop(slot_handles);
            // Block forever; the guard aborts all slots if we are cancelled.
            std::future::pending::<()>().await;
        }
        Ok(())
    }

    /// Run a single slot's reconnect loop with exponential backoff.
    ///
    /// The last slot (`pool_size - 1`) is the dedicated **relay slot** when
    /// `pool_size >= 2`: it exclusively maintains a peer-Edge relay path to Hub
    /// so that the control channel stays alive even while the direct path is
    /// disrupted.  All other slots are **direct slots** that only try the
    /// direct Hub WebSocket address.
    ///
    /// Because the relay slot keeps Hub connected during transient direct
    /// outages, Hub never triggers session cleanup, eliminating the need for
    /// Hub-side grace periods or quick-reconnect flags.
    ///
    /// If the Hub (including all relay paths) remains unreachable for
    /// `UNREACHABLE_TIMEOUT`, all local clients are disconnected and new
    /// connections are refused until registration succeeds again.
    async fn run_single_slot(self: &Arc<Self>, slot: usize) {
        let mut backoff = ExponentialBackoff::new(self.config.reconnect_interval);

        // Tracks when we first lost the Hub connection.  Set on first failure or
        // on normal close; cleared when registration succeeds (HubRegistered).
        let mut first_failure_at: Option<std::time::Instant> = None;
        // Prevent emitting HubUnreachable multiple times for the same outage.
        let mut unreachable_emitted = false;

        loop {
            // Relay slot: always prefer relay so Hub connectivity is maintained
            // even when the direct path is interrupted.  Direct slots only use
            // the direct Hub address — they never contend for the relay path.
            //
            // When the relay slot cannot reach any relay peer (e.g., all peer
            // Edges are also unreachable), it immediately falls back to a direct
            // Hub connection attempt.  This prevents the pool from emptying and
            // triggering Hub-side session cleanup during a relay peer outage,
            // as long as the direct path is still reachable.  Only when both
            // relay AND direct are unavailable does the pool genuinely empty.
            let connect_result = if self.is_relay_slot(slot) {
                if self.has_relay_peers() {
                    match self.try_connect_via_relay(slot).await {
                        Ok(()) => Ok(()),
                        Err(relay_err) => {
                            // All relay peers failed — immediately try direct as
                            // fallback (no backoff delay) before any_slot_alive()
                            // check so the pool stays non-empty if direct succeeds.
                            warn!(
                                slot,
                                "All relay peers unreachable ({relay_err}) — \
                                         falling back to direct Hub connection"
                            );
                            self.try_connect_slot(slot).await
                        }
                    }
                } else {
                    self.try_connect_slot(slot).await
                }
            } else {
                self.try_connect_slot(slot).await
            };

            match connect_result {
                Ok(()) => {
                    info!(
                        "Hub control channel closed (slot {}) — continuing reconnect attempts",
                        slot
                    );
                    backoff.reset();
                    // Connection was alive and has just closed — start the
                    // disconnected timer from this moment.
                    first_failure_at = Some(std::time::Instant::now());
                    unreachable_emitted = false;
                }
                Err(e) => {
                    error!(slot, "Hub connection error: {}", e);
                    // Record the start of this outage on the very first failure.
                    if first_failure_at.is_none() {
                        first_failure_at = Some(std::time::Instant::now());
                    }
                }
            }

            // Clean up this slot first so that any_slot_alive() below reflects
            // the true post-failure state (otherwise the just-failed slot's sender
            // is still present and would be counted as alive).
            self.clear_slot(slot).await;
            self.cancel_pending_for_slot(slot).await;

            // Emit HubUnreachable once the outage has lasted longer than the
            // configured threshold AND no other slot is still connected.
            // Checking any_slot_alive() prevents a single failing slot from
            // kicking all clients while other slots remain healthy.
            if !unreachable_emitted {
                if let Some(since) = first_failure_at {
                    if since.elapsed() >= UNREACHABLE_TIMEOUT && !self.any_slot_alive().await {
                        warn!(
                            elapsed_secs = since.elapsed().as_secs(),
                            "Hub unreachable — disconnecting all clients and refusing new connections"
                        );
                        self.edge_state.emit(EdgeEvent::HubUnreachable);
                        unreachable_emitted = true;
                    }
                }
            }
            // Only manage global state transitions and events if no other slot
            // is still connected.  With peer-equal slots, a single slot going
            // down should not affect the whole client while others are alive.
            {
                let any_alive = self.any_slot_alive().await;
                if !any_alive {
                    // Use the state write-lock as a mutex to ensure only one slot
                    // emits HubDisconnected even if two slots die simultaneously.
                    let was_connected = {
                        let mut st = self.state.write().await;
                        let prev = *st;
                        *st = HubConnectionState::Disconnected;
                        prev != HubConnectionState::Disconnected
                    };
                    self.pending.lock().await.clear();
                    // Drop the notification sender so the processor task exits.
                    // A fresh processor will be created on the next successful connect.
                    *self.notification_tx.lock().await = None;
                    // Reset sync_done so the next slot to connect re-runs the
                    // sync sequence (fullSync, joinCluster, etc.).
                    self.sync_done.store(false, Ordering::Release);
                    if was_connected {
                        self.edge_state.emit(EdgeEvent::HubDisconnected);
                    }
                }
            }

            let delay = backoff.next_delay();
            warn!("Slot {} reconnecting to Hub in {:?}", slot, delay);
            time::sleep(delay).await;
        }
    }

    /// Returns `true` if `slot` is the dedicated relay slot.
    ///
    /// The last slot index (`pool_size - 1`) is reserved as the relay slot
    /// when the pool has more than one connection.  It always connects via a
    /// peer-Edge relay, maintaining Hub connectivity during direct-path outages
    /// so Hub never needs to clean up sessions for a transiently-unreachable Edge.
    ///
    /// With `pool_size == 1` there is no dedicated relay slot; the single slot
    /// always connects directly.
    fn is_relay_slot(&self, slot: usize) -> bool {
        self.pool_size >= 2 && slot == self.pool_size - 1
    }

    /// Returns `true` if at least one relay peer (static or dynamic) is known.
    fn has_relay_peers(&self) -> bool {
        !self.static_relay_peers.is_empty()
            || !self
                .edge_state
                .peer_registry
                .load()
                .relay_peers()
                .is_empty()
    }

    /// Try to connect to Hub via a peer Edge's control-relay port.
    ///
    /// Candidates are tried in priority order:
    ///   1. Static peers from `hub_server.static_peers` (available before Hub connection)
    ///   2. Dynamic peers discovered via `hub.peerJoined` notifications
    ///
    /// Returns `Ok(())` if a relay connection ran and closed normally, or an error if all
    /// candidates failed.
    async fn try_connect_via_relay(self: &Arc<Self>, slot: usize) -> Result<()> {
        // 1. Static peers from config (for bootstrap before Hub connection)
        for (host, relay_port) in &self.static_relay_peers {
            let relay_url =
                rpc::build_relay_url(host, *relay_port, self.config.hmac_secret.as_deref());
            let safe_url = rpc::safe_relay_url(host, *relay_port);
            info!("Attempting Hub relay via static peer at {}", safe_url);
            match self
                .try_connect_via_url(&relay_url, slot, self.config.hmac_secret.as_deref())
                .await
            {
                Ok(()) => {
                    info!(
                        "Static peer relay connection ({}) closed normally",
                        safe_url
                    );
                    return Ok(());
                }
                Err(e) => {
                    warn!("Static peer relay via {} failed: {}", safe_url, e);
                }
            }
        }

        // 2. Dynamically discovered peers (from hub.peerJoined notifications)
        let dynamic_peers = self.edge_state.peer_registry.load().relay_peers();
        if dynamic_peers.is_empty() && self.static_relay_peers.is_empty() {
            return Err(anyhow::anyhow!("No relay peers available"));
        }
        for (peer_id, host, relay_port) in &dynamic_peers {
            let relay_url =
                rpc::build_relay_url(host, *relay_port, self.config.hmac_secret.as_deref());
            let safe_url = rpc::safe_relay_url(host, *relay_port);
            info!("Attempting Hub relay via peer {} at {}", peer_id, safe_url);
            match self
                .try_connect_via_url(&relay_url, slot, self.config.hmac_secret.as_deref())
                .await
            {
                Ok(()) => {
                    info!("Dynamic peer relay (peer {}) closed normally", peer_id);
                    return Ok(());
                }
                Err(e) => {
                    warn!("Dynamic peer relay via {} failed: {}", safe_url, e);
                }
            }
        }
        Err(anyhow::anyhow!("All relay attempts failed"))
    }

    /// Connect via a specific WebSocket URL (used for both direct and relay connections).
    async fn try_connect_via_url(
        self: &Arc<Self>,
        url: &str,
        slot: usize,
        hmac_secret: Option<&str>,
    ) -> Result<()> {
        // Only downgrade to Connecting if no other slot is still Registered/Connected.
        // Avoids clobbering a better state while another slot is alive.
        {
            let mut st = self.state.write().await;
            if matches!(*st, HubConnectionState::Disconnected) {
                *st = HubConnectionState::Connecting;
            }
        }
        info!("Connecting to Hub at {} (slot {})", url, slot);

        let connect_label = format!("Hub WebSocket at {} (slot {})", url, slot);
        let mut ws_stream = crate::control_ws::connect(url, &connect_label).await?;

        // Challenge-response auth handshake for relay connections.
        if let Some(secret) = hmac_secret {
            crate::relay_server::relay_auth_client(&mut ws_stream, secret)
                .await
                .with_context(|| {
                    format!("Relay auth handshake failed for {} (slot {})", url, slot)
                })?;
        }

        info!("WebSocket connected to {} (slot {})", url, slot);
        {
            let mut st = self.state.write().await;
            if matches!(
                *st,
                HubConnectionState::Disconnected | HubConnectionState::Connecting
            ) {
                *st = HubConnectionState::Connected;
            }
        }

        let (mut ws_write, mut ws_read) = ws_stream.split();

        let (send_tx, mut send_rx) = mpsc::channel::<Vec<u8>>(4096);
        if let Some(s) = self.pool_senders.get(slot) {
            *s.lock().await = Some(send_tx);
        }

        let (writer_fail_tx_via, writer_fail_rx_via) = tokio::sync::oneshot::channel::<()>();

        let writer_handle = tokio::spawn(async move {
            let mut fail_tx = Some(writer_fail_tx_via);
            let write_label = format!("Hub WebSocket writer (slot {})", slot);
            while let Some(data) = send_rx.recv().await {
                if let Err(e) = crate::control_ws::send_with_timeout(
                    &mut ws_write,
                    tungstenite::Message::Binary(Bytes::from(data)),
                    &write_label,
                )
                .await
                {
                    error!("{} failed: {:#}", write_label, e);
                    if let Some(tx) = fail_tx.take() {
                        let _ = tx.send(());
                    }
                    break;
                }
            }
        });

        // Per-connection gap-disconnect signal.  A fresh Notify is created for each
        // connection attempt so that a stale signal from a previous attempt cannot
        // immediately fire on the next reconnect iteration.
        let gap_disconnect = Arc::new(tokio::sync::Notify::new());

        // Ensure a notification processor task exists.  The first slot to connect
        // creates it; subsequent slots (or reconnections) reuse the existing one.
        // The processor is global (not per-connection) so notifications received
        // on any slot are fed into the same serial queue.
        {
            let mut tx_guard = self.notification_tx.lock().await;
            if tx_guard.is_none() {
                let (notif_tx, mut notif_rx) =
                    mpsc::unbounded_channel::<NotificationProcessorInput>();
                *tx_guard = Some(notif_tx);
                let notif_self = self.clone();
                let gap_disconnect = gap_disconnect.clone();
                tokio::spawn(async move {
                    // Wait until the sync sequence completes before processing
                    // notifications — avoids races with load_remote_users / load_channels.
                    notif_self.sync_notify.notified().await;
                    let initial_seq = notif_self.notification_expected_seq.load(Ordering::Acquire);
                    let mut sequencer = NotificationSequencer::new(initial_seq);
                    info!(initial_seq, "Notification sequencer started");
                    loop {
                        let gap_remaining = sequencer.gap_remaining();
                        let notif = if let Some(remaining) = gap_remaining {
                            tokio::select! {
                                biased;
                                n = notif_rx.recv() => n,
                                _ = tokio::time::sleep(remaining) => {
                                    if sequencer.is_gap_expired() {
                                        error!(
                                            expected = sequencer.expected_seq,
                                            buffered = sequencer.reorder_buffer.len(),
                                            "Notification gap not resolved in {:?} — triggering reconnect",
                                            NOTIFICATION_GAP_TIMEOUT,
                                        );
                                        gap_disconnect.notify_one();
                                        // Clear notification_tx so the next connection
                                        // attempt creates a fresh processor.
                                        *notif_self.notification_tx.lock().await = None;
                                        return;
                                    }
                                    continue;
                                }
                            }
                        } else {
                            notif_rx.recv().await
                        };
                        let input = match notif {
                            Some(input) => input,
                            None => break,
                        };
                        match input {
                            NotificationProcessorInput::HubNotification(sn) => {
                                match sequencer.feed(sn) {
                                    SequenceAction::ProcessNow(n) => {
                                        notif_self
                                            .process_sequenced_notification(&mut sequencer, n)
                                            .await;
                                        loop {
                                            let ready = sequencer.drain_ready();
                                            if ready.is_empty() {
                                                break;
                                            }
                                            for n in ready {
                                                notif_self
                                                    .process_sequenced_notification(
                                                        &mut sequencer,
                                                        n,
                                                    )
                                                    .await;
                                            }
                                        }
                                    }
                                    SequenceAction::Unsequenced(n) => {
                                        notif_self.handle_notification(n).await;
                                    }
                                    SequenceAction::Buffered | SequenceAction::Duplicate => {}
                                }
                            }
                            NotificationProcessorInput::RuntimeFullSync(request) => {
                                notif_self
                                    .handle_runtime_full_sync_request(&mut sequencer, request)
                                    .await;
                            }
                        }
                    }
                    // The channel closed because the teardown already dropped the sender
                    // (notification_tx = None).  Do NOT clear notification_tx here — a
                    // fast-reconnecting slot may have already stored a new sender there,
                    // and clearing it unconditionally would kill the new processor.
                    // The gap-timeout path above handles its own explicit cleanup via `return`.
                    debug!("Notification processor stopped");
                });
            }
        }

        let (reader_done_tx, reader_done_rx) = tokio::sync::oneshot::channel::<()>();
        let reader_self = self.clone();
        let gap_disconnect_reader = gap_disconnect.clone();
        let reader_handle = tokio::spawn(async move {
            let mut writer_fail = writer_fail_rx_via;
            loop {
                tokio::select! {
                    biased;
                    _ = &mut writer_fail => {
                        debug!("Reader (slot {}): writer failed, breaking read loop", slot);
                        break;
                    }
                    _ = gap_disconnect_reader.notified() => {
                        error!("Reader (slot {}): notification gap timeout — disconnecting", slot);
                        break;
                    }
                    msg = ws_read.next() => {
                        match msg {
                            Some(Ok(tungstenite::Message::Binary(data))) => {
                                if let Err(e) = reader_self.handle_incoming_slot(&data).await {
                                    error!("Fatal Hub message error (slot {}), closing connection: {}", slot, e);
                                    break;
                                }
                            }
                            Some(Ok(tungstenite::Message::Close(_))) => {
                                info!("Hub sent close frame (slot {})", slot);
                                break;
                            }
                            Some(Ok(tungstenite::Message::Ping(data))) => {
                                reader_self.send_on_slot(slot, tungstenite::Message::Pong(data).into_data().to_vec()).await.ok();
                            }
                            Some(Ok(_)) => {}
                            Some(Err(e)) => {
                                error!("WebSocket read error (slot {}): {}", slot, e);
                                break;
                            }
                            None => {
                                info!("WebSocket stream ended (slot {})", slot);
                                break;
                            }
                        }
                    }
                }
            }
            let _ = reader_done_tx.send(());
        });

        // Every slot registers with Hub.  The register RPC is idempotent on the
        // Hub side (re-registration cleans up stale sessions and updates the
        // sender only if no other connection from this edge is already active).
        self.do_register().await?;

        // Run the sync sequence (fullSync, joinCluster, reportLocalUsers, etc.)
        // exactly once.  CAS ensures only one slot executes it even if multiple
        // slots connect concurrently.
        if self
            .sync_done
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            // Replay control notifications that failed while the Hub was unreachable
            // (UserLeft, ChannelLinksChanged, ChannelRemoved).  Must happen before
            // do_full_sync so the Hub snapshot excludes ghost sessions and includes
            // the correct channel tree.
            self.flush_pending_notifications().await;
            let (disappeared, hub_was_empty, old_session_ids, _hub_seq) =
                self.do_full_sync().await?;
            self.do_fetch_voice_targets().await;
            self.do_join_cluster().await?;
            if let Err(e) = self.do_report_local_users().await {
                warn!("Failed to report existing users to Hub: {}", e);
            }
            if let Err(e) = self.do_report_local_voice_targets().await {
                warn!(
                    "Failed to re-upload local VoiceTarget configs to Hub: {}",
                    e
                );
            }
            // Open the gate so the notification processor starts handling events.
            // Use notify_one() (not notify_waiters()) so the permit is stored and
            // the processor task wakes up even if it hasn't reached notified().await
            // yet when this call fires (notify_waiters() is not stored and would be
            // silently dropped in that case, permanently blocking the processor).
            self.sync_notify.notify_one();
            *self.state.write().await = HubConnectionState::Registered;

            // When Hub restarted cold (`hub_was_empty = true`) and we have stale
            // cached sessions, do NOT immediately blast UserRemove to local clients.
            // Instead emit HubRegistered with an empty disappeared list (which
            // re-enables accepting_connections) and spawn a grace-period task that
            // waits for peer Edges to re-report before sending UserRemove for any
            // sessions that genuinely did not come back.
            //
            // This eliminates the "all remote users vanish for 1–3 seconds" flash
            // that otherwise occurs after every Hub cold restart.
            //
            // If any peer Edge fails to reconnect within the grace period, its
            // sessions remain absent from channel_manager and are correctly
            // included in the deferred disappeared list — so stale sessions are
            // always cleaned up, just with a short delay.
            if hub_was_empty && !old_session_ids.is_empty() {
                info!(
                    old_count = old_session_ids.len(),
                    grace_secs = HUB_RESTART_GRACE_SECS,
                    "Hub cold restart detected — deferring UserRemove for {} cached session(s); \
                     grace period: {}s",
                    old_session_ids.len(),
                    HUB_RESTART_GRACE_SECS
                );
                // Re-enable accepting_connections immediately and synchronously here,
                // before emitting the event.  The event listener sets it too, but it
                // processes events asynchronously — if the listener is busy there would
                // be a window where Hub is Registered but new connections are still
                // refused with only a debug log.
                self.edge_state
                    .accepting_connections
                    .store(true, Ordering::Relaxed);
                self.edge_state.emit(EdgeEvent::HubRegistered {
                    disappeared_session_ids: vec![],
                });
                // Spawn the grace-period reconciliation task.
                let state_clone = self.edge_state.clone();
                let my_edge = self.edge_id();
                tokio::spawn(async move {
                    tokio::time::sleep(HUB_RESTART_GRACE_DURATION).await;
                    // Re-compute disappeared: sessions that were alive before the
                    // restart and are still absent after the grace period.
                    let current_remote: std::collections::HashSet<u32> = state_clone
                        .channel_manager
                        .get_all_remote_users()
                        .await
                        .iter()
                        .filter(|u| u.edge_id != my_edge)
                        .map(|u| u.session_id)
                        .collect();
                    let reconciled: Vec<u32> = old_session_ids
                        .into_iter()
                        .filter(|id| !current_remote.contains(id))
                        .collect();
                    if reconciled.is_empty() {
                        info!(
                            "Hub restart grace period elapsed — all {} cached sessions recovered",
                            current_remote.len()
                        );
                    } else {
                        warn!(
                            count = reconciled.len(),
                            "Hub restart grace period elapsed — {} session(s) did not recover; \
                             sending UserRemove",
                            reconciled.len()
                        );
                        state_clone.emit(EdgeEvent::HubReconcileDisappeared {
                            session_ids: reconciled,
                        });
                    }
                });
            } else {
                // Re-enable accepting_connections immediately and synchronously here,
                // before emitting the event.  The event listener sets it too, but it
                // processes events asynchronously — if the listener is busy there would
                // be a window where Hub is Registered but new connections are still
                // refused with only a debug log.
                self.edge_state
                    .accepting_connections
                    .store(true, Ordering::Relaxed);
                self.edge_state.emit(EdgeEvent::HubRegistered {
                    disappeared_session_ids: disappeared,
                });
            }
            info!(
                "Edge registered with Hub successfully ({}, slot {})",
                url, slot
            );
        } else {
            debug!(
                "Slot {} connected (sync already done by another slot)",
                slot
            );
            // If Hub was previously declared unreachable (accepting_connections == false),
            // the slot that wins the sync CAS already re-emits HubRegistered.  But if
            // another slot was alive during the outage so sync_done was never reset, the
            // CAS always fails and HubRegistered is never emitted, leaving
            // accepting_connections permanently false.  Detect that here and recover.
            if !self
                .edge_state
                .accepting_connections
                .load(Ordering::Relaxed)
            {
                info!(
                    "Slot {} recovering accepting_connections after HubUnreachable (sync held by peer slot)",
                    slot
                );
                // Same eager set to avoid the event-listener async delay.
                self.edge_state
                    .accepting_connections
                    .store(true, Ordering::Relaxed);
                self.edge_state.emit(EdgeEvent::HubRegistered {
                    disappeared_session_ids: vec![],
                });
            }
        }

        let heartbeat_self = self.clone();
        let heartbeat_handle = tokio::spawn(async move {
            heartbeat_self.heartbeat_loop().await;
        });

        let _ = reader_done_rx.await;
        heartbeat_handle.abort();
        reader_handle.abort();
        writer_handle.abort();
        Ok(())
    }

    /// Clear a slot's send channel.
    async fn clear_slot(&self, slot: usize) {
        if let Some(s) = self.pool_senders.get(slot) {
            *s.lock().await = None;
        }
    }

    /// Check if any pool slot has an active sender.
    async fn any_slot_alive(&self) -> bool {
        for s in &self.pool_senders {
            if s.lock().await.is_some() {
                return true;
            }
        }
        false
    }

    /// Attempt a single WebSocket connection on `slot`.
    /// All slots are peer-equal: any slot can perform registration & sync.
    async fn try_connect_slot(self: &Arc<Self>, slot: usize) -> Result<()> {
        let url = crate::control_ws::build_hub_url(
            &self.config.host,
            self.config.control_port,
            self.config.tls,
        );
        self.try_connect_via_url(&url, slot, None).await
    }

    /// Send raw bytes through a specific pool slot.
    async fn send_on_slot(&self, slot: usize, data: Vec<u8>) -> Result<()> {
        let sender = self
            .pool_senders
            .get(slot)
            .ok_or_else(|| anyhow::anyhow!("Pool slot {} out of range", slot))?;
        // Clone the Sender under the lock so the Mutex is never held across the
        // async send — holding it would deadlock clear_slot() / any_slot_alive()
        // if the send suspends waiting for channel capacity.
        let tx = sender
            .lock()
            .await
            .as_ref()
            .map(|s| s.clone())
            .ok_or_else(|| anyhow::anyhow!("Pool slot {} not connected", slot))?;
        tx.send(data).await.context("Send channel closed")
    }

    /// Send raw bytes through the WebSocket, using round-robin across live pool slots.
    /// Returns the slot index that successfully sent the data.
    async fn send_raw(&self, data: Vec<u8>) -> Result<usize> {
        if self.pool_size == 1 {
            self.send_on_slot(0, data).await?;
            return Ok(0);
        }
        // Try each slot starting from the round-robin position.
        let start = self.pool_rr.fetch_add(1, Ordering::Relaxed) % self.pool_size;
        for i in 0..self.pool_size {
            let slot = (start + i) % self.pool_size;
            let sender_opt = {
                let guard = self.pool_senders[slot].lock().await;
                guard.as_ref().map(|s| s.clone())
            };
            if let Some(tx) = sender_opt {
                // Use try_send instead of the blocking send().await to prevent
                // indefinitely stalling callers when the writer task is backed up
                // (e.g. TCP send buffer full).  A full channel means this slot's
                // writer is stalled; skip to the next slot rather than blocking.
                match tx.try_send(data.clone()) {
                    Ok(()) => return Ok(slot),
                    Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                        warn!(
                            slot,
                            "Hub send channel full — writer task may be stalled; skipping slot"
                        );
                        // Continue to try next slot.
                    }
                    Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                        // Receiver dropped (writer exited); continue to next slot.
                    }
                }
            }
        }
        // No live slot — all connections to Hub are down or busy
        warn!(
            "HubClient::send_raw: all {} pool slot(s) unavailable (disconnected or busy) — message dropped",
            self.pool_size
        );
        Err(anyhow::anyhow!(
            "all {} connection pool slots unavailable (disconnected or busy)",
            self.pool_size
        ))
    }

    /// Send an EdgeHubPacket to the Hub.
    async fn send_packet(&self, packet: &EdgeHubPacket) -> Result<()> {
        let data = packet.encode_to_vec();
        self.send_raw(data).await.map(|_slot| ())
    }

    /// Send a sequenced fire-and-forget control notification to Hub (Edge→Hub direction).
    ///
    /// Stamps a monotonically increasing `edge_notification_seq` via atomic fetch_add.
    /// Hub’s per-edge `EdgeInboundSequencer` re-orders any out-of-order arrivals caused
    /// by concurrent pool slots, eliminating races in upper-layer notification handlers.
    async fn send_notification(&self, notification: TypedRpcNotification) -> Result<()> {
        let seq_val = self.outbound_notif_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            edge_notification_seq: Some(seq_val),
            ..Default::default()
        };
        self.send_packet(&packet).await
    }

    /// Immediately cancel (with an error) all in-flight RPC requests that were sent
    /// via `slot`.  Called when a pool slot's WebSocket connection closes, so callers
    /// see an immediate error rather than hanging until the 30-second timeout fires.
    async fn cancel_pending_for_slot(&self, slot: usize) {
        let mut pending = self.pending.lock().await;
        let cancelled: Vec<String> = pending
            .iter()
            .filter(|(_, p)| p.slot == slot)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &cancelled {
            if let Some(p) = pending.remove(id) {
                let _ = p.tx.send(Err(format!("pool slot {} disconnected", slot)));
            }
        }
        if !cancelled.is_empty() {
            debug!(
                "Cancelled {} in-flight RPC(s) for disconnected pool slot {}",
                cancelled.len(),
                slot
            );
        }
    }

    /// Send an RPC request and wait for the response.
    ///
    /// In pool mode, the request is sent via round-robin across live slots.  If the
    /// chosen slot dies before the response arrives, the pending entry is cancelled
    /// immediately by `cancel_pending_for_slot`, and this function retries once on a
    /// different live slot with a new request ID.  This covers the most common failure
    /// mode: a slot disconnects mid-flight.
    async fn rpc_call(&self, mut request: TypedRpcRequest) -> Result<TypedRpcResponse> {
        let method = request.method.clone();
        // Allow one retry when a slot dies mid-flight.  Two attempts total.
        for attempt in 0_u32..=1 {
            if attempt > 0 {
                // Assign a new request_id so the retry doesn't collide with any
                // stale response the Hub might still send for the original request.
                request.request_id = self.next_request_id();
                debug!(
                    "RPC {} retrying after slot failure (attempt {})",
                    method,
                    attempt + 1
                );
            }

            let request_id = request.request_id.clone();
            let (tx, rx) = oneshot::channel();

            let packet = EdgeHubPacket {
                r#type: PacketType::RpcRequest as i32,
                rpc_request: Some(request.clone()),
                ..Default::default()
            };
            let data = packet.encode_to_vec();

            let used_slot = match self.send_raw(data).await {
                Ok(s) => s,
                Err(e) => {
                    if attempt == 0 {
                        // No live slot — this typically means a failover is in
                        // progress (direct closed, relay not yet established).
                        // Wait up to 10 s for any slot to reconnect, then retry
                        // once rather than immediately returning an error.
                        const WAIT_FOR_SLOT: Duration = Duration::from_secs(10);
                        const POLL_INTERVAL: Duration = Duration::from_millis(250);
                        warn!(
                            "No Hub slot available for RPC {method} — waiting up to {WAIT_FOR_SLOT:?} for reconnect"
                        );
                        let deadline = time::Instant::now() + WAIT_FOR_SLOT;
                        loop {
                            time::sleep(POLL_INTERVAL).await;
                            if time::Instant::now() >= deadline {
                                return Err(e.context(format!(
                                    "timed out waiting for Hub slot for RPC {method}"
                                )));
                            }
                            if self.any_slot_alive().await {
                                debug!("Hub slot available — retrying RPC {method}");
                                break;
                            }
                        }
                        continue; // retry with attempt 1
                    } else {
                        return Err(e.context(format!("RPC {} failed after retry", method)));
                    }
                }
            };

            self.pending.lock().await.insert(
                request_id.clone(),
                PendingRequest {
                    tx,
                    slot: used_slot,
                },
            );

            // Wait for response with timeout
            let timeout = Duration::from_secs(30);
            match time::timeout(timeout, rx).await {
                Ok(Ok(Ok(response))) => return Ok(response),
                Ok(Ok(Err(err_msg))) => {
                    // Hub returned an RPC-level error — do not retry, propagate immediately.
                    anyhow::bail!("RPC {} error: {}", method, err_msg);
                }
                Ok(Err(_)) => {
                    // Slot died mid-flight (cancel_pending_for_slot dropped the sender).
                    // Retry once on a different slot.
                    if attempt == 0 {
                        warn!(
                            "RPC {} cancelled (pool slot {} died mid-flight), retrying",
                            method, used_slot
                        );
                        continue;
                    } else {
                        anyhow::bail!("RPC {} cancelled after retry", method);
                    }
                }
                Err(_) => {
                    // 30-second timeout — Hub may or may not have processed the request;
                    // do not retry to avoid duplicate state mutations.
                    self.pending.lock().await.remove(&request_id);
                    anyhow::bail!("RPC {} timed out", method);
                }
            }
        }
        // Unreachable: the loop above always returns.
        anyhow::bail!("RPC {} failed (exhausted retries)", method)
    }

    /// Handle an incoming message from a specific pool slot.
    /// Notifications are forwarded to the serial processor channel (`self.notification_tx`)
    /// and processed in arrival order, matching C++ Mumble's Qt event-loop serial semantics.
    /// All slots are peer-equal and forward notifications to the shared processor.
    async fn handle_incoming_slot(self: &Arc<Self>, data: &[u8]) -> Result<()> {
        // Decompress if the Hub compressed the payload (prefix byte 0x01).
        // Raw protobuf frames always begin with a field tag (≥ 0x08), so 0x01 is unambiguous.
        let owned: Vec<u8>;
        let data: &[u8] = if data.first() == Some(&0x01) {
            let payload = data[1..].to_vec();
            let result = tokio::task::spawn_blocking(move || {
                use std::io::Read;
                let mut dec = ZlibDecoder::new(payload.as_slice());
                let mut buf = Vec::new();
                dec.read_to_end(&mut buf).map(|_| buf)
            })
            .await
            .context("spawn_blocking join error")?;
            match result {
                Ok(buf) => {
                    owned = buf;
                    &owned
                }
                Err(e) => {
                    return Err(anyhow::anyhow!("Failed to decompress Hub message: {}", e));
                }
            }
        } else {
            data
        };
        let packet = EdgeHubPacket::decode(data).context("Failed to decode EdgeHubPacket")?;

        match PacketType::try_from(packet.r#type) {
            Ok(PacketType::RpcResponse) => {
                if let Some(response) = packet.rpc_response {
                    self.handle_rpc_response(response).await;
                }
            }
            Ok(PacketType::RpcError) => {
                if let Some(error) = packet.rpc_error {
                    self.handle_rpc_error(&error.request_id, &error.message)
                        .await;
                }
            }
            Ok(PacketType::RpcNotification) => {
                if let Some(notification) = packet.rpc_notification {
                    // Fast path: voice relay packets bypass the control notification
                    // processor and broadcast channel entirely.  High-frequency voice
                    // frames would saturate the sequencer queue and the broadcast channel
                    // (causing Lagged errors), so they are delivered on a dedicated
                    // bounded channel by a separate worker task.
                    if notification.method == "hub.relayVoicePacket" {
                        if let Some(params) = notification.relay_voice_packet {
                            // try_send: drop the packet if the worker is behind.
                            // Voice is best-effort; dropping the occasional packet is
                            // far better than blocking the Hub WS reader.
                            let _ = self
                                .voice_relay_tx
                                .try_send((params.from_edge_id, params.voice_packet.into()));
                        }
                        return Ok(());
                    }
                    // Control notification: enqueue into the serial processor channel —
                    // never blocks the reader task, guarantees arrival-order processing.
                    let guard = self.notification_tx.lock().await;
                    if let Some(tx) = guard.as_ref() {
                        let sn = SequencedNotification {
                            seq: packet.notification_seq,
                            notification,
                        };
                        if tx
                            .send(NotificationProcessorInput::HubNotification(sn))
                            .is_err()
                        {
                            warn!("Notification processor channel closed");
                        }
                    }
                }
            }
            Ok(PacketType::HeartbeatAck) => {
                debug!("Heartbeat ack received");
            }
            _ => {
                debug!("Unknown packet type: {}", packet.r#type);
            }
        }
        Ok(())
    }

    /// Handle an RPC response by resolving the pending request.
    async fn handle_rpc_response(&self, response: TypedRpcResponse) {
        let request_id = response.request_id.clone();
        if let Some(pending) = self.pending.lock().await.remove(&request_id) {
            let _ = pending.tx.send(Ok(response));
        } else {
            // Expected for fire-and-forget requests such as relay_voice_via_hub.
            debug!(
                "Received response for unregistered request (fire-and-forget): {}",
                request_id
            );
        }
    }

    /// Handle an RPC error by rejecting the pending request.
    async fn handle_rpc_error(&self, request_id: &str, message: &str) {
        if let Some(pending) = self.pending.lock().await.remove(request_id) {
            let _ = pending.tx.send(Err(message.to_string()));
        }
    }

    // ==================== RPC Methods ====================

    /// Register this Edge with the Hub (with optional HMAC challenge-response).
    async fn do_register(&self) -> Result<()> {
        let request_id = self.next_request_id();
        let params = EdgeRegisterParams {
            server_id: self.server_id,
            name: self.server_name.clone(),
            host: self.external_host.clone(),
            port: self.external_port as u32,
            region: self.region.clone(),
            capacity: self.capacity,
            certificate: String::new(),
            challenge: None,
            challenge_response: None,
        };

        let request = TypedRpcRequest {
            request_id,
            method: "edge.register".to_string(),
            timeout_ms: Some(30000),
            edge_register: Some(params),
            ..Default::default()
        };

        // Registration is sent via round-robin like any other RPC.
        // The Hub's edge_connection handler ensures only the first connection
        // per edge stores its sender in edge_connections; subsequent pool
        // connections only set their server_id.
        let response = self
            .rpc_call(request)
            .await
            .context("edge.register RPC failed")?;

        let result = response
            .edge_register
            .ok_or_else(|| anyhow::anyhow!("No edge_register in response"))?;

        if !result.success {
            // Check if we need HMAC challenge-response
            if let Some(challenge) = &result.challenge {
                if let Some(hmac_secret) = &self.config.hmac_secret {
                    info!("Received HMAC challenge, sending response");
                    return self
                        .do_register_with_challenge(challenge, hmac_secret)
                        .await;
                }
            }
            anyhow::bail!("Registration failed: {:?}", result.error);
        }

        if let Some(hub_id) = result.hub_server_id {
            info!("Registered with Hub, assigned hub_server_id={}", hub_id);
        }

        // Store our edge_id (Hub may assign it)
        if let Some(id) = result.hub_server_id {
            self.edge_state.set_edge_id(id);
        }

        // Store server limits received from Hub
        if let Some(limits) = result.server_limits {
            debug!("Stored server limits from Hub registration");
            self.apply_server_limits(limits).await;
        }

        Ok(())
    }

    /// Register with HMAC challenge-response.
    async fn do_register_with_challenge(&self, challenge: &str, hmac_secret: &str) -> Result<()> {
        use ring::hmac;

        let key = hmac::Key::new(hmac::HMAC_SHA256, hmac_secret.as_bytes());
        let data = format!("{}:{}", challenge, self.server_id);
        let signature = hmac::sign(&key, data.as_bytes());
        let challenge_response = hex::encode(signature.as_ref());

        let request_id = self.next_request_id();
        let params = EdgeRegisterParams {
            server_id: self.server_id,
            name: self.server_name.clone(),
            host: self.external_host.clone(),
            port: self.external_port as u32,
            region: self.region.clone(),
            capacity: self.capacity,
            certificate: String::new(),
            challenge: Some(challenge.to_string()),
            challenge_response: Some(challenge_response),
        };

        let request = TypedRpcRequest {
            request_id,
            method: "edge.register".to_string(),
            timeout_ms: Some(30000),
            edge_register: Some(params),
            ..Default::default()
        };

        let response = self
            .rpc_call(request)
            .await
            .context("edge.register (challenge) RPC failed")?;

        let result = response
            .edge_register
            .ok_or_else(|| anyhow::anyhow!("No edge_register in response"))?;

        if !result.success {
            anyhow::bail!("Registration with challenge failed: {:?}", result.error);
        }

        if let Some(id) = result.hub_server_id {
            self.edge_state.set_edge_id(id);
        }
        info!("Registered with Hub via HMAC challenge-response");

        // Store server limits received from Hub
        if let Some(limits) = result.server_limits {
            debug!("Stored server limits from Hub registration (challenge)");
            self.apply_server_limits(limits).await;
        }

        Ok(())
    }

    /// Request full sync from Hub (channels, users, ACLs).
    ///
    /// Returns a tuple `(disappeared, hub_was_empty, old_session_ids)`:
    ///
    /// * `disappeared` – remote-user session IDs present in the local cache
    ///   *before* the sync but absent from the fresh Hub snapshot.
    /// * `hub_was_empty` – the Hub's session table was empty at snapshot time
    ///   (proxy for a Hub cold-restart).  When `true` and the caller has a
    ///   non-empty `old_session_ids`, the `disappeared` set should be delivered
    ///   via a deferred grace-period timer rather than immediately, so that peer
    ///   Edges have time to re-report their sessions.
    /// * `old_session_ids` – the snapshot of remote session IDs taken *before*
    ///   the cache was cleared.  Passed back to the caller so the grace timer
    ///   can perform a post-grace diff against the repopulated cache.
    /// * `hub_seq` – the Hub notification fence returned with the snapshot.
    async fn do_full_sync(&self) -> Result<(Vec<u32>, bool, std::collections::HashSet<u32>, u64)> {
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.fullSync".to_string(),
            timeout_ms: Some(60000),
            edge_full_sync: Some(EdgeFullSyncParams {
                for_user_id: None,
                for_user_groups: vec![],
                for_user_channel_id: None,
                for_user_cert_hash: None,
            }),
            ..Default::default()
        };

        let response = self
            .rpc_call(request)
            .await
            .context("edge.fullSync RPC failed")?;

        let result = response
            .edge_full_sync
            .ok_or_else(|| anyhow::anyhow!("No edge_full_sync in response"))?;

        // Store the notification sequence from Hub so the processor knows where
        // to start its expected counter.  Notifications with seq <= this value
        // are already reflected in the fullsync snapshot (or will be discarded
        // as duplicates).
        let hub_seq = result.sequence;
        self.notification_expected_seq
            .store(hub_seq + 1, Ordering::Release);
        info!(
            hub_seq,
            expected_next = hub_seq + 1,
            "Full sync: notification sequence initialised"
        );

        // Filter out sessions belonging to this edge — they are tracked locally by
        // client_manager and must not pollute the remote_users cache.  Without this
        // filter, a Hub restart causes local session IDs to appear in `disappeared`,
        // which then triggers UserRemove messages being sent to local clients for
        // their *own* session — making the C++ client think it was kicked even though
        // the TCP connection is still alive.
        let my_edge_id = self.edge_id();

        // Defensive check: warn if Hub snapshot contains sessions attributed to this edge.
        // This should not happen under normal operation (Hub cleans up stale sessions
        // during re-registration), but if it does it indicates a Hub-side bug or a
        // configuration error (duplicate server_id).
        let local_in_snapshot: Vec<_> = result
            .sessions
            .iter()
            .filter(|s| s.edge_id == my_edge_id)
            .collect();
        if !local_in_snapshot.is_empty() {
            warn!(
                edge_id = my_edge_id,
                count = local_in_snapshot.len(),
                "Full sync: Hub snapshot contains {} session(s) attributed to THIS edge (edge_id={}) — \
                 these will be ignored. Possible causes: Hub did not clean up stale sessions, \
                 or duplicate server_id in config.",
                local_in_snapshot.len(),
                my_edge_id
            );
        }

        let remote_sessions: Vec<&munode_protocol::hubedge::GlobalSessionProto> = result
            .sessions
            .iter()
            .filter(|s| s.edge_id != my_edge_id)
            .collect();

        // Snapshot the old remote-user session IDs **before** clearing the cache so
        // we can compute the "disappeared" diff once the fresh data is loaded.
        // Only consider sessions from other edges to exclude any stale local sessions
        // that may have been loaded into the cache by a previous buggy run.
        let old_session_ids: std::collections::HashSet<u32> = self
            .edge_state
            .channel_manager
            .get_all_remote_users()
            .await
            .iter()
            .filter(|u| u.edge_id != my_edge_id)
            .map(|u| u.session_id)
            .collect();

        // Load channels
        self.edge_state
            .channel_manager
            .load_channels(&result.channels, &result.channel_links)
            .await;

        // Load remote users (clears and repopulates the cache) — only remote sessions.
        let remote_sessions_owned: Vec<munode_protocol::hubedge::GlobalSessionProto> =
            remote_sessions.iter().map(|s| (*s).clone()).collect();
        self.edge_state
            .channel_manager
            .load_remote_users(&remote_sessions_owned)
            .await;

        // Compute sessions that existed before but are no longer present.
        let new_session_ids: std::collections::HashSet<u32> =
            remote_sessions.iter().map(|s| s.session_id).collect();
        let disappeared: Vec<u32> = old_session_ids
            .iter()
            .filter(|id| !new_session_ids.contains(*id))
            .copied()
            .collect();

        let hub_was_empty = result.hub_was_empty.unwrap_or(false);

        if !disappeared.is_empty() {
            if hub_was_empty {
                info!(
                    "Full sync: {} session(s) in pre-restart cache — deferring UserRemove \
                     blast by grace period (hub_was_empty=true)",
                    disappeared.len()
                );
            } else {
                info!(
                    "Full sync: {} session(s) disappeared from Hub snapshot",
                    disappeared.len()
                );
            }
        }

        info!(
            "Full sync complete: {} channels, {} remote sessions ({} total from Hub)",
            result.channels.len(),
            remote_sessions_owned.len(),
            result.sessions.len(),
        );
        // Invalidate all BroadcastCaches: full state refresh means routing targets changed.
        self.edge_state
            .topology_version
            .fetch_add(1, std::sync::atomic::Ordering::Release);
        Ok((disappeared, hub_was_empty, old_session_ids, hub_seq))
    }

    /// Fetch all existing VoiceTarget configs from Hub and populate the local cache.
    /// Called once after FullSync + cache clear so that voice targets set by users
    /// on other edges (or before this edge connected) are immediately available.
    async fn do_fetch_voice_targets(&self) {
        use munode_protocol::hubedge::EdgeGetVoiceTargetsParams;
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.getVoiceTargets".to_string(),
            timeout_ms: Some(10000),
            edge_get_voice_targets: Some(EdgeGetVoiceTargetsParams { edge_id: None }),
            ..Default::default()
        };
        let result = match self.rpc_call(request).await {
            Ok(r) => match r.edge_get_voice_targets {
                Some(v) => v,
                None => {
                    warn!("edge.getVoiceTargets: empty response");
                    return;
                }
            },
            Err(e) => {
                warn!("edge.getVoiceTargets RPC failed: {}", e);
                return;
            }
        };
        if result.voice_targets.is_empty() {
            return;
        }
        let total_from_hub = result.voice_targets.len();
        apply_voice_target_proto_batch(
            &self.edge_state,
            result
                .voice_targets
                .into_iter()
                .map(|entry| (entry.client_session, entry.target_id, entry.config))
                .collect(),
        )
        .await;
        let total: usize = self
            .edge_state
            .voice_targets
            .read()
            .await
            .values()
            .map(|session_vts| session_vts.len())
            .sum();
        debug!(
            "Fetched {} voice target entries from Hub ({} cached locally)",
            total_from_hub, total
        );
    }

    /// Join the cluster topology so Hub can broadcast our address to peer Edges.
    /// Called after successful registration and full sync; sends `edge.join` RPC
    /// then confirms with `edge.joinComplete`.
    async fn do_join_cluster(&self) -> Result<()> {
        let request_id = self.next_request_id();
        let params = EdgeJoinParams {
            server_id: self.server_id,
            name: self.server_name.clone(),
            host: self.external_host.clone(),
            port: self.external_port as u32,
            voice_port: self.edge_port as u32,
            capacity: self.capacity,
        };

        let request = TypedRpcRequest {
            request_id,
            method: "edge.join".to_string(),
            timeout_ms: Some(30000),
            edge_join: Some(params),
            ..Default::default()
        };

        let response = self
            .rpc_call(request)
            .await
            .context("edge.join RPC failed")?;

        let result = response
            .edge_join
            .ok_or_else(|| anyhow::anyhow!("No edge_join in response"))?;

        if !result.success {
            anyhow::bail!("edge.join failed: {:?}", result.error);
        }

        info!(
            "Joined cluster topology, {} existing peers",
            result.peers.len()
        );
        for peer in &result.peers {
            info!(
                "  Peer edge: {} (id={}, {}:{})",
                peer.name, peer.id, peer.host, peer.port
            );
            // Register each existing peer's UDP address
            if !peer.host.is_empty() && peer.voice_port > 0 {
                if let Ok(udp_addr) = format!("{}:{}", peer.host, peer.voice_port).parse() {
                    {
                        let current = self.edge_state.peer_registry.load_full();
                        let mut new_reg = (*current).clone();
                        new_reg.upsert(
                            peer.id,
                            PeerEdgeInfo {
                                udp_addr,
                                host: peer.host.clone(),
                                relay_port: None,
                            },
                        );
                        self.edge_state.peer_registry.store(Arc::new(new_reg));
                    }
                    info!(
                        "Registered direct UDP route to existing peer edge {} at {}",
                        peer.id, udp_addr
                    );
                }
                // Connect TCP voice pool to the existing peer, dedup via voice_tcp_peers.
                let peer_id = peer.id;
                let peer_host = peer.host.clone();
                let voice_port = peer.voice_port as u16;
                let already_managed = {
                    self.edge_state
                        .voice_tcp_peers
                        .read()
                        .await
                        .contains(&peer_id)
                };
                if !already_managed {
                    let self_id = self.edge_state.get_edge_id();
                    let state_clone = self.edge_state.clone();
                    let secret = self.config.hmac_secret.clone();
                    tokio::spawn(async move {
                        crate::relay_server::connect_peer_voice_tcp(
                            peer_id,
                            peer_host,
                            voice_port,
                            self_id,
                            state_clone,
                            secret,
                        )
                        .await;
                    });
                }
            }
        }

        // Notify Hub that we have processed the peer list
        let complete_id = self.next_request_id();
        let token = result.token.unwrap_or_default();
        let connected_peers: Vec<u32> = result.peers.iter().map(|p| p.id).collect();
        let complete_request = TypedRpcRequest {
            request_id: complete_id,
            method: "edge.joinComplete".to_string(),
            timeout_ms: Some(10000),
            edge_join_complete: Some(EdgeJoinCompleteParams {
                server_id: self.server_id,
                token,
                connected_peers,
            }),
            ..Default::default()
        };
        let _ = self.rpc_call(complete_request).await;

        Ok(())
    }

    async fn report_connected_peers(&self) -> Result<()> {
        let connected_peers: Vec<u32> = self
            .edge_state
            .peer_registry
            .load()
            .all_udp_peers()
            .into_iter()
            .map(|(edge_id, _)| edge_id)
            .collect();

        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "edge.joinComplete".to_string(),
            timeout_ms: Some(10000),
            edge_join_complete: Some(EdgeJoinCompleteParams {
                server_id: self.server_id,
                token: String::new(),
                connected_peers,
            }),
            ..Default::default()
        };

        let _ = self.rpc_call(request).await?;
        Ok(())
    }

    /// After a Hub reconnect, report all currently-connected local users to the
    /// Hub so it can rebuild its session registry.  Without this, Hub restart
    /// leaves Hub unaware of existing users, breaking cross-edge visibility and
    /// other Hub-side logic.
    async fn do_report_local_users(&self) -> Result<()> {
        use crate::client::ClientState;
        let edge_id = self.edge_id();
        let clients = self.edge_state.client_manager.get_all_clients().await;
        let ready_clients: Vec<_> = clients
            .iter()
            .filter(|c| c.state == ClientState::Ready)
            .collect();

        if ready_clients.is_empty() {
            return Ok(());
        }

        info!(
            "Reporting {} existing local users to Hub after reconnect",
            ready_clients.len()
        );

        for client in ready_clients {
            let session_proto = GlobalSessionProto {
                session_id: client.session,
                edge_id,
                user_id: client.user_id,
                username: client.username.clone(),
                channel_id: client.channel_id,
                ip_address: Some(client.ip_address.clone()),
                cert_hash: client.cert_hash.clone(),
                connected_at: None,
                groups: client.groups.clone(),
                mute: Some(client.mute),
                deaf: Some(client.deaf),
                suppress: Some(client.suppress),
                self_mute: Some(client.self_mute),
                self_deaf: Some(client.self_deaf),
                priority_speaker: Some(client.priority_speaker),
                recording: Some(client.recording),
                listening_channels: client.listening_channels.clone(),
            };
            let request_id = self.next_request_id();
            let request = TypedRpcRequest {
                request_id,
                method: "edge.reportSession".to_string(),
                timeout_ms: Some(10000),
                edge_report_session: Some(EdgeReportSessionParams {
                    session: Some(session_proto),
                }),
                ..Default::default()
            };
            if let Err(e) = self.rpc_call(request).await {
                warn!(
                    "Failed to report existing session {} to Hub: {}",
                    client.session, e
                );
            } else {
                debug!(
                    "Reported session {} ({}) to Hub",
                    client.session, client.username
                );
            }
        }

        Ok(())
    }

    /// Re-upload all local VoiceTarget configs to Hub after reconnect.
    /// Necessary because Hub does not persist VoiceTarget data to database —
    /// if Hub restarts, all VoiceTarget configs are lost, causing "no VoiceTarget
    /// config for session X target Y" errors when clients use whisper/shout.
    async fn do_report_local_voice_targets(&self) -> Result<()> {
        // Snapshot the entire voice_targets map under a brief read lock, then
        // release it before any RPC calls.  The read guard must NOT be held
        // across rpc_call().await: each call has a 10-second timeout, and
        // keeping the lock live would stall all voice_targets.write() in the
        // notification handler (hub.syncVoiceTarget) for potentially minutes.
        let snapshot: Vec<(u32, u32, hubedge::VoiceTargetConfigProto)> = {
            let vt_cache = self.edge_state.voice_targets.read().await;
            if vt_cache.is_empty() {
                return Ok(());
            }
            let mut out = Vec::new();
            for (&session_id, targets) in vt_cache.iter() {
                for (&target_id, vt_config) in targets.iter() {
                    out.push((
                        session_id,
                        target_id,
                        voice_target_config_to_proto(vt_config),
                    ));
                }
            }
            out
        }; // ← read guard released here, before any await

        let mut upload_count = 0;
        for (session_id, target_id, config) in snapshot {
            if let Err(e) = self
                .sync_voice_target(session_id, target_id, Some(config))
                .await
            {
                warn!(
                    "Failed to re-upload VoiceTarget session={} target={} to Hub: {}",
                    session_id, target_id, e
                );
            } else {
                upload_count += 1;
            }
        }

        if upload_count > 0 {
            info!(
                "Re-uploaded {} VoiceTarget configs to Hub after reconnect",
                upload_count
            );
        }
        Ok(())
    }

    /// Heartbeat loop.
    async fn heartbeat_loop(&self) {
        let interval = Duration::from_millis(self.config.heartbeat_interval);
        let mut sequence: u64 = 0;

        loop {
            time::sleep(interval).await;
            sequence += 1;

            let user_count = self.edge_state.client_manager.client_count().await as u32;
            let channel_count = self
                .edge_state
                .channel_manager
                .get_all_channels()
                .await
                .len() as u32;
            let uptime_seconds = self.start_time.elapsed().as_secs();

            let packet = EdgeHubPacket {
                r#type: PacketType::Heartbeat as i32,
                heartbeat: Some(hubedge::Heartbeat {
                    edge_id: self.edge_id(),
                    sequence,
                    stats: Some(hubedge::ServerStats {
                        user_count,
                        channel_count,
                        cpu_usage: None,
                        memory_usage_mb: None,
                        network_send_kbps: None,
                        network_recv_kbps: None,
                        uptime_seconds: Some(uptime_seconds),
                    }),
                }),
                ..Default::default()
            };

            if let Err(e) = self.send_packet(&packet).await {
                warn!("Failed to send heartbeat (seq={}): {}", sequence, e);
                // A single send failure may be a transient network blip. Continue
                // sending heartbeats; the connection manager will detect a dead link
                // through its own reconnect logic after consecutive failures.
                continue;
            }
            debug!("Heartbeat sent (seq={})", sequence);
        }
    }
}
