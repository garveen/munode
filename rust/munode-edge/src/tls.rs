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

    // Use a verifier that requests but doesn't require client certificates,
    // and accepts self-signed certificates (Murmur/Mumble-compatible behavior).
    // Clients are identified by their certificate hash; the TLS handshake signature
    // is still verified to ensure the client owns the corresponding private key.
    use rustls::server::danger::{ClientCertVerifier, ClientCertVerified};
    
    #[derive(Debug)]
    struct MumbleClientCertVerifier {
        /// Delegate verifier used only for TLS handshake signature verification.
        /// This ensures clients actually own the private key of their presented certificate,
        /// while still allowing self-signed certificates (no CA chain validation).
        sig_delegate: Arc<dyn ClientCertVerifier>,
    }

    impl MumbleClientCertVerifier {
        fn new() -> Result<Self> {
            // Build a delegate verifier with an empty root store and
            // allow_unauthenticated() so that clients without certificates are
            // also accepted.  We only use this delegate for the
            // verify_tls12_signature / verify_tls13_signature calls.
            let roots = Arc::new(rustls::RootCertStore::empty());
            let sig_delegate = rustls::server::WebPkiClientVerifier::builder(roots)
                .allow_unauthenticated()
                .build()
                .context("Failed to build signature-verification delegate")?;
            Ok(Self { sig_delegate })
        }
    }
    
    impl ClientCertVerifier for MumbleClientCertVerifier {
        fn offer_client_auth(&self) -> bool {
            true // Request client certificate
        }
        
        fn client_auth_mandatory(&self) -> bool {
            false // But don't require it (Mumble allows connecting without a cert)
        }
        
        fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
            // Return empty list — we accept any certificate, including self-signed ones.
            &[]
        }
        
        fn verify_client_cert(
            &self,
            _end_entity: &rustls::pki_types::CertificateDer<'_>,
            _intermediates: &[rustls::pki_types::CertificateDer<'_>],
            _now: rustls::pki_types::UnixTime,
        ) -> Result<ClientCertVerified, rustls::Error> {
            // Accept any client certificate, including self-signed ones.
            // This is intentional Mumble/Murmur-compatible behaviour: client
            // certificates are used solely for persistent identity (cert hash),
            // not for CA-chain authentication.  Application-level auth
            // (username/password, tokens, Lua scripts) is used for actual access control.
            Ok(ClientCertVerified::assertion())
        }
        
        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            // Verify the TLS CertificateVerify signature so that we confirm the
            // client actually owns the private key of the presented certificate.
            // This prevents certificate impersonation even when CA chain validation
            // is skipped.
            self.sig_delegate.verify_tls12_signature(message, cert, dss)
        }
        
        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            self.sig_delegate.verify_tls13_signature(message, cert, dss)
        }
        
        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.sig_delegate.supported_verify_schemes()
        }
    }
    
    let config = rustls::ServerConfig::builder()
        .with_client_cert_verifier(Arc::new(MumbleClientCertVerifier::new()?))
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
