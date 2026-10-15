// The shared type vocabulary of the extension host's concern modules: the frame
// and webview handles, the page and status shapes, the activation policy and the
// Claude tap records. A leaf module, so the concern files can share these without
// importing each other (docs/architecture-restructure-plan.md R5).

export interface ActivationPolicy {
	eager: boolean;
	commands: Set<string>;
	languages: Set<string>;
	views: Set<string>;
	workspaceContains: string[];
}

export interface ClaudeChatTicket {
	id: string;
	at: number;
	phase: 'opening' | 'typing' | 'answering' | 'requesting' | 'sent' | 'error';
	error: string | null;
	panelKey: string | null;
	sessionId: string | null;
	sentAt?: number;
	/** A remote-control toggle's captured answer: the state the chat page pushed back. */
	rc?: ClaudeRcState | null;
}

export interface ClaudeRcState {
	status: string;
	connectUrl: string | null;
	sessionUrl: string | null;
	bridgeEpoch: number | null;
	/** The CLI's own refusal text, when it refused the toggle (a third-party endpoint). */
	reason?: string;
}

export interface ClaudeTapSub {
	extId: string;
	/** Bounded batches of tap events, flushed to the subscriber one `claudeTap` push at a
	 *  time (up to 32 events per push, so a burst of stream deltas crosses as one). */
	queue: { dir: 'in' | 'out'; kind: string; panelId: number; sessionId: string | null; message: unknown }[];
	dropped: boolean;
	flushing: boolean;
}

export interface ExtStatusBarItem {
	id: string;
	alignment: number;
	/** VS Code's priority: higher sits further left within its alignment. */
	priority?: number;
	text: string;
	tooltip: string;
	command?: string;
	/** The arguments of a `Command`-object command (`{ command, arguments }`). */
	commandArgs?: unknown[];
	/** A colour or a theme colour id (`statusBarItem.errorForeground`, …). */
	color?: string;
	backgroundColor?: string;
	visible: boolean;
}

export interface FormatterSelector {
	language?: string;
	scheme?: string;
	pattern?: string;
	base?: string;
}

export interface FrameHandle {
	/** The host iframe. Absent on a remote handle: an extension whose program runs in a
	 *  real-Node host process (nodeHost.ts) has no frame — its calls and pushes cross the
	 *  ggs-ext/1 stdio channel instead (see `call` / `send`). */
	frame?: HTMLIFrameElement;
	/** True on a remote handle: the extension's program runs in a backend process whose
	 *  single JS thread parks inside every host request until this side's answer crosses
	 *  back over stdio. Anything this answer waits on must never call that process back —
	 *  the caller could not answer it. */
	remote?: boolean;
	/** Posts into the frame (set once it loaded its extension). */
	send?: (message: unknown) => void;
	/** A remote handle's call transport: the host's `__studioExtCall` vocabulary over the
	 *  backend's ggs-ext/1 channel instead of the frame's window messages. */
	call?: (method: string, args: unknown[]) => Promise<unknown>;
	/** Command ids this extension registered; unregistered when it goes away. */
	commandIds: Set<string>;
	/** The calls into the frame still waiting for their result: settled (rejected) when the
	 *  frame goes away, or a command that was running in it would wait forever and its
	 *  result listener never leave the window. */
	pendingCalls: Set<(error: Error) => void>;
}

export interface PageDiffRequest {
	id: string;
	title: string;
	repo?: string;
	binaryNotice?: boolean;
	left: { revision: string; path: string; label: string; exists: boolean; local?: boolean; content?: string };
	right: { revision: string; path: string; label: string; exists: boolean; local?: boolean; content?: string };
}

export interface PageFrameHandle {
	extId: string;
	pageId: string;
	frame: HTMLIFrameElement;
	/** Calls into the page still waiting for their result, settled when it goes away. */
	pendingCalls: Set<(error: Error) => void>;
}

export interface PageTheme {
	kind: 'vscode-dark' | 'vscode-light';
	label: string;
	css: string;
	vars: Record<string, string>;
}

export interface WebviewDelivery {
	/** The owning extension — every delivery record carries it (the composed boot pins its
	 *  asset base as the page's `_VSCODE_FILE_ROOT`, the root monaco-class worker loaders
	 *  resolve their module ids against). */
	extId: string;
	/** Set once the surface mounted it (the first `setHtml` may arrive first — it queues on
	 *  the surface's own `html`). */
	frame: HTMLIFrameElement | null;
	/** Messages the extension pushed while the page could not receive them — the page's
	 *  initial state rides the first pushes, and losing them is the blank-but-loaded
	 *  page: the mount (behind the tab icon's read on a first open) and the backend's
	 *  first postMessage race, and the loser used to vanish silently. Queued until the
	 *  page's own listeners exist (the frame's load event), then delivered in order. */
	pending: unknown[];
	/** The surface's current document (the latest setHtml, painted or pending). */
	html: string;
	/** Whether the frame's current document finished loading — a message posted before
	 *  that replaces the not-yet-navigated document (or precedes the page's listeners)
	 *  and vanishes; it queues instead. */
	loaded: boolean;
	/** The html last assigned to the frame — the document actually living there once its
	 *  load settles. "Already painted" means this equals `html`; a loaded-but-older
	 *  document (the grace expired between its load and a setHtml's coalescing window)
	 *  must still be replaced, or the page boots the stale shell and sits blank. */
	painted: string | null;
	/** The load event's grace timer: a document that just loaded holds its gate closed for
	 *  a moment, because the extension's next act is often either a push (must wait for the
	 *  gate — delivering into a fresh document early is fine, but a setHtml reload right
	 *  after the push would orphan the state into the replaced document) or the real
	 *  document's setHtml itself (the shell→document pair). */
	loadGrace: number | null;
	/** The first paint's coalescing timer: extensions deliver a shell document and the real
	 *  one in rapid pairs (claude-code: 24k then 27k chars within milliseconds), and painting
	 *  the shell boots the page just to be discarded by the second setHtml's reload — worse,
	 *  the shell's load event opens the message gate, so the page's initial state can be
	 *  delivered into the doomed shell document and the real one boots blank forever (the
	 *  intermittent empty new-session page). Holding the first paint ~80 ms paints one
	 *  document — the latest — and the state queues behind its load, where it belongs. */
	firstPaintTimer: number | null;
}

export interface WebviewHandle extends WebviewDelivery {
	panelId: number;
	title: string;
}

export type WebviewViewRecord = WebviewDelivery;

/** The owner id the extension host's own Output channel logs under. */
export const EXT_HOST_LOG_OWNER = 'ggs.extension-host';
