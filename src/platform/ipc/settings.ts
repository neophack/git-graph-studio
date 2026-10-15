// The typed IPC seam of the user-data settings commands (plan §5.6): `~/.ggs/settings.json`
// and `~/.ggs/keybindings.json` as raw text — the parsed registries live in
// platform/settings.ts and platform/keybindings.ts, which own the merge with defaults.
import { invoke } from './core';

export const settingsRead = () => invoke<string | null>('settings_read');
export const settingsWrite = (contents: string) => invoke<void>('settings_write', { contents });
export const keybindingsRead = () => invoke<string | null>('keybindings_read');
export const keybindingsWrite = (contents: string) => invoke<void>('keybindings_write', { contents });
