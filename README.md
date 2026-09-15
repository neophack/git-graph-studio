# Git Graph Studio

A standalone desktop app that wraps the `git-graph-rs` engine (the `vscode-git-graph-rs/`
submodule's `native/core`) in a small VS Code-like shell: an Explorer file tree with git status colouring,
a Source Control panel (stage / unstage / discard / commit), an editor with tabs, a built-in
terminal (ConPTY on Windows), and the full Git Graph webview — the same `out.min.js` the
extension serves, hosted unchanged behind an `acquireVsCodeApi` shim.

## Layout

```text
git-graph-studio/
├── index.html               the workbench window (Vite entry, loads src/main.ts)
├── ext-host.html            the sandboxed extension-host frame (second Vite entry, loaded by src/extHost.ts)
├── package.json             npm scripts: dev / build / test / typecheck / prepare:assets / measure
├── vite.config.ts           the workbench build: entries, chunking, the first-paint closure
├── vitest.config.ts         the test suite (jsdom + the baked contributions module)
├── tsconfig.json
│
├── src/                     the shell frontend, one module per workbench part
│                            (explorer, editor, scm, search, settings, terminal, the git
│                            graph host, the extension host, …)
├── static/                  static assets served as-is: gitgraph/view.html (the webview
│                            host page) and theme/*.css (the colour themes)
├── src-tauri/               the Rust backend — its own Cargo workspace
│   ├── src/                 the command modules (fs / scm / graph / search / extensions),
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
│   ├── build-ggx.mjs        packs the built-in .ggx extension package
│   ├── builtin-contributions.mjs  bakes the extension manifest's menus/commands into the bundle
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
                             (native/core), the webview assets it compiles (npm run compile
                             → out/, media/), and the manifest the baked contributions read
```

Everything generated — the Vite public dir and dist, the Cargo target, the installers, the
coverage and the metrics — lives under `target/studio/` (gitignored), never in the source
tree; `node_modules/` and the submodule's own build products stay where npm/cargo put them.

## Extensions (.ggx and VSIX)

git-graph-rs is **built in**: its engine (`git-graph-core`) is linked into the app and answers
the graph in-process through the single seam `src/graphHost.ts` ↔ `src-tauri/src/cmd_graph.rs`
(git's command echo for the write path streams into the panel's Git channel), and its webview
assets are assembled by `scripts/prepare.mjs` into the app's own public dir. The Extensions
view lists it as a built-in whose version follows the application; it cannot be uninstalled,
and an install of its id (from a `.vsix` or a `.ggx`) is refused — upgrading the graph means
upgrading the app (or the submodule it is built from).

Studio's extension store (`~/.ggs/extensions/<id>-<version>/`, a user-level directory like
`.vscode/extensions`) serves two package formats, installed by hand from local files
(Extensions view → "Install from VSIX or GGX...", or the Command Palette):

- **VSIX** — VS Code extensions whose `main` is a self-contained bundle (see the extension
  host below).
- **`.ggx`** — Studio's own format (`docs/ggs-development-plan.md` §8.2; the packer is
  `scripts/build-ggx.mjs`): a zip with a `manifest.json` header (`format: "ggx/1"`, id,
  version, the frontend page under `web/`) next to the VS Code-style `package.json` the
  Extensions view and the contribution points read.

A `.ggx` and a `.vsix` of the same id are the same extension; whichever has the higher version
wins, and a downgrade is refused. The Extensions page shows each package's format.

The Extensions view also parses each install's richer metadata — `displayName`, icon,
categories, repository, license, `engines.vscode`, `extensionDependencies` / `extensionPack` —
and a click opens a VS Code-style detail page as an editor tab: the icon and metadata header,
category chips, and the install's `README.md` / `CHANGELOG.md` rendered as markdown (the same
markdown-it bundle the Git Graph webview ships), with relative README images inlined as data
URLs via `ext_read_file_base64` and dangerous markup stripped.

What the extension host (`src/extHost.ts` + the sandboxed `ext-host.html` frame) supports:

- **Manifest contributions** (`src/contributions.ts`): every installed extension's
  `contributes.commands` (titles localized through `package.nls.json`), `contributes.keybindings`
  and the context menu locations Studio surfaces — `explorer/context`, `editor/context` and
  `editor/title/context` — are parsed and merged into the workbench (palette, keybindings,
  context menus), the built-in git-graph-rs included (its `git-graph-rs.view` dispatches to the
  workbench's Git Graph view). `when` clauses other than `"false"` are treated as matching.
- Extensions whose `main` is a **self-contained bundle** — `require()` only resolves
  `'vscode'`. Extensions that require other local files at runtime do not load.
- A subset of the `vscode` API (`src/vscodeApi.ts`): commands, messages/quick input,
  configuration (persisted per extension), `env.openExternal`, clipboard, and the common
  value types. Anything else (webview panels, tree views, `workspace.fs`, …) throws a clear
  "not supported" error.
- No Node native addons (`.node`) — the built-in git-graph-rs never runs here; the workbench
  hosts its webview and backend natively (`src/graphHost.ts` + `cmd_graph.rs`), so upgrades of
  it only refresh that path.
- No marketplace: installation and upgrades are manual, from local VSIX files.

## Build

Prerequisites: Rust 1.82+, Node.js, and the submodule compiled once:

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
  out to `git`, like the extension's CLI backend.
