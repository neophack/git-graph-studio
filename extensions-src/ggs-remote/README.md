# GGS Remote

Use Git Graph Studio from a phone, a tablet or another computer — the whole workbench:
files, editors, source control, the Git Graph view, terminals, code analysis, the CAN
Trace Analyzer and every installed extension.

- **One link and one password per PC.** A small tray service (`ggs-remote`, a few MB of
  memory) serves every Git Graph Studio window of this PC. Pick a window after signing in,
  switch between windows, open new ones, close or restart a stuck one.
- **Phone-ready.** The same workbench, re-laid out for small screens: bottom tabs, full-screen
  side views, an action sheet for context menus, a terminal key row (Esc, Tab, Ctrl, arrows).
- **Light on the network.** Files and views load on demand over one binary WebSocket;
  hashed assets are cached by the browser for good; a Data Saver mode for slow links.
- **Private by default.** HTTPS with a local certificate authority the devices trust once,
  Argon2id passwords, login throttling, and changing the password signs every device out.

## Getting started

1. Install the extension: the service installs itself and starts at login.
2. **Remote Access: Open** — set the access password, unlock, scan a QR code with the phone.
3. On the phone, install the certificate the page offers (once per device) for a trusted
   connection; the pairing page shows the steps for iOS and Android.

Anyone with the password can do on this PC whatever you can — including running commands in
a terminal. Share it only with people you trust; **Sign Out All Devices** ends every session.

## Outside the local network

GGS Remote serves the local network only. To reach the PC from elsewhere, put it behind a
tunnel or a reverse proxy that terminates TLS (`ggsRemote.tlsMode: none`, bind `127.0.0.1`),
use Tailscale with your own certificate (`ggsRemote.tlsMode: custom`), or run the
self-hosted relay (`ggs-remote-hub`). Plain HTTP may also bind the wildcard address
(`bind 0.0.0.0` — a container publishing its port, or a trusted LAN accepting cleartext);
the session cookie follows the scheme the browser speaks, so sign-in works, but the
password, the session and every file's bytes cross the network unencrypted.

Prefer **HTTPS** wherever the network itself is not trusted; the default self-signed TLS
costs one certificate install per device and keeps everything off the wire.

## Command line

```text
ggs-remote status | stop | start | pair | print-link | set-password | autostart on|off
```

`ggs config --port <n> --scheme https|http --bind <addr>` (from the app's own command
line) sets the fixed LAN port, protocol and bind address; the Remote Access page's
Service section and the pairing page's LAN listener card set the port and protocol. The
`ggs config` spelling also installs this extension from the bundled package first, so a
fresh machine — or a container — gets the service installed, started and registered at
login without ever opening a window. The main repository's README covers the flags,
`config.json` and running in Docker.

The binary lives in `~/.ggs/remote/bin/`; its log is `~/.ggs/logs/remote.log`. On Linux the
tray needs a StatusNotifier host (KDE, or GNOME with the AppIndicator extension); without one
the service runs headless and is managed from the Remote Access page or the command line.
A systemd user unit restarts it after a crash:

```ini
# ~/.config/systemd/user/ggs-remote.service
[Unit]
Description=GGS Remote
[Service]
ExecStart=%h/.ggs/remote/bin/ggs-remote run --no-tray
Restart=on-failure
[Install]
WantedBy=default.target
```
