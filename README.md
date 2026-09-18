# Git Graph Studio

A standalone desktop app that wraps the `git-graph-rs` engine (the `vscode-git-graph-rs/`
submodule's `native/core`) in a small VS Code-like shell: an Explorer file tree with git status colouring,
a Source Control panel (stage / unstage / discard / commit), an editor with tabs, a built-in
terminal (ConPTY on Windows), and the full Git Graph webview — the same `out.min.js` the
submodule's VS Code extension builds, hosted unchanged behind an `acquireVsCodeApi` shim.

Everything is built in: there is no extension installation of any kind. The `git-graph-rs`
engine is linked in-process behind the single seam `src/graphHost.ts` ↔
`src-tauri/src/cmd_graph.rs`, its webview assets are assembled into the app at build time, and
its version follows the app — upgrading the graph means upgrading the app.

Code navigation rides a persistent symbol index (Source Insight's model): the workspace's
declarations and their occurrences indexed once under `~/.ggs/index/`, resumed on open and
updated file-by-file as files change — powering Go-to-Definition (with a list on ambiguous
names), Find References narrowed to the files that contain the word, Quick Open's `@`
(file symbols) and `#` (workspace symbols) modes, the Call Tree, and a Context Window panel
that shows the definition of the symbol under the cursor. The declarations are extracted by
a tree-sitter parser layer (one grammar per language, each behind a Cargo feature), so every
symbol carries its column, range, enclosing type and complexity.

The **Code Analysis** view (`Ctrl+Shift+A`, module 17) turns that parsed model into five
tools, each a streamed result page in the editor area: a **Call Graph** (opens on the
workspace's every call relationship with its edges on a pan-and-zoom canvas, then walks
per symbol — callers and callees, click a node to continue from it), **Complexity & Hotspots** (cyclomatic
complexity, size, nesting per function), **Dead Code** (declarations no call site in the
workspace spells), a rule-based **Security Scan** (hardcoded secrets, dangerous and
weak-crypto APIs, with CWE tags) and the **Import Graph** (file dependencies with import
cycles). The shell itself is themeable
(`Auto (System)` follows the OS) with a Compact / Comfortable density setting, motion that
respects `prefers-reduced-motion`, and keyboard focus cycling on F6.

## Layout

```text
git-graph-studio/
├── index.html               the workbench window (Vite entry, loads src/main.ts)
├── package.json             npm scripts: dev / build / test / typecheck / prepare:assets / measure
├── vite.config.ts           the workbench build: entries, chunking, the first-paint closure
├── vitest.config.ts         the test suite (jsdom; runs the seam check as its global setup)
├── tsconfig.json
│
├── src/                     the shell frontend, one module per workbench part
│                            (explorer, editor, scm, search, settings, terminal, the git
│                            graph host, …)
├── static/                  static assets served as-is: gitgraph/view.html (the webview
│                            host page) and theme/*.css (the colour themes)
├── src-tauri/               the Rust backend — its own Cargo workspace
│   ├── src/                 the command modules (fs / scm / graph / search / symbols),
│   │                        the PTY, the file watcher, the large-file viewer, the CAN parser
│   ├── build.rs             Tauri codegen + the Rust seam check (only cmd_graph.rs names the engine)
│   └── .cargo/config.toml   points the Cargo target at target/studio/cargo
│
├── tests/                   the vitest suite — jsdom with a scripted Tauri backend
│                            (tests/tauriMock.ts), no Rust and no compiled assets needed
├── dev/                     dev-only probe pages, never built and never shipped:
│   ├── dev-harness.html     the real workbench under the dev server (plain browser or tauri dev)
│   └── hex-probe.html       the hex view in isolation, against any theme
│
├── scripts/                 the build pipeline — every generated file lands in target/studio/
│   ├── prepare.mjs          assembles the public dir the app serves (webview bundle, config,
│   │                        compare page, icons; see the file header for the full layout)
│   ├── check-seams.mjs      the compile-time seam rules (graphHost.ts / view.html / cmd_graph.rs)
│   ├── measure.mjs          exe/installer/dist size measurement + the backend probes
│   ├── *-stub.cjs           the vscode/Node stubs the config and compare bundles build against
│   ├── build-studio.bat     one-command Windows build (submodule → assets → tauri build)
│   ├── build-studio-linux.bat   the Linux installers through Docker (deb | rpm | shell)
│   ├── docker/              the Linux build containers
│   │   ├── Dockerfile.studio-linux    base image = the compatibility floor (see its header)
│   │   └── studio-linux-build.sh      the in-container half of the Linux build
│   └── probes/              benchmark and debugging probes against the packaged app
│       ├── boot-bench.mjs       end-to-end startup latency of the release exe
│       └── cdp-*.mjs            live inspection over WebView2's CDP port
│
├── docs/                    ggs-development-plan.md — the development plan
├── .github/workflows/       studio.yml (CI) · release.yml (tag → GitHub Release)
└── vscode-git-graph-rs/     the git-graph-rs VS Code extension, a git submodule tracking its
                             repository's main branch: the engine crate the app links
                             (native/core) and the webview assets it compiles (npm run
                             compile → out/, media/)
```

Everything generated — the Vite public dir and dist, the Cargo target, the installers, the
coverage and the metrics — lives under `target/studio/` (gitignored), never in the source
tree; `node_modules/` and the submodule's own build products stay where npm/cargo put them.

## Build

Prerequisites: Rust 1.94+, Node.js, and the submodule compiled once:

```sh
git submodule update --init      # checks out vscode-git-graph-rs/ (the extension)
cd vscode-git-graph-rs && npm install && npm run compile && cd ..   # out/config.js and media/
npm install
npx tauri dev           # run the app
npx tauri build         # produce the installers for THIS platform
```

`scripts\build-studio.bat` (Windows) runs all of the above in one go. The installers land in
`target/studio/cargo/release/bundle/` — NSIS exe + MSI on Windows, dmg on macOS, deb/rpm on
Linux. Icons, the webview assets and the default view config are generated by
`beforeBuildCommand`, so no separate step is needed.

## Command line (`ggs`)

The app installs a `ggs` command, like VS Code's `code`:

```sh
ggs                                   # open the app (last folder, as at a normal launch)
ggs .                                 # open the current directory
ggs <path>                            # open that folder (a file opens in single-file mode)
ggs --compare <a> <b>                 # open a text diff of two files (a binary pair opens
                                      #   the hex comparison)
ggs --hex <file>                      # open the file in the hex viewer
ggs --hex-compare <a> <b>             # open the address-aligned hex comparison of two files
ggs --folder-compare <a> <b>          # open two folders in the Folder Compare view
ggs --mcp [path]                      # serve that repository's symbol database over MCP (stdio)
ggs --help, ggs -h                    # show every launch form
```

The commands are flagged (`--`) the way `--mcp` is, so they can never be confused with the
path a plain `ggs <path>` launch opens. The comparison commands open the same tabs the
Explorer's "Compare Two Files/Folders" menu opens, in a window with no folder of its own; a
wrong count, a missing path or the wrong kind is reported on stderr (exit code 2) before any
window appears.

Every launch is its own window (the app is multi-instance): `ggs <path>` and the
comparison subcommands open in the window they started.

### MCP server (`ggs --mcp`)

`ggs --mcp <repository>` speaks the Model Context Protocol on stdio: an AI assistant's
bridge to the repository's symbol index — the same persistent database the app's Go to
Definition, Find References and Symbol Database page use. Five tools: `symbol_lookup`
(where is this declared), `symbol_references` (every whole-word occurrence as
`file:line:column`), `symbol_tree` (the per-file outline with per-symbol reference counts,
narrowable by a `path` prefix), `search_symbols` (name search) and `index_status` — plus the Code Analysis tools:
`analysis_call_graph`, `analysis_call_path`, `analysis_metrics`, `analysis_dead_code`,
`analysis_security` and `analysis_import_cycles`. The
index resumes from `~/.ggs/index/`, so the first start of a big repository is the slow
one. Configure a client (Claude Desktop, Cline, Cursor, …) with a stdio command entry
shaped like:

```json
{
	"mcpServers": {
		"ggs": { "command": "ggs", "args": ["--mcp", "C:\\path\\to\\your\\repo"] }
	}
}
```

The bundled binary itself is named `ggs` (`mainBinaryName` in
`src-tauri/tauri.conf.json`). The NSIS installer adds the install directory to
the user's `PATH` (`src-tauri/nsis-hooks.nsh`, removed again on uninstall); the
deb/rpm packages place it at `/usr/bin/ggs`. Already-open terminals keep their
old `PATH` — open a new one after installing. The MSI does not modify `PATH`;
use the NSIS setup for the command line.

## Cross-platform builds and releases

CI ([`studio.yml`](.github/workflows/studio.yml)) builds the installers — PRs run the tests
only; pushes to main and release runs build everything:

| Artifact | Built in/on | Compatibility |
| --- | --- | --- |
| `*_x64-setup.exe` (NSIS) + `*.msi` | windows-latest | Windows 10/11 x64 |
| `*_amd64.deb` | ubuntu-24.04 runner | Ubuntu 24.04–26.04, Debian 13+, Mint 22+, Pop!_OS 24.04+ |
| `*.x86_64.rpm` | ubuntu-24.04 runner | Fedora 40+, openSUSE Leap 16+/Tumbleweed |
| `*_aarch64.dmg` | macos-latest (arm64) | macOS 14+ arm64 (`full` adds the x64 dmg) |

The Linux installers are built natively on the pinned ubuntu-24.04 runner — the backend
tests gate the build, and both package formats bundle the one release compile — so the
binaries' floor is the runner's glibc 2.39; every distro above loads it. For the older floors (Ubuntu 22.04 /
Debian 12, Fedora 38 / openSUSE Leap 15.6) build locally in the pinned containers:
`scripts\build-studio-linux.bat` (deb) or `scripts\build-studio-linux.bat rpm` through
Docker Desktop — their base images are the oldest distros with WebKitGTK 4.1, **Tauri 2's
hard requirement, which Ubuntu 20.04 (WebKitGTK 4.0 only) can never satisfy**. Linux arm64
is not built (no arm64 WebKitGTK on the hosted runners).

To bump the app's own version between releases, change it in `package.json`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` together.

### Making a release

Push a version tag and [`release.yml`](.github/workflows/release.yml) does the rest: it
stamps the tag's version into every build, runs the whole pipeline, then publishes a GitHub
Release with all installers and a `SHA256SUMS` (auto-generated notes included):

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The same can be run from the Actions tab ("Release" → "Run workflow") with an explicit
version; the tag is then created at that commit.

## Notes

- `dev/dev-harness.html` — a dev-only page that runs the real workbench, in two modes: under
  `npm run dev` (tauri dev) at `http://localhost:5173/dev/dev-harness.html` it uses the real
  Tauri IPC bridge and Rust backend — the exact pipeline the packaged app runs, which is the
  only mode that can catch packaged-only regressions; opened in a plain browser
  (`npm run dev:vite`) it falls back to a scripted fake Tauri backend, good only for
  frontend behaviour jsdom tests cannot express (real layout and scrolling, the webview's
  Settings widget). A banner at the top states which mode is active. `vite build` only
  bundles `index.html`, so it never ships.
- Read path (commits, details, refs, config, statistics) runs entirely in-process through gix —
  no `git` child processes.
- Write operations from the Git Graph view (fetch, push, checkout, …) are refused with a pointer
  to the built-in terminal; the Source Control panel's own writes (stage/commit/discard) do shell
  out to `git`.

## License

The repository's own code is MIT ([LICENSE](LICENSE)). The built installers are more restricted
than that: they embed the Git Graph webview and the app icon, ported from Git Graph by mhutchie,
whose license does not permit distributing derivative works — read the *Git Graph webview and
built products* section of the [LICENSE](LICENSE) and
`vscode-git-graph-rs/licenses/LICENSE_GIT_GRAPH` before redistributing anything produced by
`npx tauri build`.
