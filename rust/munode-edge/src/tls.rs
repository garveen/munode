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
    // is verified using the installed crypto provider to ensure the client owns
    // the corresponding private key.
    use rustls::server::danger::{ClientCertVerifier, ClientCertVerified};
    
    #[derive(Debug)]
    struct MumbleClientCertVerifier {
        /// Signature verification algorithms from the installed crypto provider,
        /// used to verify TLS CertificateVerify messages (proves the client
        /// owns the private key of their presented certificate).
        algs: rustls::crypto::WebPkiSupportedAlgorithms,
    }

    impl MumbleClientCertVerifier {
        fn new() -> Result<Self> {
            // Obtain the signature verification algorithms from the already-installed
            // crypto provider.  main() installs aws_lc_rs before calling EdgeServer::run(),
            // so get_default() should always succeed here.
            let algs = rustls::crypto::CryptoProvider::get_default()
                .ok_or_else(|| anyhow::anyhow!(
                    "No default crypto provider installed. \
                     Call rustls::crypto::aws_lc_rs::default_provider().install_default() \
                     before starting the Edge server."
                ))?
                .signature_verification_algorithms;
            Ok(Self { algs })
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
            // Verify the TLS 1.2 CertificateVerify signature using the crypto
            // provider's algorithms.  This confirms the client owns the private
            // key of their presented certificate without requiring a CA chain.
            rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algs)
        }
        
        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algs)
        }
        
        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.algs.supported_schemes()
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
