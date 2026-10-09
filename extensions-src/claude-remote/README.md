# Claude Remote (LAN)

View and continue **this workspace's** Claude Code conversations from a phone: full history,
live progress, remote prompts. One VSIX that runs in both VS Code and Git Graph Studio;
LAN only, no cloud relay.

## Features

- **Conversation history**: reads Claude Code's own session store (read-only, the host's own
  copy: Git Graph Studio uses `~/.ggs/claude`, VS Code uses Claude's default `~/.claude`; an
  explicit `CLAUDE_CONFIG_DIR` overrides either). By default it lists only the conversations
  under the currently open workspace folders, switchable to all projects; search, grouping
  by date, and titles (custom title › AI title › summary › first prompt).
- **Conversation view**: Markdown rendering (copyable code blocks), collapsible thinking,
  tool-call cards (Bash commands, Edit diffs, TodoWrite lists), images, and context-compaction
  and interruption notices.
- **On-demand transfer**: sync carries only entry summaries — every tool row is a one-line
  digest, and input content or output text is fetched individually when that row is expanded
  ("load full text" for oversized results); result images likewise load only when opened.
  Anything already fetched is cached on the phone and never re-sent by a sync.
- **Incremental sync**: the phone carries a version cursor and the server returns only new or
  changed entries, so even a densely polled active conversation never resends history. Session
  files are read incrementally (only newly appended lines are parsed).
- **Remote prompts**: continue an existing conversation or start a new one inside a workspace
  folder. Two send modes:
  - **After this turn**: joins that conversation's queue and sends one by one once the current
    turn (phone-initiated, or already running on the desktop) ends;
  - **Send now**: interrupts the running turn and sends immediately.
  A queued prompt can be sent "now" individually or cancelled; "Stop" interrupts the current
  turn and pauses the queue — nothing continues silently in the background.
- **Sent from the desktop (Git Graph Studio)**: the phone's prompt is typed into the
  conversation's Claude Code tab and sent from there (opened first if needed; a new
  conversation opens a new tab) — the desktop sees an ordinary conversation, using that tab's
  own model and permission mode; the phone reads exactly the session file this tab writes, so
  the two sides never diverge. "Send now" presses the tab's Stop first; "After this turn"
  waits for the turn to end before typing. The phone offers one-tap "Open on desktop", and
  the top of the session list shows the conversations the desktop already has open.
- **Remote answers (when sent from the desktop)**: when Claude calls the AskUserQuestion
  tool, the phone renders it directly as a tappable question card — options, descriptions,
  multi-select and "Other (custom answer)" are all picked and submitted on the phone; the
  desktop's tab for that conversation clicks its own option cards with those picks, and once
  the answer lands on disk the card flips to "answered" with the chosen options marked. Under
  headless operation (VS Code) questions still display, but can only be answered on the
  desktop.
- **Headless operation (VS Code)**: VS Code cannot drive another extension's pages, so prompts
  run through `claude -p` in the background; the conversation's tab opens when a turn starts
  and reloads when it ends (an open chat panel does not re-read the session file on its own).
- **Models**: the phone shows the desktop's current model (the `model` pin in project/user
  settings with tier aliases resolved through the provider mapping, else `ANTHROPIC_MODEL`,
  else the most recently used model), each conversation's last-answer model, and the running
  turn's model; under headless operation it can pick "follow the desktop", the conversation's
  own model, or the opus / sonnet / haiku / fable tiers (when sent from the desktop the tab's
  own model applies — shown, not chosen). Under a third-party provider (Git Graph Studio's
  model-provider bridge) the phone always shows the provider's own model names: tier aliases
  map through `ANTHROPIC_DEFAULT_<TIER>_MODEL` to the provider's own model ids (in the picker,
  the model pill and the running banner alike), and tiers that map to the same model merge
  into one option.
- **Permission modes**: default (follows Claude settings) / auto mode / accept edits / plan
  mode / bypass permissions (remote turns run headless — there is no per-prompt confirmation).
- **Desktop panel**: server start/stop, the pairing QR per LAN address, the pairing code
  (masked by default), **Reset pairing key**, paired devices (online state), the remote
  activity log, and the runtime environment.

## Security model

| Layer | Measure |
| --- | --- |
| Pairing secret | 120-bit random pairing code + random salt + key ID, stored in the editor's Secret Storage; survives restarts |
| Reset | "Reset pairing key" swaps in a new key at once: an old device's next request gets `rekeyed` and it must scan the new QR |
| Transport | the pairing code lives only in the link's `#` fragment (browsers never send it), and the phone wipes it from the address bar as soon as it reads it |
| Encryption | every endpoint goes through the one `/api/rpc`: AES-256-GCM, key = PBKDF2-SHA256(code, salt, 150,000); the method name travels inside the ciphertext too |
| Binding | request AAD = `cr2:req:<kid>`, response AAD = `cr2:res:<nonce>`: a response cannot be repurposed |
| Anti-replay | timestamp within a ±5-minute window (the phone corrects its clock against server time) + single-use nonce |
| Anti-brute-force | 10 decryption failures within one minute from the same address lock it out for one minute |
| Page | strict CSP (no inline scripts), `no-referrer`, `nosniff`, embedding denied; the phone's crypto uses the vendored sjcl (a plain-HTTP LAN origin is not a secure context — no WebCrypto) |
| Scope | new conversations can only be created inside the open workspace folders |

## Commands and settings

- `Claude Remote: Open Panel` (the status-bar entry), `Start LAN Server`, `Stop LAN Server`, `Reset Pairing Key`
- `claudeRemote.port`: the port; 0 = reuse the last port (paired phones' bookmarks keep working)
- `claudeRemote.autoStart`: start the server when the window opens
- `claudeRemote.backend`: `desktop` (default — sent from the desktop's Claude Code tab; falls back to headless where the host cannot) / `headless`
- `claudeRemote.desktopTab` (headless only): `reload` (default — open the tab when a turn starts, reload it when the turn ends) / `open` (open only) / `off`

## Build

```sh
node extensions-src/claude-remote/build.mjs
# output: target/studio/claude-remote-<version>.vsix
```

Bundled with every Git Graph Studio installer by default; in VS Code, install via
`Extensions → … → Install from VSIX…`.

## Known limits

- The QR and the pairing code are the access key — show them only to devices you trust, and
  reset immediately if one leaks.
- Plain-HTTP LAN carries only ciphertext; use a VPN across networks and never expose the port
  to the internet.
- When sent from the desktop, tool permission prompts (allow / deny) still pop up in the
  desktop tab and cannot be confirmed from the phone; AskUserQuestion is the exception — the
  phone can answer it by tapping.
- Sending from the desktop brings the tab to the front and focuses its input box; an unsent
  draft in that input is replaced by the prompt.
- Under headless operation, tool permissions follow the selected mode and Claude Code's own
  settings.
- Reloading a tab = closing and reopening it: unsent drafts in the tab's input are lost. Git
  Graph Studio knows exactly which tab hosts a session; VS Code has no such mapping and closes
  the current tab only after switching to that session, and only when it is indeed a Claude
  Code panel.
- "Desktop running" is inferred from the session file (the last record is mid-turn and the
  file was written within the last 3 minutes).
- Oversized sessions parse only the last 24 MiB.
- The QR encoder is vendored from [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
  (MIT); the phone's crypto library is vendored from [sjcl](https://github.com/bitwiseshiftleft/sjcl)
  (BSD-2-Clause).
