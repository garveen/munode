//! PROXY Protocol v1/v2 header parsing.
use anyhow::{Context, Result, anyhow};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use tokio::io::AsyncReadExt;

/// Magic bytes that mark the start of a PROXY Protocol v2 header.
const PROXY_V2_MAGIC: &[u8; 12] = b"\r\n\r\n\0\r\nQUIT\n";

/// A trusted-proxy allow-list entry.  Either a single IP address or a CIDR
/// block (subnet + prefix length, with the prefix bits canonicalised).
#[derive(Clone, Debug)]
pub(super) enum TrustedPeer {
    Ip(IpAddr),
    Cidr { network: IpAddr, prefix: u8 },
}

/// Parse a list of allow-list entries (IPs or CIDR blocks like `"10.0.0.0/8"`).
pub(super) fn parse_trusted_proxy_list(entries: &[String]) -> Result<Vec<TrustedPeer>> {
    let mut out = Vec::with_capacity(entries.len());
    for raw in entries {
        let entry = raw.trim();
        if entry.is_empty() {
            continue;
        }
        if let Some((addr, prefix)) = entry.split_once('/') {
            let network: IpAddr = addr
                .trim()
                .parse()
                .with_context(|| format!("invalid IP in trusted_proxy_ips entry {:?}", raw))?;
            let prefix: u8 = prefix
                .trim()
                .parse()
                .with_context(|| format!("invalid prefix in trusted_proxy_ips entry {:?}", raw))?;
            let max = if network.is_ipv4() { 32 } else { 128 };
            if prefix > max {
                return Err(anyhow!(
                    "prefix /{} too large for {} in trusted_proxy_ips entry {:?}",
                    prefix,
                    network,
                    raw
                ));
            }
            out.push(TrustedPeer::Cidr {
                network: mask_addr(network, prefix),
                prefix,
            });
        } else {
            let ip: IpAddr = entry
                .parse()
                .with_context(|| format!("invalid IP in trusted_proxy_ips entry {:?}", raw))?;
            out.push(TrustedPeer::Ip(ip));
        }
    }
    Ok(out)
}

/// Apply a CIDR prefix mask to an address so equality compares only the
/// network portion.
fn mask_addr(addr: IpAddr, prefix: u8) -> IpAddr {
    match addr {
        IpAddr::V4(v4) => {
            let bits = u32::from(v4);
            let mask = if prefix == 0 {
                0u32
            } else {
                u32::MAX << (32 - prefix)
            };
            IpAddr::V4(Ipv4Addr::from(bits & mask))
        }
        IpAddr::V6(v6) => {
            let bits = u128::from(v6);
            let mask = if prefix == 0 {
                0u128
            } else {
                u128::MAX << (128 - prefix)
            };
            IpAddr::V6(Ipv6Addr::from(bits & mask))
        }
    }
}

/// Test whether `peer` is permitted to send PROXY Protocol headers.
///
/// `allow_list` of `None` means "no allow-list configured" — keep the
/// pre-hardening behaviour of trusting every peer.  An empty (`Some(&[])`)
/// list trusts no peer.
pub(super) fn peer_is_trusted_proxy(peer: IpAddr, allow_list: Option<&[TrustedPeer]>) -> bool {
    let list = match allow_list {
        Some(list) => list,
        None => return true,
    };
    for entry in list {
        match entry {
            TrustedPeer::Ip(ip) => {
                if *ip == peer {
                    return true;
                }
                // Also match IPv4 addresses tunnelled through IPv6 (`::ffff:1.2.3.4`).
                if let (IpAddr::V6(v6), IpAddr::V4(v4)) = (peer, *ip)
                    && v6.to_ipv4_mapped() == Some(v4) {
                        return true;
                    }
                if let (IpAddr::V6(v6), IpAddr::V4(v4)) = (*ip, peer)
                    && v6.to_ipv4_mapped() == Some(v4) {
                        return true;
                    }
            }
            TrustedPeer::Cidr { network, prefix } => {
                let masked = mask_addr(peer, *prefix);
                if masked == *network {
                    return true;
                }
                if let (IpAddr::V4(v4), IpAddr::V6(_v6)) = (peer, *network) {
                    // CIDR is IPv6 but peer is plain IPv4 — also test the
                    // IPv4-mapped form.
                    let mapped: IpAddr = IpAddr::V6(v4.to_ipv6_mapped());
                    if mask_addr(mapped, *prefix) == *network {
                        return true;
                    }
                }
                if let (IpAddr::V6(v6), IpAddr::V4(_v4)) = (peer, *network)
                    && let Some(v4) = v6.to_ipv4_mapped()
                        && mask_addr(IpAddr::V4(v4), *prefix) == *network {
                            return true;
                        }
            }
        }
    }
    false
}

/// Read and parse a PROXY Protocol header (v1 or v2) from a TCP stream.
///
/// Returns `Some(addr)` with the real client address, or `None` when the proxy
/// header carries `UNKNOWN` / `LOCAL` (fall back to the TCP peer address in
/// that case).  Returns an error when the stream does not begin with a valid
/// PROXY Protocol header.
///
/// This function reads **exactly** the header bytes from the stream so that
/// the subsequent TLS handshake sees the original TLS ClientHello immediately
/// after.
pub(super) async fn read_proxy_protocol_addr(
    stream: &mut tokio::net::TcpStream,
) -> Result<Option<SocketAddr>> {
    // Peek at up to 12 bytes (v2 magic length) without consuming the stream,
    // so that plain TLS connections are completely unaffected.
    let mut peek_buf = [0u8; 12];
    let n = stream
        .peek(&mut peek_buf)
        .await
        .context("Failed to peek for PROXY Protocol header")?;

    if n >= 6 && &peek_buf[..6] == b"PROXY " {
        // ── PROXY Protocol v1 (text) ─────────────────────────────────────
        // Consume the 6 bytes we peeked above.
        let mut sig = [0u8; 6];
        stream.read_exact(&mut sig).await?;
        // Format: "PROXY <proto> <src-ip> <dst-ip> <src-port> <dst-port>\r\n"
        // Maximum total length: 108 bytes.
        let mut line: Vec<u8> = b"PROXY ".to_vec();
        let mut byte = [0u8; 1];
        loop {
            stream
                .read_exact(&mut byte)
                .await
                .context("Failed to read PROXY Protocol v1 header")?;
            line.push(byte[0]);
            if line.ends_with(b"\r\n") {
                break;
            }
            if line.len() > 108 {
                return Err(anyhow!("PROXY Protocol v1 header exceeds 108 bytes"));
            }
        }
        parse_proxy_v1(&line)
    } else if n >= 12 && &peek_buf[..12] == PROXY_V2_MAGIC {
        // ── PROXY Protocol v2 (binary) ────────────────────────────────────
        // Consume the 12-byte magic we already peeked.
        let mut magic = [0u8; 12];
        stream.read_exact(&mut magic).await?;
        // Read the 4-byte fixed header: ver/cmd + fam/proto + addr_len (u16 BE).
        let mut fixed = [0u8; 4];
        stream
            .read_exact(&mut fixed)
            .await
            .context("Failed to read PROXY Protocol v2 fixed header")?;

        let ver_cmd = fixed[0];
        let fam_proto = fixed[1];
        let addr_len = u16::from_be_bytes([fixed[2], fixed[3]]) as usize;

        // PROXY Protocol v2: address payload is at most ~216 bytes for
        // AF_INET6 (36 bytes) plus the maximum defined TLV extensions.
        // Cap here to prevent a crafted header from forcing a large heap
        // allocation before we have read a single byte of address data.
        if addr_len > 512 {
            return Err(anyhow!(
                "PROXY Protocol v2 address payload too large: {} bytes (max 512)",
                addr_len
            ));
        }

        let mut addr_buf = vec![0u8; addr_len];
        if addr_len > 0 {
            stream
                .read_exact(&mut addr_buf)
                .await
                .context("Failed to read PROXY Protocol v2 address payload")?;
        }

        parse_proxy_v2(ver_cmd, fam_proto, &addr_buf)
    } else {
        // No PROXY Protocol signature detected — this is a direct (non-proxied)
        // connection.  The peeked bytes remain in the receive buffer so the TLS
        // handshake will see them unmodified.
        Ok(None)
    }
}

/// Parse a PROXY Protocol v1 header line (including trailing `\r\n`).
pub(super) fn parse_proxy_v1(line: &[u8]) -> Result<Option<SocketAddr>> {
    let s = std::str::from_utf8(line).context("PROXY Protocol v1 header is not valid UTF-8")?;
    let s = s.trim_end_matches("\r\n");
    let parts: Vec<&str> = s.split_ascii_whitespace().collect();

    if parts.len() < 2 || parts[0] != "PROXY" {
        return Err(anyhow!("Malformed PROXY Protocol v1 header: {:?}", s));
    }

    // "PROXY UNKNOWN ..." — upstream cannot determine the original address.
    if parts[1] == "UNKNOWN" {
        return Ok(None);
    }

    // "PROXY TCP4 <src-ip> <dst-ip> <src-port> <dst-port>"
    // "PROXY TCP6 <src-ip> <dst-ip> <src-port> <dst-port>"
    if parts.len() != 6 {
        return Err(anyhow!(
            "PROXY Protocol v1 header has wrong number of fields: {:?}",
            s
        ));
    }

    let src_ip: IpAddr = parts[2]
        .parse()
        .context("Invalid source IP in PROXY Protocol v1 header")?;
    let src_port: u16 = parts[4]
        .parse()
        .context("Invalid source port in PROXY Protocol v1 header")?;

    Ok(Some(SocketAddr::new(src_ip, src_port)))
}

/// Parse a PROXY Protocol v2 header (after the magic and fixed header bytes).
pub(super) fn parse_proxy_v2(
    ver_cmd: u8,
    fam_proto: u8,
    addrs: &[u8],
) -> Result<Option<SocketAddr>> {
    let version = ver_cmd >> 4;
    let command = ver_cmd & 0x0F;

    if version != 2 {
        return Err(anyhow!("Unsupported PROXY Protocol version: {}", version));
    }

    // Command 0 = LOCAL (health-checks, loopback): ignore the address information.
    if command == 0 {
        return Ok(None);
    }

    if command != 1 {
        return Err(anyhow!(
            "Unsupported PROXY Protocol v2 command: {}",
            command
        ));
    }

    let family = fam_proto >> 4; // 1 = IPv4, 2 = IPv6, 3 = Unix

    match family {
        1 => {
            // AF_INET: src_addr(4) + dst_addr(4) + src_port(2) + dst_port(2)
            if addrs.len() < 12 {
                return Err(anyhow!(
                    "PROXY Protocol v2 IPv4 address payload too short: {} bytes",
                    addrs.len()
                ));
            }
            let src_ip = Ipv4Addr::new(addrs[0], addrs[1], addrs[2], addrs[3]);
            let src_port = u16::from_be_bytes([addrs[8], addrs[9]]);
            Ok(Some(SocketAddr::new(IpAddr::V4(src_ip), src_port)))
        }
        2 => {
            // AF_INET6: src_addr(16) + dst_addr(16) + src_port(2) + dst_port(2)
            if addrs.len() < 36 {
                return Err(anyhow!(
                    "PROXY Protocol v2 IPv6 address payload too short: {} bytes",
                    addrs.len()
                ));
            }
            let src: [u8; 16] = addrs[..16]
                .try_into()
                .context("Failed to copy IPv6 source address")?;
            let src_ip = Ipv6Addr::from(src);
            let src_port = u16::from_be_bytes([addrs[32], addrs[33]]);
            Ok(Some(SocketAddr::new(IpAddr::V6(src_ip), src_port)))
        }
        _ => {
            // AF_UNSPEC or AF_UNIX: no usable IP address.
            Ok(None)
        }
    }
}
