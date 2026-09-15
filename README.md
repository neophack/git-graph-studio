# Git Graph Studio

A standalone desktop app that wraps the `git-graph-rs` engine (the `vscode-git-graph-rs/`
submodule's `native/core`) in a small VS Code-like shell: an Explorer file tree with git status colouring,
a Source Control panel (stage / unstage / discard / commit), an editor with tabs, a built-in
terminal (ConPTY on Windows), and the full Git Graph webview — the same `out.min.js` the
extension serves, hosted unchanged behind an `acquireVsCodeApi` shim.

## Layout

- `src/` — the shell frontend (Vite + TypeScript)
- `static/gitgraph/view.html` — the webview host page (loads `out.min.js` prepared from `vscode-git-graph-rs/media/`)
- `src-tauri/` — the Tauri 2 backend: filesystem commands, the graph message protocol
  (`cmd_graph.rs`, served by `git-graph-core` from `vscode-git-graph-rs/native/core` in-process), the SCM
  git-CLI write path, and the PTY
- `vscode-git-graph-rs/` — the `git-graph-rs` extension, a git submodule tracking its
  repository's `main` branch: the engine crate the app links, the webview assets it compiles
  (`npm run compile` there → `out/`, `media/`), and the manifest the baked-in contributions read

## Extensions (.ggx and VSIX)

Studio ships git-graph-rs as a **built-in `.ggx` package** — its own plugin format, frontend
and backend together (`docs/ggs-development-plan.md` §8.2): `scripts/build-ggx.mjs` packs the
webview assets (`web/`), the extension's manifest and resources, and **`git-graph-backend`**,
the engine and git runner as a separate process (`src-tauri/src/bin/git-graph-backend.rs`,
no Tauri, speaking the newline-JSON `ggx-rpc/1` protocol of `backend_rpc.rs`). `prepare.mjs`
drops it into `target/studio/bundled/`, `tauri.conf.json` bundles it as a resource, and on
first launch `cmd_ext.rs` unpacks it into `~/.ggs/extensions/` and `plugin_host.rs` starts the
backend; every request of the graph view then crosses to that process (git's command echo
streams back into the panel's Git channel), and the view page itself is loaded out of the
installed package. The built-in cannot be uninstalled, but installing a `.ggx` (or a VSIX)
with a **higher version upgrades it independently** of the app (a downgrade is refused) — the
backend restarts on the new binary at once. The same store serves any VSIX the user installs
by hand (Extensions view → "Install from VSIX or GGX...", or the Command Palette); the
Extensions page shows each package's format and, for a `.ggx`, its backend's pid, protocol
and last error with a Restart button.

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

`build-studio.bat` (Windows) runs all of the above in one go. The installers land in
`target/studio/cargo/release/bundle/` — NSIS exe + MSI on Windows, dmg on macOS, deb/rpm on
Linux. Icons, the webview assets and the default view config are generated by
`beforeBuildCommand`, so no separate step is needed.

## Cross-platform builds and releases

CI ([`studio.yml`](.github/workflows/studio.yml)) builds the installers — PRs run the tests
only; pushes to main and release runs build everything:

| Artifact | Built in/on | Compatibility |
| --- | --- | --- |
| `*_x64-setup.exe` (NSIS) + `*.msi` | windows-latest | Windows 10/11 x64 |
| `*_amd64.deb` | `ubuntu:22.04` container | Ubuntu 22.04–26.04, Debian 12/13, Mint 21+, Pop!_OS 22.04+ |
| `*.x86_64.rpm` | `fedora:38` container | Fedora 38+, openSUSE Leap 15.6+/Tumbleweed |
| `*_aarch64.dmg` | macos-latest (arm64) | macOS 14+ arm64 (`full` adds the x64 dmg) |

The Linux containers' base images ARE the compatibility floor: each is the oldest distro
that still has WebKitGTK 4.1 — **Tauri 2's hard requirement, which Ubuntu 20.04 (WebKitGTK
4.0 only) can never satisfy** — so the binaries' glibc baseline (2.35 deb / 2.37 rpm) loads
on every still-supported release above. Building on the runners directly would pin them to
the runner's newer glibc and break older distros. Linux arm64 is not built (no arm64
WebKitGTK on the hosted runners).

To build the Linux installers from Windows, `build-studio-linux.bat` runs the same
containers through Docker Desktop (`build-studio-linux.bat rpm` for the rpm pass).

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

- `dev-harness.html` — a dev-only page that runs the real workbench, in two modes: under
  `npm run dev` (tauri dev) at `http://localhost:5173/dev-harness.html` it uses the real
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
