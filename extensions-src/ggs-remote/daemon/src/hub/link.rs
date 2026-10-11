//! The outbound tunnel (docs/ggs-remote-plan.md §20.4): one WebSocket to the Hub, the
//! key-proof handshake, then a pump. Everything the Hub forwards — browser frames for a
//! session, HTTP request heads — is routed to that session's task; everything the daemon
//! answers goes back stamped with the session the Hub assigned.

use ed25519_dalek::Signer;
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

use super::identity;
use super::msg::{ConnClose, TAuth, THello, PROTO};
use super::{HubClient, Settings};
use crate::state::Daemon;
use crate::ws::frame::{ty, Frame};

/// Why a tunnel ended — the retry loop reads this (§20.4).
pub enum End {
    Replaced,
    Rejected(String),
    Dropped {
        was_online: bool,
    },
    /// The settings changed under this tunnel: the caller loops straight around.
    Stopped,
}

/// How long a tunnel may stay silent before the client gives up on it (three heartbeats).
const SILENCE_LIMIT: Duration = Duration::from_secs(75);
const HEARTBEAT: Duration = Duration::from_secs(25);

/// The tunnel's shared half: the writer every session task answers through, and the
/// per-session inbound pumps the router feeds.
pub struct Tunnel {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    sessions: Mutex<HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>>,
}

impl Tunnel {
    /// One downlink message for a session: stamp its frames and queue them for the Hub.
    pub fn send_session(&self, session: u32, mut message: Vec<u8>) -> bool {
        if !crate::ws::frame::stamp_session(&mut message, session) {
            return false;
        }
        self.tx.send(message).is_ok()
    }

    /// Tunnel control (CONN_CLOSE for a browser the daemon kicked, T_PONG) rides session 0.
    pub fn send_control(&self, frame: &Frame) -> bool {
        self.tx.send(frame.encode()).is_ok()
    }

    /// Register (CONN_OPEN/HTTP_REQ) or replace a session's inbound pump.
    pub fn bind(&self, session: u32, pump: mpsc::UnboundedSender<Vec<u8>>) {
        self.sessions.lock().unwrap().insert(session, pump);
    }

    /// Whether a session's pump is bound — an HTTP request's body chunks carry the same
    /// frame type as its head and must route, not open a second task.
    pub fn is_bound(&self, session: u32) -> bool {
        self.sessions.lock().unwrap().contains_key(&session)
    }

    /// The browser side of this session went away — drop its pump; its task drains and ends.
    pub fn unbind(&self, session: u32) {
        self.sessions.lock().unwrap().remove(&session);
    }

    /// The daemon is closing a browser session itself (a kick's 4401): tell the Hub, which
    /// closes the browser's WebSocket with the same code (§20.4 CONN_CLOSE, PC→Hub).
    pub fn close_session(&self, session: u32, code: u16, reason: &str) {
        self.unbind(session);
        let _ = self.send_control(&Frame::msgpack(
            ty::CONN_CLOSE,
            &ConnClose {
                session,
                code,
                reason: reason.to_owned(),
            },
        ));
    }

    fn route(&self, session: u32, frame: Frame) {
        let bytes = frame.encode();
        let pump = self.sessions.lock().unwrap().get(&session).cloned();
        if let Some(pump) = pump {
            let _ = pump.send(bytes);
        }
    }
}

/// Serve one tunnel until it ends. `generation` is the settings revision it was started
/// under; a newer one stops it cleanly.
pub async fn serve(
    daemon: Arc<Daemon>,
    client: Arc<HubClient>,
    settings: &Settings,
    generation: u64,
) -> End {
    match run(daemon, client, settings, generation).await {
        Ok(end) => end,
        Err(e) => {
            crate::warn!("hub tunnel: {e}");
            End::Dropped { was_online: false }
        }
    }
}

async fn run(
    daemon: Arc<Daemon>,
    client: Arc<HubClient>,
    settings: &Settings,
    generation: u64,
) -> Result<End, String> {
    let (key, _fresh) = identity::load_or_create(&daemon.paths).map_err(|e| e.to_string())?;
    let uuid = identity::uuid_for(&key.verifying_key().to_bytes());

    let url = tunnel_url(&settings.url)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "User-Agent",
        format!("ggs-remote/{}", env!("CARGO_PKG_VERSION"))
            .parse()
            .map_err(|_| "header")?,
    );
    let connector = tls_connector(settings)?;
    let (ws, _response) =
        tokio_tungstenite::connect_async_tls_with_config(request, None, false, connector)
            .await
            .map_err(|e| format!("connect: {e}"))?;
    let (mut sink, mut stream) = ws.split();

    // T_HELLO → T_CHALLENGE → T_AUTH → T_READY (§20.3).
    let hello = THello {
        pubkey: key.verifying_key().to_bytes().to_vec(),
        join_key: (!settings.join_key.is_empty()).then(|| settings.join_key.clone()),
        daemon_version: env!("CARGO_PKG_VERSION").into(),
        proto: PROTO,
    };
    sink.send(Message::Binary(
        Frame::msgpack(ty::T_HELLO, &hello).encode().into(),
    ))
    .await
    .map_err(|e| e.to_string())?;
    let challenge = first_frame(&mut stream)
        .await?
        .filter(|f| f.ty == ty::T_CHALLENGE)
        .and_then(|f| f.decode_msgpack::<super::msg::TChallenge>())
        .ok_or("the Hub sent no challenge")?;
    let signature = key.sign(&identity::auth_message(&challenge.nonce, &challenge.host));
    sink.send(Message::Binary(
        Frame::msgpack(
            ty::T_AUTH,
            &TAuth {
                sig: signature.to_bytes().to_vec(),
            },
        )
        .encode()
        .into(),
    ))
    .await
    .map_err(|e| e.to_string())?;
    let ready_frame = first_frame(&mut stream).await?;
    if let Some(rejected) = ready_frame
        .as_ref()
        .and_then(|f| (f.ty == ty::T_REJECTED).then_some(f))
        .and_then(|f| f.decode_msgpack::<super::msg::TRejected>())
    {
        return Ok(End::Rejected(rejected.reason));
    }
    let ready = ready_frame
        .filter(|f| f.ty == ty::T_READY)
        .and_then(|f| f.decode_msgpack::<super::msg::TReady>())
        .ok_or("the Hub sent no T_READY")?;
    // The UUID must be the one this key derives to — the Hub computing another means the
    // two sides disagree about the identity (§20.3 step 2).
    if ready.uuid != uuid {
        return Err(format!(
            "the Hub derived {} for this key (locally {uuid})",
            ready.uuid
        ));
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let tunnel = Arc::new(Tunnel {
        tx: tx.clone(),
        sessions: Mutex::new(HashMap::new()),
    });
    client.status.send_replace(Status::Online {
        uuid: uuid.clone(),
        public_base: ready.public_base.clone(),
    });
    crate::info!("hub tunnel online: {} ({})", ready.public_base, uuid);

    let writer = tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });

    let online_since = Instant::now();
    let mut restart = std::pin::pin!(client.restart.notified());
    let mut beat = tokio::time::interval(HEARTBEAT);
    beat.tick().await; // immediate
    let mut last_heard = Instant::now();
    let end = loop {
        let outcome = tokio::select! {
            message = stream.next() => {
                let Some(Ok(message)) = message else { break End::Dropped { was_online: true } };
                last_heard = Instant::now();
                let Message::Binary(bytes) = message else { continue };
                let Ok(frames) = Frame::decode_all(&bytes) else {
                    crate::warn!("hub tunnel: undecodable frame, dropping the tunnel");
                    break End::Dropped { was_online: true };
                };
                let mut outcome = Inbound::Ok;
                for frame in frames {
                    outcome = match inbound(&daemon, &tunnel, frame) {
                        Inbound::Ok => outcome,
                        other => other,
                    };
                    if outcome != Inbound::Ok {
                        break;
                    }
                }
                match outcome {
                    Inbound::Ok => Inbound::Ok,
                    Inbound::Replaced => break End::Replaced,
                    Inbound::Poison => {
                        crate::warn!("hub tunnel: protocol violation, dropping the tunnel");
                        break End::Dropped { was_online: true };
                    }
                }
            }
            _ = beat.tick() => {
                if last_heard.elapsed() > SILENCE_LIMIT {
                    crate::warn!("hub tunnel: the Hub went quiet");
                    break End::Dropped { was_online: true };
                }
                if !tunnel.send_control(&ping_frame()) {
                    break End::Dropped { was_online: true };
                }
                Inbound::Ok
            }
            _ = &mut restart => {
                if client.generation() != generation {
                    break End::Stopped;
                }
                // A spurious wake (someone else's connect): re-arm and carry on.
                restart.as_mut().set(client.restart.notified());
                Inbound::Ok
            }
        };
        let _ = outcome;
    };
    let was_online = online_since.elapsed() >= Duration::from_secs(60);
    writer.abort();
    Ok(match end {
        End::Dropped { .. } => End::Dropped { was_online },
        other => other,
    })
}

/// A heartbeat frame: RAW, session 0.
fn ping_frame() -> Frame {
    Frame::new(ty::T_PING, crate::ws::frame::Enc::Raw, Vec::new())
}

#[derive(PartialEq, Eq)]
enum Inbound {
    Ok,
    Replaced,
    Poison,
}

/// One frame from the Hub.
fn inbound(daemon: &Arc<Daemon>, tunnel: &Arc<Tunnel>, frame: Frame) -> Inbound {
    if frame.ty == ty::T_PING {
        let _ = tunnel.send_control(&Frame::new(
            ty::T_PONG,
            crate::ws::frame::Enc::Raw,
            Vec::new(),
        ));
        return Inbound::Ok;
    }
    if frame.ty == ty::T_REPLACED {
        return Inbound::Replaced;
    }
    if frame.ty == ty::CONN_OPEN {
        let Some(open) = frame.decode_msgpack::<super::msg::ConnOpen>() else {
            return Inbound::Poison;
        };
        // Bind before the task runs: the frames that follow (a HELLO, a body) must not
        // route past an unbound session.
        let (pump_tx, pump_rx) = tokio::sync::mpsc::unbounded_channel();
        tunnel.bind(open.session, pump_tx);
        let daemon = daemon.clone();
        let tunnel = tunnel.clone();
        tokio::spawn(async move {
            super::session::ws(daemon, tunnel, open, pump_rx).await;
        });
        return Inbound::Ok;
    }
    if frame.ty == ty::HTTP_REQ && !tunnel.is_bound(frame.session) {
        let Some(head) = frame.decode_msgpack::<super::msg::HttpReq>() else {
            return Inbound::Poison;
        };
        let session = frame.session;
        let (pump_tx, pump_rx) = tokio::sync::mpsc::unbounded_channel();
        tunnel.bind(session, pump_tx);
        let daemon = daemon.clone();
        let tunnel = tunnel.clone();
        tokio::spawn(async move {
            super::session::http(daemon, tunnel, session, head, pump_rx).await;
        });
        return Inbound::Ok;
    }
    if frame.ty == ty::CONN_CLOSE {
        if let Some(close) = frame.decode_msgpack::<ConnClose>() {
            tunnel.unbind(close.session);
        }
        return Inbound::Ok;
    }
    if frame.session != 0 {
        tunnel.route(frame.session, frame);
    }
    Inbound::Ok
}

async fn first_frame(
    stream: &mut futures_util::stream::SplitStream<
        WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    >,
) -> Result<Option<Frame>, String> {
    match tokio::time::timeout(Duration::from_secs(10), stream.next()).await {
        Ok(Some(Ok(Message::Binary(bytes)))) => Ok(Frame::decode_all(&bytes)
            .ok()
            .and_then(|frames| frames.into_iter().next())),
        Ok(Some(Ok(_))) => Ok(None),
        Ok(Some(Err(e))) => Err(e.to_string()),
        Ok(None) => Err("the Hub closed the tunnel during the handshake".into()),
        Err(_) => Err("the handshake timed out".into()),
    }
}

/// `https://host` → `wss://host/tunnel` (and http → ws); a url that already names the
/// tunnel path is taken as-is.
fn tunnel_url(url: &str) -> Result<String, String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or("the server address needs a scheme")?;
    let ws_scheme = match scheme {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        other => return Err(format!("unsupported scheme: {other}")),
    };
    if rest.contains("/tunnel") {
        return Ok(format!("{ws_scheme}://{rest}"));
    }
    Ok(format!("{ws_scheme}://{rest}/tunnel"))
}

/// The Mozilla root store (bundled, no platform verifier): a public Hub's certificate
/// chains here; a self-signed one pins with `fp=` instead.
fn web_roots() -> rustls::RootCertStore {
    rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    }
}

fn tls_connector(settings: &Settings) -> Result<Option<Connector>, String> {
    if !settings.url.starts_with("https://") && !settings.url.starts_with("wss://") {
        return Ok(None); // plain ws: tests and a front proxy already inside a tunnel
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?;
    let config = if settings.fingerprint.is_empty() {
        builder
            .with_root_certificates(web_roots())
            .with_no_client_auth()
    } else {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
                fingerprint: settings.fingerprint.clone(),
            }))
            .with_no_client_auth()
    };
    Ok(Some(Connector::Rustls(Arc::new(config))))
}

/// A certificate pin (§20.3 `fp=`): trust exactly the certificate whose SHA-256 this is —
/// the self-signed-Hub answer. With the pin itself the authentication, the signature check
/// inside the handshake accepts what the pinned key signed.
#[derive(Debug)]
struct PinnedVerifier {
    fingerprint: String,
}

impl rustls::client::danger::ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let digest = Sha256::digest(end_entity.as_ref());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        if hex == self.fingerprint {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "the server certificate does not match the pinned fingerprint".into(),
            ))
        }
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
            rustls::SignatureScheme::RSA_PKCS1_SHA384,
            rustls::SignatureScheme::RSA_PKCS1_SHA512,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA512,
        ]
    }
}

use super::Status;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_become_tunnel_websockets() {
        assert_eq!(
            tunnel_url("https://remote.example.com").unwrap(),
            "wss://remote.example.com/tunnel"
        );
        assert_eq!(
            tunnel_url("http://127.0.0.1:8080").unwrap(),
            "ws://127.0.0.1:8080/tunnel"
        );
        assert_eq!(
            tunnel_url("wss://remote.example.com/tunnel").unwrap(),
            "wss://remote.example.com/tunnel"
        );
        assert!(tunnel_url("ftp://x").is_err());
        assert!(tunnel_url("no-scheme").is_err());
    }
}
