use std::sync::Arc;

use tracing_subscriber::{fmt, reload, EnvFilter, Registry};
use tracing_subscriber::prelude::*;

/// Handle for dynamically reloading the active log-level filter at runtime.
///
/// Obtained from [`init_logging_with_reload`].  The handle is cheap to clone
/// (backed by an `Arc`).  Log-format changes (text ↔ JSON) still require a
/// process restart because the format layer cannot be swapped after the global
/// subscriber has been installed.
#[derive(Clone)]
pub struct LogReloadHandle {
    handle: Arc<reload::Handle<EnvFilter, Registry>>,
}

impl LogReloadHandle {
    /// Update the active log filter to the given `level` string.
    ///
    /// `level` is parsed as an [`EnvFilter`] directive (e.g. `"debug"`,
    /// `"mymodule=trace"`).  If the `RUST_LOG` environment variable is set it
    /// takes precedence over the supplied value, matching the behaviour of the
    /// initial [`init_logging_with_reload`] call.
    pub fn reload_level(&self, level: &str) {
        let new_filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new(level));
        if let Err(e) = self.handle.reload(new_filter) {
            // Only fails if the subscriber was dropped, which cannot happen for
            // a global subscriber installed via `try_init`.
            tracing::warn!("Failed to reload log filter: {}", e);
        }
    }
}

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
///
/// Uses `try_init()` internally and silently ignores failures (e.g. a global
/// subscriber is already registered).  Prefer [`init_logging_with_reload`] when
/// runtime log-level changes are required.
pub fn init_logging_with_format(level: &str, format: &str) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(level));

    if format == "json" {
        let _ = fmt()
            .json()
            .with_env_filter(filter)
            .with_target(true)
            .with_thread_ids(false)
            .with_line_number(true)
            .try_init();
    } else {
        let _ = fmt()
            .with_env_filter(filter)
            .with_target(true)
            .with_thread_ids(false)
            .with_line_number(true)
            .try_init();
    }
}

/// Initialize logging with a reloadable filter and return a [`LogReloadHandle`].
///
/// This is the preferred entry point for long-running processes that support
/// runtime log-level changes (e.g. via SIGHUP config reload).  Call this
/// **once** from `main` before spawning any tasks and keep the returned handle
/// to reload the level later.
///
/// * `level`  – initial log level / filter directive (e.g. `"info"`).
/// * `format` – `"text"` or `"json"`.
///
/// If a global subscriber was already registered (e.g. in tests) the returned
/// handle will be a no-op; log output continues through the existing subscriber.
pub fn init_logging_with_reload(level: &str, format: &str) -> LogReloadHandle {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(level));

    // The explicit `Registry` type parameter is required so that the reload
    // handle has a concrete type before the layer is composed with the
    // subscriber.  At runtime the phantom `S` parameter does not affect the
    // handle's behaviour — only `EnvFilter` (the layer type `L`) matters.
    let (reload_layer, reload_handle): (reload::Layer<EnvFilter, Registry>, _) =
        reload::Layer::new(filter);

    if format == "json" {
        let _ = tracing_subscriber::registry()
            .with(reload_layer)
            .with(
                fmt::Layer::new()
                    .json()
                    .with_target(true)
                    .with_thread_ids(false)
                    .with_line_number(true),
            )
            .try_init();
    } else {
        let _ = tracing_subscriber::registry()
            .with(reload_layer)
            .with(
                fmt::Layer::new()
                    .with_target(true)
                    .with_thread_ids(false)
                    .with_line_number(true),
            )
            .try_init();
    }

    LogReloadHandle { handle: Arc::new(reload_handle) }
}
