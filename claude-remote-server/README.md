# claude-remote-server

The Claude Remote relay: routes end-to-end encrypted frames between a PC's Claude Remote
windows (the editor extension, every window of the machine shares one identity) and its
paired phones. **The relay never sees a payload** — it checks membership, shape and rate,
and routes opaque ciphertext; the pairing key exists only in the QR link's URL fragment,
the PC's secret storage, and the phone's local storage.

One user per PC (`u_…`), one QR per PC, phones paired by scan (challenge-response HMAC
over `k_auth = HKDF(K, "crr1/auth")`), frames sealed with `k_e2e = HKDF(K, "crr1/e2e")`
under `AES-256-GCM`, the AAD binding user/epoch/sender/receiver/seq (replay and
re-addressing fail authentication). Resetting the key bumps the epoch: every phone is
kicked at once and must scan the new QR.

## Run

```sh
cargo run -- serve --registration token --invite <your-secret> --listen 0.0.0.0:8787 --data /var/lib/claude-remote
```

- `--registration open|token|closed` (default `token`, which requires `--invite`)
- `--memory` keeps everything in RAM (tests, throwaway relays); the persistent store is
  one atomically-written `users.json` under `--data`
- TLS belongs to a reverse proxy (Caddy/nginx) in front; the phone page works on any
  origin (WebCrypto on HTTPS, the vendored sjcl on plain-HTTP LANs)
- operator commands: `user list|disable|enable|delete <id>`, `gc [--days <n>]`

Limits (all flags): `--max-users` (1000), `--max-windows` (16 per PC), `--max-devices`
(10 per PC), `--max-frame` (1 MiB). A slow window's queue drops its oldest frames and
marks a `gap` (the PC replays from the conversation store); a phone that cannot keep up
is disconnected and resyncs itself.

The phone app is served from `/c/<user id>`; the PC side is the Claude Remote extension
(`extensions-src/claude-remote/` in the app's repository) configured with
`claudeRemote.serverUrl`.

## Layout

- `src/store.rs` — the PCs and their paired phones (one JSON file, atomic writes; Argon2id passwords)
- `src/hub.rs` — the routing core: windows' replay rings (cursor-resumable, `gap`-marked), phones' live channels, epoch broadcasts
- `src/api.rs` — the HTTP/WebSocket surface + the embedded phone app
- `src/guard.rs` — per-address lockouts; `src/config.rs` — flags over env over defaults
- `web/` — the phone app (plain browser scripts; `crypto.js` is WebCrypto-or-sjcl)
- `tests/integration.rs` — the full flows over real sockets: pairing → frames both ways,
  the long-poll pair, the rekey kick, cross-user isolation, the password gate, overflow,
  and one run of the built binary itself

## Wire contract (v1)

| Side | Surface |
| ---- | ------- |
| PC | `POST /api/v1/register {token?, auth}` → `{user_id, agent_secret, epoch}` |
| PC (Bearer agent_secret) | `PUT /me/pairing {auth, expect_epoch}` (rekey), `PUT/DELETE /me/password`, `GET /me/devices` (+ `password_set`), `GET /me/windows` (the sealed window metas), `DELETE /me/devices/{id}`, `POST /me/rotate-agent-secret`, `DELETE /me` |
| PC window | `GET /ws/agent?window=w_…[&token=…]` **or** `GET /api/v1/agent/poll?window&cursor&wait` + `POST /api/v1/agent/send {window, frames}` |
| Phone | `GET /c/{user_id}` (the app), `POST /pair/challenge`, `POST /pair`, `POST /login`, `POST /device/verify` (a stored token's liveness — the phone's pre-WebSocket probe; a dead token becomes the re-pair screen instead of a reconnect loop into the lockout), `GET /ws/device?token=…` |
| Ops | `GET /healthz` |

Frames: `{v:1, kind:"frame", from, to, seq, ct}` where `ct` is `<nonce>.<ciphertext‖tag>`
(base64url); controls: `hello`, `windows` (sealed metas), `window.meta`, `epoch_changed`,
`gap`, `kick`. Close codes: 4400 protocol, 4401 auth/rekeyed/revoked, 4413 overflow. Lockouts (429) carry `Retry-After`.
