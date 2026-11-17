// The typed IPC seam of the OS-integration commands (plan §5.6): file associations,
// the Explorer context-menu verb, and the Windows taskbar jump list — the app crate's
// cmd_assoc halves. The two applies answer with a localisable `messageKey` (+ free-text
// `detail`) the caller renders through t(); the jump list answers nothing on success.
import { invoke } from './core';

/** One entry of the File Associations setting as `assoc_list_defaults` ranks them. */
export interface AssocDefault {
	ext: string;
	recommended: boolean;
}

/** The apply results: `messageKey` names an i18n key, `detail` a platform-rendered
 *  addition (the Default Apps hand-off on Windows explains itself this way). */
export interface AssocApplyResult {
	messageKey: string;
	detail: string;
}

export const assocListDefaults = () => invoke<AssocDefault[]>('assoc_list_defaults');
export const assocApply = (extensions: string[]) => invoke<AssocApplyResult>('assoc_apply', { extensions });
export const contextMenuApply = (on: boolean, label: string) => invoke<AssocApplyResult | null>('context_menu_apply', { on, label });
/** The taskbar's right-click jump list (Windows): `folders` — the recents, most recent
 *  first — become launch tasks beside the `newWindowLabel` blank-window task; every
 *  other platform answers without doing anything. Failures are swallowed by the sync
 *  caller (`state.syncJumpList`), the shell list just staying stale. */
export const jumpListApply = (folders: string[], newWindowLabel: string) => invoke<void>('jump_list_apply', { folders, newWindowLabel });
