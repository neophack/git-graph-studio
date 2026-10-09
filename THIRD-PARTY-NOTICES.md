# Third-Party Notices

The repository's own code is MIT ([LICENSE](LICENSE)). The components listed
below are bundled, statically linked or derived from, and remain governed by
their upstream licenses — this file keeps the notices those licenses require.

## npm packages bundled into the frontend

- CodeMirror 6 (`@codemirror/*`, `codemirror`, `@lezer/highlight`) — MIT.
- xterm.js (`@xterm/xterm`, `@xterm/addon-fit`) — MIT.
- The codicon set (`@vscode/codicons`) — MIT, Copyright (c) Microsoft Corporation.
- mermaid and `@mermaid-js/layout-elk` — MIT.
- `@tauri-apps/api` and the Tauri plugins — MIT OR Apache-2.0.

## Vendored assets

- `static/vendor/markdown-it.min.js` — markdown-it, MIT.

## Derived sources

- `src/fuzzy.ts`, ported from VS Code's `vs/base/common/fuzzyScorer.ts`, and
  the `--vscode-*` token values in `static/theme/`, which follow VS Code's
  theme definitions — Copyright (c) 2015 - present Microsoft Corporation, MIT.

## Rust backend

- The crates the backend links — MIT OR Apache-2.0; each crate's license text
  ships with it (see `cargo license` for the inventory of a given build).

## Extension packages carried by a build

- The extension packages `scripts/prepare.mjs` bundles (fetched from Open VSX,
  plus the local `extensions-src/claude-remote/` package) are separate works
  distributed under their own package licenses, which their `.vsix` files
  carry. They install into `~/.ggs/extensions/` beside the app, not into it.

The respective license texts are available in the upstream packages. If the
terms above ever conflict with an upstream license, the upstream license
prevails for its respective component.
