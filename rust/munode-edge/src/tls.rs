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

    // Use a verifier that requests but doesn't require client certificates
    // This allows optional client certificate authentication (Mumble behavior)
    use rustls::server::danger::{ClientCertVerifier, ClientCertVerified};
    
    #[derive(Debug)]
    struct OptionalClientCertVerifier;
    
    impl ClientCertVerifier for OptionalClientCertVerifier {
        fn offer_client_auth(&self) -> bool {
            true // Request client certificate
        }
        
        fn client_auth_mandatory(&self) -> bool {
            false // But don't require it
        }
        
        fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
            // Return empty list - we accept any certificate
            &[]
        }
        
        fn verify_client_cert(
            &self,
            _end_entity: &rustls::pki_types::CertificateDer<'_>,
            _intermediates: &[rustls::pki_types::CertificateDer<'_>],
            _now: rustls::pki_types::UnixTime,
        ) -> Result<ClientCertVerified, rustls::Error> {
            // Accept any client certificate (we only use it for identification, not authentication)
            Ok(ClientCertVerified::assertion())
        }
        
        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &rustls::pki_types::CertificateDer<'_>,
            _dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }
        
        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &rustls::pki_types::CertificateDer<'_>,
            _dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }
        
        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            vec![
                rustls::SignatureScheme::RSA_PKCS1_SHA256,
                rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
                rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
                rustls::SignatureScheme::ED25519,
            ]
        }
    }
    
    let config = rustls::ServerConfig::builder()
        .with_client_cert_verifier(Arc::new(OptionalClientCertVerifier))
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
