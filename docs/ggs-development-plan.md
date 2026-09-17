# Git Graph Studio (GGS) Development Plan

> Status: v2, 2026-09-13 (v1 was 2026-09-12; `docs/feature-roadmap.md` is gone, this is the only plan). Section 1.3 is the progress log.
> Scope: the desktop application under `app/` (Tauri 2 + Vite/TS frontend + Rust backend) and the engine's library interface (`native/core/src/api.rs`). The VS Code extension's own UI is out of scope.
>
> History note: the plan was written while the app lived in the `app/` directory of the
> vscode-git-graph-rs repository. The app is now this standalone repository and the extension
> is the `vscode-git-graph-rs/` submodule — read `app/…` as the project root and `src/…`,
> `native/core/…`, `web/…`, `media/…` as `vscode-git-graph-rs/…` where the distinction matters.

---

## 0. The goal in one sentence

**GGS is a single desktop binary under 10 MB that does everything VS Code does, opens and searches 100,000-file projects instantly like Source Insight, compares and merges like Beyond Compare, feels as polished as Xcode, and installs git-graph-rs and other VSIX extensions.**

Each of the five benchmarks contributes one thing, and each has a measurable acceptance line (section 4):

| Benchmark | What we take | What we leave |
|---|---|---|
| VS Code | The workbench model (activity bar / side bar / editor groups / panel / status bar / command palette), keybindings, the settings system, the extension contract | Electron, the Node extension host, debugger / remote development / notebooks |
| Source Insight | The project-wide symbol database, references / call trees / relation window, startup and open speed on huge projects, the context window | Its UI style and proprietary parser scripts |
| Beyond Compare | Folder compare and sync, three-way merge, comparison rules (ignore whitespace / case / regex), hex / image compare, sessions | FTP / cloud remote sessions |
| Xcode | Restrained visual hierarchy, motion and feedback, native window feel, keyboard-first, empty-state design | Interface Builder, Instruments |
| Size | One exe, no runtime dependency (system WebView2 on Windows), installer ≤ 8 MB | — |

---

## 1. Where we are (2026-09-12)

### 1.1 Size of the codebase

| Item | Value |
|---|---|
| Frontend TS (`app/src`) | 31 modules, ~9,300 lines |
| Backend Rust (`app/src-tauri/src`) | 16 modules, ~6,400 lines (incl. 1,203 lines of git write-operation tests) |
| Engine `native/core` | 4,362 lines, gix 0.87 in-process read path |
| Frontend tests | vitest, 13 files, ~74 cases (jsdom + `tauriMock`) |
| Backend tests | `git_actions/tests.rs`, `stage_bench.rs` (real temporary repositories) |
| Release exe (Windows x64) | **23.2 MB** (`target/studio/cargo/release/git-graph-studio.exe`) |
| NSIS installer | **28.1 MB** |
| Frontend dist | 3.3 MB (`workbench-*.js` 820 KB, `out.min.js` 416 KB, codicon.ttf 148 KB) |
| Bundled VSIX | **21.5 MB**, of which the `git-graph.node` native addons for 6 platforms are 56 MB uncompressed — GGS **never loads them** |

### 1.2 What exists, by module

**Workbench shell (`workbench.ts`, `titlebar.ts`, `panel.ts`, `statusbar.ts`, `ui.ts`, `state.ts`)**
- Custom-drawn title bar with VS Code's menu layout (File / Edit / Selection / View / Go / Terminal / Help), window controls, recent folders.
- Activity bar: Explorer / Source Control / Extensions / Git Graph / Terminal / Open Folder.
- Resizable, persisted side bar and panel; command palette (`Ctrl+Shift+P`) and Quick Open (`Ctrl+P`, backend rayon walk, prefetched on folder open, capped at 20,000 files).
- 46 keybindings; the `commands.ts` registry drives menus / panels / keybindings / context menus alike.
- 6 themes (Dark / Light Modern, Default Dark+, HC Black, Monokai, Nord), English and Chinese UI, a settings panel (theme / language / outline toggle).
- A boot splash (`index.html`) covers the window while the module graph loads.

**Explorer (`explorer.ts`, `cmd_fs.rs`)**
- Lazy tree, indent guides, codicon icons, git status colouring, new / rename / delete / reveal in OS / copy path, context menu (including extension-contributed `explorer/context`).

**Editor (`editor.ts`, `fastView.ts`, `cmTheme.ts`, `viewer/*.rs`)**
- CodeMirror 6: languages loaded on demand (`@codemirror/language-data`), folding, bracket matching, find/replace, selection-match highlighting, multi-cursor (CM built-in).
- Tabs + breadcrumbs + back/forward history, dirty tracking, save / save all, on-disk change detection by fingerprint.
- Fast read-only viewer: backend ropey + syntect (pure Rust) with per-block highlight checkpoints, frontend virtual scroller rendering only visible lines, an "Edit" button that swaps in the real editor; per-file Outline.
- Diff editor over any two revisions (working tree / index / HEAD / hash), split or unified by available width.
- Go to Definition (F12 / Ctrl+Click): backend workspace symbol index (`cmd_search::workspace_symbols`) with a regex heuristic fallback.

**Source control (`scm.ts`, `gitCommands.ts`, `cmd_scm.rs`, `scm_ops.rs`)**
- Staged / Changes groups, inline stage / unstage / discard, commit (amend / all / staged variants), click-to-diff.
- 37 `git.*` commands: clone, branch / checkout / rename / delete, merge, rebase, pull / push / sync (with rebase / force variants), fetch / prune, the stash family, tags, remote add / remove, undo commit, Gerrit hook install and push-ref.
- The panel's "Git" output channel echoes every git command as it runs.

**Git Graph (`graphHost.ts`, `cmd_graph.rs`, `git_actions.rs`)**
- The extension's `out.min.js` hosted unchanged in an iframe behind an `acquireVsCodeApi` shim; the read path runs 100% through `git-graph-core` (no git child processes).
- Every write operation of the view (branches / tags / stash / merge / rebase / cherry-pick / revert / reset / push / fetch …) is implemented in `git_actions.rs` over the git CLI, one arm per `DataSource` method of the extension, including the data-loss-warning confirmation protocol.
- The commit comparison tab `compareView.ts` (GitHub style: commit cards + file tree + unified diff).

**Terminal (`terminal.ts`, `pty.rs`)**: xterm.js + portable-pty (ConPTY on Windows), multiple sessions, an entered command triggers an SCM refresh.

**Extensions (`extHost.ts`, `extHostBoot.ts`, `vscodeApi.ts`, `contributions.ts`, `extensionsPanel.ts`, `cmd_ext.rs`)**
- VSIX install / uninstall / upgrade into `~/.ggs/extensions/`; git-graph-rs ships as a built-in (not uninstallable, upgradable by a newer VSIX, downgrades refused).
- A sandboxed iframe extension host (`ext-host.html`) that only supports self-contained bundles whose `require` resolves nothing but `'vscode'`.
- Parses `contributes.commands / keybindings / menus` (`explorer/context`, `editor/context`, `editor/title/context`) with NLS localisation.
- A `vscode` API subset: commands, `window.show*Message`, quickPick / inputBox, configuration, `env.openExternal`, clipboard, the common value types.

### 1.3 Progress log

**2026-09-17, multi-instance round** (the app runs N independent windows):

The single-instance policy of M7 7.7 is reversed at the owner's request: **every launch is its own process and its own window** — `tauri-plugin-single-instance` is removed (no forward, no `studio://open-path`), and `ggs <path>` (or an "Open with GGS" launch) opens in the window it started; `launch_path_of` remains the one launch-argv normalisation. Instances share `~/.ggs`, so its writers became multi-process safe: a crate-root `atomic_write` (process-unique temp sibling + one rename) now backs `settings_write` / `keybindings_write` and `symbols.bin`'s save (the old shared `symbols.bin.new` temp name let two saves interleave), and the Git Graph session log is named per process (`git-graph-studio-session-<pid>.log`) so one instance's export never clobbers another's. A concurrent reader now sees the old or the new whole file, never a torn one.

**2026-09-17, Zed scroll-model round** (580 vitest; plan: `docs/zed-scroll-port-plan.md`):

Zed's scrolling (`crates/editor/src/scroll.rs` and kin) ported to every file-browsing surface, on branch `port/zed-scroll`: `src/scroll/` is the row model — the viewport's top is a row index the model owns, clamped to the document (`one_page` beyond the last line), with the autoscroll strategies (`fit` with a 3-row margin, `center`, `top`, `bottom`); a wheel notch is the system's lines per notch (three on Windows) times the row height, landed at once, Alt ×4, a trackpad's pixels with the gesture's axis lock; a page is the viewport less one anchor row; the scrollbar is drawn (thumb = the viewport's share, 25 px minimum). The Fast Viewer, the hex views, the CAN raw view and the windowed editor place only the visible rows where the model puts them — the spacer, the scaled `VirtualScroll` range past the engines' 33.5M px clamp, the 125 ms wheel glide, `pageScrollTop` and the windowed editor's slide cooldown / unwedge / anchor-capture timers are gone (`ui.ts` −300 lines). The windowed editor projects the model onto CodeMirror's own scroller (`(top − first) × lineHeight`) and reads its caret reveals back; PageDown is Zed's `move_page_down` (caret + `visible − 1`, then `fit`), queued so a burst of presses is a page each. The CodeMirror editor's wheel is the same model (`wheelExtension`). Settings: `mouseWheelScrollSensitivity` now means Zed's `scroll_sensitivity` (default 1), `fastScrollSensitivity` 4, `smoothScrolling` removed (stored values of the old defaults migrate). The CDP probes drag the drawn scrollbar.

**2026-09-16, RustDesk study round (M7 7.1 / 7.7 + indexing performance)** (484 vitest, 193 backend tests, clippy clean):

The RustDesk source (rustdesk/rustdesk@851d2df, a shallow clone studied outside the tree) was mined for its multi-platform and performance practice, and four techniques landed:

- **Single instance with path forwarding (M7 7.7)**: `tauri-plugin-single-instance` — a second launch hands its path to the running window and exits (RustDesk's "forward, don't duplicate"; theirs is D-Bus / `WM_COPYDATA` / a unix socket per OS, ours is the plugin's one cross-platform transport). The argv side is `launch_path_of` in lib.rs — one normalisation function both the launch and the forward use, flags and the `--mcp` / `--measure` folder arguments never reading as paths — with the primary process emitting `studio://open-path` and focusing the window; the webbench opens a folder as a workspace switch, a file as an editor tab. *(Superseded 2026-09-17 by the multi-instance round above: the plugin is gone, every launch is its own process, `launch_path_of` serves the launch itself.)*
- **macOS title bar (M7 7.1)**: `tauri.macos.conf.json` switches the window to the Overlay title-bar style (native traffic lights over our bar — RustDesk reserves 78px and hides its own controls), `hiddenTitle: true`; the frontend gains a `body.mac` class (user-agent sniff at composition) that pads the bar's left side and stands the custom window controls down. Linux and Windows keep the custom-drawn controls.
- **Indexing CPU budget**: the symbol build now runs on a private rayon pool sized by `SymbolIndex::index_threads` — half the cores (minimum two) for background builds on folder open, all of them for an explicit rebuild or a headless `--mcp` start — RustDesk's `codec_thread_num` clamps its video pool to `max/2` for exactly this reason. The build also prints a wall-clock line (`[index] N files, M symbols in T ms (K threads)`), their "log the interesting points" habit.
- **Spin-loop audit**: every `loop` in the backend was checked for a blocking step per RustDesk's just-fixed pulseaudio busy loops (`recv_timeout` in pty.rs and watcher.rs both block; no `try_recv` polling exists) — clean, no change needed.

**2026-09-16, Symbol Database page + MCP server round (M4 extension at the owner's request)** (482 vitest, 193 backend tests, clippy clean):

**The Symbol Database page**: `workbench.showSymbolDatabase` (View menu, `src/symbolDbView.ts`) opens the whole index as one editor tab — a collapsible folder / file / symbol tree with per-symbol reference counts (the occurrence lists surfaced as "n refs"), a name filter that auto-expands the matching branches, jump-to-declaration on click, and a rebuild action. The new `symbol_tree` command serves the per-file outline (kind, line, refs) from the index — with the in-memory rebuild as the no-index fallback. `store.occurrence_counts()` and `SymbolIndex::symbols_with_refs` expose the counts.

**The MCP server (`ggs --mcp <repository>`, `src-tauri/src/mcp.rs`)**: the symbol database served to AI assistants over the Model Context Protocol — newline-delimited JSON-RPC 2.0 on stdio (the transport every MCP client launches servers with; protocol details grounded in the official spec and the JSON-RPC 2.0 error codes: -32700 parse, -32601 method, -32602 params). The `initialize` handshake (protocol echo, `tools` capabilities, serverInfo), `ping`, `tools/list`, `tools/call`; five tools: `symbol_lookup`, `symbol_references` (the shared occurrence-narrowed scan, `scan_references`), `symbol_tree` (path-narrowable, 4000-line budget), `search_symbols`, `index_status`. Tool failures are in-band text, protocol errors are JSON-RPC errors. The reference scan core moved out of `references_for` so the commands and the server share one implementation. Module 16 in AGENTS' map.

**2026-09-16, symbol database + Xcode polish round (M4 storage/queries/UI 🟡, M7 7.2-7.8 🟡)** (478 vitest, 182 backend tests, clippy clean):

**The persistent symbol index (M4)**: `symbols/store.rs` + `cmd_symbols.rs` — the compact binary per root under `~/.ggs/index/<hash>/symbols.bin` (interned names, per-file mtime+size fingerprints, per-name occurrence lists marking which files contain the word, and an explicit "trusted" bit: names first seen by an incremental update fall back to a full reference scan until the next full build). A folder open resumes the saved index and repairs it against the disk in the background; watcher batches update single files (`apply_changes`), and a generation counter cancels like the text search's. Four commands (`symbols_status`, `symbols_rebuild` with a streaming channel, `symbol_lookup`, `symbol_references`); the old `workspace_symbols` / `find_references` serve from the index when it has landed and keep the in-memory path as the fallback. Frontend: Go-to-Definition asks `symbol_lookup` first (one hit jumps, several offer VS Code's definition list), Find References scans the occurrence-narrowed file set, Quick Open grows the `@` (file outline) and `#` (workspace symbols) modes, the status bar follows `studio://symbol-index` ("Indexing symbols n/m", click to rebuild), and Source Insight's **Context Window** is the panel's third tab — the definition of the symbol under the cursor after a 150 ms dwell, pinnable, click-to-open. Still open in M4: the tree-sitter parser layer (the outline scan remains the extractor — §3's pure-Rust rule defers it), `symbol_fuzzy`, the Peek popup (F12 list today), the Search-view grouping of references, the Relation Window, semantic colouring, and the exclusion-rules setting.

**Xcode-level polish (M7)**: the motion tokens (`--motion-fast/normal`, the easings, `prefers-reduced-motion` collapsing every transition) and the density setting (Compact / Comfortable — the row / tab / status / activity / panel-tab heights travel as CSS variables); the theme picker grows **Auto (System)** with a live `prefers-color-scheme` follow; delayed hover tooltips (activity bar, status items), the saved-tab flash, the busy cursor during a rebuild, F6 cycling focus through activity bar → side bar → editor → panel, and the tablists label their selected tab (`aria-selected`). A build-script fix came out of the round: the Windows test exes now carry the Common-Controls v6 side-by-side dependency as an external manifest (the lib test exe died at load with STATUS_ENTRYPOINT_NOT_FOUND without it).

**2026-09-14, full-UI sweep round** (294 vitest):

`tests/uiSweep.test.ts` - the real workbench booted against one rich repository (staged, unstaged, untracked, deleted and conflicted files, a folder tree, an image, a binary, branches, tags, a stash) and every interactive surface driven the way a user drives it, one test per surface: the title bar menus entry by entry (submenus walked), the activity bar, the Explorer (every row, the keyboard, every row's context menu, the background menu), Source Control (title actions, the "..." menu and its submenus, group headers, every row and its inline actions and context menu, the commit box and its dropdown, tree mode), Search (toggles, replace, filters, results, Replace All, an invalid regex), the editor tabs and text context menus, the diff editors, the Markdown / image / hex / history / folder-compare / call-tree / graph tabs, the panel, every status bar item and picker, the settings dialog's every control, the shortcuts editor, Quick Open in each mode, every registered keybinding, the sashes, and the folder lifecycle. A surface fails on anything thrown (synchronously, as a window error, or as an unhandled rejection), on an **error toast**, and on the outcome checks folded in (a staged row opens `(Index)`, an untracked one the file, a conflicted one the conflict toolbar; a checkbox flips its setting and back; a select's every option changes a setting; the arrow keys expand and walk a folder; the second search match lands at its column; ...). The run writes `target/studio/ui-sweep-report.md` (surface, controls driven, failures). Found and fixed: **the Settings search returned nothing while the Extensions category was selected** (an early return skipped the built-in settings; a search now spans every category, as VS Code's does), **the Markdown preview hung forever when the vendor `markdown-it` script never reported** (no onload / onerror - a 10 s grace period now falls back to the source), and the scenario fixtures' root path was `'C:\repo'` (a carriage return, not a backslash).

**2026-09-13, scenario harness round** (241 vitest):

`tests/scenarioFixtures.ts` + `tests/scenarioHarness.test.ts` - ten scripted repository situations (and two non-git folders), each "a git project in a state", answered the way the real backend would answer, with the real workbench booted against each and asserted on what becomes visible; the run writes a markdown report to `target/studio/scenario-report.md` (scenario, situation, PASS/FAIL, observed status bar / SCM groups). The git situations: an empty repository (no commits, no branch), a clean tree, mixed changes (staged + unstaged + untracked + deleted), **a merge stopped on conflicts** (the Merge Changes group, the status-bar conflict count, and the conflict toolbar appearing in the opened file), a detached HEAD (the short hash in the status bar), ahead-and-behind sync counts, branches-and-tags, and a stash. The non-git projects: a plain folder (explorer and file open work, the git views stand down) and an empty folder. The first run caught a real bug: **the status bar always showed the repository items, even for a plain non-git folder** (`applyRoots` hardcoded `setRepo(true)` - now follows the folder's isRepo).

**2026-09-13, single-file mode + large-file latency round** (230 vitest, 100 Rust tests, clippy clean):
**2026-09-13, single-file mode + large-file latency round** (230 vitest, 100 Rust tests, clippy clean):

**Single-file mode**: `git-graph-studio <file>` (and File > Open File...) shows exactly one file, immediately - the side bar and its sash are hidden, the terminal panel is closed, every repository view stands down (no watcher, no graph, no SCM, explorer and search disabled), the window title is the file's name, and the first paint is timed as a `boot_stage` stamp ("single file shown"). Backend: the launch argument recognises a plain file (`initial_file`), and `open_single_file` clears the folder wiring. **The large-file open probe**: `--measure` now writes a synthetic code file (`GGS_PERF_FILE_MB`, default 32, up to 2048) and times the single-file open path's phases - `largeFileRead` (raw read), `largeFileDecode` (encoding decode) and `largeFileViewer` (the viewer document build + first highlighted screen). First numbers at 64 MB: read 116 ms, decode 17 ms, **viewer 1459 ms** - the syntect document build is the bottleneck to attack next (a segmented/lazy build is the plan's M2.6 line).

**2026-09-13, UI metrics round** (228 vitest; verified in a real browser):
**2026-09-13, UI metrics round** (228 vitest; verified in a real browser):

The dev harness gained its second job: **measuring the laid-out workbench** (`uiMetrics.ts`, run from `dev-harness.html?metrics=1` - a clean boot, driven through a file open / find / split, then a pass/fail/skip invariant report rendered on the page and exposed as `window.__uiMetrics` for automation). The invariants: no window-level horizontal overflow; the chrome strips' bounds (title bar 28-40, status bar 18-32 spanning the window bottom, activity bar 44-56, side bar within its limits); one compact tab strip (28-42) with readable tabs (>=60px); split groups >=140px with grabbable sashes; the minimap's fixed 82-90px rail flush right; the find widget within the editor and clear of the minimap; sticky scroll below an open panel; the notification centre bounded and above the status bar; the quick input inside the window; the diff header one row; the graph iframe filling its pane. Page errors and console.error output join the report as failures. The first real-browser run caught a genuine bug: **unbounded editor splits** (a snapshot restore loop grew 13 groups x 220px and pushed the whole layout off-screen) - splits are capped at 8 now, like VS Code. jsdom covers the module's shape (tests/uiMetrics.test.ts). Known gaps, noted honestly: the in-app browser swallows the REAL Ctrl+F as its own find accelerator (synthetic dispatches are what the driver can rely on), so the find widget's browser measurement stays skipped in practice (its behaviour is pinned by the jsdom UI-harness flow), and the notification centre / quick input / diff header surfaces need their opening driven before they can be measured.

**2026-09-13, UI harness round** (227 vitest):
**2026-09-13, UI harness round** (227 vitest):

`tests/uiHarness.test.ts` - the real Workbench booted against a scripted backend and driven through DOM events the way a user drives the app, one flow per interaction surface: the file lifecycle (Explorer click, edit, Ctrl+S save, middle-click close), editor groups (split, tab drag across groups, focus-by-index), the find widget (count, Escape), the settings dialog (search, toggle, the editor follows live, settings.json written), the notification centre (bell count, panel, Clear All), the status bar pickers (the EOL quick pick), the keybindings editor (record F9 for Save, then the new binding saves), and Quick Open (list, choose, the tab opens). The editor chunk is pre-warmed once so a flow's file open is ticks, not transform time. Two fixes came out of it: **a keydown arriving with `document` as its target crashed the workbench's shortcut handler** (no `closest` on Document - now guarded), and the Workbench gained **`dispose()`** so a torn-down instance stops answering keystrokes (the harness builds one per flow).

**2026-09-13, diff UX round (Xcode's version editor)** (219 vitest):
**2026-09-13, diff UX round (Xcode's version editor)** (219 vitest):

The diff editor's toolbar became Xcode's version editor: **change navigation** (prev/next arrows over the changed chunks and a "n / m" counter that follows the cursor - the merge view's chunks directly, the unified view's via `Chunk.build`), **+added / −deleted line statistics** with the change count in the header (identical sides say "No changes"), and a **manual side-by-side / inline switch** - the pane width keeps ruling until the user pins a layout. Ignore-whitespace / ignore-case keep working through the rebuilds (the stats and navigation recompute per render, under the same normalisation). Speed: the **first render waits one frame for the pane to be measurable** - the previous build-blind-then-flip cost two full CodeMirror constructions on narrow panes, and every ignore toggle rebuilds through the same path. The compare tab (commit comparison) already carries per-file additions/deletions from the engine; left as is.

**2026-09-13, keybindings round (M3 3.10 ✅)** (219 vitest, 100 Rust tests, clippy clean):
**2026-09-13, keybindings round (M3 3.10 ✅)** (219 vitest, 100 Rust tests, clippy clean):

`keybindings.ts` - any command can be rebound: `~/.ggs/keybindings.json` (VS Code's shape, `{key, command, when?}` - `when` is stored and shown, not yet evaluated) overrides the registry's defaults everywhere a binding is matched or shown: single keys (`forKeyEvent`), **chords** (`commandForBinding`, the Ctrl+K Ctrl+S path itself), the palette's hint column and the Welcome page. The **Keyboard Shortcuts view is the editor now** (Ctrl+K Ctrl+S): searchable rows of every command with its effective binding and source (user bindings outlined), **key recording** (click the key cell, press the new key, Escape cancels - the pane takes focus so the recorder hears the keystroke), a per-row reset-to-default, and **conflict badges** (`commandsBoundTo` finds every command sharing a chord; unknown commands in the file count too). Backend: `keybindings_read` / `keybindings_write` beside the settings pair.

**2026-09-13, settings registry round (M3 3.9 ✅)** (215 vitest, 100 Rust tests, clippy clean):
**2026-09-13, settings registry round (M3 3.9 ✅)** (215 vitest, 100 Rust tests, clippy clean):

`settings.ts` grew a schema (`SETTING_DEFS`: key, category, kind - boolean / number / enum / theme / locale - with bounds and options), and the Settings dialog is generated from it: one row per setting, the control chosen by the kind, a **search box** spanning every category (and the extension declarations), and a **"modified" marker** (a focus-border stripe) wherever a value differs from its default. **Extensions' `contributes.configuration`** is parsed now (`contributions.ts`) and joins as an Extensions section - booleans toggle, others edit - stored per extension in the existing `extSettings` store the extension API reads. **`~/.ggs/settings.json` is the both-ways file**: the form writes it through on every change (`settings_write`), and a hand edit of it wins over the stored settings on the next launch (`settings_read`, applied before the theme boots - VS Code's reload semantics).

**2026-09-13, status bar + notifications round (M3 3.11 ✅, 3.12 ✅)** (208 vitest):
**2026-09-13, status bar + notifications round (M3 3.11 ✅, 3.12 ✅)** (208 vitest):

The status bar is VS Code's layout now: left four separate buttons - the repository's name (click to open Source Control), the branch (click to switch), the **Synchronize Changes** item (sync icon with the ahead/behind counts, click to pull then push; shown only while the branch tracks an upstream), Git Graph - then the conflict count; right the cursor position, a new clickable **indent item** ("Spaces: N", a picker over the tab-size setting - the open editors reconfigure in place), the encoding, the EOL, the language, and the **notification bell** (M3 3.12): every toast ever posted joins a bounded (100) notification centre - auto-dismissed info toasts live on in it, as in VS Code - the bell counts it, and its panel (newest first, relative times, per-row clear and Clear All, closes on outside click) drops from the bell. Remaining 3.11 gaps, noted: no problem count (no Problems panel exists yet - it is M4 work) and the language item is still static (no per-file language override machinery).

**2026-09-13, UI sweep round** (206 vitest):
**2026-09-13, UI sweep round** (206 vitest):

Six interface bugs found by walking the recent features' interactions, all fixed: **the recents (menu and Welcome page) opened a `.ggs-workspace` entry as a folder** and failed - `openRecent` dispatches by extension now, and **boot prefers the remembered workspace file** over the backend's launch folder (its first root), so a relaunch keeps every root; **the find widget sat on top of the minimap** (it now clears it: `right: 98px` under `.has-minimap`); **sticky scroll hid under the find widget** (its stack starts below the open panel, tracked with a ResizeObserver on `.cm-panels-top`); **every empty split showed a full copy of the welcome page** (the welcome belongs to the first group; splits stay blank - and when groups collapse back to one, the survivor takes the welcome back); **splitting the welcome screen collapsed the welcome group away** (the welcome group is exempt from empty-collapse, so the split actually splits); and **the welcome page could sit blank on a freshly-built shell** - `renderWelcome` is assigned after the area's constructor already rendered, so both the area and the group re-render on assignment now.

**2026-09-13, multi-root workspaces round (M3 3.8 ✅)** (205 vitest, 100 Rust unit tests, clippy clean):
**2026-09-13, multi-root workspaces round (M3 3.8 ✅)** (205 vitest, 100 Rust unit tests, clippy clean):

`.ggs-workspace` files (VS Code's `.code-workspace` shape - `{"folders":[{"path":"./rel"}]}`, JSONC comments allowed, missing folders skipped, a root is NOT collapsed to its repository root) open through the new `open_workspace` backend command: every folder becomes an open root (`AppState.repos` was a list all along), each with its own watcher thread, its own file-list and symbol-cache slot (both caches went from single-slot to per-root maps), and its own Quick Open prefetch. In the shell: File > Open Workspace...; the Explorer renders a virtual top level (one expandable folder row per root, reconciled like any level); the Search view runs its query root by root - the backend's generation counter forbids concurrent searches, so the roots chain, each starting when the previous one's `done` arrives - with results tagged by root (the same relative path in two roots stays two results opening in their own root) and Replace All looping the roots; Quick Open and Go to Symbol in Workspace concatenate the roots' lists as absolute paths; the session snapshot is keyed by the workspace file (a workspace keeps its own tabs). The first root stays the active repository seam (SCM view, graph, status bar) - the graph's own repository dropdown switches between roots; the SCM-side repository picker is the remaining gap, noted below.

**2026-09-13, find widget round (M3 3.4 ✅)** (202 vitest):
**2026-09-13, find widget round (M3 3.4 ✅)** (202 vitest):

`findWidget.ts` + `findOptions.ts` - the editor's find/replace is VS Code's find bar now, mounted through `search({ createPanel })` so the search keymap (Ctrl+F, Enter / Shift+Enter / F3) and the match highlighting keep working: the compact bar over the code with the search field and the "n of m" match count (capped at 10,000, "No results", an invalid-regex marker), previous / next, the four toggles - match case, whole word, regular expression, find in selection (multi-cursor selections filter the matches) - an expandable replace row with replace-next / replace-all, and a single-line selection seeding the field. The three option toggles read and write the same persisted `searchOptions` object the Search view uses, so the two surfaces share their state. (Sticky note: the panel is created inside a view update - no dispatching there, the count computes against the opener's seeded query.)

**2026-09-13, bugfix round** (195 vitest, 98 Rust unit tests):
**2026-09-13, bugfix round** (195 vitest, 98 Rust unit tests):

A sweep of the recent rounds found and fixed four bugs: **a group split after the workbench wired the graph host could never open the Git Graph tab** (the iframe was handed only to the groups that existed when the setter ran; the area now remembers it and every new group receives it - regression-tested); **brackets inside strings and comments still shifted the bracket-colouring depth** (they are skipped for colouring, and now for counting too); **the snapshot stored groups without file tabs**, so a relaunch conjured empty splits; and **Rust's Quick Open prefix tier compared an original-case label against the lowercased query**, so a capitalised file never reached the prefix tier (case-insensitive now, unit-tested).

**2026-09-13, Rust-side completion round** (193 vitest, 97 Rust unit tests, clippy clean):
**2026-09-13, Rust-side completion round** (193 vitest, 97 Rust unit tests, clippy clean):

`cmd_fuzzy.rs` - the two hot per-keystroke scans left in TypeScript moved into the backend, scoring the file list the backend already caches (so a keystroke ships ~60 rows over IPC instead of the walked tree, and runs at Rust speed instead of the webview's event loop): **`fuzzy_files(query, limit)`** is Quick Open's matcher - the VS Code fuzzyScorer tiers (label prefix > label > path) on a case-insensitive subsequence with consecutive-run, word-start and separator bonuses, returning the top rows with their bold ranges - and **`path_completions(prefix)`** is the editor's path source, listing a fragment's folder entries with directories folded into trailing-slash names. The TS implementations (`fuzzy.ts` scoring in `filePicker.ts`, `pathOptions` in `autocomplete.ts`) stay as the fallback when the backend does not answer (no folder open, a stubbed backend in tests); 6 Rust unit tests pin the tier ordering, run bonuses, range merging and the path entries, 4 vitest cases pin the wiring and both fallbacks.

**2026-09-13, settings round** (189 vitest):
**2026-09-13, settings round** (189 vitest):

Seven settings joined the dialog, wired to the features the recent rounds added: **Editor Font Size** (12-24 px, live via a `--editor-font-size` CSS variable), **Tab Size** (2/4/8) and **Word Wrap** - both applied to *open* editors in place through new `indentSlot` / `wrapSlot` compartments (merge views reconfigure both sides), **Auto Save Delay** (a number control, the setting existed but had no UI), and the completion toggles **Snippet Suggestions** / **Path Suggestions** (each gates its completion source live). Also fixed a latent bug the new listener exposed: the settings event's `detail` *is* the changed key, not `{key}` - the workbench's locale reload of the Git Graph view had been comparing against `detail.key` and never fired.

**2026-09-13, performance round** (185 vitest; startup, idle, resize):
**2026-09-13, performance round** (185 vitest; startup, idle, resize):

A full audit (no `setInterval` or polling loop exists anywhere; the watcher idles blocked on `recv`, and no Rust window-event handler runs on drag) left four real findings, all fixed: **session restore opens a group's files in parallel** as inactive tabs (`openFile(path, { inactive: true })`, `EditorGroup.activateLast()`), then activates the remembered one - the restore was the boot path's only serial file-read chain; **the definition-search cache is capped** at 64 files (whole file strings were retained for the session, unbounded); **the minimap's scroll path repaints nothing** - scrolling only repositions the slider (a style write), a full canvas repaint happens on content/layout changes only (and the constructor now re-schedules one draw, because CodeMirror's theme init rewrites `dom.className` and wiped the `has-minimap` class); **the editor split sash coalesces to one apply per animation frame** (like the workbench sashes), sets the same `body.resizing` marker that defers git refreshes during a drag, and the terminal `fit()` and the hex view's `relayout()` are rAF-coalesced too.

**2026-09-13, completion round (M3 3.3 ✅)** (184 vitest):

`snippetRegistry.ts` + the rebuilt `autocomplete.ts` — completion now has three sources: VS Code snippets (the built-in base set covers 21 languages, two to four high-traffic snippets each; the workspace's `.vscode/*.code-snippets` are parsed — JSONC, scope-checked — and loaded on every folder open), word completion of the open document, and workspace path completion (a fragment containing a slash lists the entries of its folder, directories with a trailing slash, the file list cached 5 s against typing). Snippets expand through CodeMirror's snippet engine, so VS Code's tabstops (`$1`, `${2:default}`, `$0`) and Tab / Shift-Tab field navigation work, and `$TM_*` / `$CURRENT_*` variables resolve (filename, date). Ctrl+Space triggers (the completion keymap was already wired).

**2026-09-13, editor decorations round (M3 3.2 ✅)** (176 vitest):

`editorExtras.ts` — three CodeMirror extensions in the text editor's async chunk, each reading its setting live (Settings → Editor: Minimap, Sticky Scroll, Bracket Pair Colorization, all default on): brackets coloured gold/purple/blue by nesting depth (visible lines only; a lazily-filled per-line depth index survives edits, and loaded syntax trees keep brackets inside strings/comments uncoloured); sticky scroll pins the enclosing indented blocks over the code (indentation-based, so it works for every language, lines clickable, capped at a quarter of the editor height); the minimap is a canvas beside the scroller — one 2 px row per sampled line, the stride capping the draw at the editor height however long the file, monochrome word bars (comments dimmed), and a viewport slider that scrolls on click and drag. Diff and revision panes stay lean (editable editors only).

**2026-09-13, editor groups round (M3 3.1 ✅)** (172 vitest):

`editorArea.ts` — the workbench's editor part is now any number of `EditorGroup`s: a stack of rows (flex sizes, drag sashes between neighbours), `Ctrl+\` splits the focused group right, `Ctrl+K Ctrl+\` starts a row beneath it, `Ctrl+1/2/3` focus a group, tabs drag between groups (the dragged editor's view and pane move untouched), and an empty group collapses once another has the focus. The area is the workbench's facade: everything about "the" editor answers from the focused group; saving, closing, path renames and dirty state span groups; back/forward falls back to a group that still has history. The graph tab stays one shared iframe wherever it is open. The per-group file tabs persist in the workspace snapshot (`groups`) and a relaunch restores them as a row of splits. View menu: **Editor Layout** submenu.

**2026-09-12** — the Search view, Folder Compare and the conflict toolbar were wired in (activity bar icon, `Ctrl+Shift+F`, `File > Compare Two Folders…`, `EditorInput` kinds); bookmarks (`bookmarks.ts`), the call tree (`callTree.ts`), Quick Open fuzzy scoring (`fuzzy.ts`, `filePicker.ts`), word completion (`autocomplete.ts`), Go to Symbol in File / Workspace and Find References landed with tests. That closed M0.1, M0.3, most of M0.4, M2.5, M3.3 (words only), M3.6, M4.5 (word-match version), M4.6 (basic).

**2026-09-13** — this round (all with tests: 131 vitest, 80 cargo tests in the app, +2 engine tests; `cargo clippy -D warnings` clean in both crates):

| Task | What landed |
|---|---|
| M0.2 streaming search | `search_workspace` pushes `SearchEvent::Batch` / `Done` over a `tauri::ipc::Channel`, 256 files per batch, path-ordered, on a blocking thread; a generation counter (`SearchState`) cancels the previous search on every new one and on `search_cancel`; the view fills batch by batch ("Searching… N results so far"), drops late batches of superseded searches |
| M0.4 conflicts | The engine's `ScmChange` gained `conflicted` (gix index conflict stages); the SCM view lists unmerged paths under **Merge Changes** (`!` decoration, click opens the file in the conflict toolbar, "Stage Changes (Mark Resolved)"); the status bar shows a warning-coloured **N conflicts** item that opens Source Control; the Explorer colours conflicted files |
| M0.6 measurement | `git-graph-studio --measure <folder>` (headless: resolve root → walk → scm status → graph first page → symbol index → search `TODO`, JSON); `scripts/measure.mjs` collects exe / installer / dist / first-paint chunk / bundled VSIX sizes (+ the probes with `--repo`) into `target/studio/metrics.json`, `--gate` fails on the section-4 budgets |
| M1.1 slim VSIX | `scripts/slim-vsix.mjs` repacks the bundled VSIX without `out/`, `native/`, `*.map`, `.theme-audit/`, build scripts: **16.2 MB → 0.33 MB** |
| M1.2 / 1.5 | `[profile.release]` (`opt-level = "z"`, fat LTO, 1 codegen unit, `panic = "abort"`, stripped) in `app/src-tauri/Cargo.toml`; NSIS `lzma` compression |
| M2.3 uncapped walk | `walk_files` is the `ignore` crate's parallel walker: `.gitignore` / `.ignore` aware (also outside a repository), dotfolders kept, the VCS / `node_modules` / `target` list pruned, **no 20,000 cap** |
| M2.4 file watcher | `watcher.rs` (`notify`, recursive, 100 ms debounce, ≤ 200 paths per batch, `.git/` folded into a `gitChanged` flag, `node_modules` / `target` churn dropped); `open_folder` starts it, the batch invalidates the file-list and symbol caches and reaches the webview as `studio://fs-changed`; the workbench reloads clean tabs of the changed files and refreshes SCM / graph / status bar / Explorer |
| Library interface | `native/core/src/api.rs`: `Engine` — one type in one file (open, graph, info, refs, stashes, commit, commit_files, diff, file at `hash` / `:index` / working tree, file_diff, status, config, authors, stats); `git_graph_core::Engine` re-exported; covered by `native/core/tests/api.rs` |

**2026-09-13, third round** (147 vitest, 86 cargo tests + 3 integration tests):

| Task | What landed |
|---|---|
| Functional sweep | `tests/commands.test.ts`: every registered command (80+) executed against a defaulting mock backend with a repository and a text editor open - must settle or park on a dismissable overlay without throwing; every menu entry must name a registered command; keybindings unique |
| M2.8 performance gate | `src-tauri/tests/perf.rs`: a synthetic git repository (5,000 files by default, 20,000 in CI, `GGS_PERF_FILES=100000` for the plan's line) timed through walk / search / symbol index and, via the backend process, repo root / SCM status / graph first page; content phases gated as multiples of a raw parallel read of the tree (Windows: ~47 µs/file is the filesystem + antivirus floor; the search runs at 1.5× it, the index at 1.1×). `tests/perf.test.ts` adds a 50,000-row search view (a plain DOM tree, ~21 s in jsdom / a few hundred ms in a browser) and a 5,000-change SCM view (620 ms - not virtualised yet) |
| M2.2 session snapshot | Per-folder: file tabs in order, the active tab, the Explorer's expanded folders - saved on change and on close, restored on reopen (still open: scroll positions, the cached tree skeleton painted before validation) |
| M2.9 auto-save + hot exit | `autoSave` off / afterDelay / onFocusChange in Settings; every edit backed up to `~/.ggs/backups/` 500 ms later (atomic), dropped on save / discard; backups of a killed session recovered into dirty editors on boot |

Release numbers on 20,000 files (Windows, NVMe): walk 30 ms, raw read 938 ms, search 1.44 s, symbol index 1.06 s, SCM status 117 ms, graph first page 103 ms (through the pipe), backend spawn + hello 99 ms.

**2026-09-13, second round** (138 vitest, 84 cargo tests in the app + 2 integration tests, clippy clean for both feature sets):

| Task | What landed |
|---|---|
| M1.6 frontend splitting | The text editor widget is `textEditor.ts`, loaded on the first file / diff open (`lazy.ts`); xterm and `@codemirror/merge` are async chunks too; Vite emits `dist/first-paint.json` (the static closure of the boot entry + workbench) and `measure.mjs` gates it: **902 KB → 200 KB** first paint (workbench 173 KB + Tauri API 16 KB + boot 9 KB); `tests/lazy.test.ts` guards the module graph |
| **git-graph-rs as a `.ggx` plugin** (§8.2) — *monorepo only; not carried into this repository, see the status note in §8.2* | `app/src-tauri` is a library + two binaries: the app (`desktop` feature) and **`git-graph-backend`** (no Tauri: the engine seam + git runner behind `ggx-rpc/1`, `src/bin/git-graph-backend.rs`, 3.9 MB release). `plugin_host.rs` spawns the installed package's binary, pairs answers by id, streams its `log` events and stderr into the panel's Git channel, restarts it after a crash, and `graph_request` forwards to it (falling back in-process when it is unhealthy). `cmd_ext` installs `.ggx` next to VSIX (same upgrade rules, platform binary resolved, `format` / `backend` on `ExtInfo`); `install_bundled` prefers the `.ggx`. `scripts/build-ggx.mjs` packs `web/` + `backend/<platform>/` + manifests (2.2 MB, replaces the slim VSIX); `prepare.mjs` bundles it (`--with-backend` on release builds). `graphHost.ts` loads the view page, `config.js` and `compare.js` **from the installed package** (same-origin `srcdoc` + blob URLs, `/gitgraph/` as the fallback). The Extensions page shows the format and the backend's pid / protocol / last error with a Restart button. Tests: `backend_rpc.rs` (protocol), `tests/backend_rpc.rs` (the real process: reads, a write with its log event, a 6-way burst, stop / restart), `cmd_ext::ggx_tests`, `graphAssets.test.ts`, `extensions.test.ts` |

### 1.4 The headline gaps (after 2026-09-13)

- No sticky-scroll tree usage yet, no snippets / path completion, no Problems panel, no file history / blame (editor groups M3 3.1 ✅, minimap / sticky scroll / bracket colours M3 3.2 ✅).
- The symbol index is regex-based and in memory only (`SymbolCache`, 30 s TTL, invalidated by the watcher); no persistent index, no real parser (M4).
- Three-way merge, comparison options (ignore whitespace, …), image / hex compare UI are missing (M5).
- The extension host has no webview panels / tree views / `workspace.fs` / language providers, no marketplace, no auto-update (M6); the no-Node plugin package of §8.1 is designed, not built.
- The measured sizes after M1.1 / M1.2 are in the section-4 table's "measured" column once CI publishes `metrics.json`; the remaining diet items (M1.3 dependency trimming, M1.4 gix features, M1.6 frontend chunking) are open.
- macOS / Linux are only compiled in CI; no window / menu / keybinding adaptation has been done (`decorations: false` means no traffic lights on macOS).

---

## 2. Gap analysis against each benchmark

### 2.1 VS Code (feature completeness)

| Capability | Today | Gap | Milestone |
|---|---|---|---|
| Editor groups (split left/right, up/down, drag tabs) | Split right / down, drag, Ctrl+1/2/3, persisted (M3 3.1 ✅) | Drag-arranged tree layout, more than 3 focus keys | M3 |
| Minimap, sticky scroll, indent guides, bracket pair colouring | Yes / yes / yes / yes (M3 3.2 ✅) | Sticky scroll from the lezer tree (today: indentation heuristic) | M3 |
| Completion (words / snippets / paths), signature help | Words, snippets (VS Code format), paths (M3 3.3 ✅) | Signature help | M3 |
| Find / replace in file | Yes (CM panel) | Restyle to VS Code's find widget | M3 |
| Find / replace in files (Ctrl+Shift+F / H) | Backend done, frontend unwired | Wire in + streaming results | M0 |
| Problems / diagnostics | None | Fed by language providers (extensions) | M6 |
| Outline / breadcrumb symbols / Go to Symbol in File & Workspace | Outline exists; `Ctrl+Shift+O`, `Ctrl+T` missing | `@` and `#` modes in Quick Open | M4 |
| File history / Timeline / line blame | None | All (the engine can already fetch files and diffs per commit) | M3 |
| Multi-root workspaces / workspace files | Single folder (`AppState.repos` is already a list) | `.ggs-workspace` file, multi-root tree | M3 |
| File watching, auto-save, hot exit (recover unsaved buffers) | No / no / no | notify watcher, autoSave, `~/.ggs/backups` | M2 |
| Settings: JSON editing, categorised search, keybinding editor | A form with 3 settings | Settings registry + `settings.json` + Keyboard Shortcuts editor | M3 |
| Status bar: line/col / indent / encoding / EOL / language / branch sync | Line/col, language, branch | Clickable indent, encoding, EOL | M3 |
| Encodings (GBK / UTF-16), EOL conversion, BOM | UTF-8 only | `encoding_rs` detection + conversion | M3 |
| Drag-drop into the window, "Open with GGS", `ggs <path>` CLI, multi-instance launches | CLI exists | Drag-drop, file association, one window per launch (shared `~/.ggs` written atomically) | M7 |
| Image / Markdown preview / hex viewer | None | Image and Markdown preview (reuse the vendored markdown-it), hex viewer | M3 |
| Git: submodules, worktrees, cherry-pick / revert (palette), hunk staging, interactive rebase | Cherry-pick / revert inside the graph view; nothing else | Hunk-level stage, worktree / submodule trees, rebase editor | M3 |
| Notification centre, progress | `notify()` toasts | Notification centre, cancellable progress for long tasks (clone / fetch / indexing) | M7 |
| Zen mode / full screen / layout presets | None | All | M7 |
| Debugger / tasks / remote / notebooks | None | **Explicitly out of scope** (tasks are replaced by "run in terminal") | — |

### 2.2 Source Insight (large projects, speed, symbols)

| Capability | Today | Gap | Milestone |
|---|---|---|---|
| Project symbol database (persistent, incremental) | In-memory `SymbolCache`, regex extraction | tree-sitter parsing + on-disk index + incremental updates | M4 |
| Find References (Shift+F12), Peek | Backend `find_references` (word match), no UI | References panel, Peek popup, scope-weighted ranking | M4 |
| Call tree / caller tree | None | Call / caller tree view on top of the reference index | M4 |
| Relation / Context window | None | Definition of the symbol under the cursor shown in a lower pane (reuses the fast viewer) | M4 |
| Symbol-aware colouring (functions / variables / types differ) | Lexical only (syntect / lezer) | Index-driven semantic token overlay | M4 |
| Huge files (>100 MB, >1M lines) | Fast viewer opens instantly (whole file read into a rope) | mmap + lazy line index, no full read | M2 |
| Large-project file enumeration | 20,000 cap, BFS | Uncapped streaming index, `.gitignore`-aware (`ignore` crate), persisted file list | M2 |
| Startup to interactive | Splash exists, never measured | Instrument it and get under 300 ms | M2 |
| Bookmarks, snippets | None | Persistent bookmarks, snippets | M3 |

### 2.3 Beyond Compare (compare and merge)

| Capability | Today | Gap | Milestone |
|---|---|---|---|
| Folder compare + sync | Frontend written but unwired, backend done | Wire in + status filters + batch sync + saved sessions | M0 / M5 |
| Compare any two files (Explorer "Select for Compare / Compare with Selected") | Revision diffs only | Entry points + clipboard compare + unsaved-buffer compare | M5 |
| Three-way merge (Base / Ours / Theirs + Result, four panes) | Two-way marker walker (unwired) | A real three-way view, per-block accept, conflict count, `git add` on completion | M5 |
| Rules: ignore whitespace / case / line endings, regex-unimportant lines, syntax-block alignment | None | Options toolbar + backend normalised diff | M5 |
| Editable diff (edit either side and save) | Read-only | CM MergeView with both sides editable + save | M5 |
| Hex compare / image compare (side-by-side / overlay / highlighted) / table (CSV) compare | Backend `hex_diff` | Three views | M5 |
| Moved-block detection, block / word-level highlighting | CM gives line / character level | Moved-block detection (backend hash-pairing of hunks) | M5 |
| Report export (HTML / patch) | None | Unified patch / HTML report export | M5 |

### 2.4 Xcode (polish)

| Aspect | Today | Target | Milestone |
|---|---|---|---|
| Window feel | Custom title bar, fine on Windows; macOS has no traffic lights, no vibrancy | Native title bar + overlay on macOS, CSD on Linux | M7 |
| Motion and feedback | No transitions; toast notifications | ≤ 150 ms side bar / panel transitions, tab-drag animation, progress bars, skeletons; honour `prefers-reduced-motion` | M7 |
| Typography and density | VS Code defaults | A 4 px grid, type / line-height scale, density setting (compact / comfortable) | M7 |
| Empty states and first run | Welcome page | No folder: recent projects + Clone + Open; no repository: init guidance; indexing: progress | M7 |
| Keyboard first | 46 keys | Every command reachable, visible focus rings, tab order, Esc hierarchy | M7 |
| Follow system light / dark | Manual | `auto` theme + system accent colour | M7 |
| Accessibility | None | ARIA roles, high-contrast validation, screen-reader-readable trees / lists | M7 |

### 2.5 Extensions (git-graph-rs and other VSIX)

| Capability | Today | Gap | Milestone |
|---|---|---|---|
| Install / upgrade / uninstall VSIX | Yes | Browse and one-click install from Open VSX, filter by engine version | M6 |
| Running git-graph-rs | Hosted natively (bypasses the extension host) | Built-in version auto-follows GitHub Releases; **ship a slim VSIX without native addons** | M1 / M6 |
| `vscode` API | Commands / messages / configuration / clipboard | Webview panels, tree views, status bar items, `workspace.fs`, file-system events, `languages.register*Provider` (hover / definition / completion / diagnostics), `window.createTerminal`, decorations, `workspace.applyEdit` | M6 |
| Extensions that `require` relative files | Unsupported | Virtual file system + CJS loader | M6 |
| Activation events / `when` clauses | `when` only understands `"false"` | Full `when` expression evaluator, `activationEvents` | M6 |
| Theme / icon theme / TextMate grammar extensions | 7 built-in themes | Parse `contributes.themes / grammars / iconThemes` | M6 |

### 2.6 Size

| Item | Now | Cause | Target |
|---|---|---|---|
| Bundled VSIX | 21.5 MB | 6 platforms of `.node` + source maps + `.theme-audit` | **≤ 0.6 MB** (keep only `media/`, `package.json`, nls, LICENSE) |
| exe | 23.2 MB | No size profile; full-featured gix; full syntect syntax pack; ureq + rustls; regex with all unicode features | **≤ 10 MB** (aim for 8 MB) |
| Installer | 28.1 MB | The two above + zlib | **≤ 8 MB** (NSIS lzma) |
| Frontend | 3.3 MB | No chunk splitting, whole codicon font, graph dependencies bundled twice | ≤ 2 MB; first-paint JS ≤ 300 KB |

---

## 3. Architecture principles (apply to every milestone)

1. **Pure-Rust backend, no C bindings**: keep the syntect `default-fancy` and gix choices; tree-sitter grammars compiled with `cc` are the single exception, gated per language behind Cargo features.
2. **The read path never spawns a process**; the write path uses the git CLI (consistent with the extension; gix has no push). Writes the engine can do sink into `git-graph-core` over time, but **never block this plan**.
3. **No frontend framework**: keep hand-written DOM + `el()`; every new view uses the `ui.ts` quickInput / contextMenu / notify building blocks.
4. **Heavy work in the backend, streamed**: search, indexing, folder compare and hex diff push batches through `tauri::ipc::Channel`; the UI must show a first batch within 200 ms; every long task is cancellable.
5. **Three artefacts per feature**: a backend `#[tauri::command]` + Rust unit test (temporary-repository pattern), a frontend vitest (`tauriMock` recording), a scripted `dev-harness.html` scenario.
6. **Sizes are measured, not gated** (changed 2026-09-15): exe / installer / dist / first-paint sizes are recorded to `metrics.json` (`scripts/measure.mjs`); the size budgets and their CI gate were removed at the owner's request ("不要限制大小了"). Performance budgets remain CI gates through `src-tauri/tests/perf.rs`.
7. **The engine is a library with one interface file**: `native/core/src/api.rs` (`git_graph_core::Engine`) is the contract for every host — the extension's Node addon, GGS, a CLI, third-party programs. It is read-only, plain-data in / plain-data out (every result `Serialize`s), warm through `RepoManager`, and thread-safe. The per-topic modules stay public for finer-grained access, but a new integration should need nothing beyond `api.rs`, and changes to it are reviewed as API changes.
8. **The extension is consumed through exactly two seams** (decided 2026-09-12, after the alternative was tried and rolled back):
   - **Rust → the extension's Rust**: `src-tauri/src/cmd_graph.rs` is the only module that names `git-graph-core`. Every other backend module (`cmd_fs`, `cmd_scm`, `main`, …) goes through its small wrappers (`resolve_repo_root`, `close_engine_repos`, `scm_changes`, `revision_file`).
   - **TS → the extension's TS artifacts**: `src/graphHost.ts` is the only module that consumes the extension's artifacts at runtime — the webview bundle (`gitgraph/out.min.js`, i.e. the compiled `web/` sources), the config bundle (`gitgraph/config.js`, the extension's compiled `src/config.ts`) and the comparison page generator (`gitgraph/compare.js`, built by `scripts/prepare.mjs` from the extension's compiled `src/comparisonView.ts`; `CompareHost` runs the extension's own `getHtml` template and drives the generated page over `graph_request`, so the Commit Comparison tab is the extension's real UI, not a copy — the hand-written `compareView.ts`/`hexView.ts` are deleted).
   - **The extension's UI is never re-implemented or re-styled by hand**: the graph view loads `out.min.css` (compiled from `web/styles/`); the comparison page brings its own inline CSS because the extension generates complete pages. Still open: the binary/hex comparison page (`binaryCompareView` + the `HexDiffSession` machinery, which reads blobs through Node streams) — until it is hosted, binary files in the comparison tab show a notice instead of the hex view.
   - **Rejected**: activating the bundled git-graph-rs VSIX in the frame extension host (emulating `vscode`, Node builtins and the NAPI addon ABI) so its `out/extension.js` runs unmodified. It was landed on a branch and rolled back the same day: first-launch activation races the VSIX extraction, activation is one-shot, and the emulation is a large, permanently growing surface. The frame host stays for self-contained third-party VSIX only.

---

## 4. Hard targets (acceptance lines for 1.0)

| Metric | How measured | Target |
|---|---|---|
| exe size (Win x64) | CI `stat` | ≤ 10 MB (stretch 8 MB) |
| Installer size | CI | ≤ 8 MB |
| Cold start to first frame | `main()` entry to `boot-splash` removal, written to `session_log_file` | ≤ 150 ms |
| Cold start to interactive (menus clickable, Ctrl+P usable) | Same | ≤ 300 ms (Windows 11, NVMe, WebView2 warm) |
| Open a 100,000-file repository (e.g. the linux tree) | Explorer root expanded / graph first page / Quick Open ready | ≤ 100 ms / ≤ 150 ms / ≤ 1.5 s (in background) |
| Open a 1 GB text file | First screen visible | ≤ 300 ms, memory delta ≤ 50 MB |
| Regex search across 100k files | First batch / complete | ≤ 200 ms / ≤ 3 s |
| Cold symbol index (100k files, 2M lines) | Background completion | ≤ 60 s; incremental single file ≤ 20 ms |
| Go to Definition / Find References | Response | ≤ 30 ms / ≤ 200 ms |
| Folder compare (2 × 50,000 files) | First batch / complete | ≤ 300 ms / ≤ 5 s |
| Three-way merge on a 5 MB file | Interactive | ≤ 500 ms |
| Memory (empty repository, idle) | Task manager | ≤ 120 MB (WebView2 processes included) |
| Test coverage | vitest + cargo test | Statements ≥ 80%; critical paths (git writes, indexing, merge) ≥ 90% |

**Measured 2026-09-13 (third round, engine only in the backend)**: exe **7.43 MB** (was 9.83), NSIS installer **5.76 MB** (was 7.77), package 2.2 MB; the app binary no longer links `git-graph-core` — `--measure` and every git view go through the backend process (graph first page 36 ms through the pipe). Verified live: a stale same-version install was replaced by the rebuilt bundle (fingerprint), the backend spawned beside the app and exited with it.

**Measured 2026-09-13 (second round, release build)**: exe **9.83 MB**, NSIS installer **7.77 MB** (the 2.2 MB `.ggx` with the 3.9 MB backend process replaced the 0.33 MB slim VSIX: +3 MB, still under the 8 MB line — the engine is now linked twice, once in the app for the in-process fallback and once in the backend; dropping the in-process path or reusing the app binary as the backend would give ~3 MB back), first-paint JS **204 KB** (was 902 KB; CodeMirror 404 KB, xterm 292 KB and the merge views are async chunks now), graph first page 31 ms in-process. Verified live: the release app installs the bundled `.ggx` on first launch, `git-graph-backend.exe` runs beside it (14–19 MB), and exits by itself when the app is killed.

**Measured 2026-09-13** (Windows 11 x64, `scripts/measure.mjs --repo ..` on this repository, 331 files): exe **9.74 MB** (was 22.6), NSIS installer **4.74 MB** (was 22.5), bundled VSIX **0.33 MB** (was 16.2), frontend dist 3.38 MB / first-paint chunk 902 KB (unchanged, M1.6); backend probes: resolve root 78 ms (first engine open), walk 12 ms, scm status 21 ms, graph first page 58 ms, symbol index 24 ms, search `TODO` 13 ms. The 100k-file numbers are still to be measured against a synthetic repository (M2.8).

---

## 5. Milestones and task breakdown

Effort is estimated for one full-time developer.

### M0 — Close out and measurement baseline (1 week)

Goal: ship what is already written, and build the measurement tools every later milestone depends on.

| # | Task | Touches | Acceptance |
|---|---|---|---|
| 0.1 ✅ | Wire in the Search view: activity bar icon, `Ctrl+Shift+F / H`, add `search` to `ViewId`, result click navigates to line/column, confirm before replace | `workbench.ts`, `searchView.ts` | First batch ≤ 1 s on a 100k-file repository; editors hot-reload after replace |
| 0.2 ✅ | Make search streaming: `search_workspace` pushes over a `Channel` every 256 files, UI renders incrementally; generation-counter cancellation | `cmd_search.rs`, `searchView.ts` | Typing cancels the previous search |
| 0.3 ✅ | Wire in Folder Compare: `File > Compare Folders...`, add `folderCompare` to `EditorInput` (Explorer "Select for Compare" → M5.2) | `editor.ts`, `folderCompare.ts` | Open / filter / sync all work |
| 0.4 ✅ | Wire in the Merge Editor: a conflicts group in SCM (`ScmChange.conflicted` from the engine), click opens it, status bar shows "N conflicts" | `scm.ts`, `mergeEditor.ts`, `status.rs` | A merge with conflicts can be completed inside GGS |
| 0.5 ✅ | Tests for the three: vitest (`searchView.test.ts`, `mergeEditor.test.ts`, `scm.test.ts`) and Rust unit tests (`cmd_search` streaming / cap / replace / compare_dirs / hex_diff) | `app/tests`, `cmd_search.rs` | Coverage ≥ 80% (`folderCompare.test.ts` still to write) |
| 0.6 ✅ | Baseline: `scripts/measure.mjs` collects exe / installer / dist / VSIX sizes into `metrics.json`; `--measure <folder>` runs the backend probes headless (`measure.rs`); `--gate` enforces the budgets | `scripts/`, `main.rs`, `measure.rs` | CI publishes `metrics.json` (workflow step still to add) |
| 0.7 ✅ | `docs/feature-roadmap.md` was deleted; this document is the only plan | docs | — |

### M1 — Size diet (1 week)

Goal: exe 23 MB → ≤ 10 MB, installer 28 MB → ≤ 8 MB, no feature loss.

| # | Task | Expected gain | Acceptance |
|---|---|---|---|
| 1.1 ✅ | `scripts/slim-vsix.mjs` (called by `prepare.mjs`) repacks the VSIX: drops `out/**`, `native/**`, `*.map`, `.theme-audit/`, `node_modules/`, build scripts; keeps the envelope, `media/`, `resources/`, `package.json`, `package.nls*.json`, README, licences (`main` was already optional in `cmd_ext.rs`) | −16 MB | **0.33 MB** (was 16.2 MB); Extensions panel unchanged |
| 1.2 ✅ | `[profile.release]` in `app/src-tauri/Cargo.toml`: `opt-level = "z"`, `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = true`, `debug = false` | −35–45% exe | Perf baseline regresses by no more than 10% (re-measure with `--measure`) |
| 1.3 | Dependency trimming via `cargo bloat --release --crates`: drop `ureq + rustls` (the Gerrit hook download moves to a frontend `fetch` followed by `write_file`); disable unneeded `regex` unicode features; `zip` with `deflate` only; `syntect` with a custom syntax pack (`dump-create` once, ~60 common languages, `syntaxes.packdump`); `serde_json` without `preserve_order` | −3–5 MB | Top 10 crates in `cargo bloat` contain nothing never called |
| 1.4 | gix feature audit: `native/core` enables only what it uses (`revision`, `blob-diff`, `status`, …), `default-features = false` | −1–2 MB | Cross-backend engine tests pass |
| 1.5 🟡 | Tauri side: `bundle.windows.nsis.compression = "lzma"` ✅; audit whether all three plugins (`opener / dialog / clipboard`) are needed; disable `withGlobalTauri` (graph iframe switches to postMessage) | −1 MB | — |
| 1.6 ✅ | Frontend splitting: `textEditor.ts` (CodeMirror core) loaded on first editor open, xterm and `@codemirror/merge` async chunks (`lazy.ts`, `manualChunks`), the first-paint closure emitted by Vite and gated; still open: subset codicon, share `markdown-it` with the graph frame | First-paint JS 902 KB → **200 KB** | Gate active |
| 1.7 ✅ | CI size gate: the Studio job in `native-build.yml` runs `measure.mjs --gate --repo ..` after the build (fails when exe > 10 MB, installer > 8 MB or VSIX > 0.6 MB) and publishes `metrics.json` with the bundles ✅; PR comment with the size delta still to do | — | Gate removed 2026-09-15: sizes recorded, not limited (`measure.mjs` publishes `metrics.json` as before) |
| 1.8 | Optional: evaluate `upx --lzma` — **off by default** (antivirus false positives, decompression slows startup) | — | Conclusion recorded |

### M2 — Startup and large-project performance (2 weeks)

Goal: Source Insight-class "huge project opens instantly".

| # | Task | Touches | Acceptance |
|---|---|---|---|
| 2.1 | Startup profiling: `--measure` samples `main()` → window created → WebView ready → `workbench.ts` executed → splash removed; create `ExtensionHost`, `Panel / terminal` and the `GraphHost` iframe lazily on first use | `workbench.ts`, `main.ts` | First frame ≤ 150 ms, interactive ≤ 300 ms |
| 2.2 🟡 | State snapshot: expansion set, open tabs and the active tab per folder (localStorage) restored on open ✅; still open: scroll positions, the cached tree skeleton painted before validation | `state.ts`, `workbench.ts` | Last layout visible within 100 ms of restart |
| 2.3 🟡 | File index: `walk_files` is the parallel `ignore`-crate walk (honours `.gitignore` / `.ignore`), **uncapped** ✅; still to do: the memory-mapped snapshot at `~/.ggs/index/<hash>/files.bin` loaded at startup and diffed in the background | `cmd_fs.rs` → `cmd_index.rs` | 100k-file Quick Open ≤ 1.5 s first time, ≤ 50 ms thereafter |
| 2.4 ✅ | File-system watcher with the `notify` crate, 100 ms debounce, driving the SCM / graph / status bar / Explorer refresh, clean-tab reloads and the file-list / symbol cache invalidation (partial Explorer refresh and "file changed on disk" prompts for dirty tabs still to do) | `watcher.rs`, `workbench.ts` | External change reflected within 300 ms |
| 2.5 ✅ | Quick Open fuzzy scoring: `fuzzy.ts` (VS Code-style scoring, path-segment weighting), `filePicker.ts` (chunked scan, capped query), perf-guarded by `perf.test.ts` | `fuzzy.ts`, `filePicker.ts` | Typing `wbts` hits `workbench.ts` |
| 2.6 | Huge files: `viewer/doc.rs` switches to `memmap2` + a line-offset index (built in the background, per segment on demand) instead of reading the whole file into a rope; edit mode offers read-only or segmented editing above 10 MB | `viewer/*.rs`, `fastView.ts` | 1 GB file ≤ 300 ms to first screen, memory ≤ 50 MB |
| 2.7 | Engine warm-up and parallelism: preload packfile indexes and refs in `RepoManager` on folder open; fetch the graph's first page and SCM status in parallel; `scm_status` uses the engine's `status.rs` instead of `git status --porcelain` | `cmd_graph.rs`, `cmd_scm.rs` | First page ≤ 150 ms (engine is at 69 ms today) |
| 2.8 ✅ | Performance gate: `tests/perf.rs` builds a synthetic repository (20k files in CI, 100k on demand) and fails over budget - absolute for the walk and the engine phases, relative to a raw read of the tree for the content phases | CI | Gate active |
| 2.9 ✅ | Auto-save (`afterDelay` / `onFocusChange`) and hot exit (unsaved buffers written to `~/.ggs/backups`, restored after a crash) | `editor.ts`, `cmd_fs.rs` | Content survives a killed process |

### M3 — VS Code workbench completion (3 weeks)

Goal: the daily editing workflow no longer needs a trip back to VS Code.

**3.A Editor groups and editors**

| # | Task | Acceptance |
|---|---|---|
| 3.1 ✅ | Editor groups: `EditorGroup` becomes a tree layout (SplitView); `Ctrl+\` split right, `Ctrl+K Ctrl+\` split down, tab drag across groups, `Ctrl+1/2/3` focus group, empty groups collapse | Layout persisted; works with every editor kind (diff / graph / compare) |
| 3.2 ✅ | Minimap (Canvas, sampled from the fast viewer's highlight tokens), sticky scroll (from the lezer tree), bracket pair colouring | Minimap stays smooth on a 1M-line file (window sampling) |
| 3.3 ✅ | Completion and snippets: enable `@codemirror/autocomplete` (words + paths + snippets); snippet format compatible with VS Code `*.code-snippets`; `Ctrl+Space` | Basic snippets for 20 languages built in |
| 3.4 ✅ | Rebuild the find widget in VS Code's style (replace, regex, whole word, case, in selection, match count) | Shares option state with the Search view |
| 3.5 ✅ | Encoding / EOL / indentation: `encoding_rs` auto-detection (BOM, UTF-16, GBK / GB18030, Shift-JIS, …), clickable status bar entries to switch and convert; LF / CRLF; indentation detection and switching | A GBK file opens correctly and saves back in GBK |
| 3.6 ✅ | Bookmarks: `Ctrl+Alt+K` toggle, `Ctrl+Alt+L / J` navigate, a bookmarks side bar, persisted per workspace; gutter decorations | — |
| 3.7 ✅ | Image preview (zoom, transparency checkerboard, dimensions), Markdown preview (`Ctrl+Shift+V`, reuses `markdown-it`, scroll sync), hex viewer (virtual scrolling, byte search) | — |
| 3.8 ✅ | Multi-root workspaces: `.ggs-workspace` JSON, multi-root Explorer, search / index across roots, SCM repository picker | A workspace with 3 repositories opens |

**3.B Workbench**

| # | Task | Acceptance |
|---|---|---|
| 3.9 ✅ | Settings registry: `settings.ts` becomes schema-driven (id / type / default / enum / description / scope); the settings UI is generated, searchable, with "modified" markers; `settings.json` edited both ways; extension `contributes.configuration` merged in | Every hard-coded preference (font size, tab size, autoSave, theme, …) migrated |
| 3.10 ✅ | Keybinding editor: `keybindings.json`, conflict detection, a `Ctrl+K Ctrl+S` view with search / key recording; `when` context added | Any command can be rebound |
| 3.11 ✅ | Status bar aligned with VS Code: branch (click to switch), sync (↑n ↓m, click to sync), problem count on the left; line/col / indent / encoding / EOL / language / notification bell on the right | — |
| 3.12 ✅ | Notification centre: stackable toasts, an expandable centre, progress (clone / fetch / indexing), cancellable | Cloning a large repository shows a progress bar |
| 3.13 ✅ | File history and blame: a Timeline side bar (the file's commits, engine `log.rs`), inline blame decorations (`Ctrl+K Ctrl+B`); "Open File at Revision" already exists | Blame ≤ 500 ms on a 100k-commit repository (engine blame, or CLI first) |
| 3.14 | Git completion: hunk-level stage / unstage / discard (diff gutter buttons, backend builds a patch for `git apply --cached`), worktree and submodule views, cherry-pick / revert palette entries, an interactive rebase editor (draggable todo list via `GIT_SEQUENCE_EDITOR`) | — |
| 3.15 | Explorer completion: drag to move / copy, multi-select, cut / copy / paste, `.gitignore` dimming, Open Editors group, collapse all | — |

### M4 — Source Insight: symbol database and code navigation (4 weeks)

Goal: semantic navigation for eight languages — C / C++ / Rust / TS / JS / Python / Go / Java.

| # | Task | Touches | Acceptance |
|---|---|---|---|
| 4.1 | Parser layer: `tree-sitter` + 8 grammars, each behind a Cargo feature (all on by default; +2.5 MB budget reserved in M1); `build.rs` compiles the grammars (validate Windows MSVC first) | new `symbols/parse.rs` | A def / ref query `.scm` per language |
| 4.2 ✅ | Index storage: a compact custom format (no SQLite, saves 1.5 MB): `symbols.bin` (interned names + sorted arrays + file bitmaps), `refs.bin`; loaded via mmap; mtime + size fingerprints; incremental through the M2 watcher | `symbols/store.rs` | Cold build of 100k files ≤ 60 s, single-file update ≤ 20 ms, usable immediately after restart. One file `symbols.bin` (names + fingerprints + occurrence lists in one buffer) read whole instead of mmap'd; the bitmap became a sparse per-name file list — the dense form is O(names × files) |
| 4.3 🟡 | Query API: `symbol_lookup(name, kind?, file?)`, `symbol_fuzzy(query)`, `references(symbolId)`, `callers / callees(symbolId, depth)`, `symbol_at(file, line, col)`; background thread pool, foreground queries prioritised | `cmd_symbols.rs` | Definition ≤ 30 ms, references ≤ 200 ms. Landed: `symbol_lookup`, `symbol_references` (occurrence-narrowed), `symbols_status` / `symbols_rebuild`; still open: `symbol_fuzzy` (the substring `workspace_symbols` serves), server-side callers / callees (the Call Tree computes them frontend-side today) |
| 4.4 🟡 | Go to Definition uses the index (regex fallback kept for languages without a grammar); Peek list on multiple definitions; `Alt+F12` Peek Definition (popup reusing the fast viewer's fragment rendering) | `editor.ts` | —. The exact-name lookup jumps / offers the list; the `Alt+F12` popup itself is still open |
| 4.5 🟡 | Find References (`Shift+F12`): results reuse the Search view's tree, grouped as definition / write / read / call, scope-weighted (same file > same directory > others); `Ctrl+Shift+F12` reference Peek | `searchView.ts` | —. The scan is occurrence-narrowed by the index; the Search-view tree and grouping are still open |
| 4.6 | Call hierarchy view: a "Call Hierarchy" side bar, lazily expanded nodes, callers / callees toggle, double-click to jump, cycle detection; export as text | new `callHierarchy.ts` | 5 levels deep ≤ 300 ms |
| 4.7 ✅ | Context window (Source Insight's Context Window): a "Context" panel tab showing the definition of the symbol under the cursor after a 150 ms hover (pinnable, navigable) | `panel.ts`, new `contextView.ts` | Never steals focus, never jitters |
| 4.8 | Relation window: the selected symbol's five relation groups (definition / references / calls / callers / members) as a tree | new `relationView.ts` | — |
| 4.9 ✅ | Quick Open modes: `@` symbols in file, `#` workspace symbols, `:` line; `Ctrl+Shift+O`, `Ctrl+T` | `quickOpen.ts` | — |
| 4.10 | Semantic colouring overlay: token classes from the index (function / type / variable / macro / parameter) layered over lezer / syntect highlighting, switchable; Outline and breadcrumbs read the index | `cmTheme.ts`, `fastView.ts` | Visually matches VS Code semantic tokens |
| 4.11 🟡 | Index UI: status bar progress, an "unparseable files" list, exclusion rules setting, manual rebuild | — | —. Progress + click-to-rebuild + the rebuild command landed; the unparseable list and exclusion setting are open |

### M5 — Beyond Compare: the compare and merge suite (3 weeks)

| # | Task | Touches | Acceptance |
|---|---|---|---|
| 5.1 | Compare session model: `CompareSession { left, right, kind: text \| folder \| hex \| image \| table, rules }` saved to `~/.ggs/compare-sessions.json`; a "recent compares" list; Welcome page entry | new `compare/session.ts` | — |
| 5.2 | Entry points: Explorer "Select for Compare / Compare with Selected", drop two files on the window, palette `Compare: Clipboard with Editor` and `Compare: Active File with Saved`, CLI `ggs --diff a b` and `ggs --merge base ours theirs out` (usable as git mergetool / difftool) | `explorer.ts`, `main.rs` | `git difftool --tool=ggs` works |
| 5.3 | Rules toolbar: ignore leading / trailing / all whitespace, case, line endings, blank lines; regex "unimportant text"; syntax-block alignment (top-level lezer node boundaries as anchors); backend `text_diff(left, right, rules)` returns normalised hunks, frontend only renders | `cmd_diff.rs`, `editor.ts` | Rule switch ≤ 100 ms on a 5 MB file |
| 5.4 | Editable diff: both sides editable (CM MergeView supports it), per-block "← / → take this block", "merge both", save either side; block navigation F7 / Shift+F7 | `editor.ts` | — |
| 5.5 | Moved-block detection and word-level highlighting: backend pairs hunks by content hash and labels "moved from line N"; word diff via the `similar` crate | `cmd_diff.rs` | — |
| 5.6 | Three-way merge: four panes (Base / Ours / Theirs above, Result below), per conflict Accept Ours / Theirs / Both / Base, manual editing, Next Conflict, remaining-conflict count; entered from the SCM conflicts group, `git mergetool` or the CLI; `git add` on completion | rewrite `mergeEditor.ts`, `cmd_scm.rs::merge_sides` (reads stages `:1 / :2 / :3`) | Mark Resolved disabled until every conflict is resolved |
| 5.7 | Folder compare upgrades: status filters (differences only / left only / right only / newer), three comparison strategies (timestamp / size / content), fast binary compare (size + chunked hash), batch sync (left→right / right→left / bidirectional mirror, preview the plan before executing), exclusion rules, expand all differences, compare against a git ref tree (`HEAD~3` vs working tree) | `folderCompare.ts`, `cmd_search.rs::compare_dirs` | 2 × 50k files ≤ 5 s |
| 5.8 | Hex compare view (two columns, differing bytes coloured, synced scrolling, next difference), image compare (side-by-side / overlay / blink / difference heat map, Canvas pixel diff), table compare (CSV / TSV aligned on a key column) | new `compare/hexView.ts`, `imageView.ts`, `tableView.ts` | — |
| 5.9 | Report export: unified patch, side-by-side HTML report, folder-compare CSV | — | — |

### M6 — Extension system II (3 weeks)

Goal: common VSIX beyond git-graph-rs (themes, snippets, grammars, light language tools) install and run.

| # | Task | Touches | Acceptance |
|---|---|---|---|
| 6.1 | Host runtime: the iframe becomes a **Web Worker** (the main thread can no longer be blocked by an extension), the `vscode` API is RPC over `MessageChannel`; the CJS loader supports relative `require` (files read from the VSIX; `cmd_ext::ext_read_file` exists) and shims for common Node built-ins (`path`, `events`, `util`, read-only `fs` mapped to `workspace.fs`) | `extHost.ts`, `ext-host.html` → `extHost.worker.ts` | An extension in an infinite loop does not freeze the UI |
| 6.2 | A `when` clause evaluator (VS Code syntax: `&&`, `\|\|`, `!`, `==`, `=~`, `in`) and context keys (`editorLangId`, `resourceExtname`, `scmProvider`, `gitOpenRepositoryCount`, …); `activationEvents` (`onCommand`, `onLanguage`, `onStartupFinished`, `workspaceContains`) | `contributions.ts` | Every `when` of git-graph-rs evaluates correctly |
| 6.3 | API surface (by demand): `window.createWebviewPanel` (sandboxed iframe + `asWebviewUri`), `window.createTreeView` (side bar containers via `contributes.viewsContainers / views`), `window.createStatusBarItem`, `window.createTerminal`, `window.createTextEditorDecorationType`, `workspace.fs`, `workspace.onDid*`, `workspace.applyEdit`, `languages.register{Hover, Definition, Completion, DocumentSymbol, CodeLens}Provider`, `languages.createDiagnosticCollection` (→ Problems panel), `env.appName = 'Git Graph Studio'` | `vscodeApi.ts` | Verified with 3 real marketplace extensions (e.g. Todo Tree, Bookmarks, a theme pack) |
| 6.4 | Contribution points: `themes` (TextMate theme → generated `theme/*.css` and CM highlighting), `grammars` (TextMate grammar → loaded by syntect, shared by viewer and CM), `iconThemes`, `snippets`, `configuration`, `viewsContainers / views`, `languages` | `contributions.ts`, `viewer/*.rs` | Installing a theme VSIX makes it selectable |
| 6.5 | Open VSX integration: search / details / install / update in the Extensions panel (`open-vsx.org/api`), filtered by `engines.vscode` and a "GGS compatibility list" (no native Node, no debug), compatibility badge; cache in `~/.ggs/CachedExtensions` | `extensionsPanel.ts`, `cmd_ext.rs` | Panel still works offline (installed list) |
| 6.6 | Built-in git-graph-rs auto-update: check GitHub Releases asynchronously after startup; download the slim VSIX into `~/.ggs/extensions/` when newer; hot-reload `out.min.js` in the graph iframe | `cmd_ext.rs`, `graphHost.ts` | Upgrade completes without restarting GGS |
| 6.7 | Extension safety: a permission manifest (network, file writes, terminal) granted on first use; crash isolation and "disable this extension"; host logs in Output | — | — |
| 6.8 | Optional "Node compatibility mode": detect a system `node` and run Node-requiring extensions in a `node` child-process host (same protocol as the Worker); **Node is not bundled** (size) | `extHostNode.rs` | Without node, the panel states these extensions are unavailable |

### M7 — Xcode-level polish (2 weeks)

| # | Task | Acceptance |
|---|---|---|
| 7.1 | macOS: `titleBarStyle: Overlay` with native traffic lights, side bar vibrancy (`window-vibrancy`), a Cmd key table (`Cmd+P / Shift+P / , / W / S`, `Cmd+Alt+← / →`), native application menu; Linux: CSD, `Super` / `Ctrl` keys | Screenshot review on all three platforms |
| 7.2 ✅ | Motion system: `--motion-fast / normal` and easing tokens in `shell.css`; CSS transitions for side bar / panel, tab drag, notifications, the command palette; disabled under `prefers-reduced-motion`; every animation ≤ 150 ms | No jank (60 fps in a performance recording) |
| 7.3 🟡 | Design spec: 4 px grid, type / line-height scale (11 / 12 / 13 / 14 / 16 / 20), spacing tokens, radius tokens; density setting (Compact / Comfortable); redesigned empty states (no folder / no repository / empty search / indexing) and Welcome | Design walkthrough checklist passes. The density setting and its five strip variables landed; the grid / type-scale audit and the empty-state redesign are open |
| 7.4 🟡 | Keyboard completeness: every command runs from the palette; visible focus rings; `Esc` unwinds layer by layer; type-to-navigate in lists / trees; `F6` cycles focus areas | "Open → edit → commit → push" completed with the mouse unplugged. F6's cycle (activity bar → side bar → editor → panel) landed; type-to-navigate is open |
| 7.5 🟡 | Themes: `auto` follows the system, system accent colour mapped to focus / selection, cross-fade on switch; HC contrast validated (4.5:1) | —. `auto` with the live `prefers-color-scheme` follow landed; the accent mapping and cross-fade are open |
| 7.6 🟡 | Accessibility: ARIA roles for trees / lists / tabs, `aria-live` notifications, screen readers announce diff change summaries; Windows Narrator and macOS VoiceOver smoke tests | —. The tablists label their selection and the tooltips keep accessible names; the tree / list roles and the screen-reader passes are open |
| 7.7 | Window and OS integration: multi-instance (every launch is its own process and window, decided 2026-09-17; the earlier single-instance forward is removed), drag-drop files / folders onto the window, file associations and "Open with GGS" (registered by the installer), taskbar Jump List / Dock recents, multiple windows (`Ctrl+Shift+N`) | — |
| 7.8 🟡 | Micro-interactions: delayed hover tooltips, sash hover highlight, busy cursor on long tasks, tab flash on save, smooth scrolling on diff block navigation | —. All but the smooth diff-block scroll landed |

### M8 — Release engineering (1 week)

| # | Task | Acceptance |
|---|---|---|
| 8.1 | App self-update: `tauri-plugin-updater` (signed, GitHub Releases as the source), silent download, applied on next launch; +0.8 MB already in the budget | 0.1.0 upgrades to 0.2.0 |
| 8.2 | Crashes and logs: a Rust panic hook writes `~/.ggs/logs/crash-*.txt`, frontend `window.onerror` persisted, Help > Open Logs; no telemetry | — |
| 8.3 | Installers: Windows NSIS (per-user default, plus a portable zip), MSI; macOS dmg + notarisation; Linux AppImage / deb / rpm; `winget` / `brew cask` manifests | Artefacts for all three platforms in CI |
| 8.4 | Documentation: `app/README.md` becomes a user manual, keybinding table, extension compatibility list, performance and size numbers written into the README from `metrics.json` | — |
| 8.5 | Single source of truth for the version: `app/package.json`, propagated by `prepare.mjs` to `tauri.conf.json` / `Cargo.toml` | — |

---

## 6. Special topic: the size playbook

**Measurement**: every release build emits `metrics.json` (exe, installer, dist, bundled VSIX, top 15 crates from `cargo bloat`); CI gate + PR comment.

**Budget split (how ≤ 10 MB exe breaks down)**

| Component | Budget |
|---|---|
| Tauri runtime + wry + tao + serde / json | 2.5 MB |
| gix (trimmed) | 2.5 MB |
| tree-sitter + 8 grammars (M4) | 2.0 MB |
| syntect (fancy-regex + trimmed syntax pack) | 1.2 MB |
| Everything else (pty, zip, regex, notify, memmap, updater) | 1.3 MB |
| Headroom | 0.5 MB |

**Rules**
1. Run `cargo bloat` before adding any crate; a dependency over 300 KB must justify in the PR why no alternative works.
2. Never introduce: SQLite, reqwest, full tokio, openssl, or any parser with a C runtime (tree-sitter is the exception).
3. Frontend: first-paint chunk ≤ 300 KB; any library over 50 KB is an async chunk; no UI framework.
4. Assets: subset fonts; inline and de-duplicate SVG icons; themes are CSS variables, never a duplicated full sheet.
5. The bundled VSIX is always the slim one; user-installed VSIX do not count toward app size.
6. No UPX.

---

## 7. Special topic: performance budget and measurement

**Tools**
- Backend: `git-graph-studio --measure <folder>` runs headless through "open folder → walk → index → graph first page → scm status → search `TODO`" and prints JSON; `perf_bench` builds a synthetic 100k-file repository with `test_support`.
- Frontend: `performance.mark` probes (`boot`, `workbench-ready`, `folder-open`, `explorer-root`, `graph-first-page`, `quickopen-ready`), visible in a "Perf" output channel; a "performance scenario" in `dev-harness.html`.
- The measured values in the section-4 table are refreshed at the end of every milestone.

**Principles**
- Yield the main thread within 16 ms: the big lists / trees are virtual-scrolled (large Explorer folders, folder compare, call trees). The search result tree is the deliberate exception - a plain DOM tree like VS Code's, one group per file, folding by a class flip - because streamed appends and O(1) collapse keep it responsive without windowing.
- IPC messages ≤ 1 MB; anything larger is chunked over a `Channel`.
- Every backend walk runs in parallel (rayon / `ignore`) and is cancellable (a cancellation token goes into every long task; switching away in the UI cancels it).
- Index-like data (file lists, symbols, cached compare results) is memory-mapped from disk — zero parsing at startup.

---

## 8. Special topic: extension system design (M6 in detail)

```
┌──────────────── main thread (workbench) ────────────┐
│ contributions.ts  when-evaluator  commands  views     │
│        ▲ RPC (MessageChannel, JSON, cancel token)     │
└────────┼──────────────────────────────────────────────┘
         ▼
┌──── Worker: extension host ────┐   ┌── optional node child host ──┐
│ vscode API shim (vscodeApi.ts) │   │ same protocol, real Node exts │
│ CJS loader ← VSIX virtual FS   │   │ requires a system node        │
│ one module sandbox per ext     │   └──────────────────────────────┘
└────────────────────────────────┘
         ▼ files / network / terminal go through the main thread to Tauri commands,
           constrained by the permission manifest
```

- **Compatibility grades**: A (full) / B (some APIs missing, listed) / C (needs Node) / D (unsupported: debug, remote, notebooks). The Open VSX list filters by grade.
- **git-graph-rs stays special**: `nativeCommands` dispatch to the workbench's native views; its `contributes.configuration` merges into the settings registry; the Settings Widget still writes through `graphHost.ts`.
- **Versioning**: the GGS version and the built-in VSIX version are decoupled; the VSIX follows releases via 6.6, GGS itself updates via 8.1.

### 8.1 The GGS plugin package: no Node runtime, multi-process, fast

VSIX compatibility (above) is for the existing ecosystem. GGS's *own* plugin format is designed for the three things a VSIX cannot promise — no Node runtime, no main-thread blocking, native-speed heavy lifting — and it reuses the same host contract, so one plugin can ship as both.

**Package**: a `.ggx` zip with `manifest.json` (a strict subset of `package.json`: `name`, `publisher`, `version`, `engines.ggs`, `contributes` with the same contribution points as §M6.4, plus `permissions` and `entry`). Signed (ed25519, the publisher's key in the manifest, the signature in `SIGNATURE`); GGS refuses unsigned packages unless the user enables developer mode.

**Two entry kinds** (decided 2026-09-13: **no WebAssembly** — its performance is not good enough for the engine-class work a plugin backend does, and native processes give full speed with the same isolation), both speaking one RPC protocol (JSON messages with a `cancel` token, as §8's diagram):

| `entry.kind` | Runs as | For | Isolation |
|---|---|---|---|
| `web` | A **Web Worker** in the webview (`entry.script`, a self-contained ES module; the `vscode`-compatible `ggs` API is RPC over `MessageChannel`) | UI-side logic: commands, tree views, decorations, small language tools | Cannot block the workbench thread; killed on `disable`; no filesystem or network without a permission |
| `process` | A **separate native process** (one binary per platform, spawned by the app, newline-JSON RPC on stdio — `ggx-rpc/1`, §8.2) | Engines, language servers, indexers, anything CPU-bound or needing its own threads — the multi-process path: each plugin is its own OS process, crashes and hangs are isolated, the host restarts it | Permission-gated (the manifest lists the folders / network it may touch); the host passes the repository path per request, never inherits the app's environment |

**Performance rules**: the host never waits synchronously on a plugin; every request carries a deadline; results larger than 1 MB stream in batches (the same `Channel` pattern the search uses); a `process` plugin is started lazily on its first `activationEvents` match and stopped after idling; a `web` plugin that misses three deadlines in a row is paused and reported in the Extensions view.

**Why not embed Node**: it costs 40–60 MB, violates the size budget by itself, and is the one dependency that makes VS Code's extension host slow to start. The `process` kind gives a Node extension author the same escape hatch (ship `node` yourself, or use the optional §M6.8 compatibility mode) without GGS carrying the runtime.

**Delivery**: the `web` kind is M6.1 (the Worker host is shared with VSIX support); `process` **shipped 2026-09-13 for git-graph-rs** (§8.2). Native code that a plugin needs (a tree-sitter grammar pack, §M4) ships as a `process` too.

### 8.2 The `.ggx` package, as shipped (ggx/1)

> **Status in this repository (2026-09-15).** The design below was landed in the monorepo's
> `app/` tree, but the process backend did not come across in the split into this repository:
> there is no `src/bin/git-graph-backend.rs`, `backend_rpc.rs` or `plugin_host.rs`, and
> `Cargo.toml` builds one binary (`git-graph-studio`). What ships today is the **in-process**
> engine behind the single seam (`cmd_graph.rs` / `graphHost.ts`); `cmd_ext.rs` installs
> frontend-only `ggx/1` packages (`manifest.json` header + `web/`) and lists git-graph-rs as a
> built-in whose version follows the app. The process backend (`backend` header, `ggx-rpc`,
> host restart) is the M6 target, not the current state — `README.md` → *Extensions*
> describes the shipped behaviour.

git-graph-rs is the first `.ggx`: **frontend and backend in one package**, installed and upgraded like any extension, the backend running as its own process.

```
git-graph-rs-1.0.23.ggx                       (zip; scripts/build-ggx.mjs)
  manifest.json                               the ggx header (below)
  package.json, package.nls*.json             the VS Code-style manifest: contribution points, NLS, icon
  README.md, LICENSE.txt, licenses/, resources/
  web/  view.html, out.min.js, out.min.css, config.js, compare.js, markdown-it.min.js, highlight.min.js
  theme/                                       the shell's theme tokens the page links
  backend/win32-x64/git-graph-backend.exe     one binary per platform key (darwin-arm64, linux-x64, …)
```

```json
{ "format": "ggx/1", "id": "neophack.git-graph-rs", "version": "1.0.23", "engines": { "ggs": ">=0.1.0" },
  "frontend": { "kind": "webview", "page": "web/view.html", "config": "web/config.js", "compare": "web/compare.js" },
  "backend":  { "kind": "process", "protocol": "ggx-rpc/1", "binaries": { "win32-x64": "backend/win32-x64/git-graph-backend.exe" } },
  "permissions": ["repo:read", "git:write", "clipboard", "terminal", "network"] }
```

**Install** (`cmd_ext::install_from_ggx_into`): into `~/.ggs/extensions/<id>-<version>/`, the same store as VSIX; forward-only upgrades (a `.ggx` replaces a same-version `.vsix`); the platform's binary is validated and made executable; `studio-ext.json` records `format: "ggx"`. The app's bundled copy installs as built-in on first launch; a user-installed newer `.ggx` takes over the graph immediately (the backend restarts, the page reloads from the new `web/`).

**Backend protocol `ggx-rpc/1`** (`src-tauri/src/backend_rpc.rs`): newline-delimited JSON on stdin / stdout. Host → backend: `{"id","method":"hello"}`, `{"id","method":"request","repo","message","settings"}` (one `RequestMessage` of the view), `{"id","method":"closeRepos"}`, `{"id","method":"shutdown"}`. Backend → host: `{"id","result"}` / `{"id","error"}`, and events `{"event":"log","line":"> git fetch [120ms]"}` (git's command echo, folded into the panel's Git channel and the session log) and `{"event":"ready"}`. Requests are concurrent (a thread each in the backend), answers are paired by id; stderr is folded into the log as `[plugin] …`.

**Host** (`plugin_host.rs`): spawned lazily after the bundled install (requests made meanwhile wait, bounded, for that first configuration), `hello` handshake with a 10 s deadline and a protocol check, `closeRepos` on folder switch, restart on the next request after a crash, status (pid, protocol, start count, last error) on the Extensions page with a Restart button. The host-only arms of the protocol — clipboard, opening URLs, `copyFilePath` — never leave the app.

**The backend is the only engine** (decided 2026-09-13, "去掉回退"): the app links no `git-graph-core` at all — `engine` is a Cargo feature only the backend binary enables (`--no-default-features --features engine`), `cmd_graph.rs`'s engine arms compile only there, and the workbench's own reads are protocol methods: `repoRoot` (folder open), `scmStatus` (the SCM view), `revisionFile` (the diff editors), `firstPage` (the `--measure` probe). Without an installed backend the git views report "not installed" instead of silently answering with a second copy of the engine. This removed the double link (~3 MB) and makes the package genuinely the thing that provides git.

**Isolation of styles**: the package carries only the extension's own CSS (`out.min.css`, the comparison page's inline styles); the shell's `shell.css` has no Git Graph rules; the host injects its theme-token stylesheet (`--vscode-*`, `#ggs-host-theme`) into the view page at load — exactly VS Code's webview contract — and nothing of Studio's travels inside the `.ggx`.

**Performance**: one JSON line per request across a pipe (~0.1 ms), the engine warm inside the backend exactly as it was in-process. The backend binary is 3.9 MB (the size profile, no Tauri); the package 2.3 MB compressed.

**Not yet**: signatures (the manifest has the fields reserved), the permission manifest being enforced, the `web` kind, Open VSX-style discovery of packages, per-platform packages in CI (the build packs the host platform's binary; the workflow's matrix has to pass `--backend` per target).

---

## 9. Quality and release process

- **Branches**: `main` is always releasable; one `ggs/mN-*` branch per milestone, one PR per task.
- **Every PR must pass**: vitest + `cargo test` (app workspace) + `tsc --noEmit` + `cargo clippy -D warnings` + the size gate + the performance gate (from M2).
- **At the end of every milestone**: the manual smoke checklist on all three platforms (open repository, edit and save, commit and push, graph actions, terminal, extension install, compare, merge), refresh the measured values in section 4, tag `studio-v0.x.0`.
- **Version plan**: M0–M2 → 0.2; M3 → 0.3; M4 → 0.4; M5 → 0.5; M6 → 0.6; M7–M8 → **1.0**.

---

## 10. Schedule summary

| Milestone | Content | Effort | Cumulative | Main new dependencies |
|---|---|---|---|---|
| M0 | Wire in search / folder compare / merge + measurement | 1 week | 1 week | — |
| M1 | Size diet | 1 week | 2 weeks | `cargo-bloat` (dev) |
| M2 | Startup and large-project performance | 2 weeks | 4 weeks | `ignore`, `notify`, `memmap2` |
| M3 | VS Code workbench completion | 3 weeks | 7 weeks | `encoding_rs` |
| M4 | Symbol database / references / call tree / relation window | 4 weeks | 11 weeks | `tree-sitter` + 8 grammars |
| M5 | Compare and merge suite | 3 weeks | 14 weeks | `similar` |
| M6 | Extension system II | 3 weeks | 17 weeks | — |
| M7 | Xcode-level polish | 2 weeks | 19 weeks | `window-vibrancy` |
| M8 | Release engineering | 1 week | 20 weeks | `tauri-plugin-updater` |

About 5 months to 1.0. M1 ∥ M2 and M5 ∥ M6 can run in parallel with two developers, compressing to roughly 3.5 months.

---

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| tree-sitter grammars: compile problems on Windows MSVC / macOS cross builds, and size | M4 slips, size budget breached | Validate the build chain with C / Rust / TS first; grammars gated per feature; if still over budget, make grammars an optional pack downloaded on first use |
| gix API churn on upgrade (0.87 → 0.9x) | Engine and size trimming rework | Do the engine feature audit once in M1 and pin the version; reassess the upgrade before M8 |
| WebView2 version differences causing CSS / performance divergence | Uneven experience across machines | CI smoke tests with both Evergreen and a pinned WebView2 runtime; a separate Linux WebKitGTK walkthrough |
| Extension API semantics drifting from VS Code's after the surface grows | Third-party extensions misbehave | Three real extensions as a regression set; no 100% promise, compatibility grades stated explicitly |
| Three-way merge state machine vs git index stages | Data loss | Write the merge result to a temp file first, verify no conflict markers before `git add`; cover with real-repository tests in the `git_actions/tests.rs` style |
| M3 / M4 too large for a single developer | Schedule slips | 3.7 / 3.8 / 3.14 in M3 and 4.8 / 4.10 in M4 are marked deferrable to 1.1 |
| Performance gate noise on shared CI runners | False failures | Gate against a relative baseline (the previous `main` run on the same runner) with 20% tolerance, not absolute values |

---

## Appendix A: VS Code command → GGS status (excerpt; the full table is generated into `docs/commands.md` during M3)

| Command | Keys | Status | Milestone |
|---|---|---|---|
| Go to File / Command Palette | Ctrl+P / Ctrl+Shift+P | ✅ | — |
| Find in Files / Replace in Files | Ctrl+Shift+F / H | 🟡 written, unwired | M0 |
| Go to Symbol in Editor / Workspace | Ctrl+Shift+O / Ctrl+T | ❌ | M4 |
| Go to Definition / References / Peek | F12 / Shift+F12 / Alt+F12 | 🟡 / ❌ / ❌ | M4 |
| Split Editor | Ctrl+\ | ❌ | M3 |
| Toggle Minimap / Sticky Scroll | — | ❌ | M3 |
| Trigger Suggest | Ctrl+Space | ❌ | M3 |
| Toggle Bookmark | Ctrl+Alt+K | ❌ | M3 |
| Compare Active File With… / Selected | — | ❌ | M5 |
| Merge Editor | — | 🟡 | M0 → M5 |
| Open Keyboard Shortcuts | Ctrl+K Ctrl+S | ❌ | M3 |
| Open Settings (JSON) | — | ❌ | M3 |
| Toggle Zen Mode | Ctrl+K Z | ❌ | M7 |
| Git: Stage Selected Ranges | — | ❌ | M3 |
| Git: Open File History / Blame | — | ❌ | M3 |
| Extensions: Install from VSIX / Marketplace | — | ✅ / ❌ | M6 |

## Appendix B: directory conventions (new)

```
~/.ggs/
  extensions/            installed extensions (exists today)
  index/<repo-hash>/     files.bin, symbols.bin, refs.bin       (M2 / M4)
  workspaceStorage/<hash>/state.json                             (M2)
  backups/               hot-exit buffers                        (M2)
  compare-sessions.json                                          (M5)
  settings.json, keybindings.json, snippets/                     (M3)
  logs/                                                          (M8)
```
