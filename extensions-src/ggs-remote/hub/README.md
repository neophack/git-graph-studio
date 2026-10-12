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
| `/u/<uuid>/…` | the browser entry — proxied to that uuid's tunnel |
| `/tunnel` | a PC's outbound WebSocket (Ed25519 challenge handshake) |
| `/healthz` | liveness for orchestrators |
| `/metrics` | Prometheus text, on `metrics_listen` when configured |
| `/` | nothing (an optional `landing_page = true` static note) |

Every not-online link — mistyped, unknown, or the PC is away — answers the same page, so the
relay cannot be probed for which PCs exist; probing past 100 links / 10 minutes holds an IP
off for ten minutes.

## Limits

`join_key` (the server password, constant-time compared), `max_tunnels`, per-tunnel concurrent
sessions, per-tunnel daily bytes, per-IP handshake and login-entry rates — all in `hub.toml`.

## Build

```sh
cargo build --release            # a single static-friendly binary
docker build -t ggs-remote-hub . # rust:alpine → FROM scratch
deploy/build-deb.sh              # the deb + the musl tarball (musl-tools + the musl target)
```

One hub binary, one config file, no data directory.
