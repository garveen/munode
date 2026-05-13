//! Embedded Lua 5.4 authentication engine.
//!
//! When `auth.lua_script` is set in the Hub config, this engine executes the
//! script for every authentication attempt.  The script runs inside a single
//! persistent Lua VM that maintains its own caches, timers, and state across
//! requests.
//!
//! # Concurrency model
//!
//! A **single** Lua VM handles all concurrent authentication requests.  Each
//! call to `authenticate` creates a Lua coroutine; when the coroutine calls an
//! async Lua function (e.g. `http_post`) it yields back to Tokio, releasing the
//! internal Lua lock.  Hundreds of HTTP requests therefore run concurrently with
//! no serialisation.  The Lua lock is re-acquired only for Lua code execution
//! windows (typically <1 ms), so even 500 simultaneous logins complete well
//! within the Edge's 30-second RPC timeout.
//!
//! # Injected globals
//!
//! ```lua
//! -- Async HTTP POST.  Returns { status, ok, json?, body? }.
//! http_post(url, body_table [, headers_table]) -> response_table
//!
//! -- Async HTTP GET.  Returns { status, ok, json?, body? }.
//! http_get(url [, headers_table]) -> response_table
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

use anyhow::{Context, Result, anyhow};
use mlua::{Lua, LuaSerdeExt, Table, Value};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::debug;

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

/// Embedded Lua 5.4 authentication engine backed by a single persistent VM.
///
/// Each `authenticate` call spawns a Lua coroutine.  When the script calls
/// `http_post` or `http_get`, the coroutine yields to Tokio so that all
/// in-flight HTTP requests proceed concurrently.  The Lua lock is only held
/// during brief Lua execution windows — never during I/O waits.
///
/// Designed to be stored as `Arc<LuaAuthEngine>` inside `HubState`.
pub struct LuaAuthEngine {
    lua: Lua,
}

// mlua's `send` feature makes `Lua: Send + Sync`, so `LuaAuthEngine` is
// automatically `Send + Sync`.  This assertion catches accidental regressions.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<LuaAuthEngine>();
};

impl LuaAuthEngine {
    /// Compile and initialise a Lua auth engine from an inline script string.
    ///
    /// Returns an error if the script contains syntax errors, raises a runtime
    /// error during top-level execution, or does not define `authenticate`.
    pub fn new(script: &str) -> Result<Self> {
        let lua = Lua::new();
        // One shared HTTP client; `reqwest::Client` is Arc-backed and cheap to clone.
        let client = Client::new();

        // ------------------------------------------------------------------
        // Inject http_post(url, body_table [, headers_table]) -> response
        // ------------------------------------------------------------------
        {
            let client = client.clone();
            let http_post = lua
                .create_async_function(
                    move |lua_ctx, (url, body, headers): (String, Table, Option<Table>)| {
                        // Serialise Lua values to owned Rust types before the async
                        // boundary so no mlua references are held across `.await`.
                        let body_result = lua_ctx
                            .from_value::<serde_json::Value>(Value::Table(body))
                            .map_err(|e| {
                                mlua::Error::RuntimeError(format!(
                                    "http_post: body serialization failed: {e}"
                                ))
                            });
                        let headers_result = match headers {
                            Some(h) => h
                                .pairs::<String, String>()
                                .collect::<mlua::Result<Vec<_>>>()
                                .map(Some),
                            None => Ok(None),
                        };
                        let client = client.clone();
                        async move {
                            let body_bytes = serde_json::to_vec(&body_result?).map_err(|e| {
                                mlua::Error::RuntimeError(format!(
                                    "http_post: JSON encode failed: {e}"
                                ))
                            })?;
                            let mut builder = client
                                .post(&url)
                                .header("content-type", "application/json")
                                .body(body_bytes);
                            for (k, v) in headers_result?.unwrap_or_default() {
                                builder = builder.header(k, v);
                            }
                            build_lua_response(&lua_ctx, builder.send().await, "http_post", &url)
                                .await
                        }
                    },
                )
                .context("Failed to create Lua http_post function")?;
            lua.globals()
                .set("http_post", http_post)
                .context("Failed to register http_post in Lua globals")?;
        }

        // ------------------------------------------------------------------
        // Inject http_get(url [, headers_table]) -> response
        // ------------------------------------------------------------------
        {
            let client = client.clone();
            let http_get = lua
                .create_async_function(move |lua_ctx, (url, headers): (String, Option<Table>)| {
                    let headers_result = match headers {
                        Some(h) => h
                            .pairs::<String, String>()
                            .collect::<mlua::Result<Vec<_>>>()
                            .map(Some),
                        None => Ok(None),
                    };
                    let client = client.clone();
                    async move {
                        let mut builder = client.get(&url);
                        for (k, v) in headers_result?.unwrap_or_default() {
                            builder = builder.header(k, v);
                        }
                        build_lua_response(&lua_ctx, builder.send().await, "http_get", &url).await
                    }
                })
                .context("Failed to create Lua http_get function")?;
            lua.globals()
                .set("http_get", http_get)
                .context("Failed to register http_get in Lua globals")?;
        }

        // ------------------------------------------------------------------
        // Execute user script (top-level, defines authenticate + any helpers)
        // ------------------------------------------------------------------
        lua.load(script)
            .exec()
            .context("Failed to execute Lua auth script")?;

        // Verify the required entry-point exists.
        let _: mlua::Function = lua
            .globals()
            .get("authenticate")
            .context("Lua auth script must define a global 'authenticate(req)' function")?;

        Ok(Self { lua })
    }

    /// Call `authenticate(req)` asynchronously.
    ///
    /// Creates a Lua coroutine per request.  Concurrent calls share the single
    /// VM: the Lua lock is released whenever the coroutine is waiting for HTTP,
    /// so hundreds of requests can be in-flight simultaneously.
    pub async fn authenticate(&self, req: LuaAuthRequest) -> Result<LuaAuthResponse> {
        let lua_req = self
            .lua
            .to_value(&req)
            .map_err(|e| anyhow!(e).context("Failed to convert LuaAuthRequest to Lua value"))?;

        let func: mlua::Function =
            self.lua.globals().get("authenticate").map_err(|e| {
                anyhow!(e).context("authenticate function not found in Lua globals")
            })?;

        let result_val: Value = func
            .call_async(lua_req)
            .await
            .inspect_err(|e| debug!("Lua authenticate() error detail: {:?}", e))
            .map_err(|e| anyhow!(e).context("Lua authenticate() raised an error"))?;

        self.lua
            .from_value(result_val)
            .map_err(|e| anyhow!(e).context("Failed to deserialise authenticate() return value"))
    }
}

/// Convert a `reqwest` response into a Lua result table `{ status, ok, json?, body? }`.
async fn build_lua_response(
    lua_ctx: &Lua,
    send_result: Result<reqwest::Response, reqwest::Error>,
    method: &str,
    url: &str,
) -> mlua::Result<mlua::Table> {
    let resp = send_result
        .map_err(|e| mlua::Error::RuntimeError(format!("{method}: transport error: {e}")))?;
    let status_code = resp.status().as_u16();
    let is_ok = resp.status().is_success();
    let body_text = resp.text().await.map_err(|e| {
        mlua::Error::RuntimeError(format!("{method}: failed to read response body: {e}"))
    })?;

    debug!(
        url = %url,
        status = status_code,
        ok = is_ok,
        body = %body_text,
        "{method} response"
    );

    let result = lua_ctx.create_table()?;
    result.set("status", status_code)?;
    result.set("ok", is_ok)?;
    if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&body_text) {
        result.set("json", lua_ctx.to_value(&json_val)?)?;
    } else {
        result.set("body", body_text)?;
    }
    Ok(result)
}
