use tracing_subscriber::{fmt, EnvFilter};

/// Initialize the logging system with the given level and optional JSON format.
///
/// Set `log_format = "json"` in config to enable structured JSON logging,
/// which is useful for log aggregation systems (Loki, Elasticsearch, etc.).
pub fn init_logging(level: &str) {
    init_logging_with_format(level, "text");
}

/// Initialize the logging system with the given level and format.
///
/// `format` can be `"text"` (default human-readable) or `"json"` (structured JSON).
pub fn init_logging_with_format(level: &str, format: &str) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(level));

    if format == "json" {
        fmt()
            .json()
            .with_env_filter(filter)
            .with_target(true)
            .with_thread_ids(false)
            .with_line_number(true)
            .init();
    } else {
        fmt()
            .with_env_filter(filter)
            .with_target(true)
            .with_thread_ids(false)
            .with_line_number(true)
            .init();
    }
}
