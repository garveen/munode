use std::io::Result;
use std::path::PathBuf;

fn main() -> Result<()> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let out_dir = manifest_dir.join("src/generated");
    let force_regen = std::env::var("MUNODE_REGEN_PROTO")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    // If generated files already exist, skip regeneration.
    // This allows building without protoc when generated files are committed.
    let expected = out_dir.join("mumbleproto.rs");
    if expected.exists() && !force_regen {
        return Ok(());
    }

    // Determine proto directory:
    // 1. MUNODE_PROTO_DIR env var (used in Docker builds)
    // 2. Default: relative path to packages/protocol/proto/
    let proto_dir = if let Ok(dir) = std::env::var("MUNODE_PROTO_DIR") {
        PathBuf::from(dir)
    } else {
        let workspace_root = manifest_dir
            .parent()
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Failed to find munode-protocol parent directory",
                )
            })?
            .parent()
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Failed to find workspace root (expected 2 levels above munode-protocol)",
                )
            })?;
        workspace_root.join("packages/protocol/proto")
    };

    if !proto_dir.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "Proto directory not found at {:?}. Set MUNODE_PROTO_DIR env var or ensure packages/protocol/proto/ exists.",
                proto_dir
            ),
        ));
    }

    std::fs::create_dir_all(&out_dir).ok();

    let mut config = prost_build::Config::new();
    config
        .out_dir(&out_dir)
        .bytes([
            ".hubedge.EdgeRelayVoiceViaTcpParams.voice_packet",
            ".hubedge.HubRelayVoicePacketParams.voice_packet",
        ])
        .compile_protos(
            &[
                proto_dir.join("Mumble.proto"),
                proto_dir.join("HubEdge.proto"),
                proto_dir.join("HubEdgeSync.proto"),
                proto_dir.join("HubEdgeRPC.proto"),
                proto_dir.join("AuthService.proto"),
                proto_dir.join("VoiceUDP.proto"),
            ],
            &[&proto_dir],
        )?;
    Ok(())
}
