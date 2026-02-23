use std::io::Result;
use std::path::PathBuf;

fn main() -> Result<()> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let out_dir = manifest_dir.join("src/generated");

    // Determine proto directory:
    // 1. MUNODE_PROTO_DIR env var (used in Docker builds)
    // 2. Default: relative path to packages/protocol/proto/
    let proto_dir = if let Ok(dir) = std::env::var("MUNODE_PROTO_DIR") {
        PathBuf::from(dir)
    } else {
        manifest_dir
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("packages/protocol/proto")
    };

    // If proto dir does not exist and generated files already exist, skip regeneration.
    // This allows building without protoc when generated files are committed.
    if !proto_dir.exists() {
        let expected = out_dir.join("mumbleproto.rs");
        if expected.exists() {
            println!("cargo:warning=Proto dir not found at {:?}, using pre-generated files", proto_dir);
            return Ok(());
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "Proto directory not found at {:?}. Set MUNODE_PROTO_DIR env var or ensure packages/protocol/proto/ exists.",
                proto_dir
            ),
        ));
    }

    std::fs::create_dir_all(&out_dir).ok();

    prost_build::Config::new()
        .out_dir(&out_dir)
        .compile_protos(
            &[
                proto_dir.join("Mumble.proto"),
                proto_dir.join("HubEdge.proto"),
                proto_dir.join("HubEdgeSync.proto"),
                proto_dir.join("HubEdgeRPC.proto"),
                proto_dir.join("VoiceUDP.proto"),
            ],
            &[&proto_dir],
        )?;
    Ok(())
}
