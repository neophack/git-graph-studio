# ggs-remote-hub

The self-hosted, account-free relay of [GGS Remote](../daemon) (docs/ggs-remote-plan.md §20):
each PC's daemon keeps an **outbound** tunnel open to one Hub — so the PC can sit behind NAT —
and each PC answers on its own link, `https://<your-domain>/u/<uuid>/`. The UUID derives from
the PC's Ed25519 device key; the relay holds **no accounts, no database, and nothing to back
up**. Restart it and every PC reconnects with the same link.

```text
phones / browsers ── https://your-domain/u/<uuid>/… ──┐
                                                      ▼
                                            ggs-remote-hub
                            (forwards, strips /u/<uuid>/, stamps sessions)
                                                      ▲
                              outbound wss tunnels (one per PC, keyed)
                      PC A: ggs-remote daemon        PC B: ggs-remote daemon
                      (its own password, windows,    (the same, independently)
                       git-graph studio instances)
```

What the relay can see: the traffic it forwards (TLS ends here unless you front it with
Caddy/nginx — then that layer sees it instead). It never sees a password in clear beyond the
frames it relays, and it stores nothing. Run it on a machine you trust, and set a `join_key`
on a public deployment.

## Run

```sh
ggs-remote-hub --example-config > hub.toml   # commented template
ggs-remote-hub --config hub.toml
```

Or as a standalone package (every release carries them, alongside the container image):

- **Windows**: `ggs-remote-hub-<version>-windows-x64.zip` — unzip and run
  `ggs-remote-hub.exe --config hub.toml.example` (edit a copy first; the example listens
  on `0.0.0.0:8443` behind a TLS proxy).
- **Debian/Ubuntu**: `ggs-remote-hub_<version>_amd64.deb` — `sudo dpkg -i` puts the
  binary under `/usr/bin`, a hardened systemd unit under `lib/systemd/system`, and the
  example config at `/etc/ggs-hub/hub.toml` (a conffile — edits survive upgrades):
  ```sh
  sudo dpkg -i ggs-remote-hub_*_amd64.deb
  sudo systemctl enable --now ggs-remote-hub    # journalctl -u ggs-remote-hub -f
  ```
  The binary is statically linked (musl): no runtime dependencies on any glibc.
- **Any other Linux**: `ggs-remote-hub-<version>-x86_64-musl.tar.gz` — the binary, the
  example config and the systemd unit; run it wherever you like.

Or with Docker:

```sh
cd deploy && docker compose up -d
```

TLS: either `mode = "files"` with your certificate, or `mode = "none"` behind a front proxy
(the `deploy/Caddyfile` gets a Let's Encrypt certificate and proxies to the Hub). A Hub with
a self-signed certificate works too — paste its fingerprint into the connect string:
`ggsr1:https://your-host#your-join-key;fp=<sha256-hex>`.

## Connect a PC

In GGS: Remote Access page → *Reach this PC from anywhere (relay)* → paste the server address
(or the whole `ggsr1:` connect string) → Connect. The page then shows this PC's own
`/u/<uuid>/` link and QR code. Nothing to register; a password must exist on the PC first.

## Surfaces

| path | what |
| ---- | ---- |
| `/u/<uuid>/…` | the browser entry — proxied to that uuid's tunnel; the only public surface, and only for a well-formed uuid (a malformed segment drops like any scan path) |
| `/tunnel` | a PC's outbound WebSocket (Ed25519 challenge handshake); plain HTTP probes of it are dropped |
| `/metrics`, `/healthz` | the operator's corners, on `metrics_listen` when configured |
| anything else | **nothing** — the connection closes without a byte, as if the port was not open |

A well-formed link whose PC is unknown or away answers the same offline page, so the relay
cannot be probed for which PCs exist; probing past 100 links / 10 minutes holds an IP
off for ten minutes. Everything else — every path outside `/u/<uuid>/…`, every uuid that
is not the well-formed v8 shape, and any `/tunnel` request that is not a WebSocket
handshake — is dropped at the gate (`src/gate.rs`) with zero response bytes. TCP-level SYN
replies and (in `tls = "files"` mode) the TLS handshake itself still happen — the port must
answer its own clients — but no HTTP fingerprint ever leaves it. The same rule ships in
`deploy/Caddyfile`, which proxies only `/u/*` and `/tunnel` and aborts the rest.

## Limits

`join_key` (the server password, constant-time compared), `max_tunnels`, per-tunnel concurrent
sessions, per-tunnel daily bytes, per-IP handshake / request / login-entry rates, and the
per-link daily distinct-viewer ceiling — all in `hub.toml`.

## Abuse guards

The relay forwards whatever a connected PC's daemon serves — an open relay is a free hosting
service waiting to happen, so the guards come in layers (§20.6 of the plan):

- **`join_key`** — treat it as an invitation list. A keyless public Hub admits any GGS Remote;
  on the public internet, set one.
- **`visitors_per_day_per_tunnel`** (default 32, 0 = off) — a personal remote-workbench link has
  a handful of viewers; a link shared like a public site has hundreds of distinct IPs. The count
  hangs off the link's uuid (a reconnect does not reset it) and past the ceiling new IPs get 429.
- **`http_rate`** (default 600/min/IP, 0 = off) — the session ceiling caps concurrency, not rate;
  this is the rate cap on proxied requests.
- **`audit_log`** (empty = off) — one JSON line per tunnel lifecycle, browser session and proxied
  answer *head*: no bodies, no cookies, package tokens in paths masked to their first 6
  characters. The trail an operator answers takedowns and forensics with.
- **`blocklist`** (empty = off) — a plain file of uuids, one per line (`#` comments), re-read
  every 30 s and at every handshake: a listed PC's tunnel is taken off the air (its browsers see
  the plain offline page) and its next handshake is refused with `banned`. Edit the file, no
  restart.

For a public deployment, also consider fronting with Caddy/nginx for real TLS, keeping the audit
log on, and the legal duties of a relay operator in your jurisdiction (log retention, a takedown
contact on the landing page).

## Build

```sh
cargo build --release            # a single static-friendly binary
docker build -t ggs-remote-hub . # rust:alpine → FROM scratch
bash deploy/build-deb.sh         # the deb + the musl tarball (musl-tools + the musl target)
```

```bat
deploy\build-zip.bat             # the Windows zip (the release page's layout, built locally)
```

One hub binary, one config file, no data directory.
