// The one door to Tauri's IPC surface (plan §5.6 / R6): `invoke`, `Channel`, `listen` and
// `emit` are re-exported here and nothing outside platform/ipc/ imports the packages
// directly — so the remote build's shim aliasing (vite.remote.config.ts) and the test
// mock (tests/tauriMock.ts) each have exactly one place to stand in for the real bridge.
// The per-domain files beside this one grow the typed wrappers as P5-4 migrates the
// callers; the command names there are the contract check-ipc.mjs compares against the
// backend's registration.

export { invoke, Channel } from '@tauri-apps/api/core';
export { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
