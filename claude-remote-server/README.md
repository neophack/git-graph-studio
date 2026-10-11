# claude-remote-server

The Claude Remote relay: routes frames between a PC's Claude Remote windows (the editor
extension, every window of the machine shares one identity) and its paired phones, and
serves the phone app. The relay reads only the routing envelope of a frame — `from`,
`to`, `seq` — and passes the `ct` body through untouched.

> **Plain bodies for now.** While the remote flows are brought up, both ends encode `ct`
> as `p.` + base64url(JSON) — readable by whoever runs the relay. End-to-end encryption
> (AES-256-GCM under keys from the QR's fragment) returns in the two clients' codecs; the
> relay's contract does not change. Run it on a trusted network or behind HTTPS until then.

One user per PC (`u_…`), one QR per PC. A phone pairs with the credential the QR link
carries in its fragment (`#p.<auth>.<epoch>`, posted once as `secret`; the older
challenge-response HMAC form is still accepted). Resetting the key bumps the epoch: every
phone is kicked at once and must scan the new QR.

## Run

```sh
cargo run -- serve --registration token --invite <your-secret> --listen 0.0.0.0:8787 --data /var/lib/claude-remote
```

- `--registration open|token|closed` (default `token`, which requires `--invite`)
- `--memory` keeps everything in RAM (tests, throwaway relays); the persistent store is
  one atomically-written `users.json` under `--data`
- TLS belongs to a reverse proxy (Caddy/nginx) in front; the phone page works on any
  origin
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
- `web/` — the phone app (plain browser scripts; `crypto.js`/`sjcl.js` stay for when the
  sealed codec returns — the page does not load them today)
- `tests/integration.rs` — the full flows over real sockets: pairing → frames both ways,
  the long-poll pair, the rekey kick, cross-user isolation, the password gate, overflow,
  and one run of the built binary itself

## Wire contract (v1)

| Side | Surface |
| ---- | ------- |
| PC | `POST /api/v1/register {token?, auth}` → `{user_id, agent_secret, epoch}` |
| PC (Bearer agent_secret) | `PUT /me/pairing {auth, expect_epoch}` (rekey), `PUT/DELETE /me/password`, `GET /me/devices` (+ `password_set`), `GET /me/windows` (the sealed window metas), `DELETE /me/devices/{id}`, `POST /me/rotate-agent-secret`, `DELETE /me` |
| PC window | `GET /ws/agent?window=w_…[&token=…]` **or** `GET /api/v1/agent/poll?window&cursor&wait` + `POST /api/v1/agent/send {window, frames}` |
| Phone | `GET /c/{user_id}` (the app), `POST /pair` (`{user_id, epoch, secret, password?, device_name}` — or the challenge form: `POST /pair/challenge` then `{nonce, proof}`), `POST /login`, `POST /device/verify` (a stored token's liveness — the phone's pre-WebSocket probe; a dead token becomes the re-pair screen instead of a reconnect loop into the lockout), `GET /ws/device?token=…` |
| Ops | `GET /healthz` |

Frames: `{v:1, kind:"frame", from, to, seq, ct}` where `ct` is base64url-with-dots (today
`p.<base64url JSON>`; sealed, `<nonce>.<ciphertext‖tag>`). A frame for a member that is not
connected is dropped — never an error that closes the sender. Controls: `hello`, `windows` (sealed metas), `window.meta`, `epoch_changed`,
`gap`, `kick`. Close codes: 4400 protocol, 4401 auth/rekeyed/revoked, 4413 overflow. Lockouts (429) carry `Retry-After`.
