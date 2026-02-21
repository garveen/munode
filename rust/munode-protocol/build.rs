use std::io::Result;
use std::path::PathBuf;

fn main() -> Result<()> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let proto_dir = manifest_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("packages/protocol/proto");
    let out_dir = manifest_dir.join("src/generated");

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
