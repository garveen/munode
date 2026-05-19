//! Hub Web API integration tests — migrated from `tests/integration/suites/web-api.test.ts`.

use anyhow::Result;
use munode_protocol::mumbleproto;
use serde_json::Value;

use crate::harness::{ClientConfig, cleanup_clients, create_clients, single_edge_env};

async fn get_json(port: u16, path: &str) -> Result<(u16, Value)> {
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let res = reqwest::get(&url).await?;
    let status = res.status().as_u16();
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, body))
}

async fn get_text(port: u16, path: &str) -> Result<(u16, String)> {
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let res = reqwest::get(&url).await?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    Ok((status, text))
}

#[tokio::test]
async fn test_health_returns_ok() -> Result<()> {
    let env = single_edge_env().await?;
    let (status, body) = get_json(env.web_api_port, "/api/health").await?;
    assert_eq!(status, 200);
    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
    Ok(())
}

#[tokio::test]
async fn test_status_returns_running_with_fields() -> Result<()> {
    let env = single_edge_env().await?;
    let (status, body) = get_json(env.web_api_port, "/api/status").await?;
    assert_eq!(status, 200);
    assert_eq!(body.get("status").and_then(Value::as_str), Some("running"));
    assert!(body.get("version").and_then(Value::as_str).is_some());
    assert!(body.get("uptime_secs").and_then(Value::as_u64).is_some());
    assert!(body.get("edge_count").and_then(Value::as_u64).is_some());
    let edge_count = body.get("edge_count").and_then(Value::as_u64).unwrap_or(0);
    assert!(edge_count >= 1, "expected at least 1 edge");
    Ok(())
}

#[tokio::test]
async fn test_edges_list_and_detail() -> Result<()> {
    let env = single_edge_env().await?;
    let (status, body) = get_json(env.web_api_port, "/api/edges").await?;
    assert_eq!(status, 200);
    let arr = body.as_array().expect("edges should be array");
    assert!(!arr.is_empty(), "should have at least 1 edge");
    let first = &arr[0];
    assert!(first.get("id").and_then(Value::as_u64).is_some());
    assert!(first.get("name").and_then(Value::as_str).is_some());
    assert!(first.get("port").and_then(Value::as_u64).is_some());
    assert!(first.get("is_online").and_then(Value::as_bool).is_some());

    let id = first.get("id").and_then(Value::as_u64).unwrap();
    let (status, detail) = get_json(env.web_api_port, &format!("/api/edges/{}", id)).await?;
    assert_eq!(status, 200);
    assert_eq!(detail.get("id").and_then(Value::as_u64), Some(id));

    let (status, _) = get_json(env.web_api_port, "/api/edges/999999").await?;
    assert_eq!(status, 404);
    Ok(())
}

#[tokio::test]
async fn test_stats_increases_when_client_connects() -> Result<()> {
    let env = single_edge_env().await?;
    let (_, before) = get_json(env.web_api_port, "/api/stats").await?;
    let before_sessions = before
        .get("total_sessions")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    let (_, after) = get_json(env.web_api_port, "/api/stats").await?;
    let after_sessions = after
        .get("total_sessions")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    assert!(
        after_sessions > before_sessions,
        "sessions should increase: {} -> {}",
        before_sessions,
        after_sessions
    );

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_topology_returns_edges_and_links() -> Result<()> {
    let env = single_edge_env().await?;
    let (status, body) = get_json(env.web_api_port, "/api/topology").await?;
    assert_eq!(status, 200);
    assert!(body.get("edges").and_then(Value::as_array).is_some());
    assert!(body.get("links").and_then(Value::as_array).is_some());
    Ok(())
}

#[tokio::test]
async fn test_dissemination_returns_edge_views() -> Result<()> {
    let env = single_edge_env().await?;
    let (status, body) = get_json(env.web_api_port, "/api/dissemination").await?;
    assert_eq!(status, 200);

    let edges = body
        .get("edges")
        .and_then(Value::as_array)
        .expect("dissemination edges should be array");
    assert!(!edges.is_empty(), "should expose at least one edge view");

    let first = &edges[0];
    let edge_id = first
        .get("edge_id")
        .and_then(Value::as_u64)
        .expect("edge_id missing");
    assert!(first.get("name").and_then(Value::as_str).is_some());
    assert!(first.get("source_count").and_then(Value::as_u64).is_some());
    assert!(first.get("sources").and_then(Value::as_array).is_some());

    let (status, detail) = get_json(
        env.web_api_port,
        &format!("/api/dissemination/edge/{}", edge_id),
    )
    .await?;
    assert_eq!(status, 200);
    assert_eq!(detail.get("edge_id").and_then(Value::as_u64), Some(edge_id));

    let (status, _) = get_json(env.web_api_port, "/api/dissemination/edge/999999").await?;
    assert_eq!(status, 404);
    Ok(())
}

#[tokio::test]
async fn test_voice_targets_endpoint_tracks_updates() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[ClientConfig::new("user1", 1), ClientConfig::new("user2", 1)],
    )
    .await?;

    let test_result = async {
        let sender = &clients[0];
        let target = &clients[1];
        let sender_session = sender.session_id().expect("sender session missing");
        let target_session = target.session_id().expect("target session missing");

        sender
            .voice()
            .set_target(
                1,
                vec![mumbleproto::voice_target::Target {
                    session: vec![target_session],
                    ..Default::default()
                }],
            )
            .await?;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let (status, body) = get_json(env.web_api_port, "/api/voice_targets").await?;
        assert_eq!(status, 200);
        let entries = body
            .get("voice_targets")
            .and_then(Value::as_array)
            .expect("voice_targets should be array");
        let entry = entries
            .iter()
            .find(|entry| {
                entry.get("client_session").and_then(Value::as_u64) == Some(sender_session as u64)
                    && entry.get("target_id").and_then(Value::as_u64) == Some(1)
            })
            .expect("missing sender voice target entry");

        let sessions = entry
            .pointer("/config/sessions")
            .and_then(Value::as_array)
            .expect("config.sessions should be array");
        assert!(
            sessions
                .iter()
                .any(|value| value.as_u64() == Some(target_session as u64)),
            "voice target should include configured receiver session"
        );

        let (status, body) = get_json(
            env.web_api_port,
            &format!("/api/voice_targets/session/{}", sender_session),
        )
        .await?;
        assert_eq!(status, 200);
        let entries = body
            .get("voice_targets")
            .and_then(Value::as_array)
            .expect("session voice_targets should be array");
        assert!(
            entries
                .iter()
                .any(|item| item.get("target_id").and_then(Value::as_u64) == Some(1)),
            "session-scoped endpoint should retain the configured target"
        );

        Ok(())
    }
    .await;

    cleanup_clients(clients).await;
    test_result
}

#[tokio::test]
async fn test_metrics_prometheus_format() -> Result<()> {
    let env = single_edge_env().await?;
    let (status, text) = get_text(env.web_api_port, "/metrics").await?;
    assert_eq!(status, 200);
    for needle in [
        "munode_hub_connected_edges",
        "munode_hub_total_sessions",
        "munode_hub_total_channels",
        "munode_hub_uptime_seconds",
        "# HELP munode_hub_connected_edges",
        "# TYPE munode_hub_connected_edges gauge",
    ] {
        assert!(text.contains(needle), "metrics should contain {}", needle);
    }
    // At least 1 connected edge
    let re = regex::Regex::new(r"(?m)^munode_hub_connected_edges (\d+)").unwrap();
    let cap = re.captures(&text).expect("connected_edges line missing");
    let n: u64 = cap[1].parse().unwrap();
    assert!(n >= 1);
    Ok(())
}

#[tokio::test]
async fn test_metrics_per_edge_labels() -> Result<()> {
    let env = single_edge_env().await?;
    let (_, text) = get_text(env.web_api_port, "/metrics").await?;
    for needle in [
        "munode_hub_edge_user_count",
        "munode_hub_edge_channel_count",
        "munode_hub_edge_online",
    ] {
        assert!(text.contains(needle), "metrics should contain {}", needle);
    }
    let re =
        regex::Regex::new(r#"munode_hub_edge_online\{edge_id="(\d+)",edge_name="([^"]+)"\} (\d+)"#)
            .unwrap();
    let cap = re.captures(&text).expect("per-edge label missing");
    assert!(cap[1].parse::<u64>().unwrap() > 0);
    assert!(!cap[2].is_empty());
    assert!(matches!(&cap[3], "0" | "1"));
    Ok(())
}

#[tokio::test]
async fn test_bans_endpoint() -> Result<()> {
    let env = single_edge_env().await?;
    let (status, body) = get_json(env.web_api_port, "/api/bans").await?;
    assert_eq!(status, 200);
    assert!(body.get("bans").and_then(Value::as_array).is_some());

    let url = format!("http://127.0.0.1:{}/api/bans/99999999", env.web_api_port);
    let res = reqwest::Client::new().delete(&url).send().await?;
    assert_eq!(res.status().as_u16(), 403);
    Ok(())
}

#[tokio::test]
async fn test_unknown_path_returns_404() -> Result<()> {
    let env = single_edge_env().await?;
    let (status, _) = get_text(env.web_api_port, "/api/nonexistent").await?;
    assert_eq!(status, 404);
    Ok(())
}
