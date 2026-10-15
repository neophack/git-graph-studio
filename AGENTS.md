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
| `cargo test --workspace --all-features` (in `src-tauri/`) | Backend unit and integration tests across every crate — needs `node scripts/prepare.mjs --icons-only` run once first (`generate_context!()` embeds the icons it derives into `target/studio/icons/`, and the pass stages the sidecar copies tauri-build verifies; Linux/macOS add `--exclude ggs-bash`) |
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
   enforced by `src-tauri/tests/it/perf.rs`.
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
| 18 | GGS Bash | The Windows-only bundled bash-like shell and the Terminal Shell setting |
| 19 | Remote Access | The tray daemon, the Hub relay and the browser workbench (ggs-remote) |

### 1. Workbench Shell

The application frame: custom title bar (menus, command center, window controls), activity
bar, side bar, editor area host, bottom panel and status bar, plus the boot splash that
guarantees the window is never a blank dark rectangle.

- Frontend: `src/main.ts` (boot entry), `src/workbench.ts` (composition root),
  `src/titlebar.ts`, `src/statusbar.ts`, `src/panel.ts` (panel chrome; its Output view is
  the Git channel), `src/platform/ui/` (shared DOM kit: dom, codicon, notify, progress,
  contextMenu, quickInput under one facade — codicons, notifications, context menus, quick
  input), `src/platform/fileIcons.ts` / `src/platform/extAssets.ts` (the file-icon mapping and
  extension-asset data URLs every view decorates with), `src/platform/lazy.ts` (async-chunk
  loaders), `src/platform/state.ts` (localStorage
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

- Frontend: `src/platform/commands.ts` (registry), `src/platform/keybindings.ts`, `src/platform/settings.ts` (setting
  registry `SETTING_DEFS`), `src/settingsPanel.ts` (generated Settings dialog),
  `src/platform/i18n.ts` (`t(key)`, en / zh-cn), `src/themeMetrics.ts` (WCAG contrast per theme),
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

The workspace folder tree — lazy, with git status colouring, inline new/rename inputs, the
full context menu, and external file drops (a drag from the OS over the tree copies into
the folder under the cursor — the row itself, a file row's parent, or the root; elsewhere
the drop keeps opening the files, `workbench.ts` routes Tauri's window-level drag events)
— over filesystem services that also serve the editors — and the workbench's **file
transfers** (rewritten 2026-10-13): one vocabulary, every environment. `src/transfer.ts`
is the layer the Explorer's context menu, the remote shell's commands and the mirror's
appended rows all ride — `uploadInto` / `downloadTo` dispatch on the environment: a
browser session's own UI runs the remote wire transport (module 19's chunked uploads and
ticket downloads, `src/remote/transfer.ts`), and the desktop app drives the native pickers
plus the backend's own copies — `fs_import` (picked sources land inside the target folder
beside whatever exists, the ` (copy)` rule the drop copy uses) and `fs_export` (a file
copies to the save dialog's destination; a folder zips into it), both streaming progress
over a `Channel` with a Cancel action (`fs_transfer_cancel`, the generation-counter shape
search cancellation uses). The wire's upload confinement is unchanged; the desktop pair is
refused to remote sessions outright (`pathGate.ts`'s `REFUSED_COMMANDS` — their paths name
anywhere on the machine, the native picker's business). While a mirror viewer watches the
window the desktop rows hide (`transferMenuShown` over the hostStub's cached viewer
answer): the viewer's own device-run entries are the vocabulary then, and a PC-run row
would open a dialog the phone cannot see.

- Frontend: `src/explorer.ts` (the context menu adapts to the remote shell: the
  desktop-only Reveal hides; the transfer rows show in every environment, mirrored
  windows excepted), `src/transfer.ts` (the transfer layer, the `TransferSink` progress
  surface the mirror page re-installs)
- Backend: `src-tauri/src/cmd_fs.rs` (tree, file contents of the working tree / index / any
  revision, new-rename-delete, the external-drop copy-in `copy_into` — a dragged entry
  never clobbers what exists: it lands beside it as a " (copy)" sibling; the desktop
  transfer pair `fs_import` / `fs_export` over the same no-clobber engine with streamed
  progress and cancellation; the shared `zip_tree` the remote download path and the export
  both pack through; the confined chunked upload writes), `src-tauri/src/watcher.rs` (one recursive `notify` watch,
  debounced `FsChange` batches — external changes appear by themselves)
- Tests: `tests/explorer.test.ts` (the tree, the menus, the drops, the transfer rows'
  environments), `tests/transfer.test.ts` (the desktop half over the tauriMock recording —
  the picker-to-command flows, the streamed progress, the Cancel action, the remote
  delegation), `cmd_fs.rs`'s `transfer_tests` (the engine: no-clobber copies, per-entry
  failures, whole-job cancellation with no partial left behind, the zip export without
  `.git`), the dev harness's real-IPC transfer check (`?full=1`, the Channel's events
  over the real bridge)

### 4. Quick Open

VS Code's anythingQuickAccess model: the walked file list pre-lowered once, queries scanned
in event-loop-yielding chunks.

- Frontend: `src/filePicker.ts`, `src/fuzzy.ts` (the fuzzyScorer port)
- Backend: the `ggs-index` crate's `fuzzy` module (server-side scoring — a keystroke ships
  rows, not the tree) behind the `src-tauri/src/cmd_fuzzy.rs` command adapters

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
- Backend: the `ggs-index` crate (`src-tauri/crates/ggs-index/`) — `scan` (the shared
  matcher / glob / searchable-read vocabulary), `search` (the rayon-parallelised streaming
  text search), `replace`, `compare` (the folder comparison), `hexdiff` (the byte
  comparison), `symbols::parse` (the tree-sitter parser layer, plan M4.1: one embedded
  `.scm` query per language over defs, call sites and imports, each grammar behind a
  `grammar-*` Cargo feature, the outline scan as the fallback), `symbols::store` (the
  compact on-disk store), `symbols::index` (the per-root databases, the build / resume /
  rebuild, the reference scan) and `symbols::cache` (the in-memory fallback) — behind the
  `src-tauri/src/cmd_search.rs` / `cmd_symbols.rs` command adapters (the
  `#[tauri::command]` halves; progress crosses the ggs-base push seams, cancellation is
  the generation counter). Every walk reuses the Quick Open walk so the exclusion policy
  is one list.

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
  `src/platform/markdown.ts` (preview; also renders extension READMEs)
- Backend: the `ggs-text` crate (`src-tauri/crates/ggs-text/`: `viewer/doc.rs` ropey rope
  + syntect highlight checkpoints; `viewer/find.rs` the whole-document find/replace
  matcher, scan and replacement pass; `viewer/indexed.rs` the memory-bounded line-index
  viewer for enormous files (index + on-demand windows + streaming find);
  `viewer/outline.rs` symbol outline; `encoding.rs` encoding detection and line endings),
  behind the `src-tauri/src/viewer_commands.rs` adapters

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
- Backend: `src-tauri/crates/ggs-text/` (the viewer engine), byte comparison in the
  `ggs-index` crate's `hexdiff`, chunked reads via `ggs-fs` (the `cmd_fs.rs` adapters)
- Bench: `src-tauri/examples/viewer_bench.rs` (the open path's phases — syntax set, rope,
  `ViewerDoc::new`, the first highlight window — `viewer_bench [mb]`)
- Dev probe: `dev/hex-probe.html` (the hex view in isolation, against any theme)

### 8. Compare & Merge

The Beyond Compare workflow: folder comparison with sync actions, git-conflict resolution
in place, and side-by-side diffs of any two revisions.

- Frontend: `src/folderCompare.ts`, `src/mergeEditor.ts` (walk conflicts, keep
  ours/theirs/both, Mark Resolved), diff editors in `src/editor.ts` / `src/textEditor.ts`
- Backend: folder comparison in the `ggs-index` crate's `compare`, revision contents via
  the `ggs-git` crate's `revision` (the `cmd_fs.rs` / `cmd_scm.rs` adapters)

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
  ref/hash validators `fetch` shares; 2026-10-14, a Git installed to a custom directory the
  PATH never names still answers — the executable is located once per run through the PATH,
  then Git for Windows' registry `InstallPath` and the standard install roots
  (`ggs_bash::pref::find_git_exe`), and `git::backend_env` — registered at the composition
  root onto `ext_process`'s spawn-env sources — prepends the located install's directory to
  every extension backend's PATH, so the Git Graph view's own `findGit` (standard roots,
  then PATH) finds the same git the app runs and its write operations work)

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
  ESM, workers, `node_modules` and `.node` all behave natively. The ESM graph's static
  `import 'vscode'` rides the same shim through a `module.register()` loader hook
  (`src/nodeHostEsm.ts`, the generated data-URL hooks; below Node 20.6 the old
  ERR_MODULE_NOT_FOUND stands, logged), and a `"type": "module"` entry's `require` falls
  back to the dynamic import on both refusal codes (`ERR_REQUIRE_ESM`, and
  `ERR_REQUIRE_ASYNC_MODULE` — a top-level-await graph on the Node lines that grew
  require(esm)).
- The package's own web side (the extension repository's `studio/`: `bridge.js`/
  `compare-bridge.js` the in-page extension hosts, `bundle.mjs` the page bundles with
  relative URLs, `config-stdin.js` the config bundle's entry, `vsix.mjs` the zip writer,
  `stubs/` the `vscode` / Node / `fs` shims the bundles build against)
- Host side (generic): the `ggs-ext` crate's `process` module behind `src-tauri/src/ext_process.rs` (spawns every installed backend, the
  start handshake carries the open folders, `notify_workspace` pushes changes, a manifest
  still naming the retired `ggx-rpc/1` fails its start with an upgrade hint),
  `src-tauri/src/ext_protocol.rs` (the one wire protocol, `ggs-ext/1`: JSON-RPC 2.0 over
  stdio, `serve_plugin` dispatching every request onto its own thread — the view's opening
  burst of reads never serializes), `src/extHost.ts` (the page services:
  `theme.stylesheet`, `backend.run`, `workbench.*`, singleton pages, theme/workspace pushes;
  plus the change pushes that keep a page off polling — the watcher's every batch rides the
  page channel as `kind: 'fs'` (root/paths/`gitChanged`/`truncated`, so a stage or commit's
  `.git` burst is the stage/commit event) and a workbench save as `kind: 'documentSaved'`;
  additive and GGS-internal — under VS Code these posts never exist and a package keeps its
  own degradation path)

### 11. Integrated Terminal

xterm.js fronting portable-pty sessions (ConPTY on Windows), with new/kill actions and the
terminal list. The shell a new terminal opens is the Terminal Shell setting (module 18's
`terminalShell`: Git Bash the default — GGS Bash standing in where none is installed —
GGS Bash, or PowerShell; a Windows-only concern — off Windows neither bash of the
setting exists, the terminal opens the system's own `$SHELL`, and the Settings dialog
hides the row); the choice rides every `pty_create`, so it reaches the next terminal
without a restart.

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
frame cannot host: too big for the frame's code map (2026-09-27, the Kimi rule), opening
listening sockets through a qualified call (`http.createServer(…)` — the frame's http/net
shims are client halves, nothing there can accept a connection), or calling a crypto
constructor the frame's shim refuses at invocation (`crypto.createHmac(…)`-class — the
frame serves the digests and the randoms; 2026-10-11, Claude Remote 2.0's resident: it
dropped its LAN server and crossed no route until this rule). A minified bundle's aliased
`l.createServer` never trips any of it — only the qualified forms count.
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
beside the app. The first launch installs whatever sits there like
VS Code's bundled extensions (`cmd_ext::install_missing_bundled`; a deliberate uninstall
stays uninstalled). Which packages ride is one policy everywhere (2026-09-28, the owner's
direction): git-graph-rs in every build, claude-code in none by default — the Extensions
view's marketplace row installs it online on demand. The `GGS_BUNDLE_GIT_GRAPH` /
`GGS_BUNDLE_CLAUDE_CODE` env are the switches (CI's release form forwards its
checkboxes; `GGS_BUNDLE_CLAUDE_CODE=1` opts a build back in).
A marketplace package a build left out still installs from
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
config dir rides on it), and every window shares that one `~/.ggs/claude` (the official
login, the chat history and the analysis MCP registration are per-machine, not
per-provider), while the **active provider is per window** (2026-10-13, the owner's
direction): several GGS instances run at once — one on GLM, one on the official
service, one on Kimi — and a switch in one window never drags another. The window's
choice lives in its own process memory (`effective_choice`: seeded from the store's
`active_id` at the window's first resolution, moved only by its own switches; a
profile deleted from under it falls back to the store's default), and
`provider_activate` writes both — the window's own choice now and the store's
`active_id` on disk, the default a NEW window boots with (`provider_list`'s
`activeId` answers this window's provider, so the chip and the page render the
window's own, never another's). The window's active
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
default), and `CLAUDE_CODE_GIT_BASH_PATH` (2026-10-10, module 18; reworked 2026-10-13, and the
same day made three-way): when GGS Bash is chosen and the bundled sidecar resolves, the
spawn env points Claude Code's shell tool at it — at a `bash`-named copy of the sidecar
under `~/.ggs/shell/` (`ggs_bash::pref::ensure_bash_exe`), because claude-code 2.1.296
whitelist-checks the variable's basename (`bash.exe`/`sh.exe`/`bash`/`sh` — the
sidecar's own name is rejected as "not a bash/sh binary" and the injection silently fell
to auto-detection) — with `CLAUDE_CODE_USE_POWERSHELL_TOOL=0` beside it: claude-code's
Windows PowerShell tool (a rollout makes it the model's first choice even with bash
present) is off, so the Bash tool is the command tool; the Git Bash choice — the
default since 2026-10-13, the owner's direction — points the same keys at Git for
Windows' own bash, located automatically (`ggs_bash::pref::find_git_bash`: the
`GitForWindows\InstallPath` registry value, the standard install
roots, then a PATH entry's `git.exe` or a non-WSL `bash.exe` — never WSL's System32
launcher or the WindowsApps shims), and where none is installed the bundled `bash`
copy stands in — only a machine with neither injects nothing, Claude Code's own
detection standing; off Windows nothing is injected at all (2026-10-13, the owner's
direction: neither bash of the setting exists there, and Claude Code's own POSIX
picker serves itself); the PowerShell choice sets `=1` and pins
`CLAUDE_CODE_GIT_BASH_PATH` empty instead (the user asked, and no git bash path may
survive the choice — the spawn env only adds pairs, so an inherited value, a Git
Bash session that launched the app or a user-level leftover, is overridden empty;
an empty value reads as unset everywhere downstream; the rollout does not decide),
and a change restarts through `providers_shell_refresh`,
the provider switch's own path. The whole env set is
inherited by the
extension's CLI children (the same takeover `claude-code-sandbox.mjs` proves against a
local server). The UI is the sidebar chip on the Claude view's section header
(`aiProviders.ts` — mounted only for the ids the backend's `bridgedExtIds` names, so
`src/` names no extension id), its quick pick, and the Model Providers page
(`providersPage.ts`, the `ai.providers` command); switching provider (or editing the
profile the window runs under) **restarts this window's running bridged backend**
(`restart_bridged_backends`, 2026-09-30 — the never-restart cut shipped that morning
and left the sidebar on the old provider's login page forever: the extension process
applies its environment once, at its own start, so a running one keeps answering with
the provider it booted under; the fresh process spawns with the window's new provider
env, and the settled start attempt — success or failure, the old process is dead either
way — is announced as the `ext-backend-restarted` event, on which the
extension host re-resolves the extension's webview views — the chat page reloads with
the new provider, a conversation in flight restarting on it; 2026-10-01, the
long-login-page bug, is why the spawn env carries the provider pairs and not only the
redirect: the extension reads `process.env` for Claude Code's own keyless-auth shape —
a token there authenticates from the first state push, where a fresh backend without
one answered its auth status null and rendered the official login page until a config
probe, tens of seconds under ggs-node, said otherwise). **The spawn environment is the
provider configuration's only sink** (2026-10-13, the owner's direction: do not save
the Claude configuration to disk — the API key must never be plaintext at rest):
nothing provider-shaped is written into Claude's own files, and what earlier versions
wrote there is withdrawn (`withdraw_claude_provider_env` → `withdraw_provider_settings`,
run at boot, on every folder change beside the MCP registration, and on every switch):
the `env` map (endpoint, key, models, the flags, the shell keys, a bridge-written
`SHELL`), the top-level `model` pin an earlier version rewrote onto the active
provider's model (a pin naming an id the official service cannot serve is ours-shaped
and goes; the user's own `claude-*` id or bare tier alias survives verbatim), and the
empty `attribution` hide-pin the bridge once wrote on every profile — the user's own
env keys, pins and trailers are preserved verbatim, a clean file is never touched, and
an unparseable file is failed on rather than replaced. The honest cost is stated where
it lives: a `/model` pick Claude Code persists into the settings' top level outranks
the environment, and this bridge no longer rewrites it — the tier aliases still resolve
through the per-window env remap, and a stale `claude-*` pin from an official-era
session is the user's own to clear (the official service serves it, so the withdrawal
never touches it). Commercial finish
(2026-09-30): a **NewAPI gateway** preset beside
DeepSeek / GLM / Kimi, a **Test Connection** probe (a 1-token `/v1/messages` round
trip whose every HTTP answer is a diagnosis — key rejected, wrong base URL, throttled)
and a **Fetch Models** catalogue read (`/v1/models`, the OpenAI-compatible shape every
gateway answers) — both probing with the form's typed key or, untouched, the stored
profile's decrypted one; and a **cc-switch import**: `provider_ccswitch_scan` reads
`~/.cc-switch/config.json` (both the array and id→map shapes, `claude.current` by its
raw key) plus the live `~/.claude/settings.json` env — keys stripped from the answer,
deduplicated by endpoint+key — and `provider_import_ccswitch` seals the named ones
into the store and activates the one cc-switch points at (this window's choice and the
new-window default together). **The analysis rides into
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
  `mountUsagePanel`; and while any third-party provider runs the chat, the page's own
  Account & usage bar starts collapsed — 2026-10-13, the owner's direction: its dollars
  are Claude's own estimates, guesses over a gateway's unknown models ("costs may be
  inaccurate"), so the gate watches the pane's chat iframe and clicks the section's own
  toggle once per loaded page when it first renders expanded; the page persists the
  collapsed state itself, the user's later expansion is never fought within a page, and
  under the official provider the page is never touched), `src/providersPage.ts` (the Model
  Providers page — flat and compact: the usage card, the profiles as one-line rows,
  the add/edit form whose key field travels once into the
  backend's seal, activate and delete), `src/nodeHost.ts` (the real-Node
  extension host's entry, compiled to `node-host.cjs`: stdio ggs-ext/1 server, the shared
  `vscode` shim over a stdio bridge, `require('vscode')` interception, ESM fallback —
  VS Code's own extension-host shape), `src/nodeHostEsm.ts` (the generated loader hooks
  mapping an ESM graph's static `import 'vscode'` onto that same shim — named exports
  over the host instance, the well-known unserved names linking undefined), `src/extHost.ts` (the extension host for VSIX
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
  picker chosen, the AskUserQuestion card answered, the Account & usage bar collapsed
  through its own toggle — the page's own DOM, same-origin),
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
  channel dropdown), `src/platform/ui/` (`progressToast`)
- Backend: the `ggs-ext` crate (`src-tauri/crates/ggs-ext/`: `store` — the install /
  upgrade / uninstall engine and the bundled-package scan over roots the app resolves;
  `vsix` — `.vsix` unpack, the JSONC manifest reader (comments and trailing commas, the
  tolerance VS Code's own reader applies) and `resolve_node_binaries`, the backend
  derivation; `page` — the `ggs://` serving core, composing the page bootstrap into
  every HTML page (`page_boot.js`); `fsapi` — `ext_fs`'s workspace-confined core and the
  pages' revision/window byte services; `log`; `loadcode` — the package's bounded
  loadable-code map the frame's CommonJS loader resolves against; `nodeenv` — the Node
  environment facts the frame's `os`/`process` shims carry), behind the
  `src-tauri/src/cmd_ext.rs` adapters (the `#[tauri::command]` halves, the
  `~/.ggs/extensions` resolution and its one-time migration, the bundled-root discovery
  — git-graph-rs, `ext_install_bundled`'s id — and the `ggs://` protocol registration
  over tauri's asset resolver; P3-9 of docs/architecture-restructure-plan.md),
  `src-tauri/src/ext_gallery.rs` (the marketplace commands over the `ggs-ext` crate's `gallery` engine: Open VSX search, icon fetch and
  download-and-install over ureq, origin-confined, a marketplace package installing
  through `cmd_ext`'s ordinary VSIX path),
  the `ggs-providers` crate behind `src-tauri/src/cmd_providers.rs` (the AI provider bridge: the provider store under
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
  `.json` grammars converted to Sublime syntax and added to the rope viewer's syntect set), the `ggs-ext` crate's `process` module behind `src-tauri/src/ext_process.rs` (the process extension host: eager
  start at boot and install, lazy start on first command as the fallback, `initialize`
  handshake, `runCommand`, crash isolation, remembered status (start count, last error),
  stop on uninstall and at app exit; a `node` backend runs on the bundled `ggs-node` (the
  default) — off the main thread, with the backend's own `ggs.hostRequest`s forwarded to
  the workbench as `ext-host-request` events — or, under the `GGS_REAL_NODE=1` opt-in, on
  the real Node runtime plus `node-host.cjs`; `resolve_node_binaries` (cmd_ext) derives a
  backend from a package's engine `.node` (real-Node host), its `package.json` `main` when
  native binaries are present, or — loadable code the sandboxed frame cannot host — an
  oversized entry, or a qualified `http.createServer`-class or `crypto.createHmac`-class
  call anywhere in the package's `.js`/`.cjs` surface (2026-10-01: the scan reads the
  whole loadable tree, not the entry alone — Claude Remote 0.2 moved its server into
  `server.js` and the entry-only scan left the package `backend: null` in a frame that
  could not even resolve its siblings; 2026-10-11: the crypto constructors the frame's
  shim refuses joined the rule — Claude Remote 2.0 dropped its LAN server and crossed no
  route until `crypto.createHmac` derived its backend, while `createHash` and the randoms
  stay off the list because a frame serves them)),
  `src-tauri/src/node_runtime/` (`ggs-node`, the `node-runtime` feature's
  pretend Node runtime sidecar — the default `node`-backend host: Boa on one JS thread fed
  by a job queue — protocol requests, timers, child-process events, the activation — a CommonJS `require`
  confined to the package root (`require.rs`), real `fs`/`path`/`os`/`child_process`
  builtins over std (`builtins/`: `mod` the registry, `fs`, `path`, `os` — including a
  real `networkInterfaces()` over if-addrs (2026-10-01: Claude Remote's pairing QR needs
  the machine's true LAN addresses; the prelude's empty stub is gone), `child` (a
  child's exit waits at most 2 s for its pipes to drain — a grandchild holding them
  open never again withholds the exit), `net`
  the TCP sockets and the HTTP(S) client under the prelude's `net` / `http` / `fetch`
  (at most 1024 live sockets, two threads each — a LAN listener sheds the rest; a
  refused thread spawn fails its socket, never the accept thread),
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
  `.node` loads through (`native.rs` the loader, `napi_host.rs` the `napi_*` surface —
  its handle arena honours N-API's scopes: a callback, a threadsafe delivery, the
  registration and every explicit scope release what they created, an escapable scope
  keeps one slot below its mark, a settled deferred is freed, and every export runs
  under `catch_unwind` because a panic may not unwind out of `extern "C"`; before
  2026-10-04 the arena only grew, rooting every argument and result an addon touched
  for the process's life) — and the dispatch: launcher → `ggs.onRequest` →
  `exports.dispatch`; stdout is the protocol, package code writes through `ggs.log`
  only. The run loop's crash-proofing (2026-10-04): the JS thread runs on a 64 MiB
  stack reservation with the native stack guard armed; every step that runs package
  code — a job, a timer, an addon completion, the promise jobs, the activation poll —
  runs under `contained` (`catch_unwind` + the VM unwind + the N-API arena release),
  and the state drops before the context however `js_main` leaves; and
  `collect_on_external_pressure` collects the heap when the allocator's live large
  blocks (`alloc::large_live_bytes` — strings, buffers: memory Boa's box-counting pacing
  never sees) grow by half their post-collection watermark, 64 MiB at least — a
  git-graph session's results and claude-code's payloads used to pile up by the
  gigabyte before a collection ran; `examples/boa_bench.rs` the
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
  grammar and semantics are pinned in `tests/it/vscode_shim_boa.rs`, the compile semantics
  end-to-end in `tests/it/node_runtime.rs`; retire the fork when upstream carries the
  fixes. Crash-proofing patches (2026-10-04, same marking): `boa-parser`'s
  `stack_guard.rs` is the native stack guard — the embedder arms it at the top of its
  JS thread with that thread's stack size, the parser's recursion hubs
  (`AssignmentExpression`, `UnaryExpression`, `Statement`, `StatementListItem`) fail
  as a `SyntaxError` once two thirds of the stack is used (the last third is the
  unguarded scope-analysis / bytecompile / drop passes' over the same tree), and
  `boa-engine`'s `check_runtime_limits` (every call), `JSON.stringify`'s
  `serialize_json_property` and `flat`'s `flatten_into_array` throw a catchable
  `RangeError: Maximum call stack size exceeded` with an eighth left — before it, a
  hundred nested closures or a 700-deep array handed to `String()` overflowed the
  native stack (0xC00000FD, the backend gone); `boa-engine`'s `SimpleJobExecutor` pops
  its batch one job at a time and lets a failing job fail alone (upstream `clear()`ed
  every queue on the first error, stranding every pending `await` in the program); and
  `Context::vm_checkpoint` / `unwind_vm_to` put the VM back at rest after a panic the
  embedder caught mid-run (the abandoned frames stayed pushed, charged against the
  512-frame budget, with the environment and realm still swapped to the dead frame).
  Performance patches ride along (2026-09-27, same marking), taking Claude
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
  protocol, shared with plugin binaries), the `ggs-ext` crate's `routing` module (which of the
  instance's frontends answers a backend's `ggs.hostRequest` — `main`, or ONE remote
  session `remote/<n>` (the Relay's `x-ggs-frontend` header, believed only from the
  Relay's webview; through a Hub these are different people, and one user's click must
  never land in another's page): every webview panel and view request goes to the
  desktop window (`WEBVIEW_HOME`, 2026-10-12 — one live page per instance, which a
  remote workbench shows as a live copy, module 19's webview streams: before, a webview
  followed whichever frontend last resolved or messaged it, and the other side's Claude
  chat froze), else the frontend whose call is in flight, else the composition root's
  policy, the Relay then handing a session's request to that session only; plus the
  compacted registration journal — commands, `setContext` keys, providers, views,
  status bar items, and the live panels' create args — that a frontend attaching to a
  running backend replays through `ext_process_registrations`, and that the
  `ext-host-state` event mirrors live into every frontend but the serving one (a
  panel's create / title / reveal / dispose among them, with the `caller` whose click
  caused it; the desktop's own tab close crosses as a mirrored dispose); and since a backend bakes its webview asset URLs from whichever frontend served
  its activation, every frontend rewrites those roots to its own before rendering
  (`extHost.ts`'s `localizeAssetRoots`); 2026-10-11: a remote page never saw
  claude-code's activation-time `setContext`, so its Claude Code container stayed
  hidden, and a remote "View Git Graph" opened on the desktop), `src-tauri/crates/ggs-ext/src/page_boot.js` (the
  `acquireGgsApi()` bootstrap the protocol composes into served pages),
  `src-tauri/src/ext_child.rs` (the frame host's child processes, over the `ggs-ext` crate's `child` engine: one `ext_child_spawn` +
  stdin/kill follow-ups per spawned tool, stdout/stderr streamed as base64 `Channel` events,
  every handle killed at app exit and on extension reload — the real process surface a
  sandboxed frame cannot have, which `nodeShims.ts` maps onto the Node `child_process`
  shapes; the sync variants stay call-time failures, a frame cannot block its loop)
- The packer lives in the extension's own repository (its `studio/` —
  `build.mjs` the packer, `bundle.mjs` the page-bundle builder, `config-stdin.js`,
  `vsix.mjs` the zip writer, `stubs/` the bundle stubs, plus the two in-page bridges); the
  app tree carries no plugin code, and no build step of this repository runs the packer —
  the package arrives here as the marketplace's VSIX (or a hand-picked `--vsix`).
- Build: `scripts/prepare.mjs` (fetches the bundled packages from the marketplace —
  Open VSX per architecture; `--vsix <path>` / `GGS_BUNDLED_VSIX` bundles a ready-built
  VSIX as-is, outranking the registry for git-graph-rs)
- Tests: `tests/extensions.test.ts` (pages, the process dispatch, the real-Node remote
  handle routing), `tests/providers.test.ts` (the provider bridge's frontend half: the
  store client's seam contract — the key travels only inside `provider_save`, never
  back in a `provider_list` — the sidebar chip and its quick pick, the Model Providers
  page, the usage curve's ranges and hover breakdown, and the chat pane gate's two
  states — the set-key page that saves into `provider_save`, the usage strip after),
  `tests/claudeChatInject.test.ts` (the
  host's chat driver against a stand-in composer: type, send, interrupt, the model
  picker, the AskUserQuestion card, the permission card and the permission-mode menu),
  `tests/editor.test.ts` (the extpage tab),
  `tests/editorServices.test.ts` (the diagnostics store and the document-formatting
  registry, booted through the frame bootstrap),
  `src-tauri/tests/it/node_runtime.rs` (the pretend Node runtime: a package's JS entry served
  over `ggs-ext/1`, the process-host chain over the bundled `ggs-node` sidecar, a NAPI
  addon answering under ggs-node, the installed extension's whole activation),
  `src-tauri/tests/it/vscode_shim_boa.rs` (the Boa define-op repro bed
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
performance gate lives in `src-tauri/tests/it/perf.rs`.

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
  `src-tauri/src/stage_bench.rs` (launch-stage timing), `src-tauri/tests/it/perf.rs`
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
- Backend: the `ggs-mcp` crate (`src-tauri/crates/ggs-mcp/`: the server loop, the tool
  implementations, the handshake, the call log — headless, no tauri; `ggs --mcp` dispatches
  to `ggs_mcp::run` from the composition root, and the MCP Server page's two commands are
  the `src-tauri/src/mcp.rs` adapters); the index itself is module 5's (the `ggs-index`
  crate's `symbols::store` / `symbols::index`), the analysis tools sit on module 17's
  engine (the `ggs-analysis` crate)
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
- Backend: the `ggs-analysis` crate (`src-tauri/crates/ggs-analysis/`) — `lib.rs` the
  engine and the per-symbol call graph, `index.rs` the per-root `AnalysisIndex` and the
  streaming report runners, `metrics.rs`, `deadcode.rs`, `security.rs`, `modules.rs` the
  Module Analysis aggregation, `diagram.rs` the Module Analysis drawing — the
  architecture-only curation, gitdiagram's caps, tone
  palette, group roll-up and fold, and the mermaid source (classDefs included) behind
  `analysis_module_diagram`,
  `imports.rs`, `bca.rs` the big-code-analysis
  bridge whose report-time columns — cognitive complexity, Halstead volume, logical SLOC,
  the maintainability index — enrich the Complexity & Hotspots rows; parsing comes from
  module 5's `ggs-index` crate (`symbols::parse`) — behind the
  `src-tauri/src/cmd_analysis.rs` command adapters (the `#[tauri::command]` halves;
  progress crosses the ggs-base push seams)
- Tests: `tests/analysis.test.ts`, the crate's `#[cfg(test)]`

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
  cannot serve fails the build. A build pass re-checks the registry
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
  `bash scripts/build-studio.sh` (macOS/Linux, the same release / dev / debug forms; not the
  distributable deb/rpm — those need the floor containers below). The LOCAL release
  compiles ride a speed diet (2026-10-14, docs/ci-speed-plan.md): both scripts export
  `CARGO_PROFILE_RELEASE_LTO=thin` / `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16` (and the
  `ggs-node` profile's pair), trading a slightly larger exe for a fraction of the fat
  LTO + one-unit compile time — CI's published installers keep the size diet, the
  overrides living only in the scripts' environments. **Windows ships exactly
  one package format, the NSIS setup** (2026-10-14, the owner's direction):
  `tauri.conf.json`'s `bundle.targets` is the explicit list `["nsis", "deb", "rpm", "app",
  "dmg"]` — the `"all"` it replaces built a WiX MSI beside the setup exe
  (`Git Graph Studio_0.1.11_x64_en-US.msi`), and no artifact path, checksum filter or
  measurement names the MSI anymore. The macOS build carries the
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
  remove the runtime-registered ProgIds and the RegisteredApplications entry on uninstall,
  and (2026-10-12, never on an `/UPDATE` run) clean what lives outside the install
  directory: GGS Remote's tray daemon — its "GGS Remote" logon task first, then the process
  (a capped `ggs-remote stop`, then `taskkill` scoped to this user) — its binary and asset
  cache, the bytecode cache and the symbol indexes; the whole of `~/.ggs` (settings,
  extensions, Claude state, provider keys, the remote password and link identity) only
  with the uninstaller's own "Delete the application data" box ticked, and only the
  profile's own `~/.ggs`, never a `GGS_HOME`-chosen path (pinned in
  `tests/marketplace.test.ts`)
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
- CI: `.github/workflows/studio.yml` (PRs: typecheck + vitest; `main` and releases: the
  backend test jobs `test-windows` / `test-linux` / `test-macos` run clippy + `cargo
  test` in PARALLEL
  with the installer jobs — tests and packaging were split 2026-10-14, docs/ci-speed-plan.md
  P2, the wall clock being the max of the two rather than the sum; the tests still gate
  every release (a calling workflow fails unless they passed), and each Linux package
  format compiles in its own floor container; one backend test pass per platform (the
  owner's direction, 2026-10-14: rpm and deb are both Linux — the native test-linux job
  covers the platform once, the rpm container leg only packages; macOS joined the same
  day, its suite having never run there before; the Linux and macOS jobs pass
  `-- --skip ggs_bash` — the shell is a Windows-only sidecar, its suite runs in the
  Windows job alone). The test jobs' prepare runs
  `--icons-only` — the window icons are the test compile's only prepare-made input, the
  sidecars/daemon/marketplace belong to the installer builds). The Rust toolchain
  is pinned by the root `rust-toolchain.toml`
  (docs/ci-speed-plan.md P1 #6, 2026-10-14): the `dtolnay/rust-toolchain@<version>` refs
  in both workflows install exactly the ref — keep them and the file in sync on a bump
  (the action does not read toolchain files, and a mismatch means every job downloads a
  second toolchain at run time); the Linux build containers deliberately override back to
  their image's own stable (`RUSTUP_TOOLCHAIN` in `studio-linux-build.sh` — their
  RUSTUP_HOME is not on the cache volume). rust-caches save from `main` only
  (`save-if`; `cache-workspace-crates` keeps the vendored boa warm), the test and
  installer jobs carry separate cache keys (dev half vs release half), PRs cancel their
  predecessor and never cancel a `main` run, the Windows jobs exclude their build paths
  from Defender and redirect `TMP`/`TEMP` to the runner scratch, and CI narrows dev
  debuginfo (`CARGO_PROFILE_DEV_DEBUG=line-tables-only` plus
  `[profile.dev.package."*"] debug = false` in `src-tauri/Cargo.toml`) — all
  docs/ci-speed-plan.md, measured against that plan's baselines;
  `.github/workflows/release.yml` (a pushed `v*` tag publishes installers with `SHA256SUMS`
  and its GPG signature). Every `.sh` is invoked as `bash <script>.sh`, never directly —
  in CI, in docs and in the scripts' own usage notes (2026-10-14, the owner's direction:
  a `.sh` committed from Windows carries no executable bit, and release.yml's
  `deploy/build-deb.sh` call died on the ubuntu runner with Permission denied, exit 126)
- Tests: `tests/marketplace.test.ts` (the marketplace fetch's cache contract — the dev
  iteration's TTL serves offline, the build pass's forced registry re-check, the newer-build
  download, the stale-cache fallback — and the `--build` wiring in `tauri.conf.json`)

### 18. GGS Bash

The bundled bash-like shell and the app's default terminal shell (2026-10-10, the
owner's direction): a pure-Rust `ggs-bash` sidecar (no dependencies beyond std) that
speaks **Git Bash's dialect end to end** — a clean Windows machine has no bash, and
both the interactive terminal and Claude Code's shell tool need one that answers the
way Git Bash does.

The SHIPPED sidecar is Windows-only (2026-10-14, the owner's direction: Linux and macOS
neither install it, nor package it, nor test it there): the `ggs-bash` cargo feature and
the bin's `required-features` gate the binary — tauri.conf.json's `build.features` turns
it on (so every Windows build and every `tauri dev` carries it), while the macOS
signing merge (scripts/signing.mjs) and the Linux builds (the container pass and
build-studio.sh's local path) clear the feature list through their `--config` merges, a
list-replacing JSON merge — cargo and the bundler both skip a bin whose required
features are off. The LIBRARY module stays cross-platform (ggs-config borrows its
pure-std zip reader); in CI its tests run only in the Windows job (test-linux and
test-macos pass `-- --skip ggs_bash`).

- The dialect (`msys.rs`): `/c/...` drive paths accepted everywhere the shell resolves
  and printed everywhere it reports (`pwd` answers `/c/Users/...`, `pwd -W` the Windows
  form) — and the drive ROOT is the bare letter both ways (`/d` ⇄ `D:/`,
  `cd /d && pwd` answering `/d`, 2026-10-13: `D:` alone is drive-relative on
  Windows, the current directory on that drive, not the root — the shape
  behind `ls -la /d/` once failing with a localized "file not found"); the
  dialect reaches EVERY path-taking surface (the applets' `resolve_paths`, the
  builtins' `source`, redirections, glob patterns) through
  `Shell::resolve_working_path`, never a raw `cwd.join`; `/dev/null` (redirects hit the null device, arguments cross to `NUL`);
  `/tmp`; a colon-separated presented `PATH` over a Windows-native stored one
  (`PATH=$PATH:/c/tools` round-trips; children spawn with the `;` form); a `HOME`
  derived from `USERPROFILE`; MSYS-shaped arguments translated for native children
  exactly the way MSYS2 does (`git -C /c/x` works); `cygpath` for explicit conversion
- Git Bash's startup and look: `~/.bashrc` sourced at interactive start, the colored
  `user@host ~/path` prompt — Git Bash's shape without its `MINGW64` segment
  (2026-10-10, the owner's direction; `uname` and `MSYSTEM` keep answering MINGW64 for
  scripts that probe the dialect) — (a hand-set `PS1` with `\u \h \w` wins), `ls`
  colorized on a terminal (bold blue directories, bold green executables), `history`
- The language: quotes and every `$` form, pipes, redirections (heredocs `<<`/`<<-`,
  here-strings), **process substitution `<(cmd)` and `>(cmd)`** (temp-file backed:
  the input form's file carries the command's output, the output form's command
  consumes the file when the caller finishes), `&&`/`||`/`;`/`&`, `if`/`for`/`while`/
  `until`/`case`, functions, subshells, `set -e`/`-x`, aliases, `test`/`[[ ]]`, and
  `./script.sh args` executing through this shell (shebang lines honoured, no chmod
  ceremony), **brace expansion** (`{a,b}`, nested, `{1..10..2}`, `{a..e}`, `{01..10}`;
  quoted or comma-less braces stay literal), `trap 'cmd' EXIT` (fires at script end, `exit`
  and EOF; other signal names are remembered for `trap -p`, never delivered) and
  `break N` / `continue N`, **indexed arrays** (`a=(x y)`, `a+=(z)`, `a[i]=v`, `${a[i]}`,
  `${a[@]}` spliced in double quotes, `${#a[@]}`, `${!a[@]}`, negative indices, `unset a[i]`,
  `declare -a/-x`, `mapfile -t`), the **parameter operators** (`${x#p}` `${x##p}` `${x%p}`
  `${x%%p}` `${x/p/r}` `${x//p/r}` `${x/#p/r}` `${x/%p/r}` `${x:o:l}` `${@:2}` `${x^}` `${x^^}`
  `${x,}` `${x,,}`) and `set -- a b c`, **associative arrays** (`declare -A`, `m[key]=v`, `m=([k]=v)`, `${m[$k]}`,
  `${!m[@]}`, `unset m[k]`), `name[$i]=v` subscripts, `read -a`, **`(( ))` / `let` / C-style
  `for ((i=0;i<n;i++))`** over a full arithmetic engine (`arith.rs`: C precedence, `**`, bitwise,
  shifts, `?:`, `,`, assignments and `++`/`--` on variables and array elements, short-circuit)
  and **job control** (`cmd &` registers a job: `jobs`, `wait [%n]`, `fg`, `bg`, `disown`,
  `$!`, `Done` notices at the next prompt; `kill pid` reaches real processes only — a job is a
  thread of the shell and cannot be signalled); not implemented: `select`, `getopts`, nested
  associative values — unsupported
  constructs fail with a clear syntax error
- The tools — Claude's high-frequency set, analysed and closed to parity (nothing
  external, no MINGW/MSYS component anywhere): the curated applet list wins over
  `PATH` (a script's `find` is never Windows' `find.exe`) — and whatever the list
  and the `PATH` both lack still answers from the local Git Bash's own
  `usr/bin` when one is installed (2026-10-13, the owner's direction "支持所有
  git bash 命令": `stat`, `file`, `chmod`'s GNU cousins… — `exec.rs`'s
  `git_usr_bin_from`, found through a PATH `git.exe` walking up or the standard
  install roots; `which` reports those hits as `/usr/bin/<name>`, and the
  Tab-completion's command list reads the same directory) — `ls(-t/-r/-l/-C/-a/
  -A/-d/-F/-1/-w, GNU coreutils' own shapes 2026-10-13: the `-l` rows carry the
  MSYS uid-name/gid-number columns (`0x100000`+RID) and the `total` block sum,
  the POSIX error wording (`cannot access 'x': No such file or directory`,
  never the Windows locale text), byte-wise C-locale sorting, and the `-C`
  planner is coreutils' `calculate_columns` ported verbatim — pre-seeded
  3-wide columns, the 2-space gap, tab-preferring indent — byte-diffed against
  a live Git Bash across widths) `cat
  grep(-o/-E/-r/-A/-B/-C/--include/--exclude) sed(-i, multiple -e) find(-exec/-delete/
  -o/! / parens/-path/-mtime) head(-c) tail wc sort(-t/-k/-o/-n/-u/-r) uniq cut tr cp mv
  rm mkdir touch env which basename dirname realpath readlink(-f) date sleep seq clear
  diff(Myers, unified) tee xargs(-n/-0/-I/-r, GNU empty-input semantics) uname whoami
  hostname cygpath md5sum sha1sum sha256sum(-c) base64(-d) du(-s/-h) ln(-s) chmod
  timeout(124 on expiry) tar(-c/-x/-t/-z) unzip(-l/-o/-d) gzip/gunzip(-c/-k, stdin
  filters) less/more` (the pager
  prints whole inputs, `-N` numbers; the terminal has its own scrollback) plus **`bash`/`sh`
  as builtins** (`bash script.sh`, `bash -c '…' a b`, `sh -c`, a script on stdin: a fresh
  nested shell over the parent's exported environment and cwd, `run_nested` in `mod.rs`) and a working
  **awk** interpreter (`awk.rs`: patterns and actions, BEGIN/END, `$n` fields with
  assignment, associative arrays, `print`/`printf` with redirection, `sub`/`gsub`/
  `split`/`substr`/`index`/`sprintf`, `if`/`while`/`for`/`for-in`, pre/post `++`/`--`,
  `next`/`exit`, `-F`/`-v`; no user functions, no `getline`/`system`); the archives are
  pure Rust (`compress.rs`: a real DEFLATE inflater, fixed and dynamic Huffman, plus a
  stored-block gzip writer; `archive.rs`: USTAR tar read/write and zip extraction)
- **The 2026-10-14 parity batch** (the owner's direction: "ggs bash 相对 git bash
  缺失很多命令" — the curated list still left a Git Bash install carrying far more
  than the sidecar answered, and the usr/bin fallback only helps machines that
  already have Git Bash, which a clean one does not). Two halves landed:
  - *The OS-facing half finally compiled* — `sysinfo.rs` (written 2026-10-13)
    had never been declared in `mod.rs`: dead, uncompiled, every one of its
    commands answering nothing. Wired in and fixed where its never-run tests
    disagreed: `df -h/-H/-T` (Windows drives as `C:` rows on `/c`), `free`
    (procps' table, the totals column 15 wide and the rest 12), `ps` (MSYS'
    PID/PPID/PGID/WINPID/TTY/UID/ST/TIME/COMMAND listing over the Toolhelp
    snapshot), `mount`/`umount` (the listing and the honest refusal), `id`/
    `groups`/`logname` (the Cygwin-folded SID identity), `tty`, `nproc`,
    `arch`, `start` (ShellExecuteW)
  - *The pure-Rust text/file half* — ~45 new applets in `applets.rs`: the text
    tools (`nl` — GNU's blank label on unnumbered lines, `tac`, `paste` —
    the delimiter list with the last one repeating, `join` — the merge walk
    with `-a`/`-v`/`-o`/`-t`, `comm` — a suppressed column takes its tab
    with it, `fold -s`, `expand`/`unexpand` — GNU's per-span tab rule where
    any stop a run of ≥2 blanks spans converts, `tsort`, `expr` — the full
    precedence chain with `:` matching through the BRE engine, `factor`,
    `numfmt` — iec/iec-i/si both ways, `shuf -e/-i/-n/-r`, `yes`, `printenv`
    — PATH printed in the MSYS dialect, `column -t/-s`, `cmp -l/-s`,
    `egrep`/`fgrep`, `dir`/`vdir`), the byte inspectors (`od` — GNU's
    little-endian 2-byte words, `-c`'s 3-wide cells, `*` dedup, `-A d/o/x/n`;
    `xxd` — the offset/group/ASCII column widths byte-checked against vim's
    own, `-p`/`-r`), the digests (`sha224sum`/`sha384sum`/`sha512sum`/`b2sum`
    — BLAKE2b in pure Rust — `cksum` — POSIX's CRC with the final complement —
    `sum` BSD and SysV, `base32`), the file tools (`stat` — GNU's default
    column shape and `-c`'s token set over path-derived device/inode
    stand-ins, `file` — shebangs, PE32/PE32+ headers with OS version and
    subsystem, ELF, the archive magics, text/charset/CRLF census, the
    >2-operand name alignment, `truncate -s +N/-N/K/M/G`, `mktemp` — the
    X-run filled, the name printed in the dialect, `shred -n/-u/-z`,
    `install -d/-t/-D`, `link`/`unlink`, `dd` — bs/ibs/obs/skip/seek/count
    with GNU's records-and-bytes stats line, `split -l/-b/-d/-a`, `sync`),
    the converters (`iconv` — UTF-8/16/32 both ends with BOM handling,
    latin1/cp1252, GNU's error wording for the rest; the `dos2unix` family —
    CRLF/LF/CR each way, `-n in out`; `zcat`/`uncompress` over the inflater;
    `dircolors`), the wrappers (`nohup` — nohup.out on a terminal stdout,
    `nice`, `stdbuf`) and the terminal probes (`tput` — clear/cup/cols/lines/
    setaf/bold/sgr0…, `stty size` off the console buffer, `reset`/`tset`,
    `chown`/`chgrp` refusing the way Git Bash does)
  - *The pre-existing bugs the batch's own tests surfaced*: `tr -d` deleted
    EVERY character (the delete arm mapped all of them to nothing — only
    SET1's members go); `gzip -c` wrote `file.gz` and removed the source
    instead of streaming to stdout (and `gzip` with no operand now filters
    stdin, `-k` keeps); a command with TWO process substitutions lost the
    first's temp file (the nested script's pipeline-tail flush drained the
    outer command's pending files — the flush now drains only its own
    depth's entries); `printf '\xHH'`/`'\NNN'` didn't decode (GNU printf's
    byte escapes, and printf's format now accumulates raw bytes so a split
    UTF-8 pair survives); `wc < file` padded its columns (GNU reads a
    redirected stdin bare); `od -A d` printed space-padded decimal offsets
    (GNU zero-pads)
- The setting (`terminalShell`: **gitBash is the default** — 2026-10-13, the owner's
  direction: Git Bash where it is installed, the bundled GGS Bash standing in where it
  is not; ggsBash itself was the 2026-10-10 default, powershell the alternative, and
  a stored old default follows the new one through `migrateStoredSettings`, the
  sticky-scroll rule — and the whole setting is Windows-only: off Windows neither
  bash exists, the terminal opens the system's own `$SHELL`, the bridged environment
  injects no shell keys, and the Settings dialog hides the row): it rides every `pty_create` (new terminals pick it up live),
  the backend reads it from `~/.ggs/settings.json`, and for the bridged claude-code
  backend it injects `CLAUDE_CODE_GIT_BASH_PATH` + `MSYSTEM=MINGW64` + `SHELL` +
  `CLAUDE_CODE_USE_POWERSHELL_TOOL=0` (module 12's two sinks, the provider switch's
  own restart path `providers_shell_refresh`) — the bash path naming the
  auto-located Git for Windows bash when gitBash is chosen (`pref.rs`'s
  `find_git_bash`: the `GitForWindows\InstallPath` registry value HKCU then HKLM,
  `%ProgramFiles%\Git`, `%ProgramFiles(x86)%\Git`, `%LocalAppData%\Programs\Git`,
  then the PATH — a `git.exe` or a non-WSL `bash.exe` entry derives the root; WSL's
  System32 launcher and the WindowsApps shims are never taken for Git Bash) — the same
  roots `pref.rs`'s `find_git_exe` (2026-10-14) turns into the app-wide `git.exe`
  location: the PATH first, then those roots, answering `git.rs`'s runner, the shell's
  own `git` (`exec.rs`'s resolution tail — `usr\bin` never carries the exe) and the
  extension backends' spawn PATH (module 9's `git::backend_env`), so a custom-directory
  install the PATH never names is one git everywhere — or a
  `bash.exe` copy of the sidecar under `~/.ggs/shell/` when ggsBash is chosen or no
  Git Bash was found (claude-code 2.1.296 whitelist-checks the basename and rejects
  `ggs-bash.exe` as "not a bash/sh binary", 2026-10-13 — which is why the copy's
  name is `bash`) — the PowerShell tool switch keeping the Bash tool as the command
  tool (a claude-code rollout makes PowerShell primary on Windows even with bash
  present); the PowerShell choice injects `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` with
  `CLAUDE_CODE_GIT_BASH_PATH` pinned empty — a path the app itself inherited (a Git
  Bash session launching it, a user-level leftover) is overridden empty, never
  surviving the choice — so Claude Code writes its commands exactly as on Git Bash,
  on whichever bash serves the choice, or exactly as on PowerShell when the user
  picks it
- `uname` answers `MINGW64_NT-...` (the dialect's identity, stated on purpose); the
  checksums are pure-Rust MD5/SHA-1/SHA-256 (`hashes.rs`); the regex engine
  (`regexlite.rs`) is a backtracking VM on an explicit heap stack — no pattern can
  overflow a thread stack

- The line editor (`lineedit.rs`): the REPL's readline — raw mode only while a line is read
  (Win32 console mode / `stty`, restored before any command runs; a stdin that cannot
  enter it falls back to plain `read_line`), cursor motion, Ctrl-A/E/U/K/W/L, word motion,
  history recall on Up/Down, Ctrl-R reverse incremental search, `!!` / `!$` / `!^` / `!*` /
  `!n` / `!-n` / `!prefix` / `!?text` history expansion (single quotes and `\!` keep a bang
  literal), Ctrl-C/Ctrl-D, and **Tab completion**: command names
  (builtins, applets, functions, aliases, PATH executables), files and directories
  (`~`, `/c/...`, spaces escaped, hidden files on a leading dot, `cd` dirs only),
  `$VARIABLES`, git subcommands and — after `checkout`/`switch`/`merge`/… — branch,
  remote and tag names; a unique match is inserted, an ambiguous one extends to the common
  prefix and then lists in columns
- The shell: `src-tauri/src/ggs_bash/` (`lex.rs` the tokenizer, `parse.rs` the parser,
  `expand.rs` word expansion, `exec.rs` the interpreter over in-process pipes and the
  PATH/HOME plumbing, `builtins.rs` the shell builtins, `applets.rs` the line tools,
  `sysinfo.rs` the OS-facing applets (df/free/ps/id/…, direct Win32 declarations),
  `awk.rs` the awk interpreter, `arith.rs` shell arithmetic, `lineedit.rs` the line editor,
  `regexlite.rs`, `glob.rs`, `hashes.rs`, `localtime.rs`,
  `msys.rs` the path dialect, `compress.rs`/`archive.rs` the pure-Rust archives,
  `mod.rs` the CLI entry and REPL, `pref.rs` the setting
  read + the claude env), the binary `src-tauri/src/bin/ggs_bash.rs` (no feature gates:
  `cargo test` builds and runs its suite everywhere, and the bundler ships it as the
  crate's own additional binary beside `ggs.exe` — never also as a staged `externalBin`
  sidecar: two components installing the same `ggs-bash.exe` fail MSI validation with
  ICE30)
- The setting: `terminalShell` in `src/platform/settings.ts` (switching it awaits the
  `~/.ggs/settings.json` write and only then invokes `providers_shell_refresh` —
  the restart thread re-reads that file for the spawn environment, and a refresh
  racing the write respawned the backend under the old shell, 2026-10-13), the
  shell choice on every `pty_create` in `src/terminal.ts`, the shell spawn in
  `src-tauri/src/pty.rs` (`shell_command`)
- Tests: the `#[cfg(test)]` suites through `src-tauri/src/ggs_bash/` (the language, the
  dialect round-trip, the invocation-dialect parser, and the e2e batches in
  `mod.rs` — the file operations, `ls`, the grep/find/sed/sort/head/xargs flag sets,
  the checksums and archives, `timeout`, the builtins, the `>`/`<` process
  substitutions, the parameter forms, and the 2026-10-14 parity batches' three
  e2e groups — text tools, byte viewers, file tools — each shape pinned against
  a live Git Bash's own output) and `pty.rs`'s `shell_command`;
  `cmd_providers.rs`'s spawn-env guard; `src-tauri/tests/it/ggs_bash_cli.rs` (the built
  binary's CLI contract — the `-l`/`-i` flags riding around `-c` in any order,
  `--login`, the positional words after the command string);
  `scripts/probes/ggs-bash-parity-diff.sh` (the byte-diff harness itself: ~80
  commands run through both a real Git Bash and the built `ggs-bash`, every
  mismatch reported — the parity batch's acceptance gate);
  `scripts/probes/ggs-bash-parity-matrix.sh` (the exhaustive matrix, 2026-10-14:
  every applet plus the builtin-shaped commands Git Bash also ships in
  `/usr/bin` — ~350 cases — each run through BOTH a real Git Bash and the built
  `ggs-bash` over one shared fixture set, byte-comparing stdout, stderr, the
  exit code AND the after-state of the working tree (both normalized: timings,
  temp names, psub paths, pids), machine-state commands (df/ps/free/mount/…)
  compared by structure only, interactive/OS-opening commands skipped by
  design — the repo root and the built sidecar derived from the script's own
  location, `bash scripts/probes/ggs-bash-parity-matrix.sh` from any checkout);
  `tests/ggsBash.test.ts` and the module self-test group

### 19. Remote Access (ggs-remote)

One PC, one link and one password: a tray-resident daemon serves every Git Graph Studio
window of this machine to a phone's or another computer's browser over HTTPS and the binary
`ggs-remote/1` WebSocket protocol; a self-hosted relay (`ggs-remote-hub`, no accounts, no
database) carries the link through NAT. The whole design lives in
`docs/ggs-remote-plan.md` — this section is the map of where its parts live.

- **The security sandbox** (2026-10-12, the owner's direction, plan §23): when enabled, every
  instance a remote session opens runs OS-sandboxed — the engine is Microsoft's open-source
  mxc (`mxc-sdk`, MIT — Copilot local sandboxing's GA runtime; ProcessContainer on Windows,
  bubblewrap on Linux, Seatbelt on macOS) applied to the spawned process and its whole tree.
  Filesystem deny-by-default with the sandbox root (`~/.ggs/remote/sandbox`, configurable) as
  the instance's whole world — the real `~/.ggs` and the rest of the disk are unreadable;
  network is a three-level setting (off / intranet / internet; hosts whose tier cannot
  express CIDR rules degrade intranet to off, flagged). The instance's `GGS_HOME` is
  relocated inside the root (settings, extensions, provider keys, Claude state start empty
  in the sandbox). The control channel gets a second, sandbox endpoint — Windows a pipe
  created through the GGS-patched vendored `../vendor/interprocess`
  (`ListenerOptions::security_descriptor_sddl`, the Boa vendoring precedent) with an
  ALL APPLICATION PACKAGES DACL; every spawn carries a one-shot registration token
  (`GGS_REMOTE_CONTROL_TOKEN`) the Register must present. `Register`/`InstanceInfo` carry
  `sandboxed`/`controlToken`; the app's `remote_host.rs` honours `GGS_REMOTE_CONTROL`.
  Only remote-driven SPAWNs are sandboxed (tray/admin act for the user at the PC); with the
  sandbox on, WINDOWS lists sandboxed instances only and ATTACH to a desktop window answers
  INSTANCE_GONE. `daemon/src/sandbox.rs` is the module; the Remote page carries the
  "Security sandbox" section and the picker an "open a sandboxed window" entry; the real
  e2e is `cargo test --test integration sandbox_launch -- --ignored` on a capable host.
- **`ggs-config`** (2026-10-13, the owner's direction): the one-command Remote Access
  setup from a command line — an SSH session on a fresh machine runs `ggs-config` (or
  `ggs config`, either spelling) and gets the daemon installed, the access password set,
  an optional relay connected, and the links printed, no window ever opened.
  `src-tauri/src/remote_config.rs` (no `desktop` feature — headless) finds the daemon
  binary (the installed running copy in `~/.ggs/remote/bin`, an installed extension's
  package, or the bundled `ggs-remote.vsix` beside the app, whose daemon it extracts into
  `~/.ggs/remote/bin-incoming/` staging — never `bin/`, the running copy the daemon's own
  install replaces), then drives the daemon CLI end to end: `install --ggs-exe`, the
  password over the loopback admin API with the value on a stdin pipe (never an argv),
  `hub/connect`, `print-link`. Flags `--password` / `--server` / `--join-key` answer the
  prompts non-interactively (`--server ""` skips the relay without asking); the password
  prompt doesn't echo (rpassword). The binary ships as the crate's own `[[bin]]` beside
  `ggs` (the ggs-bash precedent), so it lands on the user's PATH through
  `cmd_assoc::user_path_apply`.
- **The 2026-10-13 security pass** (plan §23.6): three directed audits (daemon attack
  surface, the public Hub, app-side remote + web) and their fixes, all tested. The
  remote-session file boundary lives in the Relay (`src/remote/pathGate.ts`): path-carrying
  invokes land inside the open folders only (`remote_paths_policy` feeds the roots); the one
  exception is `ext_fs`, which may also reach the extension platform's own areas
  (`remote_ext_roots`: the installed packages' files, the extensions' storage and their logs
  — the same roots the backend's `ext_fs` contract allows, without which every activation
  that reads its own bundled files failed from a browser session — Python's `pythonrc.py`
  copy was the first seen),
  `open_folder` is refused, `relayEmit` is allowlisted and identity-stamped
  (`remote/<session>` over any client-claimed `by`/`from`), workbenchSync confines
  remote-originated opens, and the mirror copy drops foreign-origin URLs. The daemon
  gained: the sandbox guard on INSTANCE_CLOSE/RESTART, an Argon2 concurrency semaphore,
  a session gate on `/sw.js`, instance-keyed asset cache, rightmost-XFF + a single tunnel
  bucket for login limiting, expiring sandbox tokens, Register/Update field caps, control
  chars stripped from device names, and `hub.settings` behind the unlock. The Hub gained:
  link-keyed asset cache (no cross-PC poisoning), `trusted_proxies` CIDR config +
  rightmost-hop XFF + proxy-aware handshake limiting, an empty-join_key startup warning,
  header-read timeouts + a request-work ceiling, a body idle-gap timeout, and PC response
  header hygiene. Declared honestly (plan §23.7): **the Hub is a full-trust component**
  — e2e.rs is designed but unwired, so everything through a Hub is visible to it.

- **The daemon** (`extensions-src/ggs-remote/daemon/`, a crate of its own workspace — the app
  binary never links it): tray, self-signed TLS, Argon2id password + sessions + epochs
  (a password change closes every socket with 4401 within a second), the window registry
  over the local control channel, frame routing to each window's hidden Relay webview,
  credit-window flow control, the 120 s resume ring, instance lifecycle (SPAWN / close /
  restart with the dirty-file check), and the Hub client (`src/hub/`: the Ed25519 device
  key whose public half *is* the link's UUID, the outbound tunnel with challenge handshake
  and reconnect backoff, and tunneled browser sessions served through the very router the
  LAN listener uses). The one-time downloads (2026-10-13): a folder zip answers its
  headers before its tree is packed — the instance sends an empty first `FileReply`
  up front, so the browser's download bar appears at once however long the build takes
  (the daemon's 30 s first-chunk wait once failed every big folder, and the browser's
  retry against the spent one-time URL answered 404 — Chrome's "未发现文件"); a build
  that dies after the headers sends a mid-stream error chunk, which the daemon turns into
  an aborted body so a truncated archive never lands as a complete file. The recently
  opened folders (`src/recent.rs`, 2026-10-12): every
  folder a window registers or updates with — most recent first, deduped, capped at 12 —
  persists as `recent.json` under the root and rides every WINDOWS frame
  (`recentFolders`), so the picker's "recent paths" list survives a daemon restart and a
  tap reopens the folder (entering the window that already shows it, SPAWNing one
  otherwise). The daemon's web pages (`web/`) are VS Code-styled (2026-10-12, the owner's
  direction): flat and compact, light and dark, phone to desktop — `style.css` mirrors
  the `--vscode-*` palette; the change-password forms are one-line rows (placeholder +
  aria-label instead of stacked labels); the login page centers its card under the logo.
  The pages' language follows the user's set language (`GET /lang.js`, guard-exempt and
  `no-store`, answers `window.ggsLang` from `~/.ggs/settings.json` — the same
  `Paths::display_language` the tray reads, the browser's language as fallback). The
  window picker (2026-10-12, the owner's direction): sign-out lives in the header row,
  the standalone "new window" button is gone, and the "open a folder by typing its path"
  row stays behind the `folderInput` config switch (`api/session` carries it; the
  extension page's Service section exposes the toggle). The install path (`client.rs`) never shuts down a running daemon of
  the same or a newer version — it asks the live one over the admin API before touching
  it, so the plugin's activation cannot drop every remote session for a byte-identical
  reinstall (2026-10-11: the fresh-home case once killed the daemon for ~20 s, and a page
  opened in that window showed nothing at all — no explorer, no file contents, no SCM).
  The extension likewise never pushes its activation-time config/hub patch to a daemon
  that answers `outcome: "current"` (2026-10-12: the boot pass activates the backend
  before any frontend has served the stored settings, and that defaults-shaped patch
  once rebound the live daemon off the port every open page was on — user-made changes
  still land through the configuration-change push; an install or upgrade starts the
  daemon fresh and takes the config there).
  The token-guarded package route (`http/assets.rs`) rewrites `ggs://localhost/`
  references AND the root-absolute `/assets/…` ones onto the token path — the extension
  host frame's document is an app asset whose build spells its hashed scripts
  root-absolute, and unrewritten they fell out of the token route and 404'd at the
  daemon's root (no frame extension ever activated remotely). Its
  `tests/integration.rs` covers the LAN paths; `tests/hub_link.rs` runs a real Hub
  against a real daemon — login, a WebSocket session and a password change's kick, all
  through `/u/<uuid>/`.
- **The Hub** (`extensions-src/ggs-remote/hub/`, another crate of its own — never inside the
  VSIX): standalone packaging beside the container image — `bash deploy/build-deb.sh` wraps the
  static musl binary into a deb (hardened systemd unit + the example config as a conffile
  at `/etc/ggs-hub/hub.toml`, so dpkg -i plus systemctl runs out of the box) and a plain
  tarball; `deploy/build-zip.bat` builds the Windows zip locally in the release page's
  layout (exe + `hub.toml.example` + README under a versioned folder). `release.yml`'s
  `hub-packages` job builds all of them on tags.
  `/tunnel` handshake, the uuid → tunnel table (a newer key connection replaces the
  older, `T_REPLACED`), HTTP and WebSocket proxying with session re-stamping, the offline
  page every not-online link answers, per-IP limits (handshakes, login entries, proxied
  requests, offline-probe bans), joinKey in constant time, and the cross-PC cache for the
  workbench's immutable assets only. The silence gate (2026-10-12, the owner's direction:
  "如果不是 /u/uuid 访问，不要返回任何东西，就像没开这个端口一样" +
  "判别不是 uuid 也要返回端口关闭，链接对才返回内容" — only a well-formed link is ever
  answered, everything else is the shape of an unopened port): `gate.rs` wraps the router
  in a tower service whose `Silent` error makes hyper close the connection without one
  byte of HTTP — the public surface is exactly `/u/<uuid>/…` for a uuid segment that
  passes `identity::valid_uuid` (the lowercase v8 shape every real link spells; a
  malformed segment — wrong spelling, uppercase, percent-encoded — drops like every other
  scan path, while unknown-but-well-formed stays the identical offline page) plus
  `/tunnel` opened only as the WebSocket handshake shape the daemon's client sends;
  `/healthz` moved beside `/metrics` onto the configured `metrics_listen`, the optional
  `/` landing page and its `landing_page` config are gone, and `deploy/Caddyfile` carries
  the same rule at the TLS front (proxy `/u/*` and `/tunnel`, `abort` the rest — never a
  Caddy 502 for a dropped path; TCP SYN replies and the TLS handshake itself are physical
  facts of listening, the silence is the HTTP layer's). The abuse guards (2026-10-12, the
  open-relay problem:
  a keyless public Hub is a free hosting service waiting to happen): the per-link daily
  distinct-viewer ceiling `visitors_per_day_per_tunnel` (default 32 — a personal link has a
  handful of viewers, a link shared like a public site hundreds; the bucket hangs off the
  uuid so a reconnect cannot launder it), the per-IP request rate `http_rate`, the audit
  trail `audit_log` (one JSON line per tunnel lifecycle / browser session / proxied answer
  head — never a body, package tokens in paths masked to 6 characters) and the blocklist
  file `blocklist` (one uuid per line, re-read every 30 s and at every handshake: a listed
  PC's tunnel is taken off the air — its browsers see the plain offline page — and its next
  handshake is refused with `banned`). The HTTP proxy's session slot is owned by a
  `SessionSlot` guard freed on drop however the request leaves (before it, a request
  abandoned before the PC's answer head leaked its entry forever — eight ghosts bricked a
  default tunnel's session ceiling), the answer head waits under a 30 s timeout (a hung PC
  answers 504, never a hanging request), and `to_conn` drops a dead session's entry on its
  failed send. Deploy files and the Dockerfile sit in `hub/deploy/`.
- **The plugin package** (`extensions-src/ggs-remote/`: `extension.js`, `lib/daemon.js`
  install/upgrade/start, `lib/admin.js` the admin API client, `media/page/` the Remote
  Access page — links + QR behind the password unlock, devices, password, and the relay
  section "Reach this PC from anywhere": connect string, the `/u/<uuid>/` link, change-link,
  export/import of the sealed device key. 2026-10-12, the owner's direction: the
  set-password and unlock screens carry the relay server fields themselves — a server saved
  before any password exists is held in NoPassword and connects the moment the password
  lands (`set_password` wakes the tunnel loop) — on BOTH pages: the extension page (the
  admin API's `hubConnect`) and the tray's loopback pair page, whose server card lives on
  every screen and rides the ticket-guarded `pair/hub/connect` / `pair/hub/disconnect`
  routes (`pair/state`'s `hub.settings` prefills the form) — and while the relay is set and
  online its `/u/<uuid>/` link is the ONE QR on both the extension page and the pair page
  (2026-10-12, the owner's direction: `status_json`'s `links` is the relay link alone —
  the LAN codes hide; a configured-but-offline relay has no link to show, so the LAN codes
  stand as the fallback, and `lanLinks` always keeps the direct addresses for the CA
  anchors). Its
  `build.mjs` packs the platform's daemon binary into the VSIX.
- **The replica** (2026-10-12, the owner's direction: "the whole GGS runs on the PC, the
  remote page is only a copy"): the PC's desktop window is the one real frontend of its
  instance, and a remote page is by default a live DOM copy of it (`src/remote/mirror/`;
  the browser-side workbench below stays reachable as `?frontend=1`). The window records
  its own tree and every same-origin frame's — the extension webview pages, Claude Code's
  chat among them — as a snapshot plus mutation batches (`recorder.ts`: node ids,
  MutationObservers, polled form values / scroll / CSSOM and adopted sheets, URLs crossing
  as app / package tokens), out as the `studio://mirror-down` app event the Relay forwards;
  a viewer (`viewer.ts`, a script-less sandboxed frame scaled to fit; its base style
  hides the PC window's own minimize / maximize / close — 2026-10-12, the owner's
  direction: a remote page shows no window controls, a tap there would drive the PC's
  real window) rebuilds it, and its
  input (`viewerInput.ts`: mouse, touch taps / drag-scroll / long press, a hidden text field
  for keys, IME and the phone keyboard) comes back as `studio://mirror-up` to `main`, where
  `replay.ts` dispatches it with each frame's own event constructors and performs the
  defaults a synthetic event lacks (focus on press, scroll on wheel, editing keys).
  **The replica's focus and caret state** (2026-10-13, the owner's report "Claude's input
  shows a caret and a red border on the PC, neither in the remote copy", direction: **no
  extra visuals — the mirror resolves the state into the copy's own display**): focus and
  the caret are display state, not DOM — nothing mutates when the PC's composer takes
  focus. The focused chain (one entry per document along `activeElement`, into the watched
  frames, each carrying a `:focus-visible` bit) crosses as a `focus` op on
  `focusin`/`focusout`; the viewer marks the focused element `mirror-focus` (+`-visible`)
  and its ancestors `mirror-focus-within`, and derives, right beside every rule of the
  copy's own sheets whose selector carries a `:focus*` pseudo, the same rule with the
  pseudo exchanged for the marker class (CSSOM-adjacent insertion, order-preserving) —
  Claude's composer border is painted by Claude's own `:focus-within` CSS matched through
  the marker, never by the viewer; the markers go back on after every batch (a class
  attribute the page rewrote cannot wipe them). The caret keeps its op and painted bar,
  and **both states ride the snapshot**: they cross as ops only on change, so a viewer
  attaching later — the page opened after the PC had already selected the input — starts
  from the current state instead of nothing until the PC's next move (the bug as
  reported). A `<link>` sheet derives when it loads, and every fill re-attaches that
  load hook: the refill's `document.open()` erases a document's listeners in Chromium,
  so a webview frame reloaded inside the window copy once lost its focus border for good.
  The painted bar takes the page's own `caret-color` (its text colour only when that is
  unset or transparent; the copy's caret-hiding sheet is detached for the read): Claude's
  composer types in transparent text over a mirror layer, and a bar in the text colour
  was invisible. A flush puts a poll's earlier reads before its own — a caret read while
  it sat in a not-yet-serialized text node (the first character typed) once crossed last
  as "no caret".
  **The replica's wire economy** (2026-10-13, the owner's direction: 1/10 of the mirror
  traffic — "animations the page itself draws need no syncing; sync the core data and
  operations"; plan §22.8): the copy is a picture, not a renderer, so intermediate states
  are not information. Four levers in `recorder.ts` (each disableable as `{ legacy: true }`
  for the A/B tests): **string deltas** — `text`/`attr`/`val`/`css`/`adopted` ops carry the
  edit against the value the viewers hold (`stringDelta` in `protocol.ts`; the recorder
  keeps per-node/attr/control bases seeded by the snapshot, the viewer mirrors them, and a
  delta without its base throws into a resnap — never a silent divergence), so a streamed
  chat token crosses as the token; **animation sampling** — an attribute a script rewrites
  per frame (two changes < 100 ms apart starts a run, timed in the observer callback) is
  sampled at ~1 Hz while it runs and its settled value always lands (settle timer); a
  change-and-change-back inside one batch crosses nothing; **storm folding** — pending
  churn (childList nodes added+removed; one innerHTML window swap is a single record) ≥ 24
  holds the intermediate renders up to 600 ms so a virtualized list's scroll (git-graph-rs)
  collapses into settled batches, the rows that lived and died inside the hold never
  serialized at all; **cadence tiers** — a quiet period's first change leaves at 50 ms,
  continuous background traffic (previous batch non-empty) coalesces at 500 ms, and
  replayed input still flushes immediately (`host.ts`), so interactivity keeps the fast
  floor. The frame compression threshold dropped 1024 → 256 on both sides (`frame.ts`,
  daemon `ws/frame.rs`). `tests/remoteTraffic.test.ts` measures the modelled wire against
  the legacy recorder: streaming chat 11×, virtualized scroll 12.7×, JS animation 28.8×,
  combined 19.6× — each scenario ends with the copy's DOM equal to the PC's.
  **The replica's file transfers** (2026-10-13): the mirrored Explorer's context menu is the
  PC's own — and since the desktop gained its own transfer rows (module 3's rewrite), the
  PC hides them while a viewer watches (`transferMenuShown` over the hostStub's cached
  viewer answer: a PC-run row would open a native dialog the phone cannot see), so the
  device's transfers are the viewer's to serve. A right click (or long
  press) that `explorerSpotAt` reads as an Explorer row, or the list's blank area (the
  workspace root, derived from the top-level rows: one shared parent is the single root,
  unrelated parents the multi-root virtual level), arms `explorerTransfer.ts`, which waits
  for the menu the PC builds — the desktop `.context-menu`, the phone shell's action sheet —
  and appends this page's own Download / Download as Zip / Upload Here entries to it. The
  appended rows carry `data-ggs-local` (input never forwards them; the entries shift nothing
  above, so the PC items' replay rects stay exact), their click closes the mirrored surface
  (an Escape for menus, a press on the sheet's backdrop — its Escape listener sits where a
  replayed key never lands) and rides `src/transfer.ts` (the shared layer) over this page's
  own transport, whose
  progress / notices report through `setTransferSink` — the replica installs
  `mirror/transferSink.ts` (a small toast; the workbench's `#notifications` never exists
  here), the own-UI workbench keeps ui.ts's toasts.
  `host.ts` keeps the viewers (hello every 10 s, forgotten after 35 s silent, the recorder
  stopped with the last one) and `hostStub.ts` loads it on the first hello, so a desktop
  nobody watches pays nothing. **Webview streams** (2026-10-12, §22.6): a page that runs
  its own workbench still shows the PC's one live page of each backend extension's
  webviews — Claude Code's chat view or tab — as a copy: `webviewCopy.ts` mounts a fluid
  viewer (laid out at the pane's own size, scrolled locally, following a scroller's end)
  in the pane, its up messages carry the stream (`view:<id>` / `panel:<ext>#<id>`), and
  `webviewShare.ts` on the PC records that one frame's document and replays the copy's
  taps and keys into it; `webviewFrames.ts` is the lookup the desktop's extension host
  registers (and the resolve of a view nobody showed yet) — so a question asked on
  either side streams on both. A mirrored `webview.create` / `webview.reveal` opens the
  copy tab in the FOREGROUND whichever side clicked (2026-10-12, the owner's direction:
  a Claude chat or Git Graph page opened on one side must open on the other — the old
  background-unless-asked policy hid the copy behind the other side's current page), and
  closing an extension page closes it everywhere: the panel's tab id
  (`webview:<extId>:<panelId>`) is the same on every frontend, so the operation sync's
  `closeTab` message turns a copy's close on a phone into the PC panel's close (which
  reaches the extension, the backend's dispose mirror then clearing every remaining
  copy) — before, a closed copy left the PC's page open (the owner's report, same day).
  **Cross-frontend operation sync** (2026-10-12, §22.7): two
  frontends running different UIs (the PC's desktop UI, a phone's own workbench) mirror
  each other's OPERATIONS, not pixels — every file open (with its line anchor), tab close,
  active-tab switch (an extension page's tab too — Git Graph or Claude Code's chat focused
  on one side comes forward on the other, a panel's own create never echoing as a switch),
  a diff or file-history tab (a Source Control change clicked, a history entry — its input
  crossing whole, revisions and paths only, so its tab id is the same on both sides and its
  focus and close key like an extension page's; a diff of an extension's provider text
  stays local),
  sidebar view switch and — from a side-by-side workbench only, a phone's side-page
  dismissal being navigation — side bar hide crosses as one `studio://workbench-sync`
  message (paths only, well under 200 bytes; a mirror-mode page subscribes to nothing and
  pays nothing) and lands on the other side's own workbench through
  `src/remote/workbenchSync.ts`: the open facade and the change hooks are wrapped for local
  operations, remote operations run raw and pre-mark an `announced` set (an echo can never
  re-announce; a local change mid-apply still crosses), a refused close settles both sides
  on "kept open", and the sync is silent until boot is through and local-only while a
  session restore rebuilds that frontend's own tabs. Its hardening round (2026-10-12, the
  sync-bugs pass, `tests/remoteWorkbenchSync.test.ts` pins each): an applied open is
  verified LANDED (the editor reports a failed open as a notification, not a rejection — an
  unverified pre-mark rebounded at the next tabs diff as a close of the other side's
  healthy tab), a close arriving while its open is still in flight queues and applies when
  it lands (a lost close re-opened the sender's just-closed tab), the bookkeeping keys
  paths slash- and drive-case-insensitively like the editor's `samePath` (one file's two
  spellings oscillated close/open until both sides' tabs closed), a superseded open's
  pending activation never swallows a later real switch and a background open never pends
  one, a remote close of the ACTIVE tab holds the applying guard until the tab is really
  gone (a dirty tab's save dialog settles whenever the user answers, and the successor
  activation it then fires is the close's consequence, not a switch), and the side-bar
  hide rule keys on the session (a real phone's own UI), not the window's live phone-shell
  marker — the PC wearing it for a mirror viewer keeps crossing. `editorArea.ts`'s `closeFilePath` /
  `revealFilePath` (and `EditorGroup.editorForPath`) are the path-keyed landings. A fluid copy of a page that renders its content around
  the scroll position needs the copy's own scroll on the PC too (2026-10-12, the phone's
  git-graph-rs showed blank below its header): the copy reports each scroller's position
  as a fraction of its range (`k:'scroll'`, its pixels being another layout's), the
  replayer puts the PC's same scroller there and the virtualized list renders the window
  the viewer looks at; and the end-following pins only a scroller already at its end —
  the old scan dragged every scrollable element (git-graph-rs's list, restored at the
  PC's offset) into the unrendered space its spacer rows stand in for. A reload is a new hello and a new snapshot: nothing on the
  PC restarts, and a Claude turn keeps running whether any browser is open. While viewers
  watch, the window's page keeps the focus (`remote_mirror_focus` — WebView2's
  `Emulation.setFocusEmulationEnabled`), a hidden window is sized to the viewer
  (`remote_mirror_fit`, the desktop size restored on Show), closing the window only hides
  it (`remote_host_hide_main`). A hidden window keeps rendering on its own — hiding a
  Tauri window never tells WebView2 it is invisible (measured 2026-10-12: rAF and 10 ms
  timers at full rate, `visibilityState` "visible"); custom `additionalBrowserArgs` are
  ruled out, since every instance of the app shares one WebView2 browser process per
  user-data folder and an instance whose arguments differ from a running one's gets no
  webview at all (macOS: `backgroundThrottling: "disabled"`); a `--remote-host` instance builds its window hidden instead of not at all,
  and declines the daemon's idle exit (`Quit { idle: true }`). A phone viewer makes the
  hidden window phone-sized, and below 600 px the window wears the phone shell itself
  (`phoneShell.ts` — the shell below, its stylesheet, the pointer counted as coarse), so
  the phone sees the phone app 1:1; the drawer's browser-only rows (windows, transfers,
  Data Saver) stay out there. One window wears one UI at a time, so a page whose UI cannot be the window's
  runs its own workbench instead (`uiMode.ts`, 2026-10-12, the owner's direction: the PC
  keeps the PC UI while a phone uses the phone UI): a phone attaching to a window the PC
  user has on screen (WINDOWS' `visible`), or flipping to one when the tray shows it; the
  first viewer owning the window's fit, a viewer of the other form factor told `own` by
  the host; the viewer bar's Own UI button and `?frontend=1` on request, the
  `remote.liveView` command (the drawer's row) and `?mirror=1` back to the copy. The tray
  lists every window of this PC — its Windows submenu, hidden ones marked, a click the
  daemon's `Show` (`tray/mod.rs`'s `window_entries`). The viewer's stylesheets come from the desktop build through
  the daemon's `main/…` app-asset route (`remote_host::app_asset` — css, fonts, images
  only, never scripts or pages).
- **`ggs-config`** (2026-10-13, the owner's direction): Remote Access configured from a
  command line — an SSH session on a fresh machine sets the password and the relay and
  reads the links, no window ever opening. `src-tauri/src/remote_config.rs` (ungated — the
  `ggs-node` sidecar pass compiles the whole lib without `desktop`, so the module is std +
  `serde_json` + `rpassword` only, its VSIX extraction over GGS Bash's pure-Rust zip
  layer, `archive.rs`'s `zip_entry`) drives the tray daemon's own CLI end to end: it finds
  the binary (the installed running copy under the remote root, an installed extension's
  package, or the daemon packed inside the bundled `ggs-remote.vsix` beside the app —
  extracted once into the root's `bin-incoming` staging dir, never the running `bin`),
  installs and starts it, sets the access password through the loopback admin API (the
  value on a stdin pipe, never an argv a process listing could show), optionally connects
  a relay, and prints the links. Reached as the `ggs-config` binary the installer carries
  beside `ggs` (`src-tauri/src/bin/ggs_config.rs`) and as the `ggs config` subcommand
  (lib.rs's run dispatches either spelling). This one module is the sanctioned exception
  to the module's naming seam (below): it names the daemon it drives.
- **The app side** (`src/remote/` + `remote.html` + `relay.html` + `vite.remote.config.ts` +
  `src-tauri/src/remote_host.rs` + `capabilities/remote-relay.json`): the same frontend with
  its `@tauri-apps/api` seam aliased onto the WebSocket shims (`tauriShim/`), the
  responsive shell, and the hidden Relay webview that executes a remote browser's
  invoke/Channel/listen calls with the real Tauri API. The phone form factor is an app,
  not a shrunken desktop (redesigned 2026-10-12): one column of full-screen pages over
  one page model (`pages.ts` — the page showing is read off the workbench's own DOM, and
  going to a page always shows it, never toggles it away; the extensions' pages are found
  generically: views containers mirrored off the hidden activity bar, `scm/title`
  navigation launchers such as Git Graph — no plugin id), the app bar (`appBar.ts`: ☰,
  the page's title and subtitle — the open file and its folder, the branch and its
  changes — and the page's own action sheets: the editor's, the repository's git set,
  the terminal's), the bottom navigation (`bottomTabs.ts`: Files · Editor · Changes ·
  each extension's page, five at most, with the open-editors and pending-changes badges;
  a second tap reselects — the Editor's opens the open editors list), the drawer
  (`navDrawer.ts`: every page, Go to File, the palette, this PC's windows, transfers,
  the full menus as sheets, Data Saver and Settings), the editor page's chrome
  (`editorSwitcher.ts`: the tab strip hidden, the open editors and the editor's actions
  as sheets, an empty state that is never a dead end), the editing row above the
  keyboard (`editorAccessory.ts`: Tab, arrows, undo/redo, comment, find, save — the
  arrows and Tab are the editor's own key events), the sheets every touch menu shares
  (`actionSheet.ts`: grabber, header, back step, drag to dismiss) — installed as `ui.ts`'s
  menu presenter, which answers before BOTH menu entry points (`showContextMenu` and
  `showMenuBelow`, 2026-10-13: the SCM pane's "More Actions…", a tree view's "…" overflow
  and the tab strip's overflow dropped desktop floating panels whose submenus cascaded
  left and right of them on a phone; on the phone every menu is the sheet, its submenus
  drilling in with a back step) — and the phone's back
  button closing the overlay on screen (`backStack.ts`); `responsive.ts` marks a raised
  keyboard (`data-keyboard`) and the body follows the visual viewport, so the bars step
  aside or lift with the content. A swipe from the left edge closes a side-view page
  (`gestures.ts`'s `swipeBack`, wired in `shell.ts`), the quick input (palette, quick
  picks) becomes a full-screen page (`remote.css`), and every file opens read-only with a
  lock button in the app bar — one tap reconfigures that editor editable in place, the
  next locks it again (`editLock.ts`, the button in `appBar.ts`; 2026-10-12 it replaced
  the unlock bar that took a row above the editor; the compartment leads the extension list because CodeMirror's
  `readOnly` facet combine honours the first value — `editor.ts` and `docEditView.ts`
  each reconfigure their own). Settings is the phone's own page (`settingsPage.ts`,
  2026-10-12: the desktop dialog's 720 px two panes leave a 390 px screen a 130 px strip,
  unreadable): one column of categories as drill-in rows, each level sliding in from the
  right with a back step, the phone's back popping one level at a time before it closes
  the page; booleans are row switches, choices (theme, language, enums) pick from an
  action sheet, numbers step in a − value + sheet snapped to the setting's own step, the
  File Associations catalogue and text/JSON extension settings edit in their own level or
  sheet, the root's search spans every category and the extension declarations, and Data
  Saver sits under a Remote Access category — all driving the same registry the desktop
  dialog drives (`SETTING_DEFS` + `updateSetting`, extensions through `saveExtSetting`,
  enum writes unified in `applyEnumSetting`); `installPhoneSettingsEntry` routes the
  drawer's row and the `workbench.openSettings` command (the palette, an extension's
  `workbench.action.openSettings`) to the page on the phone and restores the desktop
  command verbatim off it. The pages are page-stack navigation (`nav.ts`): an editor
  activating (`editor.ts`'s activate) closes the side view and the Terminal page above
  it, the panel showing (`panel.ts`'s show; a covered panel's toggle reveals it instead
  of hiding it unseen) closes the side view — over the `workbench.toggleSidebar` /
  `workbench.togglePanel` commands; before this, a file tapped in the explorer and a
  Terminal tab tap both opened beneath the overlay and looked dead. The phone chrome has
  a preview over the scripted backend (`dev/remote-phone.html`) and a screenshot pass
  (`scripts/probes/remote-phone-shots.mjs`).
  Traffic stays on demand: the Explorer pages huge
  directories over `list_dir_page` behind a "load more" row (`explorer.ts`, remote shell
  only), and the windowed-open threshold (`openThreshold.ts`) routes big files to the
  windowed editor at a sixteenth of the desktop cut. The remote hardening round
  (2026-10-12, browser-tested to a green live check): the Service Worker's cache lookups
  are bounded (`sw.ts` — a CacheStorage op wedged behind a large concurrent `put` once
  held a webview's parser-blocking stylesheet forever, and no frame extension's page
  ever finished loading; a lost race falls through to the network and refills), the
  editor area's overlay sync runs on a timer as well as rAF (`editorArea.ts` — a page
  the compositor never paints starves rAF, and a webview panel opened there stayed
  invisible), `ensure_relay` waits out the asynchronous window destroy before rebuilding
  (a rebuild racing it failed "already exists" and no relay ever came back), a backend's
  start settles are announced (`ext_process.rs`'s `ext-backend-state` — the Extensions
  view's "not running" no longer outlives the backend it described), a re-attached
  frontend recovers what it lost (`ext_routing`: a `webview.reveal` for a panel whose
  frontend died moves it to the asker, `webviewView.setHtml` joins the replay journal —
  before this a page reload left every extension panel unopenable and the sidebar's
  webview views blank), and the explorer's context menu hides the desktop-only
  "Reveal in File Explorer" on the remote shell — its transfer entries (2026-10-12; since
  2026-10-13's rewrite one vocabulary in every environment, module 3's `src/transfer.ts`:
  a file's Download, a folder's Download as Zip and Upload Files / Folder Here, riding
  `downloadTo` / `uploadInto` — progress toast, per-file failures collected and notified,
  never a silent hang; the wire transport loads on first use, so the desktop bundle never
  carries it). Uploads stay confined to the open
  folders server-side (`cmd_fs`'s `fs_write_chunk` / `fs_upload_offset` canonicalize the
  target, missing tail included, and refuse outside them — the download side's §7.8 rule;
  one process lock serializes chunks), and a download's Content-Disposition carries the
  RFC 5987 `filename*` beside the ASCII fallback, so a Chinese name no longer downloads as
  mojibake (the daemon's `content_disposition`). The menus a browser session cannot use
  drop at the source (`workbench.ts`'s `menus()`: New Window and Open Developer Tools for
  any remote session — both would open on the PC, invisible to the browser — and Keyboard
  Shortcuts plus the Editor Layout submenu on the phone form factor; Paste runs through the
  clipboard plugin there, a browser forbidding `execCommand('paste')`). `GGS_HOME` now relocates the extension
  store, the symbol index, the settings and the locale (the hermetic probes relied on
  it; before, the real `~/.ggs` leaked into every probe run).
  The module's seams are enforced:
  `scripts/check-seams.mjs` keeps `__TAURI_INTERNALS__` inside `src/remote/tauriShim/` and
  the plugin id out of the app tree — `remote_config.rs` (the `ggs-config` CLI above)
  alone excepted: its job is to find and drive the daemon by name.
- Tests: `tests/remoteMirror.test.ts` (the replica: snapshot and every mutation kind into
  the copy, URL tokens, the CSP drop, the sequence-gap resnap, the input replay, the host's
  viewer lifecycle, the PC window's phone mode, the transfer entries joining the mirrored
  menu and sheet with locally-run clicks), `tests/remote.test.ts` +
  `tests/remoteResponsive.test.ts` (the shims, transport,
  relay engine; the phone's page model, app bar, navigation, drawer, sheets, editing row
  and settings page; the transfer layer — chunked resumable uploads with per-file failure
  collection, the download ticket flow and its refusal; M10's end-to-end crypto — the
  browser twin of the tray service's e2e core against the committed cross-implementation
  vectors), `tests/remoteWorkbenchSync.test.ts`
  (the cross-frontend operation sync: the shared-bus core, a real EditorArea under the sync,
  the wired workbench, the extension pages across frontends, and the hardening round's
  regression cases), the daemon and hub crates' `cargo test`,
  `tests/e2e/remote/` (the Playwright browser specs — `npm run test:e2e-remote`, the
  Chromium/Firefox/WebKit matrix against TLS daemons: WebKit grants plain-HTTP localhost no
  Secure-cookie exemption, so the specs ride the shipping self-signed shape; the workbench
  pair behind `GGS_REMOTE_E2E_FULL=1` and a build that bundles claude-code),
  `scripts/probes/remote-live-check.mjs` (the live LAN end-to-end probe),
  `tests/remoteRound.ts` (§17.3's remote round: the sweeps re-run with every invoke
  crossing the real shim chain — tauriShim → Transport → frames → RelayEngine — against the
  same scripted handlers; the mock Channel carries the `__GGS_CHAN__:` stream marker),
  `scripts/probes/remote-hub-multi-check.mjs` (the multi-PC live probe: one Hub, two
  daemons in hermetic homes, two `--remote-host` instances, one browser user on both
  `/u/<uuid>/` links — session/Cookie/Storage isolation, the kick reaching only one PC,
  rate-limit isolation, the front-door guards; both link shapes `/u/<uuid>/` and
  `/u/<uuid>` serve the PC, never a router 404) and
  `scripts/probes/hub-load.mjs` (the Hub load probe: N fake PCs with real Ed25519
  handshakes, M browser sessions, Hub RSS/CPU to `metrics.json` under `remote.hubLoad`;
  its config sets `handshake_rate = 0`, the knob that lifts the default 10 handshakes
  per minute per IP). CI:
  `remote-daemon-test` (three OSes) and `remote-hub-test` in `studio.yml`.

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
  the search does it (the `ggs-index` crate's `search`, behind `cmd_search.rs`) before
  inventing a new pattern.

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
Key strings in `src/platform/i18n.ts`, resolve with `t(key)`. Missing translations fall back to
English, never to an empty string.

**Nothing generated in the source tree.**
`prepare.mjs` writes only to `target/studio/`; `vite build` bundles `index.html`,
`ext-host.html` and `relay.html`, and the remote workbench build
(`vite.remote.config.ts`) writes under `target/studio/dist/remote/`; `dev/` pages never
ship.

## Testing

Tests mirror the modules.

| Layer | Location | Harness |
| ----- | -------- | ------- |
| Frontend unit / view | `tests/<module>.test.ts` (e.g. `scm.test.ts`, `explorer.test.ts`, `canLog.test.ts`) | vitest + jsdom; `tests/tauriMock.ts` scripts every Tauri `invoke`, records calls, and replays backend events; most files share the `vmThreads` pool, whose snapshot environment is named explicitly in `tests/vmSnapshotEnvironment.ts` — vitest's default resolution is a bare dynamic `import()` inside the vm context that dies with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` on the Node 20 line |
| Frontend scenario | `tests/scenarioHarness.test.ts`, `tests/scenarioFixtures.ts`, `tests/helpers.ts` | Multi-view flows over the same mock |
| Frontend sweeps | `tests/commandSweep.test.ts`, `tests/uiSweep.test.ts`, `tests/themeContrast.themes.test.ts` | Every command executes; layout and WCAG invariants hold for every theme |
| Backend unit | `#[cfg(test)]` beside each command; `src-tauri/src/test_support.rs` | Scratch repositories with an isolated git config |
| Backend integration / perf | `src-tauri/tests/it/perf.rs` | Synthetic repository, `GGS_PERF_FILES` |
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
  cancellation generation (the `ggs-index` search pattern, `cmd_search.rs` the adapter).
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
