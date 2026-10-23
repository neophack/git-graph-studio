//! TLS and the link (docs/ggs-remote-plan.md §7.4–§7.5): a local ECDSA P-256 CA generated on
//! first run (ten years), a server certificate signed by it (397 days, SAN = every LAN
//! address, localhost, the host name and `<host>.local`), re-signed with the same CA when
//! the address set changes or expiry nears — so a phone that trusted the CA once never has
//! to again. Also: the LAN address list, the links, the iOS profile and QR codes.

use base64::Engine;
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, SanType,
};
use std::net::IpAddr;
use std::path::PathBuf;

use crate::paths::{write_private, Paths};

const SERVER_DAYS: i64 = 397;
const RENEW_BEFORE_DAYS: i64 = 30;

pub struct TlsFiles {
    pub ca_pem: PathBuf,
    pub ca_key: PathBuf,
    pub ca_cn: PathBuf,
    pub server_pem: PathBuf,
    pub server_key: PathBuf,
    pub server_meta: PathBuf,
}

impl TlsFiles {
    pub fn of(paths: &Paths) -> TlsFiles {
        let dir = paths.tls_dir();
        TlsFiles {
            ca_pem: dir.join("ca.pem"),
            ca_key: dir.join("ca.key"),
            ca_cn: dir.join("ca.cn"),
            server_pem: dir.join("server.pem"),
            server_key: dir.join("server.key"),
            server_meta: dir.join("server.json"),
        }
    }
}

/// Days since the Unix epoch → (year, month, day), the civil calendar (Howard Hinnant's).
fn civil_from_days(days: i64) -> (i32, u8, u8) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    let y = (yoe + era * 400 + i64::from(m <= 2)) as i32;
    (y, m, d)
}

fn today_days() -> i64 {
    (crate::util::now_secs() / 86_400) as i64
}

/// Set a certificate's validity window, in days relative to today.
fn set_validity(params: &mut CertificateParams, from: i64, to: i64) {
    let (y, m, d) = civil_from_days(today_days() + from);
    params.not_before = rcgen::date_time_ymd(y, m, d);
    let (y, m, d) = civil_from_days(today_days() + to);
    params.not_after = rcgen::date_time_ymd(y, m, d);
}

/// Every non-loopback, non-link-local IPv4 address, private ranges first (§7.4).
pub fn lan_addresses() -> Vec<String> {
    let mut addrs: Vec<std::net::Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|iface| match iface.ip() {
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() => {
                Some(v4)
            }
            _ => None,
        })
        .collect();
    addrs.sort_by_key(|ip| {
        let o = ip.octets();
        let rank = if o[0] == 192 && o[1] == 168 {
            0
        } else if o[0] == 10 {
            1
        } else if o[0] == 172 && (16..32).contains(&o[1]) {
            2
        } else if o[0] == 100 && (64..128).contains(&o[1]) {
            3
        } else {
            4
        };
        (rank, o)
    });
    addrs.dedup();
    addrs.into_iter().map(|ip| ip.to_string()).collect()
}

pub fn hostname() -> Option<String> {
    let from_env = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok();
    let name = from_env
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        })?;
    let name = name.trim().trim_end_matches(".local").to_lowercase();
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    valid.then_some(name)
}

pub fn hostname_local() -> Option<String> {
    hostname().map(|h| format!("{h}.local"))
}

/// The hosts a link may name for a listener on `bind` (the effective bind): a loopback
/// listener — plain HTTP is loopback-only (§16) — answers 127.0.0.1 alone, a wildcard one
/// every LAN address plus the mDNS name, a specific address just itself. A LAN address in
/// the link of a listener that never accepts on it is a link that cannot work.
pub fn link_hosts(bind: &str) -> Vec<String> {
    if crate::config::is_loopback(bind) {
        return vec!["127.0.0.1".into()];
    }
    let wildcard = bind
        .parse::<IpAddr>()
        .map(|ip| ip.is_unspecified())
        .unwrap_or(false);
    if !wildcard {
        return vec![bind.to_owned()];
    }
    let mut hosts = lan_addresses();
    hosts.extend(hostname_local());
    if hosts.is_empty() {
        hosts.push("127.0.0.1".into());
    }
    hosts
}

pub fn link_for(scheme: &str, host: &str, port: u16) -> String {
    let default = (scheme == "https" && port == 443) || (scheme == "http" && port == 80);
    if default {
        format!("{scheme}://{host}/")
    } else {
        format!("{scheme}://{host}:{port}/")
    }
}

fn ca_params(cn: &str) -> CertificateParams {
    let mut params = CertificateParams::new(Vec::<String>::new()).expect("empty SAN list is valid");
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, cn);
    dn.push(DnType::OrganizationName, "GGS Remote");
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params
}

/// Load or create the CA; answers its re-usable signer (params rebuilt over the stored key —
/// same DN, same key identifier, so certificates it signs chain to the installed CA).
fn ca(files: &TlsFiles) -> Result<(rcgen::Certificate, KeyPair), String> {
    let existing = std::fs::read_to_string(&files.ca_key)
        .ok()
        .zip(std::fs::read_to_string(&files.ca_cn).ok());
    if let Some((key_pem, cn)) = existing {
        if files.ca_pem.exists() {
            let key = KeyPair::from_pem(&key_pem).map_err(|e| format!("ca key: {e}"))?;
            let cert = ca_params(cn.trim())
                .self_signed(&key)
                .map_err(|e| format!("ca: {e}"))?;
            return Ok((cert, key));
        }
    }
    let key = KeyPair::generate().map_err(|e| format!("ca key: {e}"))?;
    let cn = format!(
        "GGS Remote Local CA {}",
        hostname().unwrap_or_else(|| "pc".into())
    );
    let mut params = ca_params(&cn);
    set_validity(&mut params, -1, 3650);
    let cert = params.self_signed(&key).map_err(|e| format!("ca: {e}"))?;
    write_private(&files.ca_key, key.serialize_pem().as_bytes()).map_err(|e| e.to_string())?;
    write_private(&files.ca_cn, cn.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::write(&files.ca_pem, cert.pem()).map_err(|e| e.to_string())?;
    crate::info!("generated the local CA ({cn})");
    // Rebuild the signer the same way a later start will, so both paths sign identically.
    let cert = ca_params(&cn)
        .self_signed(&key)
        .map_err(|e| format!("ca: {e}"))?;
    Ok((cert, key))
}

#[derive(serde::Serialize, serde::Deserialize, Default, PartialEq, Debug)]
struct ServerMeta {
    sans: Vec<String>,
    expires_day: i64,
}

fn wanted_sans() -> Vec<String> {
    let mut sans = vec!["localhost".to_owned(), "127.0.0.1".to_owned()];
    sans.extend(lan_addresses());
    if let Some(h) = hostname() {
        sans.push(h.clone());
        sans.push(format!("{h}.local"));
    }
    sans.sort();
    sans.dedup();
    sans
}

/// Make sure a current server certificate exists; answers whether it was (re)issued.
pub fn ensure_server_cert(paths: &Paths) -> Result<bool, String> {
    let files = TlsFiles::of(paths);
    let sans = wanted_sans();
    let meta: ServerMeta = std::fs::read(&files.server_meta)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let fresh = meta.sans == sans
        && meta.expires_day - today_days() > RENEW_BEFORE_DAYS
        && files.server_pem.exists()
        && files.server_key.exists()
        && files.ca_pem.exists();
    if fresh {
        return Ok(false);
    }
    let (ca_cert, ca_key) = ca(&files)?;
    let mut params = CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
    params.subject_alt_names = sans
        .iter()
        .filter_map(|s| match s.parse::<IpAddr>() {
            Ok(ip) => Some(SanType::IpAddress(ip)),
            Err(_) => s.clone().try_into().ok().map(SanType::DnsName),
        })
        .collect();
    let mut dn = DistinguishedName::new();
    dn.push(
        DnType::CommonName,
        hostname_local().unwrap_or_else(|| "ggs-remote".into()),
    );
    params.distinguished_name = dn;
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    let expires = today_days() + SERVER_DAYS - 1;
    set_validity(&mut params, -1, SERVER_DAYS - 1);
    let key = KeyPair::generate().map_err(|e| e.to_string())?;
    let cert = params
        .signed_by(&key, &ca_cert, &ca_key)
        .map_err(|e| e.to_string())?;
    // The chain the server presents: its own certificate, then the CA.
    let ca_pem = std::fs::read_to_string(&files.ca_pem).map_err(|e| e.to_string())?;
    std::fs::write(&files.server_pem, format!("{}{}", cert.pem(), ca_pem))
        .map_err(|e| e.to_string())?;
    write_private(&files.server_key, key.serialize_pem().as_bytes()).map_err(|e| e.to_string())?;
    let meta = ServerMeta {
        sans,
        expires_day: expires,
    };
    std::fs::write(
        &files.server_meta,
        serde_json::to_vec(&meta).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    crate::info!("issued the server certificate for {:?}", meta.sans);
    Ok(true)
}

/// The PEM pair the TLS listener loads: (chain, key).
pub fn server_pems(paths: &Paths) -> Result<(Vec<u8>, Vec<u8>), String> {
    let files = TlsFiles::of(paths);
    let chain = std::fs::read(&files.server_pem).map_err(|e| e.to_string())?;
    let key = std::fs::read(&files.server_key).map_err(|e| e.to_string())?;
    Ok((chain, key))
}

pub fn ca_pem(paths: &Paths) -> Option<Vec<u8>> {
    std::fs::read(TlsFiles::of(paths).ca_pem).ok()
}

fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .skip_while(|l| !l.starts_with("-----BEGIN"))
        .skip(1)
        .take_while(|l| !l.starts_with("-----END"))
        .collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

/// SHA-256 of the CA certificate, colon-separated hex — what the pair page asks the user to
/// compare after installing it.
pub fn ca_fingerprint(paths: &Paths) -> String {
    let Some(der) = ca_pem(paths).and_then(|pem| pem_to_der(&String::from_utf8_lossy(&pem))) else {
        return String::new();
    };
    crate::util::sha256(&der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// The iOS configuration profile carrying the CA as a root payload (§7.5).
pub fn mobileconfig(paths: &Paths) -> Option<Vec<u8>> {
    let der = pem_to_der(&String::from_utf8_lossy(&ca_pem(paths)?))?;
    let data = base64::engine::general_purpose::STANDARD.encode(&der);
    let uuid = |seed: &str| {
        let h = crate::util::sha256(&[seed.as_bytes(), &der].concat());
        let x = crate::util::hex(&h[..16]).to_uppercase();
        format!(
            "{}-{}-{}-{}-{}",
            &x[0..8],
            &x[8..12],
            &x[12..16],
            &x[16..20],
            &x[20..32]
        )
    };
    let profile = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>ggs-remote-ca.cer</string>
      <key>PayloadContent</key><data>{data}</data>
      <key>PayloadDescription</key><string>Trusts the GGS Remote server on this PC.</string>
      <key>PayloadDisplayName</key><string>GGS Remote Local CA</string>
      <key>PayloadIdentifier</key><string>dev.ggs.remote.ca</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>{inner}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>GGS Remote</string>
  <key>PayloadIdentifier</key><string>dev.ggs.remote</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>{outer}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
"#,
        inner = uuid("inner"),
        outer = uuid("outer"),
    );
    Some(profile.into_bytes())
}

pub fn qr_svg(text: &str) -> Option<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .build(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_hosts_follow_the_bind() {
        assert_eq!(link_hosts("127.0.0.1"), vec!["127.0.0.1".to_owned()]);
        assert_eq!(link_hosts("localhost"), vec!["127.0.0.1".to_owned()]);
        assert_eq!(link_hosts("192.168.7.9"), vec!["192.168.7.9".to_owned()]);
        let wildcard = link_hosts("0.0.0.0");
        assert!(!wildcard.is_empty());
        assert!(wildcard.iter().all(|h| h != "0.0.0.0"), "{wildcard:?}");
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(20_737), (2026, 10, 11));
    }

    #[test]
    fn certificates_are_issued_once_and_chain_to_one_ca() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        assert!(ensure_server_cert(&paths).unwrap());
        assert!(!ensure_server_cert(&paths).unwrap());
        let fingerprint = ca_fingerprint(&paths);
        assert_eq!(fingerprint.split(':').count(), 32);
        let (chain, key) = server_pems(&paths).unwrap();
        let chain = String::from_utf8(chain).unwrap();
        assert_eq!(chain.matches("BEGIN CERTIFICATE").count(), 2);
        assert!(String::from_utf8(key).unwrap().contains("PRIVATE KEY"));
        // Forcing a re-issue keeps the CA.
        std::fs::remove_file(TlsFiles::of(&paths).server_meta).unwrap();
        assert!(ensure_server_cert(&paths).unwrap());
        assert_eq!(ca_fingerprint(&paths), fingerprint);
        let profile = String::from_utf8(mobileconfig(&paths).unwrap()).unwrap();
        assert!(profile.contains("com.apple.security.root"));
    }

    #[test]
    fn links_and_qr() {
        assert_eq!(
            link_for("https", "192.168.1.20", 47615),
            "https://192.168.1.20:47615/"
        );
        assert_eq!(
            link_for("https", "remote.example.com", 443),
            "https://remote.example.com/"
        );
        assert!(qr_svg("https://192.168.1.20:47615/")
            .unwrap()
            .starts_with("<?xml"));
    }
}
