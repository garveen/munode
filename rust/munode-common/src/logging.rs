use tracing_subscriber::{fmt, EnvFilter};

/// Initialize the logging system with the given level.
pub fn init_logging(level: &str) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(level));

    fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_thread_ids(false)
        .with_line_number(true)
        .init();
}
