// Runs before every test file: the Tauri modules are replaced by tests/tauriMock.ts, the DOM
// gets the containers index.html provides, and jsdom's gaps (ResizeObserver, scrollIntoView,
// the config bundle) are filled in.

import { beforeEach, vi } from 'vitest';

import { backend, Channel, clipboard, dialog, invoke, listen, opener, windowApi } from './tauriMock';

vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/api/window', () => windowApi);
vi.mock('@tauri-apps/plugin-dialog', () => dialog);
vi.mock('@tauri-apps/plugin-opener', () => opener);
vi.mock('@tauri-apps/plugin-clipboard-manager', () => clipboard);
// xterm needs a real canvas; the terminal view is exercised through its session logic only.
vi.mock('@xterm/xterm', () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		written: string[] = [];
		/** Test hook: every terminal the view created, newest last. */
		constructor() { ((globalThis as unknown as { __xterms?: unknown[] }).__xterms ??= []).push(this); }
		private dataHandlers: ((data: string) => void)[] = [];
		private keyHandlers: (() => void)[] = [];
		private resizeHandlers: ((size: { cols: number; rows: number }) => void)[] = [];
		loadAddon(): void { /* no-op */ }
		open(element: HTMLElement): void { element.classList.add('xterm'); }
		write(text: string): void { this.written.push(text); }
		onData(handler: (data: string) => void): void { this.dataHandlers.push(handler); }
		onResize(handler: (size: { cols: number; rows: number }) => void): { dispose(): void } { this.resizeHandlers.push(handler); return { dispose: () => undefined }; }
		onKey(handler: () => void): { dispose(): void } { this.keyHandlers.push(handler); return { dispose: () => undefined }; }
		focus(): void { /* no-op */ }
		dispose(): void { /* no-op */ }
		/** The clipboard keys: the view's handler, a selection it can copy, and what it pasted. */
		keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
		selection = '';
		pasted: string[] = [];
		attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void { this.keyHandler = handler; }
		hasSelection(): boolean { return this.selection !== ''; }
		getSelection(): string { return this.selection; }
		paste(text: string): void { this.pasted.push(text); }
		/** Test hook: type into the terminal as the user would. */
		type(data: string): void { for (const h of this.dataHandlers) h(data); }
		pressKey(): void { for (const h of this.keyHandlers) h(); }
		/** Test hook: the shell's cell grid changed. */
		triggerResize(cols: number, rows: number): void { for (const h of this.resizeHandlers) h({ cols, rows }); }
	}
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void { /* no-op */ } } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@vscode/codicons/dist/codicon.css', () => ({}));

class ResizeObserverStub {
	observe(): void { /* no-op */ }
	disconnect(): void { /* no-op */ }
	unobserve(): void { /* no-op */ }
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
Element.prototype.scrollIntoView = () => undefined;
// jsdom has no layout engine, so Range coordinate APIs are missing; CodeMirror calls them from
// its rAF measure pass. Empty rects make it fall back to Element.getBoundingClientRect (zeroed in jsdom).
const emptyRectList: DOMRectList = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as DOMRectList;
Range.prototype.getClientRects = function (): DOMRectList { return emptyRectList; };
Range.prototype.getBoundingClientRect = function (): DOMRect { return new DOMRect(0, 0, 0, 0); };
(document as unknown as { execCommand: (name: string) => boolean }).execCommand = () => true;
// The Git Graph config bundle: a minimal stand-in that echoes the overrides into a config.
(window as unknown as { GitGraphStudioConfig: (settings: Record<string, unknown>) => Record<string, unknown> }).GitGraphStudioConfig = (settings) => ({
	graph: { colours: ['#0085d9', '#d9008f'], style: settings['graph.style'] === 'angular' ? 1 : 0, rowHeight: settings['graph.rowHeight'] ?? 24 },
	stickyHeader: settings['stickyHeader'] ?? true,
	signCommits: false,
	signTags: false,
	squashMergeMessageFormat: 0,
	squashPullMessageFormat: 0,
	overrides: settings
});

beforeEach(() => {
	backend.reset();
	(globalThis as unknown as { __xterms?: unknown[] }).__xterms = [];
	localStorage.clear();
	document.body.innerHTML = `
		<div id="titlebar"></div>
		<div id="workbench">
			<div id="activitybar"></div>
			<div id="sidebar"></div>
			<div id="sidebarSash" class="sash"></div>
			<div id="editorPart">
				<div id="editorGroup"></div>
				<div id="panelSash" class="sash" hidden></div>
				<div id="panel" hidden></div>
			</div>
		</div>
		<div id="statusbar"></div>
		<div id="notifications"></div>
		<div id="overlays"></div>`;
});
