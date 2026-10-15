// The frame-side halves of the webview surfaces: WebviewPanel (an editor tab)
// and WebviewView (a sidebar section). The host owns the tab/section and its
// iframe; these proxy html, title and messages.

import type { HostBridge, HostContext } from './bridge';
import { Disposable, EventEmitter } from './types/events';
import { ViewColumn } from './types/enums';
import { Uri } from './types/uri';

/** A live webview panel the extension created; the host owns the tab and the iframe, the
 *  frame-side half only proxies. Disposal arrives as a `webviewDisposed` host event. */
export class WebviewPanel {
	private titleValue: string;
	private htmlValue = '';
	private readonly disposed = new EventEmitter<void>();
	private readonly messages = new EventEmitter<unknown>();
	private readonly viewState = new EventEmitter<{ webviewPanel: unknown }>();
	gone = false;
	/** Built in the constructor body: it closes over the constructor's parameters, which
	 *  field initializers cannot (parameter properties initialize after them). */
	readonly webview: {
		options: Record<string, unknown>;
		html: string;
		postMessage(message: unknown): Promise<boolean>;
		onDidReceiveMessage(listener: (e: unknown) => unknown): Disposable;
		asWebviewUri(local: Uri | string): Uri;
		cspSource: string;
	};

	constructor(private readonly bridge: HostBridge, private readonly ctx: HostContext, readonly viewType: string, title: string, readonly options: Record<string, unknown>, readonly panelId: number) {
		this.titleValue = title;
		const self = this;
		this.webview = {
			options,
			get html(): string {
				return self.htmlValue;
			},
			set html(value: string) {
				self.htmlValue = value;
				void self.bridge.request('webview.setHtml', [self.panelId, value]);
			},
			postMessage: (message: unknown) => bridge.request('webview.postMessage', [panelId, message]).then(() => true) as Promise<boolean>,
			onDidReceiveMessage: this.messages.event,
			asWebviewUri: (local: Uri | string): Uri => {
				const path = typeof local === 'string' ? local : local.fsPath;
				// The extension path crosses with the host platform's separators (backslashes
				// on Windows) while the incoming path is forward-slash normalized — normalize
				// both or the root-prefix test fails and the whole absolute path is appended
				// to the resource base, a URL nothing serves.
				const root = this.ctx.extensionPath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
				const rel = path.replace(/\\/g, '/').startsWith(root + '/')
					? path.replace(/\\/g, '/').slice(root.length + 1)
					: path.replace(/\\/g, '/').replace(/^\.\//, '');
				return Uri.parse(this.ctx.webviewResourceBase + rel);
			},
			// `${cspSource}` composes the page's own CSP directives, so `data:` rides along: a
			// page inlining its icon font as a data: URL (claude-code's codicons) dies under
			// its own `font-src ${cspSource}` without it. (Both webview kinds carry it.)
			cspSource: this.ctx.webviewResourceBase + ' data:'
		};
	}

	get title(): string {
		return this.titleValue;
	}

	set title(value: string) {
		this.titleValue = value;
		void this.bridge.request('webview.setTitle', [this.panelId, value]);
	}

	private activeValue = true;

	get visible(): boolean {
		return !this.gone;
	}

	get active(): boolean {
		return !this.gone && this.activeValue;
	}

	/** The panel's tab became (in)active — VS Code's `onDidChangeViewState`. */
	setActive(active: boolean): void {
		if (this.gone || this.activeValue === active) return;
		this.activeValue = active;
		this.viewState.fire({ webviewPanel: this });
	}

	/** The tab icon an extension assigns (accepted; tabs show the package icon). */
	iconPath: Uri | { light: Uri; dark: Uri } | undefined;
	viewColumn: number | undefined = ViewColumn.One;

	readonly onDidDispose = this.disposed.event;
	readonly onDidChangeViewState = this.viewState.event;

	reveal(): void {
		if (!this.gone) void this.bridge.request('webview.reveal', [this.panelId]);
	}

	dispose(): void {
		if (this.gone) return;
		void this.bridge.request('webview.dispose', [this.panelId]);
		this.close();
	}

	/** The host confirmed the panel is gone (tab closed either way) — fire, exactly once. */
	close(): void {
		if (this.gone) return;
		this.gone = true;
		this.disposed.fire(undefined);
		this.disposed.dispose();
		this.messages.dispose();
		this.viewState.dispose();
	}

	receive(message: unknown): void {
		if (!this.gone) this.messages.fire(message);
	}
}

/** A sidebar webview view (`contributes.views` with `type: "webview"`, resolved through
 *  `registerWebviewViewProvider`): the host owns the section's iframe; this frame-side half
 *  proxies html, title and messages the way WebviewPanel does, plus the visibility events
 *  the sidebar's view switching produces. */
export class WebviewView {
	private titleValue = '';
	private descriptionValue = '';
	private htmlValue = '';
	private readonly messages = new EventEmitter<unknown>();
	private readonly visibilityChanged = new EventEmitter<{ visible: boolean }>();
	private readonly disposed = new EventEmitter<void>();
	private visibleValue = false;
	/** Set once the provider resolved it (a resolve is deferred to the first show). */
	resolved = false;
	gone = false;
	readonly webview: {
		options: Record<string, unknown>;
		html: string;
		postMessage(message: unknown): Promise<boolean>;
		onDidReceiveMessage(listener: (e: unknown) => unknown): Disposable;
		asWebviewUri(local: Uri | string): Uri;
		cspSource: string;
	};

	constructor(private readonly bridge: HostBridge, private readonly ctx: HostContext, readonly viewType: string, options: Record<string, unknown>) {
		const self = this;
		this.webview = {
			options,
			get html(): string {
				return self.htmlValue;
			},
			set html(value: string) {
				self.htmlValue = value;
				void self.bridge.request('webviewView.setHtml', [self.viewType, value]);
			},
			postMessage: (message: unknown) => bridge.request('webviewView.postMessage', [viewType, message]).then(() => true) as Promise<boolean>,
			onDidReceiveMessage: this.messages.event,
			asWebviewUri: (local: Uri | string): Uri => {
				const path = typeof local === 'string' ? local : local.fsPath;
				// The extension path crosses with the host platform's separators (backslashes
				// on Windows) while the incoming path is forward-slash normalized — normalize
				// both or the root-prefix test fails and the whole absolute path is appended
				// to the resource base, a URL nothing serves.
				const root = this.ctx.extensionPath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
				const rel = path.replace(/\\/g, '/').startsWith(root + '/')
					? path.replace(/\\/g, '/').slice(root.length + 1)
					: path.replace(/\\/g, '/').replace(/^\.\//, '');
				return Uri.parse(this.ctx.webviewResourceBase + rel);
			},
			// `${cspSource}` composes the page's own CSP directives, so `data:` rides along: a
			// page inlining its icon font as a data: URL (claude-code's codicons) dies under
			// its own `font-src ${cspSource}` without it. (Both webview kinds carry it.)
			cspSource: this.ctx.webviewResourceBase + ' data:'
		};
	}

	get title(): string {
		return this.titleValue;
	}

	set title(value: string) {
		this.titleValue = value;
		void this.bridge.request('webviewView.setTitle', [this.viewType, value]);
	}

	/** Send the current page again (a second frontend resolving the same view). */
	republish(): void {
		if (this.htmlValue !== '') void this.bridge.request('webviewView.setHtml', [this.viewType, this.htmlValue]);
	}

	get description(): string | undefined {
		return this.descriptionValue;
	}

	set description(value: string | undefined) {
		this.descriptionValue = value ?? '';
		void this.bridge.request('webviewView.setDescription', [this.viewType, this.descriptionValue]);
	}

	get visible(): boolean {
		return this.visibleValue;
	}

	/** The badge is an inert setter-accepting field: the sidebar sections do not render one. */
	badge: { text: string; tooltip?: string; command?: string } | undefined;

	readonly onDidChangeVisibility = this.visibilityChanged.event;

	/** VS Code's WebviewView carries it like a panel does; a provider that wires its cleanup
	 *  here (Claude Code's sessions list) threw "not a callable function" without it. */
	readonly onDidDispose = this.disposed.event;

	show(): void {
		// The section lives in the sidebar already; VS Code's show reveals it there.
		void this.bridge.request('webviewView.show', [this.viewType]);
	}

	dispose(): void {
		if (this.gone) return;
		this.gone = true;
		void this.bridge.request('webviewView.dispose', [this.viewType]);
		this.disposed.fire();
		this.messages.dispose();
		this.visibilityChanged.dispose();
		this.disposed.dispose();
	}

	/** The host pushed the view's visibility (its sidebar section selected or not). */
	setVisible(visible: boolean): void {
		if (this.visibleValue === visible) return;
		this.visibleValue = visible;
		this.visibilityChanged.fire({ visible });
	}

	receive(message: unknown): void {
		if (!this.gone) this.messages.fire(message);
	}
}
