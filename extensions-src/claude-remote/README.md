# Claude Remote

Continue **this machine's** Claude Code conversations from a phone — the official Remote
Control where the CLI serves it, and a self-hosted end-to-end encrypted relay everywhere
else. One VSIX that runs in both VS Code and Git Graph Studio.

## How it works

- **The relay** (`claude-remote-server`, its own workspace): one user id and one QR per
  PC — every window of the machine shares them. Phones pair by scanning the QR (the
  pairing key lives only in the link's `#` fragment, which browsers never send); every
  payload after that is an AES-256-GCM frame under keys derived from that fragment, so the
  relay — even one you run yourself — sees routing metadata only. Reset the key and every
  phone is kicked at once; set a login password and pairing asks for it too.
- **Two conversation sources** feed the phone: on Git Graph Studio, the host's read-only
  tap over the Claude Code chat panels (`io_message` SDK traffic, permission cards,
  remote-control state — never the credentials) plus the same driving commands a user at
  the keyboard could press; on VS Code (or for conversations with no desktop tab), this
  window runs the `claude` CLI itself as a stream-json child with `--permission-prompt-tool
  stdio` — the phone answers the permission questions.
- **Official Remote Control**: toggled through the conversation's own request channel (the
  host synthesizes exactly what the tab's capsule sends), its `connectUrl` shown as a QR.
  Only claude.ai login + first-party models serve it — the CLI decides and reports; on a
  third-party provider the phone path is the relay. The **mirror**
  (`claudeRemote.mirrorOfficial`) forwards a read-only, cleansed copy of the official
  session to the relay so its phone app shows the same conversation; it never touches the
  official switch, the CLI's stdin, or Claude's settings.
- **The conversations**: the same reader as ever — Claude Code's own session store, read
  only, tail-first with incremental cursors; tool rows are one-line digests until opened;
  AskUserQuestion and permission cards are answerable from the phone; prompts send "now"
  (interrupting) or queue behind the running turn.

## Settings

| Setting | Meaning |
| ------- | ------- |
| `claudeRemote.mode` | `auto` (official first, relay otherwise) / `official` / `selfHosted` |
| `claudeRemote.serverUrl` | The relay this PC registers on |
| `claudeRemote.autoConnect` | Connect when the window opens (default on) |
| `claudeRemote.mirrorOfficial` | `off` / `whenConnected` (default) / `always` |
| `claudeRemote.mirrorControl` | Let the relay's phone drive a mirrored conversation (default off) |
| `claudeRemote.mirrorConnectUrl` | Include the official `connectUrl` in the mirror (default off) |
| `claudeRemote.official.allSessions` | Claude's own `remoteControlAtStartup` |
| `claudeRemote.backend` | `desktop` (drive the tab) / `headless` (never touch the tabs) |
| `claudeRemote.desktopTab` | What an out-of-tab turn does to the conversation's tab |

Commands: **Claude Remote: Open Panel** (QR, link, devices, password, windows, the official
toggle), `Connect`/`Disconnect`, `Copy Pairing Link`, `Reset Pairing Key`, `Set`/`Clear
Login Password`, `Revoke a Paired Phone`, `Toggle Official Remote Control`.

## Notes

- A turn sent from the phone through the desktop tab runs exactly as if the desktop user
  typed it — same tab, same model, same permission mode; the desktop shows it as its own.
  Out-of-tab turns open (and reload) the conversation's tab per `claudeRemote.desktopTab`.
- AskUserQuestion and tool-permission cards are answerable from the phone: the former
  clicks the tab's own option card, the latter the tab's own Allow/Always allow/Deny
  buttons (or, on the sdk source, the CLI's `control_response`).
- Session files are read read-only, from the host's own store (Git Graph Studio
  `~/.ggs/claude`, VS Code `~/.claude`, an explicit `CLAUDE_CONFIG_DIR` over either).

## Deployment

Run the relay (see its README), point `claudeRemote.serverUrl` at it, open the panel, scan.
The phone app is served by the relay itself; a plain-HTTP LAN origin works (the phone's
crypto falls back from WebCrypto to the vendored sjcl).
