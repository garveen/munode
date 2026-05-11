//! Voice transmission and whisper-target operations.

use anyhow::{Context, Result, bail};
use bytes::{BufMut, BytesMut};
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::client::MumbleClient;
use crate::voice::build_voice_packet;

/// Voice handle — voice send + whisper target configuration.
#[derive(Clone)]
pub struct Voice<'a> {
    pub(crate) client: &'a MumbleClient,
}

impl<'a> Voice<'a> {
    /// Send an already-built voice payload (raw bytes after the Mumble
    /// codec/target/sequence header). Routes via UDP if available, otherwise
    /// over the TCP `UDPTunnel`.
    pub async fn send_packet(&self, packet: &[u8]) -> Result<()> {
        self.client.send_voice_payload(packet).await
    }

    /// Build a voice packet from `(codec, target, sequence, audio)` and send it.
    pub async fn send(&self, codec: u8, target: u8, sequence: u64, audio: &[u8]) -> Result<()> {
        let pkt = build_voice_packet(codec, target, sequence, audio);
        self.send_packet(&pkt).await
    }

    /// Configure whisper target `id` with the supplied list of receivers.
    pub async fn set_target(
        &self,
        id: u32,
        targets: Vec<mumbleproto::voice_target::Target>,
    ) -> Result<()> {
        self.client.send_proto(MessageType::VoiceTarget, &mumbleproto::VoiceTarget {
            id: Some(id),
            targets,
        })
    }

    /// Clear whisper target `id`.
    pub async fn clear_target(&self, id: u32) -> Result<()> {
        self.client.send_proto(MessageType::VoiceTarget, &mumbleproto::VoiceTarget {
            id: Some(id),
            targets: vec![],
        })
    }

    /// Toggle force-TCP voice mode (pin all voice through the TCP UDPTunnel).
    pub async fn set_force_tcp(&self, force_tcp: bool) {
        self.client.set_force_tcp_voice(force_tcp).await
    }

    /// Send an encrypted UDP Ping to the server (used to bootstrap or refresh
    /// the UDP path). Returns an error if the UDP socket isn't open or if
    /// CryptState isn't ready.
    pub async fn send_udp_ping(&self) -> Result<()> {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut plain = BytesMut::with_capacity(16);
        plain.put_u8(0x20); // type=Ping(1)<<5
        plain.extend_from_slice(&munode_protocol::varint::encode_varint(ts));

        self.client.send_encrypted_udp_packet(&plain).await
    }
}
