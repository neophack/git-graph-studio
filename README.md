# Git Graph Studio

A standalone desktop app in the shape of a small VS Code-like shell: an Explorer file tree
with git status colouring, a Source Control panel (stage / unstage / discard / commit), an
editor whose split groups behave as VS Code's (Ctrl+\ family and the orthogonal cut, moving
editors between groups, spatial and sequential group focus, maximize, join, reset, and tab
drag-and-drop whose edge bands open the split they name — a split takes half of the source
group's space and a close hands it back proportionally), a built-in terminal (ConPTY on
Windows) — and an extension platform whose
packages are the store's own `.vsix` files (whose `package.json` may declare the Studio
capabilities under a `ggs` key: pages, a process backend, or an engine `.node` served over
its C ABI) — installed from the Extensions view (which also searches the **marketplace**:
Open VSX, the open-source registry the VS Code ecosystem publishes to — one-click install
and update, every package going through the same install rules a picked `.vsix` takes),
contributing commands to the palette and
menus, running their backends as warm sibling processes. The shell names no plugin: everything of the Git
Graph view — the engine (the extension's `native/core`, in its own repository outside this
tree), the view's
write path, its webview page and its comparison pages — lives in the **git-graph-rs** plugin
(its own standard VSIX build), and the app's own
git reads and writes run the `git` CLI with no plugin installed. The installers carry the
marketplace's per-architecture builds of the extension packages a release chose to pack:
**git-graph-rs** rides in every build (installed on first launch, like VS Code's bundled
extensions); **claude-code** rides in none by default — it installs from the Extensions
view's marketplace row on demand (a release form checkbox or `GGS_BUNDLE_CLAUDE_CODE=1`
can pack it). The Claude sidebar carries an **AI provider switcher**: run the official
Claude service or any Anthropic-compatible endpoint — DeepSeek, Zhipu GLM, Moonshot Kimi,
a custom gateway — with the API key AES-256-GCM sealed at rest under `~/.ggs/` and
decrypted only when the active provider is applied to Claude's redirected settings
`~/.ggs/claude` (whose own state — login, history — never touches `~/.claude`);
switching provider is one click on the view's
header chip or the **Model Providers** page, writes the choice into Claude's
redirected settings so the next new session uses it (a running conversation is never
interrupted), and the page also probes the endpoint (Test
Connection), pulls the gateway's model catalogue (NewAPI / OneAPI `/v1/models`), and
imports an existing **cc-switch** configuration (keys sealed on import, the one
cc-switch points at becoming active).

Code navigation rides a persistent symbol index (Source Insight's model): the workspace's
declarations and their occurrences indexed once under `~/.ggs/index/`, resumed on open and
updated file-by-file as files change — powering Go-to-Definition (with a list on ambiguous
names), Find References narrowed to the files that contain the word, Quick Open's `@`
(file symbols) and `#` (workspace symbols) modes, the Call Tree, and a Context Window panel
that shows the definition of the symbol under the cursor. The declarations are extracted by
a tree-sitter parser layer (one grammar per language, each behind a Cargo feature), so every
symbol carries its column, range, enclosing type and complexity.

The **Code Analysis** view (`Ctrl+Shift+A`, module 17) turns that parsed model into five
tools, each a streamed result page in the editor area: **Module Analysis** (the
workspace's cross-file calls as a gitdiagram-style architecture diagram — the backend
builds the model (gitdiagram's caps: 10 groups, 34 blocks, 48 arrows; the busiest
files as two-line cards inside their area's subgraph, one pastel tone per area, the
cycle's back edges dashed) and emits mermaid `flowchart TD` with its tone classDefs,
which the page renders with mermaid + the same ELK layout gitdiagram runs — nodes
cannot overlap — wrapped in a port of gitdiagram's viewer (wheel zoom, trackpad pan,
a fit-relative zoom toolbar, arrow-key panning), beside a collapsible tree of module → file → call site), **Complexity & Hotspots** (cyclomatic
complexity, size, nesting per function), **Dead Code** (declarations no call site in the
workspace spells), a rule-based **Security Scan** (hardcoded secrets, dangerous and
weak-crypto APIs, with CWE tags) and the **Import Graph** (file dependencies with import
cycles). The sidebar's sixth entry opens the **MCP Server** page: the connection
snippets (with copy buttons) for pointing an AI client at this repository through
`ggs --mcp`, the 15-tool catalogue, and the bridge's recent call log. The shell itself is themeable
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
│   ├── build.rs             Tauri codegen + the Rust seam check (nothing under src/ names the engine)
│   └── .cargo/config.toml   points the Cargo target at target/studio/cargo
│
├── tests/                   the vitest suite — jsdom with a scripted Tauri backend
│                            (tests/tauriMock.ts), no Rust and no compiled assets needed
├── dev/                     dev-only probe pages, never built and never shipped:
│   ├── dev-harness.html     the real workbench under the dev server (plain browser or tauri dev)
│   └── hex-probe.html       the hex view in isolation, against any theme
│
├── scripts/                 the build pipeline — every generated file lands in target/studio/
│   ├── prepare.mjs          assembles the public dir the app serves and packs the bundled
│   │                        extension packages (the marketplace's builds, fetched from Open VSX)
│   ├── check-seams.mjs      the compile-time seam rules (the app names no extension artifact)
│   ├── measure.mjs          exe/installer/dist size measurement + the backend probes
│   ├── *-stub.cjs           the vscode/Node stubs the config and compare bundles build against
│   ├── build-studio.bat     one-command Windows build (assets → tauri build)
│   ├── build-studio.sh      the same one-command build for macOS/Linux
│   ├── build-studio-linux.bat   the Linux installers through Docker (deb | rpm | shell)
│   ├── docker/              the Linux build containers
│   │   ├── Dockerfile.studio-linux    base image = the compatibility floor (see its header)
│   │   └── studio-linux-build.sh      the in-container half of the Linux build
│   └── probes/              benchmark and debugging probes against the packaged app
│       ├── boot-bench.mjs       end-to-end startup latency of the release exe
│       └── cdp-*.mjs            live inspection over WebView2's CDP port
│
├── docs/                    ggs-development-plan.md — the development plan
└── .github/workflows/       studio.yml (CI) · release.yml (tag → GitHub Release)
```

Everything generated — the Vite public dir and dist, the Cargo target, the installers, the
coverage and the metrics — lives under `target/studio/` (gitignored), never in the source
tree; `node_modules/` stays where npm put it.

## Build

Prerequisites: Rust 1.94+ and Node.js 20+:

```sh
npm install
npx tauri dev           # run the app
npx tauri build         # produce the installers for THIS platform
```

`scripts\build-studio.bat` (Windows) or `scripts/build-studio.sh` (macOS/Linux) runs all of
the above in one go. The installers land in
`target/studio/cargo/release/bundle/` — NSIS exe + MSI on Windows, dmg on macOS, deb/rpm on
Linux. Icons, the webview assets and the default view config are generated by
`beforeBuildCommand`, so no separate step is needed.

## Command line (`ggs`)

The app installs a `ggs` command, like VS Code's `code`:

```sh
ggs                                   # open the app (last folder, as at a normal launch)
ggs .                                 # open the current directory
ggs <path>                            # open that folder (a file opens in single-file mode;
                                       #   a .ggs-workspace file opens as the workspace)
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
comparison subcommands open in the window they started. Inside the app, **File → New
Window** (Ctrl/Cmd+Shift+N) opens another instance on every platform — the discoverable
way on macOS, where clicking the app's icon again only focuses the running window
(`open -n -a "Git Graph Studio"` does the same from the terminal). On macOS the **Dock
icon's right-click menu** carries a New Window entry too, and a Finder folder's
right-click lists the app under **打开方式 / Open With** (the bundle declares
`public.folder`): the folder opens in an empty window and wins a new one otherwise, and
a file opens like a drop would — a fresh install may need one logout/relogin before
Finder lists the new declaration. Instances are independent:
each spawns and owns its own extension backends, and the shared `~/.ggs` user data is
written atomically so concurrent instances cannot corrupt it.

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

Inside Git Graph Studio, the bundled Claude Code extension gets this without any
configuration: the app registers the same server (named `ggs`) into its redirected
Claude configuration (`~/.ggs/claude/settings.json`) for the open folder — removed
when no folder is open, your other servers and settings untouched — so `/mcp` in any
new session lists the symbol index and the analysis tools, and the server's
instructions teach the model the workflow (map a symbol's references and a change's
blast radius before editing, find hotspots and cycles while planning, self-check dead
code and secrets after). The MCP Server page shows the integration's state.

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
| `*_amd64.deb` | `ubuntu:22.04` container | Ubuntu 22.04–26.04, Debian 12/13, Mint 21+, Pop!_OS 22.04+ |
| `*.x86_64.rpm` | `fedora:38` container | Fedora 38+, openSUSE Leap 15.6+/Tumbleweed |
| `*_aarch64.dmg` | macos-latest (arm64) | macOS 14+ arm64 (`full` adds the x64 dmg) |

The Linux installers are built in pinned floor containers — the backend tests gate the
build, and each package format compiles in the oldest base that still has WebKitGTK 4.1,
**Tauri 2's hard requirement, which Ubuntu 20.04 (WebKitGTK 4.0 only) can never satisfy**:
the deb in `ubuntu:22.04` (glibc 2.35), the rpm in `fedora:38` (glibc 2.37), so every
distro from Ubuntu 22.04 / Debian 12 / Fedora 38 upward loads them — and the build itself
fails if the binary's glibc requirements ever exceed its container's floor. The same
containers build locally from Windows: `scripts\build-studio-linux.bat` (deb) or
`scripts\build-studio-linux.bat rpm` through Docker Desktop. Linux arm64 is not built (no
arm64 WebKitGTK on the hosted runners).

### Installing a macOS release

Without the Apple signing secrets (below) the dmg carries only the ad-hoc bundle seal, and
a **browser-downloaded** dmg is quarantined by macOS — Sequoia's Gatekeeper answers that
with the un-bypassable "*damaged, move it to the Trash*" dialog (the right-click → Open
and "Open Anyway" escapes only exist for apps a Developer ID has signed; Homebrew is no
way round either, since brew stamps its own quarantine onto every cask install). The
account-less install channel is the installer script — **curl sets no quarantine
attribute, so what it installs opens on the first click**, no manual `xattr -dr`:

```sh
curl -fsSL https://raw.githubusercontent.com/neophack/git-graph-studio/main/scripts/install-macos.sh | sh
```

It resolves the latest release, picks the arm64 / x64 dmg for the machine, verifies its
SHA256 against the release's `SHA256SUMS`, and copies the app to `/Applications` (or
`~/Applications` when that is not writable); pass a version (`scripts/install-macos.sh
0.1.7`) or set `GGS_INSTALL_DIR` to choose the target. The manual equivalent is
downloading the dmg with `curl -LO` yourself — the same effect, since only browsers
quarantine. Once the Developer ID and notarization secrets are configured, the
browser-downloaded dmg opens directly and the script becomes unnecessary.

### Code signing

Signing is decided from repository **secrets**, never from the sources:
[`scripts/signing.mjs`](scripts/signing.mjs) writes the `tauri build --config` merge each
installer build reads. With the secrets configured the installers are fully signed;
without them the builds degrade instead of failing — macOS to the ad-hoc bundle seal,
which a quarantined (browser-downloaded) copy meets as the un-bypassable *damaged*
verdict on Sequoia — right-click → Open is gone, and "Open Anyway" only ever applied to
signed-but-unnotarized apps — so [the installer script](#installing-a-macos-release) is
the account-less channel while no secrets exist; Windows and Linux degrade to unsigned
as before.

Generate the secret values from the local certificate files in one step — base64, the
signing identity derived from the P12, the GPG export — and `--apply` pushes them
straight into the repository through `gh secret set`:

```sh
node scripts/gen-signing-secrets.mjs \
  --p12 ~/certs/DeveloperID.p12 --p12-password … \
  --p8 ~/certs/AuthKey_XYZ.p8 --issuer <uuid> \
  --pfx ~/certs/codesign.pfx --pfx-password … \
  --gpg you@example.com --apply
```

Without `--apply` the values are printed (and written under `target/studio/secrets/`) to
paste into the secrets page by hand.

| Secret(s) | Effect when present |
| --- | --- |
| `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` + `APPLE_SIGNING_IDENTITY` | macOS installers signed with the Developer ID certificate |
| `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` + `APPLE_API_KEY` (the .p8's content) | …and notarized + stapled (no Gatekeeper dialog at all) |
| `WINDOWS_CERTIFICATE` (base64 PFX) + `WINDOWS_CERTIFICATE_PASSWORD` | NSIS/MSI Authenticode-signed (SHA-256, RFC 3161 timestamp) |
| `GPG_PRIVATE_KEY` (+ optional `GPG_PASSPHRASE`) | `SHA256SUMS.asc` — the detached signature every platform's download verifies against |

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

MIT ([LICENSE](LICENSE)). The third-party components the app bundles — and the
extension packages a build carries — remain under their own licenses; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
