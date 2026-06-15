//! Per-endpoint quality scoring and runtime send-path selection.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use munode_common::config::EndpointScoringConfig;

use crate::state::{PeerQualityMap, PeerQualityState};

pub struct EndpointSelector {
    config: EndpointScoringConfig,
    active: Mutex<HashMap<u32, ActiveEndpoint>>,
    quality: Arc<tokio::sync::Mutex<PeerQualityMap>>,
    now_fn: fn() -> u64,
}

#[derive(Debug, Clone)]
struct ActiveEndpoint {
    endpoint_id: Option<String>,
    activated_at_ms: u64,
}

impl EndpointSelector {
    pub fn new(
        config: EndpointScoringConfig,
        quality: Arc<tokio::sync::Mutex<PeerQualityMap>>,
    ) -> Self {
        Self {
            config,
            active: Mutex::new(HashMap::new()),
            quality,
            now_fn: default_now_ms,
        }
    }

    /// Return the currently active endpoint ID.  Sync — safe on the hot path.
    pub fn active_endpoint(&self, target_edge_id: u32) -> Option<String> {
        let guard = self.active.lock().ok()?;
        guard
            .get(&target_edge_id)
            .and_then(|a| a.endpoint_id.clone())
    }

    /// Recompute scores and potentially switch.  Async — NOT for the hot path.
    pub async fn recompute(&self, target_edge_id: u32) {
        let now_ms = (self.now_fn)();
        let pq = self.quality.lock().await;

        let candidates: Vec<(&(u32, Option<String>), &PeerQualityState)> = pq
            .iter()
            .filter(|((eid, _), _)| *eid == target_edge_id)
            .collect();

        if candidates.is_empty() {
            return;
        }

        let mut scored: Vec<(&Option<String>, f32)> = candidates
            .iter()
            .map(|((_, epid), state)| {
                let score = compute_score(state, &self.config, now_ms);
                (epid, score)
            })
            .collect();

        scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

        let best = &scored[0];
        let best_id = best.0.clone();
        let best_score = best.1;

        let mut active = match self.active.lock() {
            Ok(g) => g,
            Err(_) => return,
        };

        let current = active.get(&target_edge_id);

        let should_switch = match current {
            Some(c) if c.endpoint_id == best_id => false,
            Some(c) => {
                let dwell_ms = now_ms.saturating_sub(c.activated_at_ms);
                if dwell_ms < self.config.min_dwell_ms {
                    return;
                }
                let cur_score = Self::lookup_score(&scored, &c.endpoint_id);
                best_score + self.config.switch_margin < cur_score
            }
            None => true,
        };

        if should_switch {
            active.insert(
                target_edge_id,
                ActiveEndpoint {
                    endpoint_id: best_id,
                    activated_at_ms: now_ms,
                },
            );
        }
    }

    fn lookup_score(scored: &[(&Option<String>, f32)], endpoint_id: &Option<String>) -> f32 {
        scored
            .iter()
            .find(|(id, _)| *id == endpoint_id)
            .map(|(_, s)| *s)
            .unwrap_or(f32::MAX)
    }
}

pub fn compute_score(state: &PeerQualityState, config: &EndpointScoringConfig, now_ms: u64) -> f32 {
    let loss = state.packet_loss().unwrap_or(0.0);
    let jitter = state.jitter_ms().unwrap_or(0.0);

    let staleness = match state.last_report_ms {
        Some(last) if now_ms.saturating_sub(last) > config.feedback_stale_ms => {
            config.stale_feedback_penalty
        }
        None if state.samples.is_empty() => return f32::MAX,
        _ => 0.0,
    };

    let probes_sent = state.probe_sample_count() as u32 + state.pending_pings.len() as u32;
    let pongs_received = state.probe_success_count() as u32;
    let local_failures = if probes_sent > 0 && pongs_received == 0 {
        config.local_failure_penalty
    } else {
        0.0
    };

    config.loss_weight * loss + config.jitter_weight * jitter + local_failures + staleness
}

fn default_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_state_returns_max() {
        let state = PeerQualityState::default();
        let config = EndpointScoringConfig::default();
        let score = compute_score(&state, &config, 0);
        assert_eq!(score, f32::MAX);
    }

    #[test]
    fn perfect_quality_scores_low() {
        let mut state = PeerQualityState::default();
        state.push_sample(
            crate::state::PeerQualitySample {
                expected_packets: 1,
                received_packets: 1,
                rtt_ms: Some(5.0),
                source: crate::state::PeerQualitySampleSource::Probe,
            },
            30,
        );
        state.push_probe_rtt_sample(5.0, 30);
        state.last_report_ms = Some(1000);
        let config = EndpointScoringConfig::default();
        let score = compute_score(&state, &config, 1500);
        assert!(score < 10.0, "score={}", score);
    }

    #[test]
    fn high_loss_scores_high() {
        let mut state = PeerQualityState::default();
        state.push_sample(
            crate::state::PeerQualitySample {
                expected_packets: 10,
                received_packets: 5,
                rtt_ms: Some(10.0),
                source: crate::state::PeerQualitySampleSource::Probe,
            },
            30,
        );
        state.push_probe_rtt_sample(10.0, 30);
        state.last_report_ms = Some(1000);
        let config = EndpointScoringConfig::default();
        let score = compute_score(&state, &config, 1500);
        assert!(score > 400.0, "score={}", score);
    }

    #[test]
    fn stale_feedback_gets_penalty() {
        let mut state = PeerQualityState::default();
        state.push_sample(
            crate::state::PeerQualitySample {
                expected_packets: 1,
                received_packets: 1,
                rtt_ms: Some(5.0),
                source: crate::state::PeerQualitySampleSource::Probe,
            },
            30,
        );
        state.last_report_ms = Some(1000);
        let config = EndpointScoringConfig::default();
        let score = compute_score(&state, &config, 5000);
        assert!(score >= config.stale_feedback_penalty, "score={}", score);
    }
}
