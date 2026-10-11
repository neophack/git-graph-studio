# Claude Remote

Continue **this machine's** Claude Code conversations from a phone: browse the history,
open a conversation or start a new one, and watch its turns live — the reply streaming in
as the CLI's own SDK messages, the same content the official `/remote-control` bridge
carries. Over a self-hosted relay (`claude-remote-server`), or the official Remote Control
where the CLI serves it. One VSIX that runs in both VS Code and Git Graph Studio.

> **2.1 relays conversation content in plain text.** End-to-end encryption is switched off
> while the remote flows (history, new conversations, the live stream, permission cards)
> are brought up and tested end to end; it returns in the frame codec (`wire.js`) and the
> phone app's `codec` — the only two places a payload is encoded. Until then, run the relay
> on a trusted network or behind HTTPS.

## How it works

- **The relay** (`claude-remote-server`, its own workspace): one user id and one QR per
  PC — every window of the machine shares them. Phones pair by scanning the QR (the
  pairing credential lives only in the link's `#` fragment, which browsers never send on
  their own; the phone hands it to the relay once and gets a device token). Reset the key
  and every phone is kicked at once; set a login password and pairing asks for it too.
- **The phone app** (served by the relay): the PC's windows → a window's conversations
  (this workspace or all, searchable) → one conversation. History is read from Claude
  Code's own session store, tail-first with earlier pages on demand and tool bodies loaded
  when opened. **New conversation** starts a fresh one in the workspace folder.
- **The live stream** (`live.js`): while a phone has a conversation open it *watches* it,
  and every SDK message of that conversation — `stream_event` deltas, `assistant`, `user`
  tool results, `result`, `system` — crosses to it verbatim, coalesced into one frame per
  60 ms. A new conversation is watched as a draft; the first event of a conversation id
  the phone did not know adopts it. The transcript stays the backfill for anything the
  stream missed (the SDK's message uuids are the session file's record uuids, so the two
  merge row for row).
- **The `/remote-control` protocol** is what the page and the window speak: out, the
  conversation's SDK messages plus `control_request {subtype: "can_use_tool"}` (tool
  permissions, AskUserQuestion, ExitPlanMode — the page's pop-up), `control_cancel_request`
  and `control_response`; in, `user` prompts, `control_request` (`interrupt`,
  `set_permission_mode`, `set_model`) and `control_response` (`{request_id, response:
  PermissionResult}` — allow with `updatedInput`, AskUserQuestion's picks as `answers`,
  "always" as `updatedPermissions`; or deny with a reason). On Git Graph Studio the answer
  reaches Claude Code as the chat tab's own response (`ggs.claudeChat.respond`); in VS Code
  it goes to the CLI's stdin.
- **Two conversation sources** feed it the same events: on Git Graph Studio, the host's
  read-only tap over the Claude Code chat panels (`io_message` SDK traffic and permission
  cards — never the credentials) plus the same driving commands a user at the keyboard
  could press, so a phone's turn runs in the conversation's own tab; on VS Code (or for
  conversations with no desktop tab), this window runs the `claude` CLI itself with the
  SDK's stream-json protocol and `--permission-prompt-tool stdio` — the phone answers the
  permission questions.
- **Official Remote Control**: toggled through the conversation's own request channel (the
  host synthesizes exactly what the tab's capsule sends), its `connectUrl` shown as a QR.
  Only claude.ai login + first-party models serve it — the CLI decides and reports; on a
  third-party provider the phone path is the relay.

## Settings

| Setting | Meaning |
| ------- | ------- |
| `claudeRemote.mode` | `auto` (official first, relay otherwise) / `official` / `selfHosted` |
| `claudeRemote.serverUrl` | The relay this PC registers on |
| `claudeRemote.autoConnect` | Connect when the window opens (default on) |
| `claudeRemote.mirrorControl` | In `official` mode, let the relay's phone drive conversations too (default off: read-only) |
| `claudeRemote.official.allSessions` | Claude's own `remoteControlAtStartup` |
| `claudeRemote.backend` | `desktop` (drive the tab) / `headless` (never touch the tabs) |
| `claudeRemote.desktopTab` | What an out-of-tab turn does to the conversation's tab |

Commands: **Claude Remote: Open Panel** (QR, link, devices, password, windows, the official
toggle, the local debug link), `Open Local Debug Page`, `Connect`/`Disconnect`, `Copy Pairing Link`, `Reset Pairing Key`, `Set`/`Clear
Login Password`, `Revoke a Paired Phone`, `Toggle Official Remote Control`.

## Notes

- A turn sent from the phone through the desktop tab runs exactly as if the desktop user
  typed it — same tab, same model, same permission mode; the desktop shows it as its own.
- AskUserQuestion and tool-permission cards are answerable from the phone: the former
  clicks the tab's own option card, the latter the tab's own Allow/Always allow/Deny
  buttons (or, on the sdk source, the CLI's `control_response`). A tool the CLI refuses on
  its own (a rule, auto mode's classifier) shows as a notice instead.
- Session files are read read-only, from the host's own store (Git Graph Studio
  `~/.ggs/claude`, VS Code `~/.claude`, an explicit `CLAUDE_CONFIG_DIR` over either).

## Local debug page

The panel's **Local debug** card (or `Claude Remote: Open Local Debug Page`) starts a
loopback server in this window and opens `http://127.0.0.1:<port>/d/<token>` in the system
browser: the same phone app, talking to this window directly — no relay, no pairing. The
conversation list, history, new conversations and the live SDK stream all work there
exactly as on a paired phone (`localDebug.js` plays the relay's part for one device over a
long-poll pair). It listens on 127.0.0.1 only, the random token in the link is the
credential, and the port is reused next time so a bookmarked tab reconnects.

## Installation note

The package declares `"extensionKind": ["workspace"]` — VS Code's own word for "runs on
the side where processes live". Git Graph Studio honours it: the install derives the
process backend (the CLI child and the conversation store outside the workspace cannot be
served by the sandboxed frame host), while VS Code reads it the standard way.

## Deployment

Run the relay (see its README), point `claudeRemote.serverUrl` at it, open the panel, scan.
The phone app is served by the relay itself, on any origin (plain HTTP on a LAN works).

## Testing

`node scripts/probes/claude-remote-e2e.mjs [--ws] [--shots <dir>]` walks the whole path
hermetically: the built relay, this extension's `activate()`, the bundled claude CLI
against the fake model server, and the phone app in headless Edge — pairing, history, a
new conversation streaming live, a resumed turn, a permission card, a page reload.
