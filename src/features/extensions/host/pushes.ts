// The workbench-to-frames pushes: active editor, theme, folders, document change/close/save and onLanguage opens.

import { ExtensionHost } from './extensionHost';

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


const DOCUMENT_CHANGE_DEBOUNCE_MS = 300;

/** A formatter's document filter as the shim sends it (plain data). */

/** The pushes concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const pushesMethods: ThisType<ExtensionHost> = {
	noteActiveEditor(editor: { kind: string; path?: string; languageName?: string; line: number; column: number; selected?: number } | null): void {
		const info = editor !== null && editor.kind === 'file' && editor.path
			? { path: editor.path, languageId: languageIdFor(editor.path), line: editor.line, column: editor.column, selected: editor.selected }
			: null;
		let push: Record<string, unknown>;
		if (info === null) {
			push = { type: '__studioExtEvent', event: 'activeEditorChanged', editor: null };
		} else if (info.path === this.lastPushedDocument) {
			// Same document: strip the text — the frame already holds it.
			push = { type: '__studioExtEvent', event: 'activeEditorChanged', editor: { ...info, text: undefined } };
		} else {
			// The text crosses only when it exists: a push that raced the document's own
			// load must not record the path as pushed, or the text-bearing re-emission (the
			// editor's first status update after mount) is stripped as a "same document"
			// push and the frame never holds the content — a language client's didOpen
			// then syncs an empty body and no diagnostic ever lands.
			const text = this.activeText?.() ?? undefined;
			if (text !== undefined) this.lastPushedDocument = info.path;
			push = { type: '__studioExtEvent', event: 'activeEditorChanged', editor: { ...info, text } };
		}
		for (const handle of this.frames.values()) handle.send?.(push);
	},

	noteThemeChanged(): void {
		const kind = themeById().kind === 'vscode-light' ? 1 : 2;
		for (const page of this.pageFrames.values()) {
			page.frame.contentWindow?.postMessage({ __ggsHost: true, type: 'event', event: { kind: 'theme' } }, '*');
		}
		for (const handle of this.frames.values()) handle.send?.({ type: '__studioExtEvent', event: 'themeChanged', kind });
		void this.refreshWebviewTheme();
	},

	noteWorkspaceChanged(folders: string[]): void {
		ExtensionHost.workspaceFolders = folders;
		for (const page of this.pageFrames.values()) {
			page.frame.contentWindow?.postMessage({ __ggsHost: true, type: 'event', event: { kind: 'workspace', folders } }, '*');
		}
		// `workspace.workspaceFolders` / `onDidChangeWorkspaceFolders` in every extension.
		for (const handle of this.frames.values()) handle.send?.({ type: '__studioExtEvent', event: 'workspaceFoldersChanged', folders });
	},

	noteDocumentChanged(path: string, text: () => string): void {
		if (this.frames.size === 0) return;
		const pending = this.documentChangeTimers.get(path);
		if (pending !== undefined) clearTimeout(pending);
		this.documentChangeTimers.set(path, setTimeout(() => {
			this.documentChangeTimers.delete(path);
			const push = { type: '__studioExtEvent', event: 'documentChanged', path, languageId: languageIdFor(path), text: text() };
			for (const handle of this.frames.values()) handle.send?.(push);
		}, DOCUMENT_CHANGE_DEBOUNCE_MS));
	},

	noteDocumentClosed(path: string): void {
		const pending = this.documentChangeTimers.get(path);
		if (pending !== undefined) clearTimeout(pending);
		this.documentChangeTimers.delete(path);
		if (this.lastPushedDocument === path) this.lastPushedDocument = null;
		for (const handle of this.frames.values()) handle.send?.({ type: '__studioExtEvent', event: 'documentClosed', path });
	},

	noteDocumentSaved(path: string): void {
		const push = { type: '__studioExtEvent', event: 'documentSaved', path, languageId: languageIdFor(path) };
		for (const handle of this.frames.values()) handle.send?.(push);
		for (const page of this.pageFrames.values()) {
			page.frame.contentWindow?.postMessage({ __ggsHost: true, type: 'event', event: { kind: 'documentSaved', path, languageId: languageIdFor(path) } }, '*');
		}
	},

	noteLanguageOpened(fileName: string): void {
		const language = languageIdFor(fileName);
		if (!language) return;
		for (const [extId, policy] of this.activationPolicies) {
			if (policy.languages.has(language)) void this.ensureActive(extId);
		}
	},
};
