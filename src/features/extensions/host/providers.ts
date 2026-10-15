import type { FormatterSelector } from './sharedTypes';
// The language provider registries and their run paths (formatting, completions, hover, definition, file decorations) plus VS Code's selector scoring.

import type { ExtensionHost } from './extensionHost';

import { Channel } from '../../../platform/ipc/core';
import { writeFile } from '../../../platform/ipc/fs';
import { extChildEndStdin, extChildKill, type ExtChildEvent, extChildSpawn, extChildStopFor, extChildWrite, extNodeRuntimePath } from '../../../platform/ipc/extChild';
import { type ExtInfo, extInstallBundled, extInstallFromVsix, extList, extLoadCode, extLogPath, type NodeEnv, extNodeEnv, extPageFileChunk, extPageRevisionBytes, extReadFile, extStoragePaths, extUninstall, type StudioManifest } from '../../../platform/ipc/ext';
import { type ExtProcessInfo, extNodeRuntime, extProcessHostRespond, extProcessInvoke, extProcessPushEvent, extProcessRegistrations, extProcessRun, extProcessStart, extProcessStatus, extProcessStop } from '../../../platform/ipc/extProcess';
import { type GalleryEntry, extGalleryAsset, extGalleryFeatured, extGalleryInstall, extGalleryLookup } from '../../../platform/ipc/gallery';
import { extFs } from '../../../platform/ipc/ext';
import { listen } from '../../../platform/ipc/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { commands } from '../../../platform/commands';
import { applyContributions, applyExtensionSettings, declaredCommand, extensionSettingDefs, extensionThemeList, extensionViewContributions, languageIdFor, localize, registerContextProvider, registerExtensionSnippets, registerExtensionThemes, removeContributions, type ExtensionThemeDef, type ManifestContributes } from '../contributions';
import { describeDetail, extLog, extLogEnabled, extLogLevel, extLogOnce, flushExtLog, levelForConsole, setExtLogOutput, type ExtLogLevel } from '../extLog';
import { defaultNodeEnv } from '../../../hosts/extModuleLoader';
import type { EditorPlacement } from '../../editor/types';
import { setFileDiagnostics, type SerializableDiagnostic } from '../editorDiagnostics';
import { settings as appSettings, syncExtensionThemes, themeById } from '../../../platform/settings';
import { locale, registerZhCnText, t, tf } from '../../../platform/i18n';
import * as state from '../../../platform/state';
import { notify, progressToast, quickInput, type ProgressToast } from '../../../platform/ui/index';
import { extFileDataUrl, forgetExtDataUrls, imageMime } from '../../../platform/extAssets';
import { hook } from '../../../platform/hooks';
import type { SerializedTreeItem } from '../treeView';
import { answerChatPermission, answerChatQuestion, chatBusy, chatControls, interruptChat, pickChatModel, pressSend, setChatInput, setChatPermissionMode, type ChatAnswer } from '../claudeChatInject';



/** A glob against a forward-slash path (`**` across segments, `*` / `?` within one). */
function globMatches(pattern: string, path: string): boolean {
	let regex = '';
	for (let at = 0; at < pattern.length; at++) {
		const char = pattern[at]!;
		if (char === '*' && pattern[at + 1] === '*') {
			regex += '.*';
			at++;
			if (pattern[at + 1] === '/') at++;
		} else if (char === '*') regex += '[^/]*';
		else if (char === '?') regex += '[^/]';
		else if (char === '{') regex += '(?:';
		else if (char === '}') regex += ')';
		else if (char === ',') regex += '|';
		else regex += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
	}
	try {
		return new RegExp(`^${regex}$`, 'i').test(path);
	} catch {
		return false;
	}
}

/** VS Code's selector score for a file document: `language`, `scheme` and `pattern` must
 *  each match where declared (`*` scores lower than an exact language). */
export function formatterScore(selectors: FormatterSelector[], path: string, languageId: string): number {
	if (selectors.length === 0) return 1;
	const normalized = path.replace(/\\/g, '/');
	let best = 0;
	for (const selector of selectors) {
		let score = 0;
		if (selector.language !== undefined) {
			if (selector.language === '*') score = 5;
			else if (selector.language === languageId) score = 10;
			else continue;
		}
		if (selector.scheme !== undefined) {
			if (selector.scheme !== 'file' && selector.scheme !== '*') continue;
			score = Math.max(score, 5);
		}
		if (selector.pattern !== undefined && selector.pattern !== '') {
			const base = selector.base?.replace(/\\/g, '/').replace(/\/+$/, '');
			const relative = base && normalized.toLowerCase().startsWith(base.toLowerCase() + '/') ? normalized.slice(base.length + 1) : normalized;
			const pattern = selector.pattern.replace(/\\/g, '/');
			if (!globMatches(pattern, relative) && !globMatches(`**/${pattern.replace(/^\*\*\//, '')}`, relative)) continue;
			score = Math.max(score, 10);
		}
		best = Math.max(best, score);
	}
	return best;
}

/** The providers concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const providersMethods: ThisType<ExtensionHost> = {
	async extensionFileDecorations(paths: string[]): Promise<{ key: string; path: string; badge: string; color?: string; tooltip?: string }[]> {
		const out: { key: string; path: string; badge: string; color?: string; tooltip?: string }[] = [];
		for (const [registrationKey, registration] of this.fileDecorationProviders) {
			const frame = this.frames.get(registration.extId);
			if (!frame) continue;
			await this.ensureActive(registration.extId).catch(() => undefined);
			const answers = await this.callFrame(frame, 'fileDecorations.ask', [{ providerId: registration.id, paths }]).catch(() => ({})) as Record<string, { badge: string; color?: string; tooltip?: string } | null>;
			for (const [path, decoration] of Object.entries(answers)) {
				if (!decoration || !decoration.badge) continue;
				out.push({ key: registrationKey, path, badge: decoration.badge, color: decoration.color, tooltip: decoration.tooltip });
			}
		}
		this.extensionDecorations = out;
		return out;
	},

	async extensionHover(path: string, languageId: string, text: string, line: number, character: number): Promise<{ contents: string[]; range?: { start: { line: number; character: number }; end: { line: number; character: number } } } | null> {
		const ranked = [...this.hoverProviders.values()]
			.map((registration) => ({ registration, score: formatterScore(registration.selectors, path, languageId) }))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score);
		for (const { registration } of ranked) {
			await this.ensureActive(registration.extId).catch(() => undefined);
			try {
				const hover = await this.callFrame(registration.handle, 'hover.run', [registration.id, { path, languageId, text }, { line, character }]) as { contents: string[] } | null | undefined;
				if (hover && hover.contents.length > 0) return hover;
			} catch {
				// the next provider tries
			}
		}
		return null;
	},

	async extensionDefinition(path: string, languageId: string, text: string, line: number, character: number): Promise<{ path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number }[]> {
		const ranked = [...this.definitionProviders.values()]
			.map((registration) => ({ registration, score: formatterScore(registration.selectors, path, languageId) }))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score);
		for (const { registration } of ranked) {
			await this.ensureActive(registration.extId).catch(() => undefined);
			try {
				const locations = await this.callFrame(registration.handle, 'definition.run', [registration.id, { path, languageId, text }, { line, character }]) as { path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number }[] | undefined;
				if (locations && locations.length > 0) return locations;
			} catch {
				// the next provider tries
			}
		}
		return [];
	},

	async extensionCompletions(path: string, languageId: string, text: string, line: number, character: number, triggerCharacter?: string): Promise<{ label: string; kind?: number; detail?: string; documentation?: string; insertText?: string; sortText?: string; filterText?: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } } }[]> {
		const ranked = [...this.completionProviders.values()]
			.map((registration) => ({ registration, score: formatterScore(registration.selectors, path, languageId) }))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score);
		for (const { registration } of ranked) {
			await this.ensureActive(registration.extId).catch(() => undefined);
			try {
				const items = await this.callFrame(registration.handle, 'completion.run', [registration.id, { path, languageId, text }, { line, character }, { triggerCharacter }]) as { label: string; kind?: number; detail?: string; documentation?: string; insertText?: string; sortText?: string; filterText?: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } } }[] | undefined;
				if (items && items.length > 0) return items;
			} catch {
				// the next provider tries (an extension's dead frame yields to the rest)
			}
		}
		return [];
	},

	async formatDocument(path: string, languageId: string, text: string, tabSize: number, insertSpaces: boolean): Promise<boolean> {
		let lastError: string | null = null;
		// The providers ranked by their selector's score for this document (VS Code's
		// language / scheme / pattern rules); the best-matching one formats first.
		const ranked = [...this.formattingProviders.values()]
			.map((registration) => ({ registration, score: formatterScore(registration.selectors, path, languageId) }))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score);
		if (ranked.length === 0) extLog('info', 'host', `format document: no formatter matches ${languageId || 'this file'} (${path})`);
		for (const { registration } of ranked) {
			const extId = registration.extId;
			await this.ensureActive(extId).catch((error) => { lastError = String(error); });
			try {
				const edits = await this.callFrame(registration.handle, 'formatDocument.run', [registration.id, { path, languageId, text }, { tabSize, insertSpaces }]) as { range?: unknown; newText?: string }[] | undefined;
				if (edits && edits.length > 0) {
					const converted = edits.map((edit) => {
						const range = edit.range as { start?: { line: number; character: number }; end?: { line: number; character: number } } | undefined;
						return {
							startLine: (range?.start?.line ?? 0) + 1,
							startCharacter: range?.start?.character ?? 0,
							endLine: (range?.end?.line ?? 0) + 1,
							endCharacter: range?.end?.character ?? 0,
							newText: edit.newText ?? ''
						};
					});
					extLog('debug', extId, `formatter ${registration.id}: ${converted.length} edits for ${path}`);
					this.onApplyEdits?.(path, converted);
					return true;
				}
			} catch (error) {
				lastError = String(error);
				extLog('error', extId, `formatter ${registration.id} failed on ${path}: ${lastError}`, error instanceof Error ? error : undefined);
			}
		}
		if (lastError !== null) notify('warning', tf('extensions.commandFailed', 'editor.formatDocument', lastError), [{ label: t('extensions.showLog'), run: () => this.showLog() }]);
		return false;
	},
};
