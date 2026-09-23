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
the Git Graph view, a `.ggx` Extension Platform, and a CAN Trace Analyzer.

| Document | Role |
| -------- | ---- |
| `README.md` | What ships: features, repository layout, build instructions |
| `docs/crabcode-development-plan.md` | The authoritative plan. §3 *Architecture principles* binds every change; §5 lists milestones; §9 defines the quality bar |
| `AGENTS.md` (this file) | How to change the code without breaking its structure |

When this file and the plan disagree, the plan wins; fix this file in the same change.

## Quick start

Prerequisites: Rust 1.94+ (`rust-version` in `src-tauri/Cargo.toml`; the floor is
big-code-analysis, module 17's metrics engine), Node.js 20+, and a
`git` executable on `PATH`.

```sh
# 1. The engine submodule — checked out and compiled once
git submodule update --init
cd vscode-git-graph-rs && npm install && npm run compile && cd ..

# 2. The app
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
| `node scripts/measure.mjs --repo vscode-git-graph-rs` | Size and performance measurement — recorded to `target/studio/metrics.json` (no budgets; see principle 6) |

All generated output — the Vite public dir and dist, the Cargo target, installers, coverage,
`metrics.json` — lands under `target/studio/` (gitignored). Nothing generated is ever written
into the source tree.

## Architecture

Two processes joined by Tauri IPC, with one library at the core:

```text
┌──────────────────────── Frontend (src/, TypeScript, no framework) ────────────────────────┐
│ workbench.ts composes the shell; every view is hand-written DOM over the ui.ts kit;        │
│ every action is a command in commands.ts; every backend call is a Tauri `invoke`.         │
└──────────────────────────────────────────┬────────────────────────────────────────────────┘
                                           │ invoke / Channel / events
┌──────────────────────────────────────────┴────────────────────────────────────────────────┐
│ Backend (src-tauri/, Rust): one cmd_*.rs per domain, exposing #[tauri::command]s.         │
│ Graph/SCM/revision reads go to git-graph-backend, a warm sibling process, over ggx-rpc/1;  │
│ every other read is plain in-process filesystem access; writes shell out via git.rs.       │
└──────────────────────────────────────────┬────────────────────────────────────────────────┘
                                           │ single seam: cmd_graph.rs (Rust) · graphHost.ts (TS)
┌──────────────────────────────────────────┴────────────────────────────────────────────────┐
│ git-graph-backend (plugins/git-graph-rs/): links git-graph-core (native/core) from        │
│ vscode-git-graph-rs/ — the app binary itself never does. The compiled webview also        │
│ comes from the submodule.                                                                 │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

The principles below are the plan's §3, condensed. They apply to every change.

1. **Pure-Rust backend.** No C bindings beyond the one sanctioned exception (plan §3.1):
   tree-sitter grammars compiled by cargo's `cc`, each behind a `grammar-*` feature;
   syntect runs on `default-fancy`, git access is gix.
2. **The read path never spawns a process.** Commit, ref, diff, config and file-at-revision
   reads go to `git-graph-backend`, a warm sibling process reached over a pipe (`ggx-rpc/1`)
   — no process is spawned per read, only once at install/boot. `git-graph-studio` itself
   never links the engine (`cmd_graph/engine_impl.rs`, `engine` feature, `git-graph-backend`
   only). Writes (stage, commit, fetch, push, …) use the `git` CLI, and only through
   `src-tauri/src/git.rs`.
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
| 12 | Extension Platform | `.ggx` installs and the extension host |
| 13 | CAN Trace Analyzer | CANoe-style `.blf` / `.asc` analysis |
| 14 | Performance Lab | Measurement, metrics and the perf gate |
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
- Backend: `src-tauri/src/lib.rs` / `main.rs` (crate inventory and app entry)

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
  macOS; and the Explorer context-menu entry `context_menu_apply` — the "Open with Git
  Graph Studio" static shell verb under `*` / `Directory` / `Directory\Background` /
  `Drive`, re-applied at every boot, removed by the NSIS uninstall hooks)
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
- Backend: `src-tauri/src/cmd_scm.rs` (status through the engine, mutations through the git
  CLI), `src-tauri/src/scm_ops.rs` (the "..." menu operations), `src-tauri/src/git.rs`
  (the one and only git-CLI runner)

### 10. Git Graph Engine

The Git Graph webview — the same `out.min.js` the extension serves — hosted unchanged
behind an `acquireVsCodeApi` shim, over the git-graph-rs engine running as its own process
(`git-graph-backend`, the `.ggx` package's backend, `ggx-rpc/1`). **This module owns both
seams**; nothing outside it may touch the extension's artifacts or the engine crate (see
[Invariants](#invariants)). **`git-graph-studio` (the app binary) never links
`git-graph-core`** — only `cmd_graph/engine_impl.rs` (the `engine` Cargo feature, compiled
into `git-graph-backend`) does; every write still runs the `git` CLI from the app itself.

- Frontend: `src/graphHost.ts` (the TypeScript seam), `src/graphPreload.ts` (the view page's
  composer and boot warmer — part of the seam: it generates the extension's own page
  (gitgraph/viewpage.js), composes it with the host environment and starts it during the
  splash; it never speaks `graph_request`)
- Backend: `src-tauri/src/cmd_graph.rs` (the Rust seam: the always-compiled wrappers and
  `handle_repo_request`'s host-only arms, both proxying to `plugin_host.rs`; the write
  dispatch `handle` over the `git` CLI; + `cmd_graph/write_tests.rs`),
  `src-tauri/src/cmd_graph/engine_impl.rs` (`#[cfg(feature = "engine")]`: every call that
  actually names `git-graph-core`, plus the Gerrit cache), `src-tauri/src/plugin_host.rs`
  (the app's typed facade over the running backend — `ext_process::global()`, no `AppHandle`
  threaded through, the bundled-install race's bounded wait), `src-tauri/src/backend_rpc.rs`
  (the `ggx-rpc/1` wire protocol: thread-per-request, distinct from `ggs-ext/1` because the
  view's opening burst needs concurrent reads), `plugins/git-graph-rs/src/main.rs`
  (the `git-graph-backend` binary itself: `serve_backend` dispatch, the `__`-prefixed
  synthetic commands `cmd_fs.rs`/`cmd_scm.rs`/`lib.rs`/the Gerrit pipeline send alongside the
  view's own protocol messages). The engine is `git-graph-core` from
  `vscode-git-graph-rs/native/core`.

### 11. Integrated Terminal

xterm.js fronting portable-pty sessions (ConPTY on Windows), with new/kill actions and the
terminal list.

- Frontend: `src/terminal.ts`
- Backend: `src-tauri/src/pty.rs`

### 12. Extension Platform

The extension store (`~/.ggs/extensions/`): Studio's own `.ggx` format (`ext_install_from_ggx`)
plus `.vsix` as the VS Code compatibility path (restored 2026-09-22 after that day's
ggx-only removal; same store, same forward-only upgrades, a `.ggx` and a `.vsix` of one id
are one extension — the higher version wins). `ggx/2` adds the named page registry (every
page a package can show, opened as editor tabs over the `ggx://` protocol) and the process
backend (a binary, speaking the `ggs-ext/1` line-JSON-RPC protocol over stdin/stdout — any
language that can write lines to stdout qualifies; the app embeds no runtime) — plus the
Extensions view with detail pages, backend status and restart. VSIX extensions activate in
the frame host (`extHost.ts` + `vscodeApi.ts`) with a growing `vscode` API surface:
commands, configuration (with `onDidChangeConfiguration` pushed in), message toasts with
MessageItem, quick picks (string and object items), `withProgress` toasts, output channels
(the Output view's channel dropdown), status bar items (`window.createStatusBarItem` /
`setStatusBarMessage`, rendered by the status bar), webview panels
(`window.createWebviewPanel` — a sandboxed srcdoc iframe in an editor tab, with
`acquireVsCodeApi()` composed in, `asWebviewUri` mapping onto `ggx://`), persisted
`globalState`/`workspaceState` mementos, and `env.clipboard`. **Nothing installs by
default.** Two packages ship beside the installer (`extensions/`, packed by `prepare.mjs`):
git-graph-rs, whose integrated entry offers it as a **one-click install**
(`ext_install_bundled`) that lands it as a standard, uninstallable package — its engine
linked in its backend process and its view assets the extension's own — and the **GGX
Demo**, the format's worked example and the template new plugins (human- or AI-authored)
start from, offered the same one-click way as a pure sample (`plugins/ggs-ext-demo/`, its
README the authoring guide). With no install of either (the default), each listing falls
back to the manifest embedded at build time. **Install means run**: the boot pass starts
every installed package that declares a backend (`ext_process::start_all_installed`, off the
window's thread), an install starts its backend at once, and the first command remains the
lazy fallback. Multiple app instances are independent — each spawns and owns only its own
backends (`GGS_INSTANCE_ID` marks the owner), every backend this instance spawned is stopped
on exit, and an uninstall stops the backend before removing its directory (a directory
another window's backend still holds refuses with a close-that-window hint). A completed
uninstall also writes an `<id>.uninstalled` marker beside the version directories: the boot
pass's every-launch auto-install of the bundled git-graph-rs honours it, so a deliberate
uninstall survives the next launch (any explicit install of the id clears the marker and
revives the auto-upgrade).

- Frontend: `src/extensionsPanel.ts`, `src/extHost.ts` (the frame host for VSIX/`.ggx`
  extensions, the page host, the process-command dispatch of `ggx/2`, and the host services
  behind the `vscode` API — webview panels, status bar items, output channels, progress
  toasts, memento persistence, tree views, activationEvents) + `ext-host.html` +
  `src/extHostBoot.ts` (one sandboxed frame per extension), `src/vscodeApi.ts` (the `vscode`
  shim the frames require), `src/treeView.ts` (the generic tree view host — the sidebar
  surface `contributes.views` declares and `createTreeView` feeds),
  `src/contributions.ts` (manifest contributions merged into the workbench); the surfaces it
  reaches into: `src/statusbar.ts` (extension items), `src/panel.ts` (the Output view's
  channel dropdown), `src/ui.ts` (`progressToast`)
- Backend: `src-tauri/src/cmd_ext.rs` (install / upgrade / uninstall, `.ggx` and `.vsix`
  unpack (the VS Code compatibility path), the
  bundled-package registry — git-graph-rs and the GGX Demo, `ext_install_bundled`'s ids — the
  `ggx://` protocol that serves an installed package's files — composing the page bootstrap
  into every HTML page, and `ext_fs` — the workspace-confined file services behind
  `vscode.workspace.fs`, `findFiles` and `workspaceContains` activations),
  `src-tauri/src/ext_grammar.rs` (the TextMate-grammar loader: `.tmLanguage` plists and
  `.json` grammars converted to Sublime syntax and added to the rope viewer's syntect set), `src-tauri/src/ext_process.rs` (the process extension host: eager
  start at boot and install, lazy start on first command as the fallback, `initialize`
  handshake, `runCommand`, crash isolation, remembered status (start count, last error),
  stop on uninstall and at app exit), `src-tauri/src/ggx_protocol.rs` (the `ggs-ext/1` wire
  protocol, shared with plugin binaries), `src-tauri/src/ext_page_boot.js` (the
  `acquireGgsApi()` bootstrap the protocol composes into served pages),
  `plugins/ggs-ext-demo/src/main.rs` (the reference plugin binary — the shipped sample's
  backend, every `ggs-ext/1` capability once)
- Every `.ggx`-producing plugin's own folder under `plugins/` (its manifest fields, page
  files, backend source and packer together, not scattered): `plugins/ggs-ext-demo/`
  (`package.json`, `web/view.html` + `web/params.html`, `resources/icon.svg`, `src/main.rs`,
  `build.mjs` its own packer, `README.md` the plugin authoring guide) and
  `plugins/git-graph-rs/` (`src/main.rs`
  the backend, `build.mjs` its own packer — the only script that reads the
  `vscode-git-graph-rs` submodule for packaging — plus `package.json`/`README.md` as the
  folder's own metadata; its frontend is that submodule, which cannot move). Each is its own
  Cargo `[[bin]]` in `src-tauri/Cargo.toml`, pointing at that folder.
- Build: `scripts/builtin-contributions.mjs` (bakes `virtual:builtin-contributions`),
  `scripts/build-ggx.mjs` (the shared packing infrastructure — `writeGgx`, `hostPlatformKey`,
  `filesUnder` — every plugin packer builds on it), `plugins/git-graph-rs/build.mjs`
  (git-graph-rs's own packer: the ggx/2 header from the submodule's manifest, `--backend`
  embedding the compiled `git-graph-backend`), `plugins/ggs-ext-demo/build.mjs`
  (the GGX Demo's own packer: the format's worked example, two pages + the process backend —
  run by `prepare.mjs` as part of every app build, so the installer carries the sample),
  `scripts/build-plugins.bat` (builds every `.ggx` under `plugins/` independently of the app
  build — one command for all of them)
- Tests: `tests/extensions.test.ts` (pages, the process dispatch), `tests/editor.test.ts`
  (the extpage tab), `src-tauri/tests/ext_process_host.rs` (the real
  install→activate→command→stop chain over the demo binary)

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
  `dev/dev-harness.html` (the two-mode harness: real Tauri IPC under `tauri dev`, or the
  scripted fake backend under `npm run dev:vite`)

### 16. Symbol MCP Server

The `ggs --mcp <repository>` mode: the persistent symbol index and the Code Analysis
engine served to AI assistants over the Model Context Protocol (newline-delimited
JSON-RPC 2.0 on stdio; headless — no window is ever created). The navigation tools —
`symbol_lookup`, `symbol_references` (the occurrence-narrowed scan), `symbol_tree` (the
same per-file outline the Symbol Database page renders), `search_symbols`, `read_file`
(a line-windowed file reader, path-confined to the repository), `search_text` (the
workspace text search), `index_status` — plus module 17's analysis tools
(`analysis_module_graph`, `analysis_call_graph`, `analysis_call_path`,
`analysis_metrics`, `analysis_dead_code`, `analysis_security`, `analysis_import_graph`,
`analysis_import_cycles`). Every call is logged as one JSON line to
`~/.ggs/logs/mcp.log` (rotated past 1 MB), which the in-app MCP Server page shows.
stderr is logs; stdout is protocol only.

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
five analysis tools plus module 16's MCP Server entry — Module Analysis (the workspace's cross-file calls as a drawing and a tree: the
drawing renders on @antv/G6 — canvas, built-in layouts the picker switches (force,
layered, circular, radial, grid, concentric), each sized to the blocks' real extents so
rectangles never overlap (nodeSize from `data.size`, preventOverlap, per-layout spacing,
a computed ring radius), blocks draggable, a click highlighting the clicked element
with the dependencies it touches (the rest dims; a canvas click or the chip clears),
the right-click menu opening the file, jumping to a related block through the
Calls / Called-by submenus, isolating the neighbourhood or listing an arrow's call
sites, double-click opening the file, a colour legend mapping the modules — over at most
400 blocks and 1500 arrows; the tree collapses the same data into
module dependencies → file pairs → call sites, children rendering only while expanded),
Complexity & Hotspots, Dead Code, Security Scan (rule-based, no taint tracking) and the
Import Graph (with cycles) — each opening a streamed result page in the editor area. The
engine resolves calls by name with receiver hints (no type inference); its honest limits
are stated on the pages themselves. The per-symbol call graph walk and the shortest call
chain remain engine services served to the MCP server (module 16), not a page. G6 is the
CodeMirror precedent: a specialized canvas engine living in the lazy analysisPages chunk,
not a frontend framework — the rest of the page stays hand-written DOM.

- Frontend: `src/analysisView.ts` (the sidebar), `src/analysisTools.ts` (the shared tool
  registry), `src/analysisPages.ts` (the lazy result pages: streaming reports, the G6
  drawing and the module tree — jsdom suites stub G6 through `tests/g6Stub.ts`)
- Backend: `src-tauri/src/cmd_analysis.rs` (the per-root `AnalysisIndex`, the streaming
  tool commands), `src-tauri/src/analysis/` (`mod.rs` the engine and the per-symbol call
  graph, `metrics.rs`, `deadcode.rs`, `security.rs`, `modules.rs` the Module Analysis
  aggregation, `imports.rs`, `bca.rs` the big-code-analysis
  bridge whose report-time columns — cognitive complexity, Halstead volume, logical SLOC,
  the maintainability index — enrich the Complexity & Hotspots rows); parsing comes from
  module 5's `symbols/parse.rs`
- Tests: `tests/analysis.test.ts`, the `analysis/` modules' `#[cfg(test)]`

### 15. Build & Release Pipeline

Everything that turns the source tree into installers: asset assembly into
`target/studio/`, the seam checks, CI, and the Linux build containers.

- Assets: `scripts/prepare.mjs` (assembles `target/studio/`), `scripts/compare-bundle.mjs`
  (the Git Graph page bundles `prepare.mjs` builds from the extension's compiled CommonJS
  output: the view page generator `gitgraph/viewpage.js` — the extension's own
  getHtmlForWebview — the Commit Comparison page generator with the binary-area host
  machinery `gitgraph/compare.js`, and the standalone Binary Compare page generator
  `gitgraph/binarycompare.js`), `scripts/*-stub.cjs` (the `vscode` / Node stubs the page
  bundles build against; `hex-fs-stub.cjs` lazily proxies the hex machinery's `fs`
  calls to the adapter `graphHost.ts` installs), `vite.config.ts`
- Seam checks: `scripts/check-seams.mjs` (TypeScript / CSS) and `src-tauri/build.rs` (Rust)
- Packaging: `scripts/build-studio.bat` (Windows, one command; builds `git-graph-backend`
  through `prepare.mjs` as part of that). `scripts/build-plugins.bat` builds every plugin's
  `.ggx` under `plugins/` on its own, without the app installer — useful when only a plugin
  changed. Linux installers are built
  in floor containers — the base image IS the compatibility floor: `ubuntu:22.04`
  (glibc 2.35) for the deb, `fedora:38` (glibc 2.37) for the rpm. CI (`studio.yml`) runs
  the same containers `scripts/build-studio-linux.bat` +
  `scripts/docker/Dockerfile.studio-linux` + `scripts/docker/studio-linux-build.sh` drive
  locally, and the in-container pass fails the build if the binary's glibc requirements
  ever exceed the floor. The `ggs` command line ships with every package:
  the bundled binary is named `ggs` (`mainBinaryName`), `src-tauri/nsis-hooks.nsh` puts the
  NSIS install directory on the user's PATH (and removes it on uninstall), and the deb/rpm
  packages install it as `/usr/bin/ggs`. Installer-level file associations for the default
  extension set come from `bundle.fileAssociations` in `tauri.conf.json`; the NSIS hooks also
  remove the runtime-registered ProgIds and the RegisteredApplications entry on uninstall
- CI: `.github/workflows/studio.yml` (PRs: typecheck + vitest; `main`: also `cargo clippy
  -D warnings`, `cargo test`, installers for Windows and Linux, the perf gate — the tests
  gate the installer build, and each Linux package format compiles in its own floor
  container);
  `.github/workflows/release.yml` (a pushed `v*` tag publishes installers with `SHA256SUMS`)

## Development workflow

### Before you change anything

1. Identify the module(s) the change belongs to from the map above. A change that needs
   three or more modules usually means a missing command or backend service — design that
   first.
2. Read the module's existing files and its test file; match their structure and naming.
3. Check `docs/crabcode-development-plan.md` §3 for a principle that constrains the approach, and
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
- [ ] No generated file, `target/` output, or edit inside `vscode-git-graph-rs/` is staged.
- [ ] Version bump (if any) touched `package.json`, `src-tauri/tauri.conf.json` and
      `src-tauri/Cargo.toml` together.
- [ ] A packaged regression was ruled out by running under `npx tauri dev` when the change
      touches boot, assets, the seams, IPC, or anything `prepare.mjs` produces.

## Invariants

These are the rules that keep the codebase navigable and the coupling to the engine
contained. The build enforces the first two; reviewers enforce the rest.

**Seam rule — TypeScript and CSS (enforced by `scripts/check-seams.mjs`).**
The extension's artifacts are consumed by exactly one seam: `src/graphHost.ts`
is the only caller of the `graph_request` channel and the only namer of the extension's asset
paths, and its companion `src/graphPreload.ts` (which generates and composes the extension's
own view page, and reads the config bundle for the warmed boot) is the only other file
allowed those patterns. Every page the user sees — the view, the Commit Comparison, the
Binary Compare — is the extension's own generated page; the app composes it with the host
environment (theme tokens, `acquireVsCodeApi` shim, deferred script loading) instead of
carrying a copy of it. The patterns
`graph_request`, `gitgraph/`, `GitGraphStudioConfig`, `out.min` and `web/styles` may not
appear anywhere else under `src/` or `static/`. The check runs on every `prepare.mjs`, every
Vite build and dev-server start, and as vitest's global setup.

**Seam rule — Rust (enforced by `src-tauri/build.rs`).**
`src-tauri/src/cmd_graph.rs` and its `cmd_graph/` submodules (`engine_impl.rs`, feature-gated
behind `engine`; `write_tests.rs`) are the only files that may name the `git-graph-core`
crate — `build.rs` exempts that one directory and scans everything else under `src/`. Every
other backend module reaches the engine through `cmd_graph.rs`'s always-compiled wrappers
(`resolve_repo_root`, `close_engine_repos`, `scm_changes`, `revision_file`, …), which since
the M6 split proxy to `plugin_host.rs` rather than calling the engine directly — their
signatures and call sites do not change; only their bodies do. Add a wrapper there rather than
a second `use git_graph_core`, and put its real implementation in `engine_impl.rs` as a
distinct name (never a bare `#[cfg(not(feature = "engine"))]` twin of the same name — that
would never compile under `cargo test --all-features`, which turns both `desktop` and
`engine` on at once).

**The engine runs as its own process; `git-graph-studio` never links it.**
`git-graph-core` is reachable only via the `engine` Cargo feature, which only
`git-graph-backend`'s (`plugins/git-graph-rs/`) `required-features` turns on — the
app's own binary (`desktop` feature) never enables it (verify with `cargo tree -e normal` on
a default build). Reads still never spawn a process per call — the backend is a long-lived,
warm sibling process (`plugin_host.rs` / `ext_process.rs` keep it running; `backend_rpc.rs`'s
`ggx-rpc/1`, thread-per-request), reached over a pipe, not launched fresh each time. Writes
still never spawn `git` anywhere except `src-tauri/src/git.rs`; the panel's Git channel is fed
from that single runner, and the write path stays entirely in the app process.

**One module, one responsibility.**
A source file belongs to exactly one module and the map is the contract. If a file does not
fit any module, the module map is wrong — fix it explicitly, do not leave the file orphaned.

**Product-grade naming.**
User-facing modules, views, commands and settings carry commercial names (File Explorer,
Source Control, CAN Trace Analyzer), consistent with the README and the Extensions view.
Internal identifiers stay technical (`cmd_fs.rs`, `graphHost.ts`).

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
- Module stubs `scripts/empty-stub.cjs`, `scripts/path-stub.cjs`, `scripts/vscode-stub.cjs`
  stand in for Node and `vscode` in the bundles the tests and build load.
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
- **Never commit**: `target/`, `out/`, anything `prepare.mjs` regenerates, `metrics.json`,
  or edits inside `vscode-git-graph-rs/` — that directory is the submodule's own repository
  and is advanced by updating the gitlink, not by editing files in place.
- Branch model (plan §9): `main` is always releasable; milestone branches are `ggs/mN-*`;
  one PR per task. A PR is mergeable when the checks in
  [Definition of done](#definition-of-done) pass and CI is green.
- Releases are cut by pushing a `v*` tag after the three-file version bump;
  `release.yml` builds and publishes the installers.

## Reference

| Topic | Where |
| ----- | ----- |
| Architecture principles | `docs/crabcode-development-plan.md` §3 |
| Hard acceptance targets for 1.0 | `docs/crabcode-development-plan.md` §4 |
| Milestones and task breakdown | `docs/crabcode-development-plan.md` §5 |
| Size playbook / performance budgets | `docs/crabcode-development-plan.md` §6–7, `scripts/measure.mjs` |
| `.ggx` package format and extension host | `docs/crabcode-development-plan.md` §8, `README.md` → *Extensions* |
| Quality and release process | `docs/crabcode-development-plan.md` §9 |
| `~/.ggs/` layout | `docs/crabcode-development-plan.md` Appendix B |
| Repository layout | `README.md` → *Layout* |
| Seam rules, as code | `scripts/check-seams.mjs`, `src-tauri/build.rs` |
| Engine API contract | `vscode-git-graph-rs/native/core/src/api.rs` (`git_graph_core::Engine`) |
