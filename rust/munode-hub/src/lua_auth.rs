//! Embedded Lua 5.4 authentication engine.
//!
//! When `auth.lua_script` is set in the Hub config, this engine executes the
//! script for every authentication attempt. The script runs inside a persistent
//! Lua VM so it can maintain its own caches, connection pools, and state across
//! requests.
//!
//! # Injected globals
//!
//! The engine injects the following Rust-backed functions into the Lua globals:
//!
//! ```lua
//! -- Perform a synchronous HTTP POST request.
//! -- body_table  : table  – serialised to JSON as the request body.
//! -- headers     : table? – optional { ["Header-Name"] = "value" } overrides.
//! --                        "Content-Type: application/json" is set by default.
//! -- Returns { status = number, ok = boolean, json = table|nil, body = string|nil }
//! http_post(url, body_table [, headers_table]) -> response_table
//! ```
//!
//! # Required Lua contract
//!
//! The script must define a top-level `authenticate(req)` function.
//!
//! `req` fields (all optional/nil if not provided by the client):
//! - `username`         string
//! - `password`         string
//! - `session_id`       integer
//! - `tokens`           array of strings
//! - `server_id`        integer
//! - `ip`               string
//! - `ip_version`       string  ("IPv4" or "IPv6")
//! - `release`          string
//! - `version`          integer|nil  (encoded Mumble version number)
//! - `os`               string
//! - `osversion`        string
//! - `certificate_hash` string|nil
//!
//! Return value must be a table:
//! - On success: `{ success=true, user_id=N, username="...", display_name="...", groups={...} }`
//! - On failure: `{ success=false, reason="...", reject_type=N }`
//!   (`reject_type` follows Mumble's Reject enum; 3 = WrongUserPW, 8 = AuthenticatorFail)

use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use mlua::{Lua, LuaSerdeExt, Table, Value};
use tracing::debug;
use serde::{Deserialize, Serialize};

/// Authentication request passed into the Lua `authenticate(req)` function.
#[derive(Debug, Clone, Serialize)]
pub struct LuaAuthRequest {
    pub username: String,
    pub password: String,
    pub session_id: u32,
    pub tokens: Vec<String>,
    pub server_id: u32,
    pub ip: String,
    pub ip_version: String,
    pub release: String,
    pub version: Option<u32>,
    pub os: String,
    pub osversion: String,
    pub certificate_hash: Option<String>,
}

/// Authentication result returned from the Lua `authenticate(req)` function.
#[derive(Debug, Deserialize)]
pub struct LuaAuthResponse {
    pub success: bool,
    pub user_id: Option<u32>,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub groups: Option<Vec<String>>,
    pub reason: Option<String>,
    /// Mumble Reject enum value.  3 = WrongUserPW, 8 = AuthenticatorFail.
    pub reject_type: Option<u32>,
}

/// Persistent Lua VM that exposes a single `authenticate` entry-point.
///
/// Thread-safety is provided by a `Mutex<Lua>`.  Concurrent authentication
/// requests serialise at the lock, so for high-volume servers consider
/// pairing this with the WebSocket auth service or HTTP URL options instead.
///
/// Designed to be stored as `Arc<LuaAuthEngine>` inside `HubState` and called
/// from `tokio::task::spawn_blocking`.
pub struct LuaAuthEngine {
    lua: Mutex<Lua>,
}

// mlua with the `send` feature makes `Lua: Send`, and `Mutex<Lua>` is therefore
// `Send + Sync`.  The explicit impls below are a belt-and-braces declaration so
// the compiler catches any regression in the feature flags.
unsafe impl Send for LuaAuthEngine {}
unsafe impl Sync for LuaAuthEngine {}

impl LuaAuthEngine {
    /// Compile and initialise a Lua auth engine from an inline script string.
    ///
    /// Returns an error if the script contains syntax errors, raises a runtime
    /// error during top-level execution, or does not define `authenticate`.
    pub fn new(script: &str) -> Result<Self> {
        let lua = Lua::new();

        // ------------------------------------------------------------------
        // Inject http_post(url, body_table [, headers_table]) -> response
        // ------------------------------------------------------------------
        let http_post = lua
            .create_function(
                |lua_ctx, (url, body, headers): (String, Table, Option<Table>)| {
                    // Serialise body table → serde_json::Value
                    let body_val: serde_json::Value =
                        lua_ctx.from_value(Value::Table(body)).map_err(|e| {
                            mlua::Error::RuntimeError(format!(
                                "http_post: body serialization failed: {e}"
                            ))
                        })?;

                    // Build the ureq request
                    let mut req = ureq::post(&url).set("Content-Type", "application/json");

                    // Apply optional caller-supplied headers (may override Content-Type)
                    if let Some(headers_tbl) = headers {
                        for pair in headers_tbl.pairs::<String, String>() {
                            let (k, v) = pair?;
                            req = req.set(&k, &v);
                        }
                    }

                    // Execute and collect status + body
                    let (status_code, is_ok, body_text) = match req.send_json(&body_val) {
                        Ok(resp) => {
                            let code = resp.status();
                            let text = resp.into_string().unwrap_or_default();
                            (code, true, text)
                        }
                        Err(ureq::Error::Status(code, resp)) => {
                            let text = resp.into_string().unwrap_or_default();
                            (code, false, text)
                        }
                        Err(ureq::Error::Transport(e)) => {
                            return Err(mlua::Error::RuntimeError(format!(
                                "http_post: transport error: {e}"
                            )));
                        }
                    };

                    debug!(
                        url = %url,
                        status = status_code,
                        ok = is_ok,
                        body = %body_text,
                        "http_post response"
                    );

                    // Build Lua result table
                    let result = lua_ctx.create_table()?;
                    result.set("status", status_code)?;
                    result.set("ok", is_ok)?;

                    if let Ok(json_val) =
                        serde_json::from_str::<serde_json::Value>(&body_text)
                    {
                        result.set("json", lua_ctx.to_value(&json_val)?)?;
                    } else {
                        result.set("body", body_text)?;
                    }

                    Ok(result)
                },
            )
            .context("Failed to create Lua http_post function")?;

        lua.globals()
            .set("http_post", http_post)
            .context("Failed to register http_post in Lua globals")?;

        // ------------------------------------------------------------------
        // Execute user script (top-level, defines authenticate + any helpers)
        // ------------------------------------------------------------------
        lua.load(script)
            .exec()
            .context("Failed to execute Lua auth script")?;

        // Verify the required entry-point exists
        let _: mlua::Function = lua
            .globals()
            .get("authenticate")
            .context("Lua auth script must define a global 'authenticate(req)' function")?;

        Ok(Self {
            lua: Mutex::new(lua),
        })
    }

    /// Call `authenticate(req)` synchronously.
    ///
    /// Intended to be called from `tokio::task::spawn_blocking` so the async
    /// executor is not blocked during external HTTP calls made from Lua.
    pub fn authenticate_sync(&self, req: LuaAuthRequest) -> Result<LuaAuthResponse> {
        let lua = self
            .lua
            .lock()
            .map_err(|_| anyhow!("Lua mutex is poisoned"))?;

        let lua_req = lua
            .to_value(&req)
            .context("Failed to convert LuaAuthRequest to Lua value")?;

        let func: mlua::Function = lua
            .globals()
            .get("authenticate")
            .context("authenticate function not found in Lua globals")?;

        let result = func
            .call::<Value>(lua_req)
            .context("Lua authenticate() raised an error")
            .inspect_err(|e| debug!("Lua authenticate() error detail: {:?}", e))?;

        let resp: LuaAuthResponse = lua
            .from_value(result)
            .context("Failed to deserialise authenticate() return value into LuaAuthResponse")?;

        Ok(resp)
    }
}
