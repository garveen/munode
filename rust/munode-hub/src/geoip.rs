/// GeoIP service for looking up geographic location from IP addresses.
///
/// Uses the MaxMind GeoLite2 database (MMDB format).  When the database path
/// is not configured, all lookups return `None` without error.
use std::net::IpAddr;
use std::path::Path;

use maxminddb::geoip2;
use tracing::{debug, warn};

/// GeoIP record returned for a single IP address.
#[derive(Debug, Clone)]
pub struct GeoLocation {
    /// ISO 3166-1 alpha-2 country code (e.g. "US", "DE").
    pub country_code: Option<String>,
    /// Human-readable country name (English).
    pub country_name: Option<String>,
    /// City name (if available in the database).
    pub city_name: Option<String>,
    /// Geographic continent code (e.g. "NA", "EU").
    pub continent_code: Option<String>,
}

/// GeoIP lookup service wrapping a MaxMind MMDB reader.
pub struct GeoIpService {
    reader: Option<maxminddb::Reader<Vec<u8>>>,
}

impl GeoIpService {
    /// Create a new GeoIpService.
    ///
    /// If `database_path` is empty or the file cannot be opened, a no-op service
    /// is created that returns `None` for all lookups.
    pub fn new(database_path: &str) -> Self {
        if database_path.is_empty() {
            return Self { reader: None };
        }
        if !Path::new(database_path).exists() {
            warn!("GeoIP database not found at '{}', GeoIP disabled", database_path);
            return Self { reader: None };
        }
        match maxminddb::Reader::open_readfile(database_path) {
            Ok(reader) => {
                debug!("GeoIP database loaded from '{}'", database_path);
                Self { reader: Some(reader) }
            }
            Err(e) => {
                warn!("Failed to open GeoIP database '{}': {}, GeoIP disabled", database_path, e);
                Self { reader: None }
            }
        }
    }

    /// Returns `true` if the GeoIP database is loaded and available.
    pub fn is_available(&self) -> bool {
        self.reader.is_some()
    }

    /// Look up geographic information for an IP address.
    ///
    /// Returns `None` if GeoIP is not available, the IP is private/loopback,
    /// or no record was found for the given IP.
    pub fn lookup(&self, ip: &IpAddr) -> Option<GeoLocation> {
        let reader = self.reader.as_ref()?;

        // Skip private/loopback addresses
        if ip.is_loopback() || is_private(ip) {
            return None;
        }

        // Try City database first, fall back to Country
        if let Ok(city) = reader.lookup::<geoip2::City>(*ip) {
            let country_code = city.country
                .as_ref()
                .and_then(|c| c.iso_code)
                .map(|s| s.to_string());
            let country_name = city.country
                .as_ref()
                .and_then(|c| c.names.as_ref())
                .and_then(|names| names.get("en"))
                .map(|s| s.to_string());
            let city_name = city.city
                .as_ref()
                .and_then(|c| c.names.as_ref())
                .and_then(|names| names.get("en"))
                .map(|s| s.to_string());
            let continent_code = city.continent
                .as_ref()
                .and_then(|c| c.code)
                .map(|s| s.to_string());
            return Some(GeoLocation { country_code, country_name, city_name, continent_code });
        }

        // Try Country database
        if let Ok(country) = reader.lookup::<geoip2::Country>(*ip) {
            let country_code = country.country
                .as_ref()
                .and_then(|c| c.iso_code)
                .map(|s| s.to_string());
            let country_name = country.country
                .as_ref()
                .and_then(|c| c.names.as_ref())
                .and_then(|names| names.get("en"))
                .map(|s| s.to_string());
            let continent_code = country.continent
                .as_ref()
                .and_then(|c| c.code)
                .map(|s| s.to_string());
            return Some(GeoLocation {
                country_code,
                country_name,
                city_name: None,
                continent_code,
            });
        }

        None
    }
}

/// Check if an IP address is in a private range.
fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_link_local() || v4.is_broadcast()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unspecified()
                || v6.segments()[0] == 0xfc00 // fc00::/7 ULA
                || v6.segments()[0] == 0xfe80 // fe80::/10 link-local
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn test_geoip_service_no_db() {
        let svc = GeoIpService::new("");
        assert!(!svc.is_available());
        let ip = IpAddr::from_str("8.8.8.8").unwrap();
        assert!(svc.lookup(&ip).is_none());
    }

    #[test]
    fn test_geoip_service_nonexistent_db() {
        let svc = GeoIpService::new("/nonexistent/path.mmdb");
        assert!(!svc.is_available());
    }

    #[test]
    fn test_private_ip_skipped() {
        let svc = GeoIpService::new(""); // No DB needed for this test
        let private_ip = IpAddr::from_str("192.168.1.1").unwrap();
        assert!(is_private(&private_ip));
        let loopback = IpAddr::from_str("127.0.0.1").unwrap();
        assert!(loopback.is_loopback());
    }

    #[test]
    fn test_public_ip_not_private() {
        let public_ip = IpAddr::from_str("8.8.8.8").unwrap();
        assert!(!is_private(&public_ip));
        assert!(!public_ip.is_loopback());
    }
}
