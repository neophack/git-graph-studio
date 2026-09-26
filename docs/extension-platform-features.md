# Extension Platform — feature surface & polish list

The contract this host offers to `.vsix` packages, and the honest state of every feature
after the marketplace-compatibility rounds (EditorConfig, Prettier, Code Spell Checker,
ms-python, git-graph-rs 1.0.25/1.0.27 live-tested). This list is the working plan: each
row moves down as the shims grow.

Legend: **✅** works end to end · **🟡** works with documented gaps · **🧪** implemented,
needs live soak · **🧱** next up (designed, not built) · **🚫** architecture boundary —
a clear named failure, not a silent no-op.

## 1. Package lifecycle

| Feature | State | Notes |
|---|---|---|
| VSIX install / upgrade / uninstall (forward-only) | ✅ | `install_from_vsix_into`; same-version reinstall refused |
| Store VSIX with `ggs` capabilities → runtime manifest | ✅ | `generated_studio_manifest` |
| Plain marketplace VSIX (no `ggs` key) installs as frame-host package | ✅ | ms-python, EditorConfig, Prettier, Spell Checker live-tested |
| Plain VSIX with `main` + native binaries → derived `ggs-node` backend | ✅ | `resolve_node_binaries`; git-graph-rs 1.0.25 live-tested |
| VSIX with unrunnable native binaries → named refusal at install | ✅ | the error names the files and the reason |
| Engine `.node` backend (`kind: node`, engine host, C-ABI JSON dispatch) | ✅ | `engine_host/`; `abiEntry` names non-standard exports |
| Process backend (`kind: process`, any language) | ✅ | `ext_process.rs`, warm sibling, crash isolation |
| JS-entry backend (pretend Node runtime `ggs-node`) | ✅ | `node_runtime/`; CommonJS + builtins + C-ABI `.node` |
| Eager start at boot + install, lazy restart on command | ✅ | `start_all_installed` + first-command fallback |
| `.wasm` payloads readable via `fs.readFileSync` | ✅ | blob preload (`ExtCodeBundle.blob_files`) |

## 2. Frame-host VS Code API (`vscode` shim)

| Surface | State | Notes |
|---|---|---|
| commands (register/execute/palette) | ✅ | declared commands of unactivated packages included |
| window: messages, notifications, quick picks, status bar, progress toasts | ✅ | quick picks: multi-select (toggle rounds), `createQuickPick` / `createInputBox`; input boxes: `password`, `validateInput`; status items: `Command` objects, colours, priority, `$(icon)` text; progress tasks get their token |
| core value types (`Range`, `Position`, `Selection`, `Uri`, `EventEmitter`, …) | ✅ | VS Code's constructors and methods; `Uri` has `authority`, platform `fsPath`, encoded `toString`; events bind `thisArgs` and isolate a throwing listener |
| ExtensionContext (`secrets`, `environmentVariableCollection`, storage URIs) | 🟡 | storage under `~/.ggs/extension-data/<id>`; secrets in workbench storage (not an OS keychain); env-var mutations kept, not applied to terminals |
| configuration defaults, sub-sections, `inspect` | ✅ | declared defaults + core sections (`editor.*`, `files.*`, `http.*`) |
| documents (`openTextDocument`, `textDocuments`, change / close events) | ✅ | open-editor buffers or disk text; `onDidChangeTextDocument` as whole-text changes (debounced 300 ms); no `onWillSave` hook |
| tree views | ✅ | codicon/ThemeIcon icons, `resourceUri`, checkboxes, selection / expand events, title / description / message / badge, `view/title` + `view/item/context` menus |
| `extensions.getExtension` of other extensions | 🟡 | manifests and paths; their `exports` stay in their own host |
| window.createWebviewPanel / webview views (sidebar) | ✅ | nonce reuse for package CSPs |
| workspace.fs (read/write/mkdir/delete/rename/find) | ✅ | confined to the open folders, the extension's own directory and its storage; errors are `FileSystemError`s |
| workspace.applyEdit / TextEditor.edit | ✅ | `WorkspaceEdit` instances, plain `changes`, LSP `documentChanges`, create / delete / rename operations |
| workspace.getConfiguration/update + mementos | ✅ | per-install persistence |
| env.clipboard, env.appVersion, openUrl/external | ✅ | |
| languages.createDiagnosticCollection → editor squiggles | ✅ | `editorDiagnostics.ts`; 0-based line/char → offsets at render |
| editor.formatDocument via formatting providers | ✅ | document and range formatters, one registration per provider, selectors scored on language / scheme / pattern; Ctrl+Shift+I |
| languages: hover/definition/codeLens/completion providers | 🚫 | inert registrations, each logged once as unsupported — need provider-hosting editors per feature |
| editor decorations, SCM providers, notebooks, debug, tasks, authentication | 🚫 | accepted, logged once as unsupported; `tasks.executeTask` rejects |
| diagnostics for large/windowed files | 🧱 | full-text CodeMirror editors only today |
| `when` clauses | ✅ | full grammar: `\|\|`, `&&`, `!`, parentheses, `==` / `!=`, `=~`, `in` / `not in`, `<` … `>=`; `setContext` values of any type |
| menus | ✅ | `explorer/context`, `editor/context`, `editor/title` (+ `/context`), `scm/*`, `view/title`, `view/item/context` |
| keybindings | 🟡 | per-platform keys and `args`; one binding per command (the first that applies) |
| ESM entries (`import`-style mains, e.g. Prettier v12) | 🚫 | CJS loader; the failure names the shape |
| debug/test/task/taskProvider APIs | 🚫 | inert registrations |

## 3. Node compatibility in the frame (`nodeShims`)

| Module | State | Notes |
|---|---|---|
| path (posix/win32 aliases + `path/posix`, `path/win32`) | ✅ | |
| fs (map sync + workspace bridge async + binary blobs) | ✅ | `(path, options, callback)` forms, `withFileTypes` Dirents, promise forms reach workspace paths |
| stream (Readable / Writable / Duplex / Transform / PassThrough, pipeline) | ✅ | no backpressure (a frame has no sockets) |
| crypto random (`randomBytes`, `randomUUID`, `getRandomValues`) | ✅ | frame and ggs-node alike |
| events, util (format/promisify/…), Buffer (codecs) | ✅ | |
| child_process: spawn/execFile/exec (+ callbacks) | ✅ | streamed via `ext_child`; sync variants 🚫 (cannot block the frame loop) |
| readline / readline/promises (inert terminal) | ✅ | answers empty, closes cleanly |
| http/https (inert local server) | ✅ | `createServer().listen()` settles; no network is served |
| os, process (real env), timers, console | ✅ | |
| net, dgram, cluster, vm, worker_threads | 🚫 | named failures |
| `node:` prefixed specifiers | ✅ | every entry answers both spellings where listed |

## 4. Pretend Node runtime (`ggs-node`, JS-entry backends)

| Feature | State | Notes |
|---|---|---|
| CommonJS require (relative/node_modules/package main/index) | ✅ | package-root confined; cycles answer partial exports |
| Builtins: fs (real), path, os, child_process (real spawn), Buffer, events, util, console, timers, process | ✅ | |
| `require('*.node')` over the C-ABI JSON dispatch | ✅ | `abiEntry` names non-standard exports |
| NAPI-only addons | 🚫 | refused by name — needs a real Node |
| `ggs.onRequest` / `exports.dispatch` / engine-message dispatch | ✅ | five-step order in `node_runtime/mod.rs` |
| `http`/`net` servers, worker_threads | 🧱 | designed as inert-or-named-failure; not started |

## 5. Marketplace & packaging

| Feature | State | Notes |
|---|---|---|
| Open VSX search + one-click install/download | ✅ | origin-confined (`ext_gallery.rs`); the search asks for this machine's target platform |
| `extensionDependencies` / `extensionPack` | ✅ | installed from the marketplace with the package; a missing one is logged and named at activation |
| Bundled package offer + boot-time forward-only upgrade | ✅ | |
| Multiple app instances own separate backends | ✅ | `GGS_INSTANCE_ID` |
| Extensions view: detail pages, backend status/restart, uninstall | ✅ | |

## 6. Known deviations (documented, not silent)

- Diagnostics for windowed (million-line) editors: not rendered.
- `child_process` sync variants: named failure (a frame cannot block its event loop).
- LSP-client extensions (Code Spell Checker's server architecture): blocked by the missing
  language-server host — the next designed milestone.
- ESM entries (Prettier v12): blocked by the CJS loader — the next designed milestone.
- Native Node addons (NAPI) outside the C-ABI convention: refused by name — needs real Node.

## 7. The extension host log

Every anomaly the platform sees is recorded — nothing fails silently:

| Recorded | Level |
|---|---|
| activation failures (with the stack, named `ggs-ext://<package>/<file>:line:col`) | error |
| command, provider, event-listener and formatter exceptions | error |
| host requests that failed, unknown host requests, unknown commands | warn |
| every unsupported VS Code API a package registers or calls (once per API) | warn |
| Node surfaces a frame cannot serve (`net`, sync `child_process`, …) | warn |
| a package's own `console.error` / `console.warn` | error / warn |
| activations, host starts, installed dependencies | info |
| each host request (`→ method`), a package's console chatter, a fork's stderr | debug |
| host answers (`← method`), a language-server fork's wire methods | trace |

Where: the Output view's **Extension Host** channel (command *Show Extension Host Log*)
and `~/.ggs/logs/ext-host.log` (command *Open Extension Host Log File*; rotated at 4 MB to
`ext-host.log.1`). The threshold is Settings → General → *Extension Host Log Level*
(default `info`); `localStorage['ggs-ext-debug']` still forces `trace`.
