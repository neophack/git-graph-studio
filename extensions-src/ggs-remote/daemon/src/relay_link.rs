//! The Relay link (docs/ggs-remote-plan.md §7.8): an instance's hidden Relay webview
//! connects to the loopback listener's `/relay?t=<token>` with the one-time token the
//! daemon handed the instance in `EnsureRelay`. One link per instance; it carries every
//! attached session's frames, told apart by the header's `session` field.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::registry::RELAY_TOKEN_TTL;
use crate::state::Daemon;
use crate::util::ct_eq;
use crate::ws::frame::Frame;

pub async fn relay_handler(
    State(daemon): State<Arc<Daemon>>,
    Query(query): Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(token) = query.get("t") else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(instance) = claim_token(&daemon, token) else {
        crate::warn!("relay connection with an unknown or expired token refused");
        return StatusCode::UNAUTHORIZED.into_response();
    };
    upgrade
        .max_message_size(crate::ws::frame::MAX_MESSAGE)
        .on_upgrade(move |socket| run(daemon, instance, socket))
}

/// Find the instance whose pending `EnsureRelay` token this is, and consume it.
fn claim_token(daemon: &Arc<Daemon>, token: &str) -> Option<String> {
    let mut map = daemon.registry.instances.lock().unwrap();
    for (id, inst) in map.iter_mut() {
        let matches = inst.relay_token.as_ref().is_some_and(|(t, at)| {
            at.elapsed() < RELAY_TOKEN_TTL && ct_eq(t.as_bytes(), token.as_bytes())
        });
        if matches && inst.relay.is_none() {
            inst.relay_token = None;
            return Some(id.clone());
        }
    }
    None
}

async fn run(daemon: Arc<Daemon>, instance: String, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    crate::router::relay_up(&daemon, &instance, tx);
    let writer = tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    while let Some(Ok(message)) = stream.next().await {
        let Message::Binary(bytes) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            }
            continue;
        };
        let frames = match Frame::decode_all(&bytes) {
            Ok(frames) => frames,
            Err(e) => {
                crate::warn!("relay {instance}: {e}");
                continue;
            }
        };
        // Fragments pass through unjoined: the browser reassembles, the daemon only routes.
        for frame in frames {
            crate::router::from_relay(&daemon, &instance, frame);
        }
    }
    writer.abort();
    crate::router::relay_down(&daemon, &instance);
}
