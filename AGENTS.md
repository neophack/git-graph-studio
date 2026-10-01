# AGENTS.md

Operating manual for coding agents — and the humans reviewing them — working in this
repository. Read it once in full; consult the [Module map](#module-map) and
[Definition of done](#definition-of-done) on every change.

## Contents

1. [Product summary](#product-summary)
2. [Quick start](#quick-start)
3. [Architecture](#architecture)
4. [Module map](#module-map)
5. [Development workflow](#development-workflow)
6. [Invariants](#invariants)
7. [Testing](#testing)
8. [Code style](#code-style)
9. [Commits and pull requests](#commits-and-pull-requests)
10. [Reference](#reference)

## Product summary

**Git Graph Studio** is a standalone desktop application (Tauri 2 + TypeScript + Rust) that
hosts the `git-graph-rs` engine in a VS Code-class workbench: a File Explorer with git status
decoration, Source Control, a tabbed Editor Suite with split groups, an Integrated Terminal,
the Git Graph view, a VSIX Extension Platform, and a CAN Trace Analyzer.

| Document | Role |
| -------- | ---- |
| `README.md` | What ships: features, repository layout, build instructions |
| `docs/ggs-development-plan.md` | The authoritative plan. §3 *Architecture principles* binds every change; §5 lists milestones; §9 defines the quality bar |
| `AGENTS.md` (this file) | How to change the code without breaking its structure |

When this file and the plan disagree, the plan wins; fix this file in the same change.

## Quick start

Prerequisites: Rust 1.94+ (`rust-version` in `src-tauri/Cargo.toml`; the floor is
big-code-analysis, module 17's metrics engine), Node.js 20+, and a
`git` executable on `PATH`.

```sh
# The app — self-contained: no submodule, no plugin source; every extension package a
# build carries is fetched from the marketplace (Open VSX) by prepare.mjs
npm install
npx tauri dev            # run with the real backend (the only mode that catches packaged regressions)
```

Everyday commands, from the repository root:

| Command | Purpose |
| ------- | ------- |
| `npm run typecheck` | `tsc --noEmit` — must pass before a change is considered done |
| `npm test` | vitest (jsdom, scripted Tauri backend); runs `scripts/check-seams.mjs` as global setup |
| `npx vitest run tests/<module>.test.ts` | One module's suite |
| `cargo test --all-features` (in `src-tauri/`) | Backend unit and integration tests — needs `node scripts/prepare.mjs` run once first (`generate_context!()` embeds the icons it derives into `target/studio/icons/`) |
| `cargo clippy --all-targets --all-features -- -D warnings` (in `src-tauri/`) | Backend lint, warnings are errors in CI |
| `npx tauri build` | Installers into `target/studio/cargo/release/bundle/` |
| `npm run dev:vite` | Frontend only, against the scripted fake backend; open `dev/dev-harness.html` |
| `node scripts/measure.mjs --repo .` | Size and performance measurement (this repository as the probe repo) — recorded to `target/studio/metrics.json` (no budgets; see principle 6) |

All generated output — the Vite public dir and dist, the Cargo target, installers, coverage,
`metrics.json` — lands under `target/studio/` (gitignored). Nothing generated is ever written
into the source tree.

## Architecture

The app process plus one extension-host process per installed package, joined by Tauri IPC:

```text
┌──────────────────────── Frontend (src/, TypeScript, no framework) ────────────────────────┐
│ workbench.ts composes the shell; every view is hand-written DOM over the ui.ts kit;        │
│ every action is a command in commands.ts; every backend call is a Tauri `invoke`.         │
└──────────────────────────────────────────┬────────────────────────────────────────────────┘
                                           │ invoke / Channel / events
┌──────────────────────────────────────────┴────────────────────────────────────────────────┐
│ Backend (src-tauri/, Rust): one cmd_*.rs per domain, exposing #[tauri::command]s.         │
│ The app's own git reads and writes run the git CLI (git.rs); generic plugin surfaces       │
│ (ext_*, ext_process) list and speak to whatever is installed — naming no plugin.           │
└──────────────────────────────────────────┬────────────────────────────────────────────────┘
                                           │ the extension platform (ext_process, ggs:// pages)
┌──────────────────────────────────────────┴────────────────────────────────────────────────┐
│ The extension (git-graph-rs, in its own repository — its studio/ packer ships the         │
│ the store-format .vsix — pages (ggs://) and the engine .node, loaded natively by the      │
│ real-Node extension host (nodeHost.ts) — no executable inside. The app tree carries no    │
│ plugin code; the app binary never links the engine and names no plugin.                   │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

The principles below are the plan's §3, condensed. They apply to every change.

1. **Pure-Rust backend.** No C bindings beyond the one sanctioned exception (plan §3.1):
   tree-sitter grammars compiled by cargo's `cc`, each behind a `grammar-*` feature;
   syntect runs on `default-fancy`, git access is gix.
2. **The app works without any plugin.** Its own git reads (status, file-at-revision, file
   history, submodules) and writes (stage, commit, fetch, push, …) run the `git` CLI, and
   only through `src-tauri/src/git.rs`. A plugin that declares a process backend is a warm
   sibling reached over the one wire protocol, `ggs-ext/1` — the Git Graph view's engine
   backend speaks; the app binary never links
   `git-graph-core` and names no plugin id anywhere under `src/`.
3. **No frontend framework.** Hand-written DOM via `el()`; new views are built from the
   `ui.ts` primitives (quick input, context menu, notifications, codicons).
4. **Heavy work runs in the backend and streams.** Search, indexing, folder compare and hex
   diff push batches through `tauri::ipc::Channel`; the first batch reaches the UI within
   200 ms; every long task is cancellable.
5. **Three artefacts per feature.** A `#[tauri::command]` with a Rust test (scratch
   repository via `test_support.rs`), a vitest over the `tauriMock` recording, and a
   `dev/dev-harness.html` scenario for behaviour jsdom cannot express.
6. **Sizes are measured, not gated.** Artefact sizes and probe timings are recorded to
   `target/studio/metrics.json`. The size budgets and their CI gate were removed on
   2026-09-15 at the owner's request ("不要限制大小了"); backend performance budgets remain
   enforced by `src-tauri/tests/perf.rs`.
7. **The engine is consumed through exactly two seams**, both build-enforced — see
   [Invariants](#invariants).

## Module map

The product is developed, reviewed and tested **module by module**. Every source file belongs
to exactly one module. When you add a file, place it in its module and update this map in the
same change; when you add a module, give it a product-grade name (what a datasheet or the
Extensions view would call it), a mission line, and a test file.

| # | Module | Mission |
| - | ------ | ------- |
| 1 | Workbench Shell | The application frame and first-paint boot |
| 2 | Command System | Commands, keybindings, settings, language, theme quality |
| 3 | File Explorer | The workspace tree and its filesystem services |
| 4 | Quick Open | Fuzzy file go-to |
| 5 | Workspace Search | Text search & replace, symbol navigation |
| 6 | Editor Suite | Text editing, completion, find, decorations |
| 7 | Large-File Viewers | Million-line and binary viewing |
| 8 | Compare & Merge | Folder sync, three-way merge, diffs |
| 9 | Source Control | Stage / commit / history / git commands |
| 10 | Git Graph Engine | The graph view and the engine seam |
| 11 | Integrated Terminal | Shells inside the panel |
| 12 | Extension Platform | VSIX installs and the extension host |
| 13 | CAN Trace Analyzer | CANoe-style `.blf` / `.asc` analysis |
| 14 | Performance Lab | Measurement, metrics, the perf gate and the module self-tests |
| 15 | Build & Release Pipeline | Asset preparation, packaging, installers, CI |
| 16 | Symbol MCP Server | The `ggs --mcp` AI bridge over the symbol index |
| 17 | Code Analysis | tree-sitter parsing and the five analysis tools |

### 1. Workbench Shell

The application frame: custom title bar (menus, command center, window controls), activity
bar, side bar, editor area host, bottom panel and status bar, plus the boot splash that
guarantees the window is never a blank dark rectangle.

- Frontend: `src/main.ts` (boot entry), `src/workbench.ts` (composition root),
  `src/titlebar.ts`, `src/statusbar.ts`, `src/panel.ts` (panel chrome; its Output view is
  the Git channel), `src/ui.ts` (shared DOM kit: codicons, notifications, context menus,
  quick input), `src/lazy.ts` (async-chunk loaders), `src/state.ts` (localStorage
  persistence), `src/shell.css`
- Backend: `src-tauri/src/lib.rs` / `main.rs` (crate inventory and app entry),
  `src-tauri/src/cmd_app.rs` (the app-instance domain: File → New Window's
  `app_new_instance` spawns a sibling process — the multi-open entry every platform
  shares, optionally carrying a folder (`open -n <bundle> --args <path>` on a packaged
  macOS run, plain argv elsewhere), the handoff a Finder "Open With" makes of an
  occupied window; a packaged macOS run reaches Launch Services through
  `open -n <bundle>`, since activating a bundled app's icon only focuses the running
  instance. On macOS the Dock icon's right-click menu offers the same:
  `dock_menu` injects `applicationDockMenu:` into tao's application-delegate class at
  boot, additively via `class_addMethod`, the item's label following the persisted
  display language. The Finder "Open With" handoff itself is lib.rs's run loop routing
  `RunEvent::Opened` (`handle_opened`): one that beats the frontend's `boot_context`
  seeds the launch context exactly like a `ggs <path>` argv launch; one that arrives
  later crosses as the `studio://open-paths` event, which workbench.ts routes — a
  folder takes over an empty window and wins a new instance otherwise, a file opens
  like a drop)

### 2. Command System

Every action is a command with id, title, keybinding and enablement; the palette, the menus
and the keyboard all resolve through one registry. Settings, keybindings and display
language are user data under `~/.ggs/`; theme and UI quality are enforced, not hoped for.

- Frontend: `src/commands.ts` (registry), `src/keybindings.ts`, `src/settings.ts` (setting
  registry `SETTING_DEFS`), `src/settingsPanel.ts` (generated Settings dialog),
  `src/i18n.ts` (`t(key)`, en / zh-cn), `src/themeMetrics.ts` (WCAG contrast per theme),
  `src/uiMetrics.ts` (layout invariants)
- Backend: `src-tauri/src/cmd_assoc.rs` (the File Associations setting: OS-level
  "open with" registration per platform — HKCU ProgIds + RegisteredApplications on
  Windows, desktop entry / MIME package / `mimeapps.list` on Linux, bundle-declared on
  macOS: the file types from `bundle.fileAssociations`, mirrored — plus `public.folder`,
  the Finder folder right-click's "Open With → Git Graph Studio" entry — in
  `src-tauri/Info.plist`, which the bundler merges after the generated keys and whose
  `CFBundleDocumentTypes` therefore replaces theirs (the module's tests fail the build
  when the two drift apart); the Explorer context-menu entry `context_menu_apply` — the
  "Open with Git Graph Studio" static shell verb under `*` / `Directory` /
  `Directory\Background` / `Drive`, re-applied at every boot, removed by the NSIS
  uninstall hooks; and the `ggs` launcher's PATH entry `user_path_apply` — the install
  directory appended to HKCU\Environment\Path at every boot, idempotently and without
  length limits: the NSIS hooks no longer write PATH, whose string-limited read once
  mistook a long user PATH for an empty one and wiped it, 2026-09-23)
- Assets: `static/theme/*.css` (the colour themes)

### 3. File Explorer

The workspace folder tree — lazy, with git status colouring, inline new/rename inputs and
the full context menu — over filesystem services that also serve the editors.

- Frontend: `src/explorer.ts`
- Backend: `src-tauri/src/cmd_fs.rs` (tree, file contents of the working tree / index / any
  revision, new-rename-delete), `src-tauri/src/watcher.rs` (one recursive `notify` watch,
  debounced `FsChange` batches — external changes appear by themselves)

### 4. Quick Open

VS Code's anythingQuickAccess model: the walked file list pre-lowered once, queries scanned
in event-loop-yielding chunks.

- Frontend: `src/filePicker.ts`, `src/fuzzy.ts` (the fuzzyScorer port)
- Backend: `src-tauri/src/cmd_fuzzy.rs` (server-side scoring — a keystroke ships rows, not
  the tree)

### 5. Workspace Search

Workspace-wide search & replace with streaming results, and Source Insight-style symbol
navigation (Go-to-Definition, Find References, Call Tree, Quick Open's `@` / `#` symbol
modes, the Context Window) over the persistent workspace symbol index: interned names,
per-file fingerprints and per-name occurrence lists under `~/.ggs/index/`, resumed on open,
updated file-by-file by the watcher.

- Frontend: `src/searchView.ts`, `src/callTree.ts`, `src/contextView.ts` (the Context
  Window panel page - the definition of the symbol under the cursor),
  `src/symbolDbView.ts` (the Symbol Database page - the index as a collapsible
  folder / file / symbol tree with reference counts, filter and rebuild)
- Backend: `src-tauri/src/cmd_symbols.rs` (the index state, the build / resume / rebuild
  commands, `symbol_lookup` / `symbol_references`), `src-tauri/src/symbols/parse.rs` (the
  tree-sitter parser layer, plan M4.1: one embedded `.scm` query per language over defs,
  call sites and imports, each grammar behind a `grammar-*` Cargo feature, the outline scan
  as the fallback), `src-tauri/src/symbols/store.rs` (the compact on-disk store), `src-tauri/src/cmd_search.rs` (rayon-parallelised text search, the
  in-memory index fallback, the folder-comparison and byte-comparison services; reuses the
  Quick Open walk so the exclusion policy is one list)

### 6. Editor Suite

VS Code-shaped editing: tabbed editor groups over a split grid, CodeMirror 6 text editing
with on-demand language support, windowed editing of large files over the backend rope,
completion (document words, snippets, paths), the find/replace widget, bracket-pair
colouring, sticky scroll, minimap, bookmarks, markdown preview.

- Frontend: `src/editor.ts` (groups, tabs, breadcrumbs), `src/editorArea.ts` (split grid),
  `src/textEditor.ts` (CodeMirror host), `src/comments.ts` (VS Code's comment toggles),
  `src/docEditView.ts` (windowed large-file editor, scrolling on module 7's `src/scroll/`),
  `src/docFind.ts` (the whole-file find/replace bar the windowed editor and the Fast Viewer
  serve, over `viewer_find` / `viewer_replace`), `src/editorExtras.ts`, `src/autocomplete.ts`,
  `src/snippetRegistry.ts`, `src/findWidget.ts`, `src/findOptions.ts` (options shared with
  Workspace Search), `src/findHistory.ts` (the find and search fields' query history — the
  Up/Down recall — shared with Workspace Search), `src/bookmarks.ts`, `src/cmTheme.ts`,
  `src/markdown.ts` (preview; also renders extension READMEs)
- Backend: `src-tauri/src/viewer/` (`doc.rs`: ropey rope + syntect highlight checkpoints;
  `find.rs`: the whole-document find/replace matcher, scan and replacement pass;
  `indexed.rs`: the memory-bounded line-index viewer for enormous files (index + on-demand
  windows + streaming find); `outline.rs`: symbol outline), `src-tauri/src/encoding.rs`
  (encoding detection and line endings)

### 7. Large-File Viewers

A million-line file opens as fast as its bytes can be read; a multi-gigabyte binary is
paged, never loaded whole.

- Frontend: `src/scroll/` (the row scroll model every viewer and the windowed editor
  share — Zed's ScrollManager in TypeScript: `model.ts` owns the viewport's top as a row
  index, clamped, with the autoscroll strategies; `wheel.ts` reads a wheel event as system
  lines per notch or trackpad pixels; `amount.ts` the page distance; `input.ts` the DOM
  listeners; `scrollbar.ts` the drawn scrollbar — the surfaces scroll nothing natively, so
  no document is too tall for the layout engine), `src/fastView.ts` (Fast Viewer —
  backend-rope document, the visible rows only), `src/hexView.ts` (offset / hex / ASCII),
  `src/hexCompare.ts` (byte-aligned two-pane compare)
- Backend: `src-tauri/src/viewer/`, byte comparison in `cmd_search.rs`, chunked reads via
  `cmd_fs.rs`
- Dev probe: `dev/hex-probe.html` (the hex view in isolation, against any theme)

### 8. Compare & Merge

The Beyond Compare workflow: folder comparison with sync actions, git-conflict resolution
in place, and side-by-side diffs of any two revisions.

- Frontend: `src/folderCompare.ts`, `src/mergeEditor.ts` (walk conflicts, keep
  ours/theirs/both, Mark Resolved), diff editors in `src/editor.ts` / `src/textEditor.ts`
- Backend: folder comparison in `cmd_search.rs`, revision contents via `cmd_fs.rs` /
  `cmd_scm.rs`

### 9. Source Control

The Source Control view (commit input, Merge / Staged / Changes groups, inline
stage-unstage-discard), the Timeline of a file's commits, and the git command set of VS
Code's Git extension plus the gerrit contributions (amend, soft-reset to remote,
commit-msg hook, `refs/for/` push).

- Frontend: `src/scm.ts`, `src/gitCommands.ts`, `src/fileHistory.ts`
- Backend: `src-tauri/src/cmd_scm.rs` (status over one parsed `git status --porcelain`, the
  Timeline's `file_log` over `git log --follow`, mutations through the git CLI),
  `src-tauri/src/scm_ops.rs` (the "..." menu operations plus the palette's branch/remote/
  stash/tag writes), `src-tauri/src/git.rs` (the one and only git-CLI runner, plus the pure
  ref/hash validators `fetch` shares)

### 10. Git Graph Engine (the git-graph-rs plugin)

The Git Graph view is an extension package: the extension packs itself — its own
`studio/build.mjs`, in the extension's repository outside this tree, builds everything of it
(the extension's own webview page, the config/compare page bundles, the in-page bridges, the
engine, the write path) into one self-contained `.vsix` (the store's own format; the
Studio-specific capabilities ride inside it under `package.json`'s `ggs` key, which VS Code
ignores and the app turns into the runtime `manifest.json` on install —
2026-09-24, before this the package was a bespoke zip), installed from the Extensions
view's one-click offer (or by hand). The page plays the extension host's own role in-page:
its own `studio/bridge.js` (the view) and `studio/compare-bridge.js` (the comparison
pages) generate the extension's own pages, compose the theme and `acquireVsCodeApi`, serve
the shell's own requests through the generic page services, and translate the view's protocol
onto the engine's dispatch surface before forwarding over `backend.run` — the one channel any
plugin's page uses (unified 2026-09-23: the old `backend.message`/`ggx-rpc/1` pair is gone;
the compare bridge gained the same translation layer 2026-09-24 — before it, every one of its
reads named a method the engine does not serve and the comparison pages opened empty).
**The app binary never links `git-graph-core`
and names no plugin id** (moved out of the app 2026-09-23; nothing under `src/` may name
the extension's artifacts — `scripts/check-seams.mjs` fails the build on any reference).

- The real-Node extension host (2026-09-25, replaces the deleted C-ABI engine host; the
  explicit `GGS_REAL_NODE=1` opt-in — the default host for every `node` backend is
  ggs-node, module 12): a system Node runtime (`ext_node_runtime` — `GGS_NODE_EXE`, a
  `node` beside the app, or the `PATH`) runs `node node-host.cjs <extension-dir> <entry>`
  — VS Code's own architecture,
  where an extension host is a node process and a package's `.node` loads as the NAPI addon
  it is. The bundle (`src/nodeHost.ts`, built by `prepare.mjs` into `node-host.cjs`) carries
  the same `vscode` shim the frames use over the ggs-ext/1 stdio channel: extension→host
  services cross as `ggs.hostRequest` requests (forwarded to the workbench, which answers
  through the same `serve` path a frame's RPC takes), host pushes arrive as
  `ggs.hostEvent` notifications, and only `require('vscode')` is intercepted — a package's
  ESM, workers, `node_modules` and `.node` all behave natively.
- The package's own web side (the extension repository's `studio/`: `bridge.js`/
  `compare-bridge.js` the in-page extension hosts, `bundle.mjs` the page bundles with
  relative URLs, `config-stdin.js` the config bundle's entry, `vsix.mjs` the zip writer,
  `stubs/` the `vscode` / Node / `fs` shims the bundles build against)
- Host side (generic): `src-tauri/src/ext_process.rs` (spawns every installed backend, the
  start handshake carries the open folders, `notify_workspace` pushes changes, a manifest
  still naming the retired `ggx-rpc/1` fails its start with an upgrade hint),
  `src-tauri/src/ext_protocol.rs` (the one wire protocol, `ggs-ext/1`: JSON-RPC 2.0 over
  stdio, `serve_plugin` dispatching every request onto its own thread — the view's opening
  burst of reads never serializes), `src/extHost.ts` (the page services:
  `theme.stylesheet`, `backend.run`, `workbench.*`, singleton pages, theme/workspace pushes)

### 11. Integrated Terminal

xterm.js fronting portable-pty sessions (ConPTY on Windows), with new/kill actions and the
terminal list.

- Frontend: `src/terminal.ts`
- Backend: `src-tauri/src/pty.rs`

### 12. Extension Platform

The extension store (`~/.ggs/extensions/`): **one package format, the store's own `.vsix`**
(since 2026-09-24 the only one — the custom `.ggx` package format was removed; an install
made from one before that still runs and uninstalls, nothing new installs from one). A
VSIX is a plain VS Code package — no host-specific `package.json` key is read (2026-10-01,
the owner's direction: the `ggs` key is gone; the retired `ggs/2` vocabulary survives only
as history). The install derives the runtime `manifest.json` from the package itself
(`ext_install_from_vsix` → `resolve_node_binaries`): identity from `package.json`, and a
backend when the package needs one — native `.node` binaries, or a `main` the sandboxed
frame cannot host: too big for the frame's code map (2026-09-27, the Kimi rule), or opening
listening sockets through a qualified call (`http.createServer(…)` — the frame's http/net
shims are client halves, nothing there can accept a connection; Claude Remote's LAN server
is this rule's resident, and a minified bundle's aliased `l.createServer` never trips it).
A package with neither entry nor binaries needs no backend at all — the frame host serves
it whole. The named page registry (every page a package can show, opened as editor tabs
over the `ggs://` protocol) registers at runtime through the process-command dispatch, and
the backends are: a
process binary (speaking the `ggs-ext/1` line-JSON-RPC protocol over stdin/stdout — any
language that can write lines to stdout qualifies) or a `node` backend (`kind: "node"`) —
the package's own JS entry. **ggs-node is the default host** (2026-09-25, the owner's
direction): every `node` backend runs on the bundled pretend Node runtime (`ggs-node`,
Boa + CommonJS + the file/os/process builtins, whose `initialize` answers in milliseconds
and queues the activation — shim install, entry `require`, `activate` — as the next job on
the one JS thread (2026-09-27: a multi-megabyte bundle's parse-and-compile is seconds on
the interpreter, and the handshake — the app's `ext_process_start`, the Extensions view's
status — no longer waits it out; requests arriving meanwhile order behind the activation,
the FIFO job queue being the gate), and whose own N-API host (`node_runtime/napi_host.rs`
— the `napi_*` surface bound to the sidecar image) loads a package's `.node` addon right
there: when the extension's activation `require`s the engine `git-graph.node`, it registers
into Boa and serves the reads (an integration test and the live check assert the ggs-node
process carries it). A main-only package with no native binaries installs no backend at
all — the sandboxed frame host owns it. The real-Node extension host (`node node-host.cjs <extension-dir> <entry>`,
VS Code's own architecture, where `.node` NAPI addons, ESM, workers and `node_modules`
behave natively) is an explicit opt-in — `GGS_REAL_NODE=1`. A plain VSIX with the packers'
engine layout derives, at install, the engine `.node` as its backend only under that
opt-in; by default its JS `main` is the derived backend (`resolve_node_binaries`);
plus the Extensions view with detail
pages, backend status and restart, and the **marketplace** (2026-09-24): Open VSX — the
open-source registry the VS Code ecosystem publishes to, the same service code-server and
Theia point at. The view offers exactly the featured packages `ext_gallery.rs` names
(`FEATURED`: claude-code and git-graph-rs — no free-text search, 2026-09-27), each looked
up by exact id as THIS machine's platform build (the registry's bare listing answers an
arbitrary platform), over `ext_gallery.rs`'s commands (featured ids, lookup, icon,
download-and-install), every URL confined to the gallery's own origin, and
a marketplace package installs through exactly the path a picked `.vsix` takes (forward-
only upgrades, the unhostable-`.node` door). Frame-host extensions run under `extHost.ts` +
`vscodeApi.ts` with a growing `vscode` API surface: commands, configuration (with
`onDidChangeConfiguration` pushed in), message toasts with MessageItem, quick picks (string
and object items), `withProgress` toasts, output channels (the Output view's channel
dropdown), status bar items (`window.createStatusBarItem` / `setStatusBarMessage`, rendered
by the status bar), webview panels (`window.createWebviewPanel` — a sandboxed srcdoc iframe
in an editor tab, with `acquireVsCodeApi()` composed in, `asWebviewUri` mapping onto
`ggs://`), persisted `globalState`/`workspaceState` mementos, and `env.clipboard`; VS Code's
own built-in commands (`vscode.diff` / `vscode.open` over a registered text-document content
provider's scheme — the host asks the registering frame for the text and opens the diff
editor or a read-only content tab, decoding nothing of any package's private schemes;
`setContext`; `workbench.view.*` / `openSettings`); `window.showTextDocument` of a
provider-scheme document (claude-code's chat opens its tool outputs and code blocks this
way, as `_claude_vscode_fs_readonly:` Uris) opens the read-only content tab too, and
every placed open — `showTextDocument`'s and `vscode.open`/`vscode.diff`'s `ViewColumn` —
lands where `editorArea.ts`'s `EditorPlacement` says: `Beside` in the side editor group
(a fresh right split when there is none, the same layer reused after — the chat keeps
its half of the area), a column number in that group; `workspace.createFileSystemWatcher`
served from the backend watcher's real batches (`fsChanged` events into every frame, the
`.git` flag firing a `.git/HEAD` change); `window.createTerminal` (`sendText` runs in the
integrated terminal); and `crypto.createHash` (md5 / sha1 / sha256, pure TypeScript — the
gravatar-class digests, synchronous like Node's). The read half of
`workspace.registerFileSystemProvider` serves too (2026-10-02): the provider parks in its
frame/process, the host remembers the scheme's owner, and `vscode.open` / `vscode.diff`
fetch the text through `fsProvider.read` — claude-code stages its change-review diffs'
both sides in in-memory `_claude_*_fs_*` schemes, and until this bridge those diffs opened
empty; watch and the directory members stay the extension's own (the host never enumerates
a package's VFS).
**Which extension packages the installer carries is the build's choice** (never a
per-install one): `prepare.mjs` packs the marketplace builds — Open VSX, per architecture,
downloaded by `scripts/fetch-marketplace-extensions.mjs` (no marketplace package has a
local source; a selected package the fetch cannot serve from cache leaves the build
unpacked, or fails it in require mode) — into `extensions/`
beside the app; the one local-source package, Claude Remote, packs from
`extensions-src/claude-remote/` by its own `build.mjs` (2026-10-01: it rides in every
build — no fetch, packs offline). The first launch installs whatever sits there like
VS Code's bundled extensions (`cmd_ext::install_missing_bundled`; a deliberate uninstall
stays uninstalled). Which packages ride is one policy everywhere (2026-09-28, the owner's
direction): git-graph-rs in every build, claude-code in none by default — the Extensions
view's marketplace row installs it online on demand — and claude-remote in every build
from its local source. The `GGS_BUNDLE_GIT_GRAPH` / `GGS_BUNDLE_CLAUDE_CODE` /
`GGS_BUNDLE_CLAUDE_REMOTE` env are the switches (CI's release form forwards its
checkboxes; `GGS_BUNDLE_CLAUDE_CODE=1` opts a build back in, `GGS_BUNDLE_CLAUDE_REMOTE=0`
leaves the local package out — which then installs only from a hand-picked VSIX, for it
is not on the marketplace). A marketplace package a build left out still installs from
the Extensions view's marketplace row. **Install means run**: the boot
pass starts every installed package that declares a backend
(`ext_process::start_all_installed`, off the window's thread), an install starts its
backend at once, and the first command remains the lazy fallback.
Multiple app instances are independent — each spawns and owns only its own backends
(`GGS_INSTANCE_ID` marks the owner), every backend this instance spawned is stopped on
exit, and an uninstall stops the backend before removing its directory (a directory another
window's backend still holds refuses with a close-that-window hint). A completed uninstall
stays uninstalled: the boot pass brings only *installed* packages current — a bundled build
newer than an install upgrades it forward-only (the install hides the Extensions view's
bundled offer, so this is the id's only update channel), and the same version unpacked
from an older build is refreshed by its recorded build stamp — but nothing installs from
nothing.

**The AI provider bridge** (2026-09-29): the claude-code backend runs under a chosen
model provider — the official Claude service or any Anthropic-compatible endpoint
(DeepSeek, Zhipu GLM, Moonshot Kimi, a custom gateway). The store lives at
`~/.ggs/ai-providers.json` — never Claude's own `~/.claude`: `cmd_providers.rs` seals
every API key with AES-256-GCM under a per-install master key
(`~/.ggs/keys/ai-providers.key`, 0600) and decrypts one only when `ext_process` spawns
the bridged backend — through the spawn-env source the composition root registers
(`lib.rs`'s `run` wires `cmd_providers::backend_env` onto
`ext_process::add_spawn_env_source`), so `ext_process` names no provider knowledge and
the coupling stays one-directional (providers reach the spawn path only through the
composition-root-registered environment source; the spawn path is
provider-agnostic). That spawn always carries `CLAUDE_CONFIG_DIR=<~/.ggs/claude>` (the
extension's own state — login, history — never touches `~/.claude`; an explicit
`CLAUDE_CONFIG_DIR` in the app's own environment wins — the sandbox probe's hermetic
config dir rides on it), and the active
third-party profile adds `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` plus the tier-alias
remap `ANTHROPIC_DEFAULT_{OPUS,FABLE,SONNET,HAIKU}_MODEL` (the flagship tiers — opus and
fable — take the profile's
main model, the everyday tiers its small one — GLM: opus and fable → glm-5.3, sonnet and
haiku → glm-5.3-flash — so a tier pick in Claude's `/model` never sends or shows a
`claude-*` id a
provider does not serve) and `CLAUDE_CODE_ATTRIBUTION_HEADER=0` (2026-09-30, the owner's
direction: Claude Code's attribution header is off on every third-party endpoint —
Anthropic-compatible gateways fold it into their request identity, so the same prompt
stops hashing equal and prompt-cache reuse drops, while the official endpoint's prefix
cache ignores headers and keeps the default; switching back to official clears it with
the rest) and `CLAUDE_CODE_AUTO_MODE_SERVER=0` (2026-10-01, the owner's direction: auto
mode's server-side classifier checks are off on every third-party endpoint — gateways
strip the `safeguards` fields those checks ride on, so the verdicts never arrive and
Claude Code holds the first checked action on an eligibility notice before falling back
to its own billed classifier requests; asking for the fallback up front keeps auto mode
notice-free, while the official endpoint serves the checks at no charge and keeps the
default),
inherited by the
extension's CLI children (the same takeover `claude-code-sandbox.mjs` proves against a
local server). The UI is the sidebar chip on the Claude view's section header
(`aiProviders.ts` — mounted only for the ids the backend's `bridgedExtIds` names, so
`src/` names no extension id), its quick pick, and the Model Providers page
(`providersPage.ts`, the `ai.providers` command); switching provider (or editing the
active profile) writes the provider environment into the redirected Claude settings
(`apply_claude_provider_env` — the `env` map Claude Code applies at every session
start, the mechanism cc-switch uses) **and restarts the running bridged backend**
(`restart_bridged_backends`, 2026-09-30 — the never-restart cut shipped that morning
and left the sidebar on the old provider's login page forever: the extension process
applies the env map once, at its own start, so a running one keeps answering with the
provider it booted under; the fresh process reads the rewritten settings, and the
settled start attempt — success or failure, the old process is dead either way — is
announced as the `ext-backend-restarted` event, on which the
extension host re-resolves the extension's webview views — the chat page reloads with
the new provider, a conversation in flight restarting on it); the spawn environment
carries `CLAUDE_CONFIG_DIR` plus the active provider's own pairs (2026-10-01, the
long-login-page bug: the settings env map is applied by the CLI at its start, never by
the extension process — a fresh backend whose `process.env` carried no
`ANTHROPIC_AUTH_TOKEN` answered its auth status null and the chat rendered the official
login page until the CLI's config probe, tens of seconds under ggs-node, delivered the
third-party verdict; the extension reads `process.env` for exactly this shape, Claude
Code's own keyless-auth form, authenticated from the first state push). Both sinks —
the settings write and the spawn env — derive from the one store read, and the switch's
restart keeps them in step. Writing the settings clears this bridge's keys when the official
profile is active (a stale endpoint would shadow the login), preserves the user's own
env keys, and lands the file at 0600 when it carries a key. The settings' top-level
`model` pin rides the same takeover (2026-09-30, the `claude-fable-5-1[1m]` bug: a
`/model` tier pick persists there and outranks the env map, so the pin is rewritten to
the active profile's model while one is pinned, and a pin naming an id the official
service cannot serve is cleared — the user's own `claude-*` / tier-alias pin survives
verbatim). Commercial finish
(2026-09-30): a **NewAPI gateway** preset beside
DeepSeek / GLM / Kimi, a **Test Connection** probe (a 1-token `/v1/messages` round
trip whose every HTTP answer is a diagnosis — key rejected, wrong base URL, throttled)
and a **Fetch Models** catalogue read (`/v1/models`, the OpenAI-compatible shape every
gateway answers) — both probing with the form's typed key or, untouched, the stored
profile's decrypted one; and a **cc-switch import**: `provider_ccswitch_scan` reads
`~/.cc-switch/config.json` (both the array and id→map shapes, `claude.current` by its
raw key) plus the live `~/.claude/settings.json` env — keys stripped from the answer,
deduplicated by endpoint+key — and `provider_import_ccswitch` seals the named ones
into the store and activates the one cc-switch points at. **The analysis rides into
Claude itself** (2026-09-30): `apply_claude_mcp` — wired at the composition root beside
every `notify_workspace` call — keeps a `ggs` entry in the user-scope `mcpServers` of
the redirected global config (`~/.ggs/claude/.claude.json` — the one place Claude Code
reads user-level MCP servers from; the first cut of this bridge wrote `settings.json`,
whose schema has no `mcpServers` key at all, so Claude never listed the server — fixed
the same day, the stale entry retired wherever it is found), pointing at the app
binary's own `ggs --mcp <folder>` headless mode for the open folder (removed when no
folder is open, Claude's own login and state keys in the file preserved verbatim, an
unparseable file failed on rather than replaced, the write landing 0600), plus the
`mcp__ggs` auto-allow rule in `settings.json`'s `permissions.allow` — every tool the
server serves is a read-only, repository-confined read, and the zero-configuration
promise is that a session never prompts for one. Every new Claude session therefore
lists the `ggs` MCP server under `/mcp`, no setup and no approval — the persistent
symbol index and the analysis tools, with the `initialize` handshake's `instructions`
teaching the model the workflow (map a name's blast radius before editing, chase
cycles while refactoring, self-check dead code and secrets after). The MCP Server
page shows the integration's state (`claude_mcp_status`).

- Frontend: `src/extensionsPanel.ts` (the Extensions view: the installed list with detail
  pages and backend status: the featured packages' rows, each its Open VSX entry merged
  with its installed state — one-click Install / Update by the installed version, the
  bundled offer as the offline fallback — and anything else installed under "Other
  installed"), `src/aiProviders.ts` (the AI provider bridge's store client and the
  sidebar switcher chip — the active provider's name on the Claude section header, the
  quick pick that switches or opens the page), `src/providerUsageView.ts` (the bridge's
  usage surfaces: the token-usage curve — `provider_usage`'s per-UTC-hour answer
  re-bucketed into local today / 7-day / 30-day ranges, one smooth line with a hover
  breakdown of cache hits, cache writes, uncached input and output, tokens only, never
  money or durations — and the chat pane's gate, `mountProviderPaneGate`: while the
  active third-party provider of a preset that requires a key has none, the pane
  carries the set-key page over the extension's own login one, and once the key lands
  the curve rides as a compact strip above the chat; the page and the strip share
  `mountUsagePanel`), `src/providersPage.ts` (the Model
  Providers page — flat and compact: the usage card, the profiles as one-line rows,
  the add/edit form whose key field travels once into the
  backend's seal, activate and delete), `src/nodeHost.ts` (the real-Node
  extension host's entry, compiled to `node-host.cjs`: stdio ggs-ext/1 server, the shared
  `vscode` shim over a stdio bridge, `require('vscode')` interception, ESM fallback —
  VS Code's own extension-host shape), `src/extHost.ts` (the extension host for VSIX
  extensions — frames without a Node runtime, remote handles over ggs-ext/1 with one;
  the page host, the process-command dispatch, and the host services behind the
  `vscode` API — webview panels, webview views, status bar items, output channels, progress
  toasts, memento persistence, tree views, activationEvents; the activation policy also
  derives the implicit `onLanguage` events VS Code 1.74 reads off `contributes.languages` /
  `contributes.grammars`) + `ext-host.html` +
  `src/extHostBoot.ts` (one sandboxed frame per extension), `src/vscodeApi.ts` (the `vscode`
  shim the frames require; unsupported surfaces degrade to inert registrations instead of
  throwing — an activation must survive whatever a foreign package registers — and every
  value type a load-time destructure touches (`Position`, `Range`, `SnippetString`,
  `CodeActionKind`, …) constructs), `src/extModuleLoader.ts` (the frame's CommonJS resolver
  over the activation preload `ext_load_code` — un-bundled multi-file packages and their
  `node_modules` load exactly as in Node: relative siblings, package.json `main`, cache,
  circular partials, `MODULE_NOT_FOUND`), `src/ggsVscodeShim.ts` (the same `vscode` shim bundled as the IIFE ggs-node evaluates when a package's entry is a frame program — ggs-node's own frame-program host; a backend command's arguments cross JSON at both hops, which has no `undefined`, so its dispatch restores a top-level `null` arg to the `undefined` the caller passed — handlers branch on `arg !== void 0` (claude-code's `editor.open` computes its column that way), and the placeholder args the host's `claudeChatRun` sends landed as `null` and threw in Boa; frames need no restore, postMessage's structured clone keeps `undefined`), `src/nodeShims.ts` (the Node builtins — `path`,
  `os`, `events`, `util`, `fs` over the preload and the workspace-confined bridge, `Buffer`,
  `process`; real implementations for what a frame can serve — `child_process` through the
  host bridge, `nodeShims/processSurfaces.ts` + `shared.ts`, and `stream` —
  `nodeShims/stream.ts`, Readable / Writable / Duplex / Transform / PassThrough with
  `pipe`, `pipeline` and async iteration — call-time failures for what it cannot
  (`net`), each reported to the extension host log, so a `require` of them never kills
  an activation),
  `src/extLog.ts` (the extension host log: one record of every extension-platform
  anomaly — activation failures with their stacks, command / provider / listener
  exceptions, failed host requests, each unsupported VS Code API a package reaches for —
  into the Output view's "Extension Host" channel and `~/.ggs/logs/ext-host.log`, at the
  `extensionLogLevel` setting's threshold; the `extensions.showLog` /
  `extensions.openLogFile` commands),
  `src/claudeChatInject.ts` (the host's Claude Code chat driver behind
  `ggs.claudeChat.*`: the composer typed into and sent, the turn interrupted, the model
  picker chosen, the AskUserQuestion card answered — the page's own DOM, same-origin),
  `src/editorDiagnostics.ts` (the diagnostics store: the host's
  `languages.createDiagnosticCollection` entries land as CodeMirror squiggles in the open
  editors) + `src/editorDiagnosticsView.ts` (the CodeMirror half, loaded with the editor
  suite so the lint library stays off the first-paint bundle),
  `src/treeView.ts` (the generic tree view host — the sidebar
  surface `contributes.views` declares and `createTreeView` feeds),
  `src/contributions.ts` (manifest contributions merged into the workbench; the manifest
  shapes VS Code accepts — `configuration` as object or array, `keybindings` as object or
  array, views with `type: "webview"` — normalize on read); the surfaces it
  reaches into: `src/statusbar.ts` (extension items), `src/panel.ts` (the Output view's
  channel dropdown), `src/ui.ts` (`progressToast`)
- Backend: `src-tauri/src/cmd_ext.rs` (install / upgrade / uninstall, `.vsix` unpack, the
  bundled-package registry — git-graph-rs, `ext_install_bundled`'s id — the `ggs://`
  protocol that serves an installed package's files — composing the page bootstrap into
  every HTML page, `ext_fs` — the workspace-confined file services behind
  `vscode.workspace.fs`, `findFiles` and `workspaceContains` activations, confined to
  the open folders plus the extension's own install and storage directories —
  `ext_log_append` / `ext_log_path` (the extension host log file, rotated) and
  `ext_storage_paths` (an extension's `~/.ggs/extension-data/<id>` storage) — `ext_load_code`
  (the package's bounded loadable-code map the frame's CommonJS loader resolves against)
  and `ext_node_env` (the Node environment facts the frame's `os`/`process` shims carry)),
  manifests read as JSONC — comments and trailing commas, the tolerance VS Code's own
  reader applies,
  `src-tauri/src/ext_gallery.rs` (the marketplace: Open VSX search, icon fetch and
  download-and-install over ureq, origin-confined, a marketplace package installing
  through `cmd_ext`'s ordinary VSIX path),
  `src-tauri/src/cmd_providers.rs` (the AI provider bridge: the provider store under
  `~/.ggs/ai-providers.json`, the AES-256-GCM key sealing under `~/.ggs/keys/`, the
  built-in presets — official / DeepSeek / Zhipu GLM / Moonshot Kimi / custom, each
  flagging whether it can run keyless — `provider_usage` (the usage curve's data: the
  redirected Claude state's session transcripts `~/.ggs/claude/projects/**/*.jsonl`,
  their assistant turns' usage records aggregated per UTC hour over the last 31 days,
  tokens only) and the
  spawn-time environment `ext_process` injects into the bridged backend through its
  registered spawn-env sources — the composition root's wiring, so the two modules do
  not name each other),
  `src-tauri/src/ext_grammar.rs` (the TextMate-grammar loader: `.tmLanguage` plists and
  `.json` grammars converted to Sublime syntax and added to the rope viewer's syntect set), `src-tauri/src/ext_process.rs` (the process extension host: eager
  start at boot and install, lazy start on first command as the fallback, `initialize`
  handshake, `runCommand`, crash isolation, remembered status (start count, last error),
  stop on uninstall and at app exit; a `node` backend runs on the bundled `ggs-node` (the
  default) — off the main thread, with the backend's own `ggs.hostRequest`s forwarded to
  the workbench as `ext-host-request` events — or, under the `GGS_REAL_NODE=1` opt-in, on
  the real Node runtime plus `node-host.cjs`; `resolve_node_binaries` (cmd_ext) derives a
  backend from a package's engine `.node` (real-Node host), its `package.json` `main` when
  native binaries are present, or — loadable code the sandboxed frame cannot host — an
  oversized entry, or a qualified `http.createServer`-class call anywhere in the package's
  `.js`/`.cjs` surface (2026-10-01: the scan reads the whole loadable tree, not the entry
  alone — Claude Remote 0.2 moved its server into `server.js` and the entry-only scan
  left the package `backend: null` in a frame that could not even resolve its siblings)),
  `src-tauri/src/node_runtime/` (`ggs-node`, the `node-runtime` feature's
  pretend Node runtime sidecar — the default `node`-backend host: Boa on one JS thread fed
  by a job queue — protocol requests, timers, child-process events, the activation — a CommonJS `require`
  confined to the package root (`require.rs`), real `fs`/`path`/`os`/`child_process`
  builtins over std (`builtins/`: `mod` the registry, `fs`, `path`, `os` — including a
  real `networkInterfaces()` over if-addrs (2026-10-01: Claude Remote's pairing QR needs
  the machine's true LAN addresses; the prelude's empty stub is gone), `child`, `net`
  the TCP sockets and the HTTP(S) client under the prelude's `net` / `http` / `fetch`,
  `core` the prelude natives — the crypto ones in Node's own shapes since 2026-10-01:
  PBKDF2 (sha1/256/512, string or Buffer password), AES-128/192/256-GCM whose `update`
  answers as it goes over the GCM counter stream with encodings honoured and AAD read
  at its byte offset, and Buffer's base64/base64url codec; bytes cross as typed arrays,
  the old base64-string hop hung on a 600 KB message — `support` the shared helpers), `alloc.rs` the size-class
  free-list global allocator the `ggs-node` binary installs (a bundle load is millions of
  small allocations, a third of its parse+compile time in Windows `HeapAlloc` round trips
  alone; the JS thread keeps lock-free per-thread lists, other threads share one guarded
  pool), the JS prelude's
  Buffer/EventEmitter/util/`vscode`-stub (`prelude.js`), the N-API host a package's
  `.node` loads through (`native.rs` the loader, `napi_host.rs` the `napi_*` surface) —
  and the dispatch: launcher → `ggs.onRequest` → `exports.dispatch`; stdout is the
  protocol, package code writes through `ggs.log` only; `examples/boa_bench.rs` the
  scratch parse/compile benchmark — `boa_bench <bundle.js> [parse|compile|lexer|read]`),
  `src-tauri/vendor/` (the patched Boa 0.21.1 crates the sidecar's parser and
  compiler run through, wired by `[patch.crates-io]` in `src-tauri/Cargo.toml`; the
  semantic diffs against crates.io are one match arm each, marked with GGS-patch
  comments: `boa-parser` lets a contextual keyword name a class expression —
  `var e = class of extends Error {}` ships inside real bundles and the stock parser
  dropped the name; `boa-ast` makes the scope-index visitor count a class constructor's
  function scope, without which `constructor(a = 1)` aims parameter locators one
  environment short and `new` panics; `boa-engine` balances the logical-assignment
  locator pair — a short-circuit `x ??= v` stranded its pushed locator and the next
  locator write hit the wrong binding — and degrades a poisoned `PutLexicalValue`
  (the known `Function`-constructor miscompile) instead of killing the JS thread; the
  grammar and semantics are pinned in `tests/vscode_shim_boa.rs`, the compile semantics
  end-to-end in `tests/node_runtime.rs`; retire the fork when upstream carries the
  fixes. Performance patches ride along (2026-09-27, same marking), taking Claude
  Code's 3 MB bundle from 13.2 s of activation to under a second end to end:
  `boa-ast`'s `Scope` carries a name→index map (with a negative-cache sentinel for
  free variables) beside its binding vector — every by-name lookup was a linear scan,
  and a real bundle's scope analysis and bytecode generation resolve identifiers
  millions of times; `boa-ast`'s `SourceText` grew `reserve` and `boa-parser`'s
  `Source` carries a `len_hint` (`from_bytes`/`from_utf16`) that the parser hands to
  the lexer cursor before the first character — the source collector otherwise grows
  by doubling, every growth a full memcpy of the text gathered so far; `boa-engine`'s
  `Script` compiles the module wrapper through the real escape analysis FIRST — register
  locals are plain register `Move`s, and a `for (let …)` loop stops allocating a
  per-iteration environment (2026-09-28: a microbench loop -40%, calls -34%) — with two
  compile-time guards falling the module back to `parse_all_bindings_escaping` (every
  binding in its environment, the mode ggs-node used before): a binding used before its
  declaration point (`TRIPPED_UNINITIALIZED_LOCAL` — Boa 0.21.1 bakes a static TDZ throw
  into such a site, wrong for every use that runs after initialization; claude-code's
  bundle trips it, real bundles carry those sites) or a register file deeper than
  `REGISTER_LOCALS_LIMIT` (4096; the VM stack limit is 10 240 slots shared by every frame
  and one huge frame reads past the checking point) — and parks a large script's compiled-out AST in
  `free_released_sources` instead of dropping it inline (tearing down a bundle's tree
  is millions of frees; the embedder frees it at idle), memoizes `Sym`→`JsString`
  inside a `JsStringMemo` scope (scope analysis and codegen resolve the same few
  thousand names millions of times), and `bytecompiler`'s declaration sets are hash
  sets (the membership tests were quadratic in a bundle's top level); `boa-parser`'s
  lexer cursor peeks through a ring (the old array `rotate_left`ed on every consumed
  character — ~30% of the lexer's time over a bundle); `boa-engine` also carries the
  module bytecode cache (`vm/bytecode_cache.rs`): a compiled wrapper's whole tree
  crosses as a bincode mirror whose scopes are one FLAT table — each distinct scope
  once, `Rc`-deduped, ancestors first (a recursive mirror expanded claude-code's
  25 thousand shared chains into a serialize that never finished) — and whose source
  text is written ONCE (every block's `SpannedSourceText` is an `Rc` clone over it
  with its own span; the naive per-block copy was the full 3 MB per function), and
  `Script::from_compiled` runs the rebuilt tree without parsing; ggs-node's `require`
  keys the blob by the source's SHA-256 under `~/.ggs/cache/bytecode/` (claude-code:
  parse 257 ms + compile 65 ms become one 29 MB read at 57 ms — cold activation
  0.79 s, warm 0.41 s; any decode failure falls back to a normal compile);
  node_runtime
  runs with the AST optimizer off (its one constant-folding pass is a full extra tree
  walk for what a minifier already folded) and installs `node_runtime/alloc.rs` as the
  sidecar's global allocator. Command registrations cross as one batch —
  `vscodeApi` queues an activation's `registerCommand` calls and every host flushes
  once the activation settles (`__ggsFlushRegistrations`; `extHost.ts`'s
  `commands.registerBatch` serves it) — each separate registration paid its own pipe
  round trip, and claude-code registers 31 on activate. `GGS_PHASE_TRACE=1` (phase
  timing, including the lexer/parser vs scope-analysis split), `GGS_TRACE_BOOT=1`
  (activation milestones), `GGS_OPCODE_STATS=1` / `=time` (per-opcode instruction counts,
  and per-opcode owned time — the interpreter-side diagnosis; claude-code's activation
  spends its execution in `Call` frames, property paths and the per-instruction dispatch
  floor) and `boa_bench` measure it all; keep the scope index fed
  if any binding-creating path changes), and the sidecar builds through its own `[profile.ggs-node]` — the release size
  diet with unwinding panics, because third-party JS must degrade its own miscompiled
  closures, never abort the backend (`scripts/prepare.mjs` builds it that way),
  `src-tauri/src/ext_protocol.rs` (the `ggs-ext/1` wire
  protocol, shared with plugin binaries), `src-tauri/src/ext_page_boot.js` (the
  `acquireGgsApi()` bootstrap the protocol composes into served pages),
  `src-tauri/src/ext_child.rs` (the frame host's child processes: one `ext_child_spawn` +
  stdin/kill follow-ups per spawned tool, stdout/stderr streamed as base64 `Channel` events,
  every handle killed at app exit and on extension reload — the real process surface a
  sandboxed frame cannot have, which `nodeShims.ts` maps onto the Node `child_process`
  shapes; the sync variants stay call-time failures, a frame cannot block its loop)
- The packer lives in the extension's own repository (its `studio/` —
  `build.mjs` the packer, `bundle.mjs` the page-bundle builder, `config-stdin.js`,
  `vsix.mjs` the zip writer, `stubs/` the bundle stubs, plus the two in-page bridges); the
  app tree carries no plugin code, and no build step of this repository runs the packer —
  the package arrives here as the marketplace's VSIX (or a hand-picked `--vsix`).
- The one extension with source in this tree: `extensions-src/claude-remote/` (Claude
  Remote (LAN), rewritten 2026-10-01 — continue the open workspace's Claude Code
  conversations from a phone. `sessions.js` reads Claude Code's store read-only from the
  host's one config root (Git Graph Studio `~/.ggs/claude`, VS Code `~/.claude`, an
  explicit `CLAUDE_CONFIG_DIR` over either — never a mix of the two stores), scoped to the
  workspace folders by default, incrementally (a poll re-reads only appended bytes), and
  tail-first: a cold open parses only the last 512 KB (long conversations answer in tail
  time, not whole-file time) and older history parses backward in 1 MB steps when a wider
  window — or a `before` page, one screen of earlier history — is asked for; prepended
  items take stamps counting down below the parsed floor, so file order keeps increasing
  stamps and the phone's delta cursor survives the extension (a before page never advances
  it);
  `runner.js` runs phone prompts through the desktop's own `claude` CLI (the Claude Code
  extension's bundled native binary first; `-p --output-format stream-json`, prompt on
  stdin, `--resume` under the session's own config root; a `.js` CLI runs on each host's
  own Node — `nodeExecutable`: real Node itself, VS Code's Electron under
  `ELECTRON_RUN_AS_NODE=1`, ggs-node through the system `node`, since the sidecar is an
  extension host and loaded the script as one, losing the prompt) with one lane per conversation —
  "send now" interrupts the running turn, "after this turn" queues behind it (and behind a
  desktop turn visibly in flight); stop pauses the queue. `server.js` serves the phone
  app (`web/`, CSP-strict, sjcl for crypto since the LAN origin is not a secure context)
  and one sealed endpoint: AES-256-GCM under PBKDF2(code), AAD `cr2:req:<kid>` /
  `cr2:res:<nonce>`, a ±5 min clock window, single-use nonces, per-address lockout. The
  pairing secret persists in `context.secrets`; "Reset Pairing Key" swaps it and every
  paired device gets `401 rekeyed`. `panel.js` is the desktop panel (QR per LAN address,
  masked code, reset, devices, activity). Phone prompts are sent FROM the desktop tab
  in Git Graph Studio (2026-10-01, the owner's direction — a background CLI turn left the
  desktop tab showing nothing): the host's `ggs.claudeChat.send` / `.open` / `.state` /
  `.stop` (`extHost.ts`, driving the page through `src/claudeChatInject.ts`: the
  composer is the form whose submit button carries `data-permission-mode`, its input
  the `role="textbox"` contenteditable; text goes in through the page's own `input`
  handling, send is a click, "now" first clicks the tab's Stop) open or reveal the
  session's tab, type, and send; they answer a ticket at once and run detached, because
  a process-backed caller's JS thread is parked inside a host request; the runner polls
  `.state` (tab busy + the session file) to settle the turn. Only VS Code, which cannot
  reach another extension's page, runs the headless CLI (`claudeRemote.backend`), and
  there `desktop.js` keeps the desktop in step
  (`claudeRemote.desktopTab`): a phone turn opens the session's Claude Code tab
  (`claude-vscode.editor.open`, "pin-to-panel") and reloads it when the turn ends — an
  open chat panel never re-reads its session file, and its next turn would branch off
  the stale history; the reload closes exactly the hosting tab through the host's
  `ggs.sessionTabs.list` / `ggs.sessionTabs.close` (`extHost.ts`, from the
  `update_session_state` session map; VS Code falls back to `window.tabGroups`, closing
  the revealed tab only when it is a Claude Code panel). The phone also sees the
  desktop's current model (`sessions.modelInfo`: settings pin → tier alias through
  `ANTHROPIC_DEFAULT_*_MODEL` → `ANTHROPIC_MODEL` → the latest answered model), each
  session's model and the running turn's (the CLI's `init` event), and can pick one — on
  Git Graph Studio the pick rides the prompt to `ggs.claudeChat.send` as a `model` arg and
  the host chooses it in the tab's own model picker first (`pickChatModel` in
  `claudeChatInject.ts`: the pill is the composer's combobox, the menu its `listbox`;
  best effort — a name the picker does not offer sends with the tab's current model,
  logged); The phone also answers Claude's own questions: an `AskUserQuestion` tool_use
  parses to a structured `question` body (options, multiSelect; `sessions.js`) that —
  alone among tool bodies — rides the sync whole (`server.js` `lazyTool` keeps it), so
  the phone renders a tappable card; `answer` (protocol 4) validates the picks against
  exactly those options ("Other" always, with its text) and hands them to
  `ggs.claudeChat.answer`, which clicks the tab's own option card — per question its nav
  tab (a button whose whole text is the header), then its `role="radio"`/`"checkbox"`
  options by label, and finally the card's own "Submit answers" button — the one act
  that resolves the question (the card collects every click but never submits itself;
  a multi-select keeps toggling until that click) (`answerChatQuestion` in
  `claudeChatInject.ts`; the submitted card renders read-only, and that flip, via the
  `tool_result`'s `"question"="answer"` summary, is what settles the phone's card);
  headless hosts have no tab to click, so there the card is display-only;
  the "default" permission mode passes no flag (the CLI has no `default` choice). A plain VS Code VSIX whose entry runs as a
  `node` backend on ggs-node and installs in VS Code too; `build.mjs` packs the
  store-format VSIX `prepare.mjs` bundles into every installer, self-checked by the
  marketplace validator).
- Build: `scripts/prepare.mjs` (fetches the bundled packages from the marketplace —
  Open VSX per architecture; `--vsix <path>` / `GGS_BUNDLED_VSIX` bundles a ready-built
  VSIX as-is, outranking the registry for git-graph-rs; claude-remote packs from
  `extensions-src/claude-remote/` by its own `build.mjs --out`, no fetch)
- Tests: `tests/extensions.test.ts` (pages, the process dispatch, the real-Node remote
  handle routing), `tests/providers.test.ts` (the provider bridge's frontend half: the
  store client's seam contract — the key travels only inside `provider_save`, never
  back in a `provider_list` — the sidebar chip and its quick pick, the Model Providers
  page, the usage curve's ranges and hover breakdown, and the chat pane gate's two
  states — the set-key page that saves into `provider_save`, the usage strip after),
  `tests/claudeRemote.test.ts` (Claude Remote headless against a fixture store and a fake
  `claude` — the sealed wire as the phone's sjcl speaks it, replay/clock/rekey/lockout,
  workspace scoping, the transcript, send-now vs queue, stop/cancel/resume — plus its
  VSIX packer), `tests/claudeRemoteActivation.test.ts` (its `activate()` against a fake
  of the real VS Code API — no `ggs.*` commands, so the headless CLI backend; on the
  classic threads pool, see `vitest.config.ts`), `tests/claudeChatInject.test.ts` (the
  host's chat driver against a stand-in composer: type, send, interrupt, the model
  picker, the AskUserQuestion card),
  `tests/editor.test.ts` (the extpage tab),
  `tests/editorServices.test.ts` (the diagnostics store and the document-formatting
  registry, booted through the frame bootstrap),
  `src-tauri/tests/node_runtime.rs` (the pretend Node runtime: a package's JS entry served
  over `ggs-ext/1`, the process-host chain over the bundled `ggs-node` sidecar, a NAPI
  addon answering under ggs-node, the installed extension's whole activation; Claude
  Remote's host conformance — its `test/conformance.js` probe (crypto vectors, the sealed
  wire with an sjcl phone, a headless turn) answering `test/conformance.expected.json`
  exactly as `tests/claudeRemote.test.ts` checks it under real Node — the e2e section's
  sjcl-on-the-interpreter cost (~35 s for the sealed 256 KB tool result, against under one
  in real Node) rides `GGS_PROMISE_TIMEOUT_SECS`, the settle-budget knob `settle()` reads
  (30 s by default, raised only by that test) — and its `activate()` under the ggs-node
  `vscode` shim serving a real HTTP request),
  `src-tauri/tests/vscode_shim_boa.rs` (the Boa define-op repro bed
  for the ggs-node `vscode` shim),
  `scripts/probes/claude-code-live-check.mjs` (the live claude-code check: the backend on
  ggs-node (or `--host real-node`), its commands, the chat webview mounted, the IDE MCP
  server up — the server read off the backend process's own LISTENING socket, the Output
  line being batched and not worth waiting for; the chat page is a same-process srcdoc
  context, so the frame probes read both CDP sessions and execution contexts (2026-10-02:
  a session-only scan reported the new-session page blank forever while it rendered fine);
  `--screenshot` saves the workbench),
  `scripts/probes/claude-code-sandbox.mjs` + `scripts/probes/fake-claude-server.mjs`
  (the logged-in claude-code sandbox, no account and no real network: the fake server
  answers `/v1/messages` (streaming), `/api/hello` and `count_tokens` on the loopback,
  the "login" is a fake API key, and `CLAUDE_CONFIG_DIR` relocates every bit of Claude
  Code's state into `target/studio/claude-sandbox/` — `~/.claude`, `~/.claude.json` and
  the keychain are never touched; the workspace is a clone of a **fake git remote** — a
  seeded bare repository (a merge, a remote-only branch, tags) served by `git daemon` on
  the loopback with receive-pack on, so git-graph-rs's remote branches, tracking state
  and fetch are all testable and all hermetic; the clone sits one commit ahead and two
  behind, and the probe verifies the plugin's fetch moved origin/main to the seeded head;
  the probe pre-flights the bundled CLI against the fake server, then boots the app under
  `tauri dev` straight into the dev harness's sandbox pass (lib.rs's dev-only
  `GGS_DEV_HARNESS` boot hook does the navigation; the harness streams its rows back over
  `write_file`, WKWebView having no CDP) and writes
  `target/studio/claude-sandbox-report.{md,json}`: the measured rows (chat open, warm
  reopen, new-session page, a real conversation send→reply against the fake server, the
  git-graph view over the seeded history, the fetch) plus the process tree's memory.
  `--keep` leaves the app open for interactive testing — chat freely, every reply is
  local, fetch and push land on the fake origin; `--no-harness` opens the plain workbench
  (unbounded until Ctrl-C — the fake remote must not die mid-testing); `--cli-only` stops
  after the pre-flights),
  `scripts/probes/git-graph-live-check.mjs` (the live git-graph-rs check: ggs-node with
  the engine `.node` loaded, the view rendering, settings pushing through),
  `scripts/probes/git-graph-menus-live-check.mjs` (the live git-graph-rs menu check: every
  contributed menu placement — the SCM header button, the "..." entries, the Pull, Push
  submenu, the explorer/editor/tab/change-row context menus — plus every palette command
  run with its observable result)

### 13. CAN Trace Analyzer

CANoe's Statistics window and graphics window in one view: `.blf` / `.asc` traces parsed in
the backend, rendered asynchronously — per-channel counts, bus load, per-identifier cycle
times, frame-loss blame, raw frame browsing and SVG charts.

- Frontend: `src/canLogView.ts`, `src/canRawView.ts`, `src/canChart.ts`
- Backend: `src-tauri/src/can_log.rs` (parsing, statistics, blf↔asc conversion)

### 14. Performance Lab

Measurement is a feature. Sizes, boot stages, open-folder phases and theme contrast are
measured and written to `metrics.json`. Size budgets are gone (removed 2026-09-15); the
performance gate lives in `src-tauri/tests/perf.rs`.

The **Module Self-Tests** are the in-app half of the test story: one click (Help → Run
Module Self-Tests, or the `help.selfTest` command) opens a report page that runs every
module's declared checks — grouped in module-map order — and streams pass / skip / fail per
check. Structural checks (a button exists, its menu entry and palette row construct, its
enablement answers) always run; live execution is limited to an explicit safe set (view
switches, toggles, pure helpers) so a click in a real session never writes, spawns or
dialogs. The runner (`src/selftest.ts`) times and streams each check with a per-check
timeout; the suites (`src/selfTestSuites.ts`, a lazy chunk) declare the 17 module groups;
the page (`src/selfTestPage.ts`) renders and copies the report. The same suites run in CI
against the scripted backend (`tests/selfTest.test.ts`), so the in-app click and CI assert
the identical checks.

- Frontend: `src/selftest.ts` (the self-test runner: classification, timing, per-check
  timeout, the Markdown report), `src/selfTestSuites.ts` (the 17 module groups' checks, a
  lazy chunk), `src/selfTestPage.ts` (the report page: streaming rows, per-module re-run,
  copy report)
- Backend: `src-tauri/src/measure.rs` (headless `--measure` probes),
  `src-tauri/src/stage_bench.rs` (launch-stage timing), `src-tauri/tests/perf.rs`
  (synthetic repository benchmark; `GGS_PERF_FILES` sets the size, CI runs 20 000)
- Tooling: `scripts/measure.mjs` (sizes + probes + the boot-bench cold-start stages,
  folded into `metrics.json`'s `perf.boot` key), `scripts/probes/boot-bench.mjs`
  (end-to-end startup latency of the release exe), `scripts/probes/cdp-console.mjs` /
  `cdp-probe.mjs` / `cdp-trace.mjs` (live inspection over WebView2's CDP port),
  `scripts/probes/verify-can-scroll.mjs` (drags a live CAN raw view to its scrollbar's
  bottom and verifies the tail rows are really visible in the layout),
  `scripts/probes/verify-indexed-view.mjs` (the same for the indexed viewer: mount time,
  first text, drag latency), `scripts/probes/run-scroll-harness.mjs` (the harness's
  `?scroll=1` scenario — every scrolling surface through the wheel, the page keys and the
  drawn scrollbar — in headless Edge over CDP, against the dev server),
  `scripts/probes/run-full-harness.mjs` (the harness's `?full=1` scenario — every
  module's self-test checks plus the git-graph-rs and claude-code passes: install state,
  backends, every declared command, the contributed menu placements, the Git Graph view
  rendering, the claude chat mounting; headless over the dev server the extension phases
  skip under the mock — the full pass runs in-app under `tauri dev` through the dev-only
  Help → Open Dev Harness entry, the any-platform equivalent of the Windows CDP live
  checks; repository-mutating commands stay structural there, their execution belongs to
  the temp-repo probes),
  `dev/dev-harness.html` (the two-mode harness: real Tauri IPC under `tauri dev`, or the
  scripted fake backend under `npm run dev:vite`; the `?full=1` pass gained a sandbox
  mode — `?sandbox=1` runs a measured claude-code conversation against the local fake
  Claude server, `?quick=1` skips the module sweep and the git-graph pass for a
  claude-only run, and `?reportFile=`/`?report=` stream every row out as it lands, over
  `write_file` (the primary channel — no webview fetch policy can eat it) and an HTTP
  POST; `scripts/probes/claude-code-sandbox.mjs` drives it through lib.rs's dev-only
  `GGS_DEV_HARNESS` boot hook, which navigates the window there and keeps it awake —
  macOS suspends an occluded WKWebView's timers, which stalls the pass's bounded waits)

### 16. Symbol MCP Server

The `ggs --mcp <repository>` mode: the persistent symbol index and the Code Analysis
engine served to AI assistants over the Model Context Protocol (newline-delimited
JSON-RPC 2.0 on stdio; headless — no window is ever created). The tool surface is a
progressive-disclosure ladder built for token economy (redesigned 2026-09-30): a model
must understand a project it cannot load without ever being handed a flood.
`project_overview` draws the whole picture in one bounded answer — totals, the language
and kind mixes, the top directories with file/symbol counts, the hub files and hub
names, the heaviest module edges, the dead-code count; `directory_tree` walks the
folder hierarchy with per-directory counts, children ranked by symbols and each level
capped at `top` rows; `file_outline` opens one file's declarations with the containers
the flat listings never showed (it replaced the flat `symbol_tree`, whose 4000-line
dump was the flood the redesign removed). The point tools stay — `symbol_lookup`,
`symbol_references` (the occurrence-narrowed scan), `search_symbols`, `read_file` (a
line-windowed file reader, path-confined to the repository), `search_text` (the
workspace text search), `index_status` — plus module 17's analysis tools
(`analysis_module_graph`, `analysis_call_graph`, `analysis_call_path`,
`analysis_metrics`, `analysis_dead_code`, `analysis_security`, `analysis_import_graph`,
`analysis_import_cycles`). Every list-shaped tool speaks one paging contract: `limit` +
`offset`, the exact total in the header, a trailer naming the continuation; the filters
(`path`, `kind`, `severity`, `pathPrefix`) narrow before totals are computed. Every call
is logged as one JSON line to `~/.ggs/logs/mcp.log` (rotated past 1 MB), which the
in-app MCP Server page shows. stderr is logs; stdout is protocol only.

- Frontend: `src/mcpPage.ts` (the MCP Server page — the connection snippets with copy
  buttons, the tool catalogue, the recent-call log; listed by module 17's tool registry
  as the Analysis sidebar's sixth entry and hosted in its editor pages, loading lazily
  with them)
- Backend: `src-tauri/src/mcp.rs` (the server loop, the tool implementations, the
  handshake, the call log); the index itself is module 5's (`cmd_symbols.rs` /
  `symbols/store.rs`), the analysis tools sit on module 17's engine (`cmd_analysis.rs` /
  `analysis/`)
- Tests: `mcp.rs`'s `#[cfg(test)]` module (scratch repository over a temp index home);
  the page's vitest lives in `tests/analysis.test.ts` (it rides the analysis suite)

### 17. Code Analysis

The Code Analysis workbench: an activity bar entry (`Ctrl+Shift+A`) with a sidebar of
five analysis tools plus module 16's MCP Server entry — Module Analysis (the
workspace's cross-file calls as a gitdiagram-style architecture diagram and a tree:
opened workspace-wide from the sidebar or the palette, or folder-scoped from the
File Explorer — a "Module Analysis" entry on every folder's context menu that
analyzes the picked folder(s) (`analysis_module_graph` / `analysis_module_diagram`
take `folders`; one tab per folder set, the scope riding the graphbar as a chip),
a multi-selection of folders unioned and its files passed over (2026-09-29); the
backend decides WHAT the diagram is — `analysis_module_diagram` curates the
architecture (vendored, test, example and bench trees stay off the drawing — they
build or verify the project, they are not its components; a focus or a folder
scope overrides the
rule) and keeps the busiest remaining files
as two-line cards (the name over the bracketed directory the box does not already
name, gitdiagram's `Component<br/>[file.ts]` shape) inside their area's subgraph,
each area one of
gitdiagram's six pastel tones (root files and anything the caps leave without a
box draw unboxed, its `groupId: null`), every kept dependency an arrow labelled by
its call count (a cycle's back edges stay off — the Import Graph page owns cycles);
the flow is mermaid
`flowchart TD` with gitdiagram's tone classDefs verbatim under its own class names,
its schema with the caps raised on the owner's ask (2026-09-29, "too few
modules": gitdiagram's 10/34/48 became 16 groups — deeper areas still roll up to
the depth that fits and an area too small to
be a subsystem folds into its parent box — 54 blocks, 72 arrows, no block fanning
past eight); the page renders that source with
mermaid itself — the same renderer, the same ELK layered layout and spacing
gitdiagram initializes, with one placement deviation on the owner's ask when the
arrows wound far around distant boxes (2026-09-29: ELK node placement runs
NETWORK_SIMPLEX instead of Brandes-Koepf, measured −24…−32 % total edge length) —
so the blocks cannot overlap and the look is gitdiagram's by
construction (`moduleDiagram.ts`), in its light or dark variable set by the workbench
theme's kind (the canvas, the zoom toolbar and the chips read the theme's `--vscode-*`
tokens; a theme switch re-renders the drawing in the other palette); the viewer around the SVG is a port of gitdiagram's
own (its use-mermaid-viewport / use-diagram-wheel-gestures): the zoom bounds and the
percentage read against the fit level (0.6×–12×, 100 % = fitted), the wheel always zooms
at the cursor — mouse wheel and trackpad scroll alike (gitdiagram's per-burst
trackpad/mouse latch misread real mice on WKWebView; panning is the drag and the arrow
keys, ctrl/cmd and WKWebView gesture events pinch-zoom), panning clamps to the
32–160 px gutter band, the toolbar's zoom and fit glide over 160 ms (skipped under
prefers-reduced-motion), the keyboard pans by arrow and fits on 0/Home, and a click
highlighting the clicked element with the
dependencies it touches (the rest dims; a background click or the chip clears), the
right-click menu opening the file, jumping to a related block through the
Calls / Called-by submenus, isolating the neighbourhood or listing an arrow's call
sites, double-click opening the file, the header action copying the mermaid source; the
drawing's filter narrows to the files whose path spells the query (a pair survives only
between matching files, so the drawing shrinks with the filter), the focus isolates one
file's neighbourhood, and the tree matches call-site symbols too; the tree collapses
the same data into
module dependencies → file pairs → call sites, children rendering only while expanded),
Complexity & Hotspots, Dead Code, Security Scan (rule-based, no taint tracking) and the
Import Graph (with cycles) — each opening a streamed result page in the editor area. The
engine resolves calls by name with receiver hints (no type inference); its honest limits
are stated on the pages themselves. The per-symbol call graph walk and the shortest call
chain remain engine services served to the MCP server (module 16), not a page. The
Module Analysis drawing is mermaid's own output (ELK layout) over a backend-built
model: the page never lays anything out, it renders the source and ports gitdiagram's
viewport (pan, zoom, states) around it.

- Frontend: `src/analysisView.ts` (the sidebar), `src/analysisTools.ts` (the shared tool
  registry), `src/analysisPages.ts` (the lazy result pages: the streaming reports, the
  Import Graph list, and the Module Analysis page — the backend-built mermaid source
  on the mermaid viewport beside its tree), `src/moduleDiagram.ts` (the Module
  Analysis drawing: mermaid + ELK rendering of `analysis_module_diagram`'s source,
  gitdiagram's viewport around it — pan/zoom, the zoom toolbar, the delegated
  selection states)
- Backend: `src-tauri/src/cmd_analysis.rs` (the per-root `AnalysisIndex`, the streaming
  tool commands), `src-tauri/src/analysis/` (`mod.rs` the engine and the per-symbol call
  graph, `metrics.rs`, `deadcode.rs`, `security.rs`, `modules.rs` the Module Analysis
  aggregation, `diagram.rs` the Module Analysis drawing — the architecture-only
  curation, gitdiagram's caps, tone
  palette, group roll-up and fold, and the mermaid source (classDefs included) behind
  `analysis_module_diagram`,
  `imports.rs`, `bca.rs` the big-code-analysis
  bridge whose report-time columns — cognitive complexity, Halstead volume, logical SLOC,
  the maintainability index — enrich the Complexity & Hotspots rows); parsing comes from
  module 5's `symbols/parse.rs`
- Tests: `tests/analysis.test.ts`, the `analysis/` modules' `#[cfg(test)]`

### 15. Build & Release Pipeline

Everything that turns the source tree into installers: asset assembly into
`target/studio/`, the seam checks, CI, and the Linux build containers.

- Assets: `scripts/prepare.mjs` (assembles `target/studio/`; the bundled packages are the
  marketplace builds — `scripts/fetch-marketplace-extensions.mjs` downloads them from
  Open VSX per architecture and packs exactly what the build selected:
  `GGS_BUNDLE_GIT_GRAPH` / `GGS_BUNDLE_CLAUDE_CODE`, the release form's checkboxes in CI —
  git-graph-rs packed in every build, claude-code in none by default (the Extensions view's
  marketplace row installs it online; `GGS_BUNDLE_CLAUDE_CODE=1` opts a build back in);
  there is no local source for either package — in require mode a fetch a selected package
  cannot serve fails the build. The one local-source package, claude-remote, packs by its
  own `extensions-src/claude-remote/build.mjs` into every build
  (`GGS_BUNDLE_CLAUDE_REMOTE=0` leaves it out) — no fetch involved, so it packs offline
  too (GGS_SKIP_MARKETPLACE_FETCH does not touch it). A build pass re-checks the registry
  even when the cache is
  fresh: `prepare.mjs --build` — which `tauri.conf.json`'s `beforeBuildCommand` and CI's
  direct prepare runs pass — sets the fetch TTL to 0 (2026-09-30, the owner's direction: an
  installer must carry open-vsx.org's latest extension builds); the re-check is a lookup, a
  same-version answer reuses the cached file, and a `tauri dev` iteration keeps the TTL and
  never phones home), `vite.config.ts`, and `src-tauri/Info.plist` (the macOS bundle's
  merged fragment — the `public.folder` declaration behind the Finder folder right-click's
  "Open With" entry plus the mirrored file associations; see module 2 and its drift test)
- Seam checks: `scripts/check-seams.mjs` (TypeScript / CSS) and `src-tauri/build.rs` (Rust)
- Packaging: `scripts/build-studio.bat` (Windows, one command; builds `ggs-node` and
  `node-host.cjs` through `prepare.mjs` as part of that) and its shell counterpart
  `scripts/build-studio.sh` (macOS/Linux, the same release / dev / debug forms; not the
  distributable deb/rpm — those need the floor containers below). The macOS build carries the
  DMG safety net `scripts/recover-dmg.mjs`: tauri's bundle_dmg.sh loses the occasional
  Finder/Spotlight detach race (`资源忙`/EBUSY on the scratch volume, exit 16, the
  `error running bundle_dmg.sh` failure) and leaks the mounted scratch — `--clean-only`
  (before every macOS build) detaches stale scratch volumes and sweeps leaked `rw.*` images,
  and the recover form (when `tauri build` failed) re-runs the same script with tauri's own
  argv, falling back to `--skip-jenkins`, tauri's Finder-less form, which cannot race.
  Linux installers are built
  in floor containers — the base image IS the compatibility floor: `ubuntu:22.04`
  (glibc 2.35) for the deb, `fedora:38` (glibc 2.37) for the rpm. CI (`studio.yml`) runs
  the same containers `scripts/build-studio-linux.bat` +
  `scripts/docker/Dockerfile.studio-linux` + `scripts/docker/studio-linux-build.sh` drive
  locally, and the in-container pass fails the build if the binary's glibc requirements
  ever exceed the floor. The `ggs` command line ships with every package:
  the bundled binary is named `ggs` (`mainBinaryName`), `cmd_assoc::user_path_apply`
  appends the install directory to the user's PATH at every boot (the NSIS hooks no
  longer write PATH — an NSIS `ReadRegStr` is string-length limited, and its empty-read
  branch once overwrote a long user PATH with the install directory alone, 2026-09-23;
  the uninstall hook deletes the value only when it is exactly the install directory),
  and the deb/rpm packages install it as `/usr/bin/ggs`. Installer-level file associations for the default
  extension set come from `bundle.fileAssociations` in `tauri.conf.json`; the NSIS hooks also
  remove the runtime-registered ProgIds and the RegisteredApplications entry on uninstall
- Signing: installer signing is decided from CI secrets, never in the sources —
  `scripts/signing.mjs` writes the `tauri build --config` merge file each build reads
  (the ad-hoc bundle seal when no secrets are configured; a quarantined download of it
  meets Gatekeeper's un-bypassable "damaged" verdict on Sequoia — the 0.1.5 dmg, with no
  seal at all, shipped exactly that way — so `scripts/install-macos.sh` (2026-09-30) is
  the account-less macOS install channel: a curl download sets no quarantine attribute,
  so what it installs opens on the first click; Homebrew is no way round it either,
  brew stamping its own quarantine onto every cask), and `scripts/gen-signing-secrets.mjs`
  turns the local
  certificate files into exactly the secret values GitHub expects (`--apply` pushes them
  with `gh secret set`). macOS: Developer ID certificate (`APPLE_CERTIFICATE` /
  `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY`) plus notarization through the
  App Store Connect key (`APPLE_API_KEY_ID` / `APPLE_API_ISSUER` / `APPLE_API_KEY`, the
  .p8's content). Windows: Authenticode from `WINDOWS_CERTIFICATE` (base64 PFX) +
  `WINDOWS_CERTIFICATE_PASSWORD` — SHA-256 digests, RFC 3161 timestamp. Linux: the
  packages carry no signature of their own; `release.yml` GPG-signs `SHA256SUMS`
  (`GPG_PRIVATE_KEY` / `GPG_PASSPHRASE`) as the check every download verifies against,
  and its `secrets: inherit` is what carries the signing secrets into studio.yml.
- CI: `.github/workflows/studio.yml` (PRs: typecheck + vitest; `main`: also `cargo clippy
  -D warnings`, `cargo test`, installers for Windows and Linux, the perf gate — the tests
  gate the installer build, and each Linux package format compiles in its own floor
  container);
  `.github/workflows/release.yml` (a pushed `v*` tag publishes installers with `SHA256SUMS`
  and its GPG signature)
- Tests: `tests/marketplace.test.ts` (the marketplace fetch's cache contract — the dev
  iteration's TTL serves offline, the build pass's forced registry re-check, the newer-build
  download, the stale-cache fallback — and the `--build` wiring in `tauri.conf.json`)

## Development workflow

### Before you change anything

1. Identify the module(s) the change belongs to from the map above. A change that needs
   three or more modules usually means a missing command or backend service — design that
   first.
2. Read the module's existing files and its test file; match their structure and naming.
3. Check `docs/ggs-development-plan.md` §3 for a principle that constrains the approach, and
   §5 for a milestone that already scopes the work.

### While changing

- Keep each change inside its module. Cross-module interaction goes through the command
  registry (`commands.ts`), workbench events, or a backend command — never by reaching into
  another module's DOM or state.
- Prefer extending an existing command, setting or backend service over adding a parallel
  one. Search for the existing implementation before writing a new one.
- New user-visible behaviour needs a command (with title and enablement), an i18n key for
  every string, and — if configurable — a `SETTING_DEFS` entry so it appears in Settings.
- Streaming backend work must be cancellable and deliver a first batch quickly; check how
  `cmd_search.rs` does it before inventing a new pattern.

### The per-change method (the open-source skill packs)

What to touch is above; how to work is standardized here, adapted from the open-source
skill packs that set the 2026 professional baseline for agent-driven development — all
MIT, all plain `SKILL.md` markdown under the Agent Skills spec GitHub Copilot has spoken
natively since 2025-12. Install the packs where the harness hosts them
(`npx skills add addyosmani/agent-skills` serves 70+ agents; Claude Code:
`/plugin install superpowers@claude-plugins-official`); where it cannot, this section
carries the standard itself:

| Pack | What it standardizes | Adoption |
| ---- | -------------------- | -------- |
| `obra/superpowers` | The development method — brainstorm → write plan → execute → test-first → systematic debugging → review, as mandatory auto-triggering workflows | the most-adopted development-methodology pack (≈293k ★, 2026-09) |
| `addyosmani/agent-skills` | The engineering depth — spec-driven development, five-axis code review, OWASP hardening, measure-first performance, ADRs | ≈100k ★ |
| `anthropics/skills` | The format itself — the Agent Skills spec, the skill template, the document and webapp-testing skills | ≈179k ★ |

Bound on every change:

1. **Design before code.** A non-trivial change opens with one screen of design notes:
   the module it belongs to, the existing command / setting / backend service it
   extends, and the test that will prove it. If the shape is unclear, brainstorm it to
   a decision first — the module map decides where a file goes, not the cursor's
   position.
2. **Plan in verifiable steps.** Break the change into steps that each end green
   (`npm run typecheck`, `npm test`, `cargo test`); the steps are the session's todo
   list, and a step that cannot be verified is not a step.
3. **Red-green where it bites.** A bug fix begins with the failing test — the module's
   `tests/<module>.test.ts` or the Rust test beside the command — red, then the fix,
   then green. A refactor keeps the tests green throughout; behaviour never moves
   without a test that pins it.
4. **Debug systematically, never by trial.** Reproduce → isolate (the smallest failing
   case; `dev/dev-harness.html` scenarios and `scripts/probes/` exist for this) → root
   cause → fix → keep the reproducing test. No fix ships without a check that fails
   without it.
5. **Review before declaring done.** Walk [Definition of done](#definition-of-done)
   plus the seam rules, the i18n keys and the module map. Security-relevant surfaces
   (IPC commands, the extension host, `ext_fs` confinement, `cmd_assoc`'s registry and
   PATH writes) get an extra OWASP pass; perf-relevant changes cite the measured
   number — module 14 measures, numbers not adjectives.
6. **Verify, then report honestly.** Claim done only what the checks prove; anything
   skipped or unverified is named in the commit body, never implied away.

### Definition of done

A change is complete only when every line below holds. Report anything you could not verify.

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes, including the seam check it runs as global setup.
- [ ] Backend changed → `cargo test --all-features` and
      `cargo clippy --all-targets --all-features -- -D warnings` pass in `src-tauri/`.
- [ ] Changed behaviour is covered: the module's `tests/<module>.test.ts` extended, Rust
      tests added beside the command, harness scenario added where jsdom cannot reach.
- [ ] Every new or moved source file is listed in the [Module map](#module-map) under its
      module.
- [ ] No new user-visible string bypasses `t(key)`.
- [ ] No generated file or `target/` output is staged.
- [ ] Version bump (if any) touched `package.json`, `src-tauri/tauri.conf.json` and
      `src-tauri/Cargo.toml` together.
- [ ] A packaged regression was ruled out by running under `npx tauri dev` when the change
      touches boot, assets, the seams, IPC, or anything `prepare.mjs` produces.

## Invariants

These are the rules that keep the codebase navigable and the coupling to the engine
contained. The build enforces the first two; reviewers enforce the rest.

**Seam rule — TypeScript and CSS (enforced by `scripts/check-seams.mjs`).**
The app names nothing of any extension: the patterns `graph_request`, `gitgraph/`,
`GitGraphStudioConfig`, `out.min` and `web/styles` may not appear anywhere under
`src/` or `static/` (moved 2026-09-23: the two seam files were deleted with the native
graph host). The Git Graph view is the plugin's own page, served over `ggs://` and hosted by
the generic extension platform; the app's only interface is the page/commands surface of
`extHost.ts`. The check runs on every `prepare.mjs`, every Vite build and dev-server
start, and as vitest's global setup.

**Seam rule — Rust (enforced by `src-tauri/build.rs`).**
Nothing under `src-tauri/src/` may name the `git-graph-core` crate — `build.rs` scans
everything under `src/` and fails the build on any reference. The engine lives only inside
the package as its `.node`; no module of this tree links or loads it directly (the
extension-host sidecars load it: ggs-node's N-API host by default, a real Node runtime
under the opt-in).

**Extensions run like VS Code: one extension-host process per package.**
Every `node` backend hosts on the bundled pretend Node runtime (`ggs-node`, the
`node-runtime` feature) — the app never depends on, or spawns, a system Node, and ggs-node
is itself the N-API host a package's `.node` addon (the engine `git-graph.node`) loads
through. The real-Node extension host (`node node-host.cjs`, `src/nodeHost.ts` — `.node`,
ESM, workers and `node_modules` behave natively, the `vscode` API crossing ggs-ext/1 as
`ggs.hostRequest`s the workbench serves) is the explicit `GGS_REAL_NODE=1` opt-in; the
sandboxed frames host main-only packages with no backend, and the deleted C-ABI hosts
(`git-graph-backend`) are gone.
Nothing links an engine crate (`cargo tree -e normal` finds `git-graph-core` nowhere).
Reads still never
spawn a process per call — the backend is a long-lived, warm sibling process
(`ext_process.rs` keeps every declared backend running; `ext_protocol.rs`'s `ggs-ext/1`,
thread-per-request), reached over a pipe, not launched fresh each time. Writes still never
spawn `git` anywhere except `src-tauri/src/git.rs`; the panel's Git channel is fed from that
single runner, and the write path stays entirely in the app process.

**One module, one responsibility.**
A source file belongs to exactly one module and the map is the contract. If a file does not
fit any module, the module map is wrong — fix it explicitly, do not leave the file orphaned.

**Product-grade naming.**
User-facing modules, views, commands and settings carry commercial names (File Explorer,
Source Control, CAN Trace Analyzer), consistent with the README and the Extensions view.
Internal identifiers stay technical (`cmd_fs.rs`, `ext_process.rs`).

**User data lives under `~/.ggs/`.**
Settings, keybindings, snippets, extensions, indexes and logs go there (layout: plan
Appendix B). Nothing user-specific is written into the repository or the install directory.

**Three-file version bump.**
`package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` carry the same
version and change together.

**i18n for every user-visible string.**
Key strings in `src/i18n.ts`, resolve with `t(key)`. Missing translations fall back to
English, never to an empty string.

**Nothing generated in the source tree.**
`prepare.mjs` writes only to `target/studio/`; `vite build` bundles only `index.html` and
`ext-host.html`; `dev/` pages never ship.

## Testing

Tests mirror the modules.

| Layer | Location | Harness |
| ----- | -------- | ------- |
| Frontend unit / view | `tests/<module>.test.ts` (e.g. `scm.test.ts`, `explorer.test.ts`, `canLog.test.ts`) | vitest + jsdom; `tests/tauriMock.ts` scripts every Tauri `invoke`, records calls, and replays backend events |
| Frontend scenario | `tests/scenarioHarness.test.ts`, `tests/scenarioFixtures.ts`, `tests/helpers.ts` | Multi-view flows over the same mock |
| Frontend sweeps | `tests/commandSweep.test.ts`, `tests/uiSweep.test.ts`, `tests/themeContrast.themes.test.ts` | Every command executes; layout and WCAG invariants hold for every theme |
| Backend unit | `#[cfg(test)]` beside each command; `src-tauri/src/test_support.rs` | Scratch repositories with an isolated git config |
| Backend integration / perf | `src-tauri/tests/perf.rs` | Synthetic repository, `GGS_PERF_FILES` |
| Manual / visual | `dev/dev-harness.html`, `dev/hex-probe.html` | Real Tauri IPC or the scripted fake backend |

Conventions:

- A new module adds `tests/<module>.test.ts`; a changed module extends its existing file.
- The extension's page-bundle stubs (`vscode` / Node / `fs` shims) live with its packer,
  in the extension repository's `studio/stubs/`.
- Backend tests must not depend on the developer's global git configuration or on network
  access; use `test_support.rs`.
- Do not weaken a sweep or budget test to make a change pass. If a `tests/perf.rs` budget
  must move, change it deliberately there and say why in the commit.

## Code style

- **Indentation**: tabs in TypeScript (semicolons, double quotes); Rust follows `cargo fmt`'s
  default style (4-space indent, reordered modules and imports) - the tree was reformatted to
  it once, 2026-09-17, and stays on it.
- **Formatting and lint**: Rust is `rustfmt`-clean and `clippy -D warnings`-clean.
  TypeScript is `tsc --strict`-clean; there is no separate linter, so keep to the surrounding
  idiom.
- **Comments** state what the code cannot show: why a path exists, what a seam may touch,
  which invariant a branch protects. Every source file opens with a module doc comment
  (`//!` in Rust, a `//` comment block in TypeScript) stating its mission — match the existing
  ones.
- **Frontend idiom**: `el()` for DOM construction, `ui.ts` primitives for quick input,
  menus and notifications, codicons for icons, CSS variables from the theme files for
  colour. No inline styles for theme-dependent colours.
- **Backend idiom**: one `cmd_<domain>.rs` per domain; commands return `Result<T, String>`
  with user-readable errors; long operations stream over a `Channel` and stop on a
  cancellation generation (the `cmd_search.rs` pattern).
- **Naming**: camelCase TypeScript, snake_case Rust, kebab-case files under `scripts/` and
  `dev/`, `cmd_<domain>.rs` for backend command modules.

## Commits and pull requests

- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `test:`, `build:`, `perf:`,
  `refactor:`, `chore:`; optional scopes name the module or layer (`feat(scm): …`,
  `fix(tauri): …`, `build(ci): …`).
- One logical change per commit; the subject says what changed for the user or the build,
  the body says why and names the invariant or plan section that motivated it.
- **Never commit**: `target/`, `out/`, anything `prepare.mjs` regenerates, `metrics.json`.
- Branch model (plan §9): `main` is always releasable; milestone branches are `ggs/mN-*`;
  one PR per task. A PR is mergeable when the checks in
  [Definition of done](#definition-of-done) pass and CI is green.
- Releases are cut by pushing a `v*` tag after the three-file version bump;
  `release.yml` builds and publishes the installers.

## Reference

| Topic | Where |
| ----- | ----- |
| Architecture principles | `docs/ggs-development-plan.md` §3 |
| Hard acceptance targets for 1.0 | `docs/ggs-development-plan.md` §4 |
| Milestones and task breakdown | `docs/ggs-development-plan.md` §5 |
| Size playbook / performance budgets | `docs/ggs-development-plan.md` §6–7, `scripts/measure.mjs` |
| VSIX package format and extension host | `README.md` → *Extensions* |
| Quality and release process | `docs/ggs-development-plan.md` §9 |
| Agent skill packs (the per-change method) | [obra/superpowers](https://github.com/obra/superpowers), [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills); the format itself — [anthropics/skills](https://github.com/anthropics/skills) |
| `~/.ggs/` layout | `docs/ggs-development-plan.md` Appendix B |
| Repository layout | `README.md` → *Layout* |
| Seam rules, as code | `scripts/check-seams.mjs`, `src-tauri/build.rs` |
| Extension Platform feature surface | `docs/extension-platform-features.md` |
| Engine API contract | the extension repository's `native/core/src/api.rs` (`git_graph_core::Engine`) |
