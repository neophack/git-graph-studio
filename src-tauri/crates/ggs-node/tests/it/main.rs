//! The ggs-node package's integration suites, linked once (the same shape as the app
//! crate's tests/it): the runtime loop over a real ggs-ext/1 channel and the Boa
//! define-op repro bed. One binary matters here — the N-API host's exported surface
//! needs a live reference to stay in the image, and one link serves both suites.

mod node_runtime;
mod vscode_shim_boa;
