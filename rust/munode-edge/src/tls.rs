use std::fs;
use std::io::BufReader;
use std::sync::Arc;

use anyhow::{Context, Result};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::TlsAcceptor;

use munode_common::config::TlsConfig;

/// Create a TLS acceptor from the edge configuration.
pub fn create_tls_acceptor(tls_config: &TlsConfig) -> Result<TlsAcceptor> {
    let certs = load_certs(&tls_config.cert)
        .context("Failed to load TLS certificate")?;
    let key = load_private_key(&tls_config.key)
        .context("Failed to load TLS private key")?;

    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("Failed to build TLS server config")?;

    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Load certificates from a PEM file.
fn load_certs(path: &str) -> Result<Vec<CertificateDer<'static>>> {
    let file = fs::File::open(path)
        .with_context(|| format!("Cannot open certificate file: {}", path))?;
    let mut reader = BufReader::new(file);
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .context("Failed to parse certificates")?;
    if certs.is_empty() {
        anyhow::bail!("No certificates found in {}", path);
    }
    Ok(certs)
}

/// Load a private key from a PEM file.
fn load_private_key(path: &str) -> Result<PrivateKeyDer<'static>> {
    let file = fs::File::open(path)
        .with_context(|| format!("Cannot open key file: {}", path))?;
    let mut reader = BufReader::new(file);
    let key = rustls_pemfile::private_key(&mut reader)
        .context("Failed to parse private key")?
        .ok_or_else(|| anyhow::anyhow!("No private key found in {}", path))?;
    Ok(key)
}
