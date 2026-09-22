# git-graph-rs (the `.ggx` package's backend)

This folder is the git-graph-rs `.ggx` package's own build: `src/main.rs` is the
`git-graph-backend` binary (`src-tauri/Cargo.toml`'s `git-graph-backend` `[[bin]]`, the
`engine` Cargo feature) — the only place `git-graph-core` links; `git-graph-studio` (the app
itself) never does. `build.mjs` packs the finished `.ggx`, reading the `vscode-git-graph-rs`
submodule directly for the frontend and the extension manifest — the app's own build
(`scripts/prepare.mjs`) never reaches into that submodule for packaging; it just calls this
folder's `buildGgx()` and gets a finished package back, the same as it would for any plugin.

## Build

```sh
cargo build --release --bin git-graph-backend --no-default-features --features engine   # in src-tauri/
node plugins/git-graph-rs/build.mjs --backend <path-to-git-graph-backend[.exe]>
```

Or `scripts/build-plugins.bat` / `scripts/prepare.mjs`, which do both steps for every plugin
under `plugins/` in one pass. Without `--backend`, the package still packs — frontend-only,
same as before this plugin had a backend at all — and the Git Graph view reports "not
installed" for it until a backend-carrying package replaces it.

## Files

- `src/main.rs` — the backend: `backend_rpc::serve_backend`'s dispatch over
  `cmd_graph::engine_impl` (the engine reads) plus the `__`-prefixed synthetic commands
  `cmd_graph.rs`'s non-view callers send.
- `build.mjs` — the packer (`buildGgx`, `ggxManifest`), built on `scripts/build-ggx.mjs`'s
  shared zip-writing infrastructure.
- `package.json` — this folder's own metadata, not the packaged extension's manifest (that
  comes from `vscode-git-graph-rs/package.json`).
