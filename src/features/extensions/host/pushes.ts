// The workbench-to-frames pushes: active editor, theme, folders, the tab layout, document change/close/save and onLanguage opens.

import { ExtensionHost } from './extensionHost';

import { languageIdFor } from '../contributions';
import { themeById } from '../../../platform/settings';
import { hook } from '../../../platform/hooks';
import type { EditorTabSummary } from './sharedTypes';
import type { TabGroupsSnapshot, TabSnapshot } from '../../../hosts/vscodeApi/bridge';


const DOCUMENT_CHANGE_DEBOUNCE_MS = 300;

/** Tab changes arrive in bursts (one open re-renders every strip): one push per burst. */
const TABS_PUSH_DEBOUNCE_MS = 50;

/** A formatter's document filter as the shim sends it (plain data). */

/** The pushes concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const pushesMethods: ThisType<ExtensionHost> = {
	/** The editor area's tabs as `window.tabGroups` sees them: a group's column is its
	 *  position, a file is a text input, a diff its two files, and a webview panel's tab
	 *  carries the panel's `viewType` in VS Code's own `mainThreadWebview-` spelling (what
	 *  `TabInputWebview.viewType` answers there) plus the panel it shows. */
	tabGroupsSnapshot(): TabGroupsSnapshot {
		const inputOf = (id: string, input: EditorTabSummary['input']): TabSnapshot['input'] => {
			if (input === null) return null;
			if (input.kind === 'file') return { kind: 'text', path: input.path };
			if (input.kind === 'diff') return { kind: 'diff', original: input.original, modified: input.modified };
			const panelId = Number(id.slice(id.lastIndexOf(':') + 1));
			if (!Number.isFinite(panelId)) return null;
			const viewType = this.webviews.get(this.webviewKey(input.extId, panelId))?.viewType ?? '';
			return { kind: 'webview', viewType: `mainThreadWebview-${viewType}`, extId: input.extId, panelId };
		};
		return (this.tabGroupsSource?.() ?? []).map((group, index) => ({
			viewColumn: index + 1,
			active: group.active,
			activeId: group.activeId,
			tabs: group.tabs.map((tab) => ({ id: tab.id, label: tab.label, dirty: tab.dirty, input: inputOf(tab.id, tab.input) }))
		}));
	},

	/** The tab layout changed: every frame's `window.tabGroups` follows, coalesced, and
	 *  only when the layout really moved. A backend-hosted extension sees the desktop
	 *  window's tabs alone — its panels live there (ext_routing's WEBVIEW_HOME), and a
	 *  remote frontend pushing its own strips would swap the backend's picture of them. */
	noteTabsChanged(): void {
		if (this.tabsPushTimer !== null) return;
		this.tabsPushTimer = window.setTimeout(() => {
			this.tabsPushTimer = null;
			const tabs = this.tabGroupsSnapshot();
			const json = JSON.stringify(tabs);
			if (json === this.lastPushedTabs) return;
			this.lastPushedTabs = json;
			const main = hook('session').frontendClass() === 'main';
			for (const [extId, handle] of this.frames) {
				if (!main && this.backendHosted(extId)) continue;
				handle.send?.({ type: '__studioExtEvent', event: 'tabsChanged', tabs });
			}
		}, TABS_PUSH_DEBOUNCE_MS);
	},

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
