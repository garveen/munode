//! Token-bucket rate limiter for per-session message rate limiting.

use std::time::Instant;

/// A simple token-bucket rate limiter.
///
/// `rate` tokens are refilled per second, up to `burst` total.
/// Each call to `try_consume` attempts to consume one token.
/// Returns `true` if the token was available (allowed), `false` if rate-limited.
///
/// Uses `f64` internally to avoid precision loss with large burst values or
/// long durations between refills.
#[derive(Debug, Clone)]
pub struct TokenBucket {
    /// Refill rate: tokens per second.
    rate: f64,
    /// Maximum tokens (burst capacity).
    burst: f64,
    /// Current token count.
    tokens: f64,
    /// Last time tokens were refilled.
    last_refill: Instant,
}

impl TokenBucket {
    /// Create a new token bucket with the given rate (tokens/sec) and burst capacity.
    pub fn new(rate: f32, burst: u32) -> Self {
        Self {
            rate: rate as f64,
            burst: burst as f64,
            tokens: burst as f64,
            last_refill: Instant::now(),
        }
    }

    /// Try to consume one token. Returns `true` if allowed, `false` if rate-limited.
    pub fn try_consume(&mut self) -> bool {
        self.refill();
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Refill tokens based on elapsed time.
    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.rate).min(self.burst);
        self.last_refill = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn test_token_bucket_burst() {
        let mut tb = TokenBucket::new(1.0, 3);
        // Should allow burst of 3
        assert!(tb.try_consume());
        assert!(tb.try_consume());
        assert!(tb.try_consume());
        // 4th should fail
        assert!(!tb.try_consume());
    }

    #[test]
    fn test_token_bucket_refill() {
        let mut tb = TokenBucket::new(10.0, 1);
        // Use the one token
        assert!(tb.try_consume());
        assert!(!tb.try_consume());
        // Wait for refill
        sleep(Duration::from_millis(150));
        // Should have ~1.5 tokens now, so 1 consume should succeed
        assert!(tb.try_consume());
    }

    #[test]
    fn test_zero_rate_unlimited() {
        // Rate 0 = unlimited (we check this at use site)
        let mut tb = TokenBucket::new(0.0, u32::MAX);
        for _ in 0..1000 {
            assert!(tb.try_consume());
        }
    }
}
