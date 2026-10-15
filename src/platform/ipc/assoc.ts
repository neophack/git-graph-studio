// The typed IPC seam of the OS-integration commands (plan §5.6): file associations and
// the Explorer context-menu verb — the app crate's cmd_assoc halves. Both applies answer
// with a localisable `messageKey` (+ free-text `detail`) the caller renders through t().
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
