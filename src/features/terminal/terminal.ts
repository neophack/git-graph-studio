// The Terminal view of the panel: xterm.js fronts over the backend's PTY sessions, with the
// view's actions (new / kill) and the terminal list on the right when more than one shell is
// open. The panel itself (tabs, maximize, hide) is panel.ts.
//
// The sessions are the INSTANCE's, not this frontend's (docs/ggs-remote-plan.md §8.6 #5):
// the terminal page mirrors `pty_list` — adopting the terminals that already run (the PC's,
// from a remote session; a terminal the phone opened, on the PC) and retiring the ones that
// died anywhere — so two frontends looking at the terminal see the same shells, never two
// private sets beside each other.

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import { ptyCreate, ptyKill, ptyList, ptyResize, ptyTail, ptyWrite, type PtySessionInfo } from '../../platform/ipc/pty';
import { listen, type UnlistenFn } from '../../platform/ipc/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

import { loadXterm } from '../../platform/lazy';

import { actionButton, el, icon, notify, showContextMenu, type MenuEntry } from '../../platform/ui/index';
import { THEME_EVENT, settings } from '../../platform/settings';
import { t } from '../../platform/i18n';
import { OutputFollow, FOLLOW_GRACE_MS } from './outputFollow';
import { planSessionSync, pickSessionId } from './sessionSync';
import { attachTerminalLinks, copyLinkFallback, type TerminalLinkController, type DetectedLink } from './links';
import { mountTerminalFindBar, type TerminalFindBar } from './findBar';

interface Session {
	id: number;
	name: string;
	term: Terminal;
	fit: FitAddon;
	/** The search addon the find bar drives (one per terminal). */
	search: SearchAddon;
	/** The link layer's controller: the hover state the context menu reads, and the
	 *  provider's disposal when the session goes away. */
	links: TerminalLinkController;
	element: HTMLElement;
	row: HTMLElement;
	exited: boolean;
	unlisten: UnlistenFn[];
	/** Adopted from the instance's list rather than created here (§8.6 #5): its death is
	 *  the list's to report, and this frontend's unload never kills it. */
	attached: boolean;
	/** The OUTPUT subscription, held apart from the lifetime listeners (the exit watch) so
	 *  the remote's page-follow (docs/remote-client-plan.md §6.6) can drop and re-take it
	 *  alone: a frontend not looking at the terminal page carries no terminal traffic. */
	outputUnlisten: UnlistenFn | null;
}

function cssVar(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The xterm theme from the current theme CSS's --vscode-terminal-* tokens. */
function terminalTheme(): Record<string, string> {
	return {
		background: cssVar('--vscode-terminal-background') || '#181818',
		foreground: cssVar('--vscode-terminal-foreground') || '#cccccc',
		cursor: cssVar('--vscode-terminalCursor-foreground') || '#ffffff',
		selectionBackground: cssVar('--vscode-terminal-selectionBackground') || '#264f78',
		black: cssVar('--vscode-terminal-ansiBlack'), red: cssVar('--vscode-terminal-ansiRed'),
		green: cssVar('--vscode-terminal-ansiGreen'), yellow: cssVar('--vscode-terminal-ansiYellow'),
		blue: cssVar('--vscode-terminal-ansiBlue'), magenta: cssVar('--vscode-terminal-ansiMagenta'),
		cyan: cssVar('--vscode-terminal-ansiCyan'), white: cssVar('--vscode-terminal-ansiWhite'),
		brightBlack: cssVar('--vscode-terminal-ansiBrightBlack'), brightRed: cssVar('--vscode-terminal-ansiBrightRed'),
		brightGreen: cssVar('--vscode-terminal-ansiBrightGreen'), brightYellow: cssVar('--vscode-terminal-ansiBrightYellow'),
		brightBlue: cssVar('--vscode-terminal-ansiBrightBlue'), brightMagenta: cssVar('--vscode-terminal-ansiBrightMagenta'),
		brightCyan: cssVar('--vscode-terminal-ansiBrightCyan'), brightWhite: cssVar('--vscode-terminal-ansiBrightWhite')
	};
}

/** A window event whose `detail` string is written to the active terminal's shell. */
export const TERMINAL_SEND_EVENT = 'ggs:terminal-send';

/** This page's session-id base: one crypto draw over half the backend's u32 id space
 *  (`pty_create`'s `id`), with the sign bit dropped. Two pages load two independent
 *  bases, so a same-number draw is a one-in-two-billion coincidence — the old 30-bit
 *  `Math.random` base collided with any live session about as often as it pleased, and
 *  a collision used to REPLACE (kill) the other page's shell. The degenerate
 *  environment's `Math.random` stand-in keeps the shape where `crypto` is absent. */
function drawIdBase(): number {
	const words = new Uint16Array(2);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(words);
	} else {
		words[0] = Math.floor(Math.random() * 0x1_0000);
		words[1] = Math.floor(Math.random() * 0x1_0000);
	}
	return ((words[0]! << 16) | words[1]!) >>> 1;
}

/** The instance's live session ids — the same `pty_list` the session sync mirrors. An
 *  unserved list (the dev harness's plain-browser mock answers unscripted commands with
 *  null) is an empty set: the backend's live-replacement refusal remains the guard. */
async function liveSessionIds(): Promise<Set<number>> {
	try {
		const list = await ptyList();
		return new Set((list ?? []).map((info) => info.id));
	} catch {
		return new Set();
	}
}

export class TerminalView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;
	private readonly host: HTMLElement;
	private readonly list: HTMLElement;
	private readonly sessions: Session[] = [];
	private active: Session | null = null;
	private readonly resizeTimers = new Map<number, number>();
	/** Unique across page reloads: the backend keys its sessions by this, and a reload must
	 *  not replace (and so close) the previous page's shells under the same numbers. The
	 *  base is a crypto draw (`drawIdBase`) and every spawn re-checks the live list
	 *  (`nextFreeId`), so two pages never meet on one number. */
	private nextId = drawIdBase();
	private visible = false;
	/** One sync at a time; events landing mid-sync queue one re-run (a burst of
	 *  sessions-changed must not adopt the same terminal twice). */
	private syncing: Promise<void> | null = null;
	private syncQueued = false;
	/** §6.6's page-follow state machine: the sessions' output subscriptions live only
	 *  while this frontend looks at the terminal page (the remote's terminalFollow drives
	 *  it; the desktop never calls setFollowing(false)). */
	private readonly follow = new OutputFollow<Session>({
		sessions: () => this.sessions,
		subscribe: (session, catchUp) => this.subscribeOutput(session, catchUp),
		drop: (session) => this.dropOutput(session)
	});

	/** The user pressed Enter in a shell: the repository may have changed. */
	onCommandEntered: (() => void) | null = null;
	/** The last shell was closed: the panel may want to hide. */
	onEmpty: (() => void) | null = null;
	/** A ctrl+clicked file link asks to open: the wiring resolves the raw path (MSYS
	 *  `/c/...`, workspace-relative) against its own workspace and lands it in an editor
	 *  group. Unwired frontends (the remote shell has no editor group) copy the path
	 *  instead — the desktop window wires this from the boot path. */
	onOpenFile: ((path: string, line?: number, column?: number) => void) | null = null;
	/** The find bar, mounted on first Ctrl+F and kept for the view's lifetime (it serves
	 *  whichever session is active through its delegates). */
	private find: TerminalFindBar | null = null;

	constructor() {
		this.actions = el('div', 'actions', [
			actionButton('plus', 'New Terminal', () => void this.create()),
			actionButton('trash', 'Kill Terminal', () => void this.kill())
		]);
		this.host = el('div', 'terminal-host');
		this.list = el('div', 'terminal-tabs');
		this.list.hidden = true;
		this.element = el('div', 'panel-body', [this.host, this.list]);
		// The DOM measure is coalesced to one fit per animation frame - a resize drag fires
		// the observer per layout, and only the last one per frame matters (the expensive
		// ConPTY side is separately debounced in session.resize()).
		let fitPending = 0;
		new ResizeObserver(() => {
			if (!this.visible || !this.active || fitPending) return;
			fitPending = requestAnimationFrame(() => {
				fitPending = 0;
				if (this.visible && this.active) this.active.fit.fit();
			});
		}).observe(this.host);
		// A page reload (dev hot reload) would otherwise leave the shells running unattached.
		// An ADOPTED terminal is not this frontend's to kill (§8.6 #5): the PC's shell stays
		// when the phone's page reloads.
		window.addEventListener('beforeunload', () => {
			for (const session of this.sessions) if (!session.attached) void ptyKill(session.id);
		});
		// The instance's terminal set changed — a terminal opened or died anywhere (the
		// PC's window, another remote session, this frontend): mirror it while this page is
		// being looked at (§6.6 keeps the traffic away otherwise).
		void listen('studio://pty-sessions-changed', () => {
			if (this.visible) void this.syncSessions();
		});
		// Keys from outside the terminal's own keyboard — the phone's extra key row (Esc,
		// Tab, Ctrl+…, arrows; src/remote/terminalKeys.ts) — go to the active shell as is.
		window.addEventListener(TERMINAL_SEND_EVENT, (event) => {
			const data = (event as CustomEvent<string>).detail;
			const session = this.active;
			if (!session || session.exited || typeof data !== 'string') return;
			void ptyWrite(session.id, data);
			session.term.focus();
		});
		// A theme switch retints the running terminals once the new stylesheet has loaded.
		window.addEventListener(THEME_EVENT, () => {
			const theme = terminalTheme();
			for (const session of this.sessions) session.term.options.theme = theme;
		});
	}

	/** The view became visible: mirror the instance's terminals first — a remote session
	 *  adopts the PC's instead of spawning a private shell beside them — and only an
	 *  instance with none running gets a fresh one. */
	async shown(): Promise<void> {
		this.visible = true;
		await this.syncSessions();
		if (this.sessions.length === 0) {
			await this.create();
		} else {
			this.activate(this.active ?? this.sessions[0]!);
		}
	}

	hidden(): void {
		this.visible = false;
	}

	sessionCount(): number {
		return this.sessions.length;
	}

	newTerminal(): Promise<void> {
		return this.create();
	}

	killActive(): Promise<void> {
		return this.kill();
	}

	/** Type a command into the active shell (the graph's interactive rebase / difftool;
	 *  an extension's `sendText` too). `pressEnter === false` writes the text alone —
	 *  VS Code's `addNewLine: false`, text without the Enter. */
	async run(command: string, pressEnter = true): Promise<void> {
		if (!this.active || this.active.exited) await this.create();
		const session = this.active;
		if (!session || session.exited) return;
		await ptyWrite(session.id, pressEnter ? command + '\r' : command);
		session.term.focus();
	}

	/** Open the find bar over the active shell (`terminal.find`, Ctrl+F inside the shell). */
	showFind(): void {
		if (!this.find) {
			this.find = mountTerminalFindBar(this.host, {
				term: () => this.active?.term ?? null,
				search: () => this.active?.search ?? null,
				focusTerminal: () => this.active?.term.focus()
			});
		}
		this.find.open();
	}

	/** Clear the active shell's viewport (`terminal.clear`; the scrollback the backend's
	 *  tail replays is not the term's buffer and stays). */
	clearActive(): void {
		const session = this.active;
		if (!session) return;
		session.term.clear();
		session.term.focus();
	}

	/** Select the active shell's whole buffer (`terminal.selectAll`). */
	selectAllActive(): void {
		const session = this.active;
		if (!session) return;
		session.term.selectAll();
		session.term.focus();
	}

	/** Run the selection in the active shell (`terminal.runSelectedText`): the selected
	 *  text crosses the same write path typing uses, a `\r` after it. Nothing selected —
	 *  nothing sent. */
	async runSelectedText(): Promise<void> {
		const session = this.active;
		if (!session || session.exited || !session.term.hasSelection()) return;
		await this.run(session.term.getSelection());
	}

	focus(): void {
		this.active?.term.focus();
	}

	/* ---------- The session sync (§8.6 #5) ---------- */

	/** Mirror the instance's terminal list into this view: adopt what appeared, retire what
	 *  died. One run at a time; a change landing mid-sync queues a re-run. */
	syncSessions(): Promise<void> {
		if (this.syncing) {
			this.syncQueued = true;
			return this.syncing;
		}
		this.syncing = this.runSync().finally(() => {
			this.syncing = null;
			if (this.syncQueued) {
				this.syncQueued = false;
				void this.syncSessions();
			}
		});
		return this.syncing;
	}

	private async runSync(): Promise<void> {
		let backendSessions: PtySessionInfo[];
		try {
			backendSessions = await ptyList();
		} catch {
			return; // the command cannot be served right now — the next event retries
		}
		if (!Array.isArray(backendSessions)) return; // a degenerate answer (the dev harness's
		// plain-browser mock answers unscripted commands with null) is no session set
		const plan = planSessionSync(this.sessions, backendSessions);
		for (const session of plan.retire) void this.remove(session);
		for (const info of plan.adopt) await this.adopt(info);
	}

	/* ---------- Sessions ---------- */

	/** One xterm instance's shared construction — the theme, the clipboard keys, the link
	 *  layer, the find addon, the right-click menu — everything a created and an adopted
	 *  session need alike. */
	private async makeTerm(): Promise<{ term: Terminal; fit: FitAddon; search: SearchAddon; links: TerminalLinkController; element: HTMLElement }> {
		// xterm is an async chunk: the first terminal pays for its load, the workbench never does.
		const { Terminal, FitAddon, SearchAddon } = await loadXterm();
		const term = new Terminal({
			fontFamily: cssVar('--vscode-editor-font-family') || 'Menlo, Consolas, monospace',
			fontSize: settings.terminalFontSize,
			lineHeight: 1,
			cursorBlink: true,
			cursorStyle: 'bar',
			scrollback: settings.terminalScrollback,
			allowProposedApi: true,
			theme: terminalTheme()
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		const search = new SearchAddon();
		term.loadAddon(search);
		const element = el('div', 'terminal-instance');
		this.host.appendChild(element);
		term.open(element);
		// VS Code's terminal clipboard keys: Ctrl+Shift+C copies the selection, Ctrl+Shift+V
		// pastes, and Ctrl+C copies too while text is selected (the interrupt goes to the
		// shell only with nothing selected). Ctrl+Insert / Shift+Insert are VS Code's other
		// copy/paste pair, and Ctrl+F opens the find bar (plain Ctrl+Shift+F stays the
		// workbench's Search view). They stop here so the workbench's own bindings (the
		// Markdown preview on Ctrl+Shift+V, the editor's find on Ctrl+F) never answer while
		// a terminal is focused.
		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== 'keydown' || event.altKey) return true;
			const ctrl = event.ctrlKey || event.metaKey;
			const key = event.key.toLowerCase();
			// Shift+Insert needs no ctrl: let it through this guard, nothing else without it.
			if (!ctrl && !(event.shiftKey && event.key === 'Insert')) return true;
			if (key === 'c' && (event.shiftKey || term.hasSelection())) {
				if (term.hasSelection()) void writeText(term.getSelection()).catch(() => undefined);
				event.preventDefault();
				event.stopPropagation();
				return false;
			}
			if (key === 'v' && event.shiftKey) {
				void readText().then((text) => { if (text) term.paste(text); }).catch(() => undefined);
				event.preventDefault();
				event.stopPropagation();
				return false;
			}
			if (ctrl && !event.shiftKey && key === 'f') {
				this.showFind();
				event.preventDefault();
				event.stopPropagation();
				return false;
			}
			if (event.key === 'Insert' && ctrl && !event.shiftKey) {
				if (term.hasSelection()) void writeText(term.getSelection()).catch(() => undefined);
				event.preventDefault();
				event.stopPropagation();
				return false;
			}
			if (event.key === 'Insert' && event.shiftKey && !ctrl) {
				void readText().then((text) => { if (text) term.paste(text); }).catch(() => undefined);
				event.preventDefault();
				event.stopPropagation();
				return false;
			}
			return true;
		});
		// VS Code's terminal.integrated.copyOnSelect: the selection lands on the clipboard
		// as soon as it is made.
		term.onSelectionChange(() => {
			if (!settings.terminalCopyOnSelect || !term.hasSelection()) return;
			void writeText(term.getSelection()).catch(() => undefined);
		});
		// The link layer: every URL and path a shell prints hovers underlined, and a
		// ctrl+click opens it — a URL through the opener, a file path through the window's
		// own `onOpenFile` wiring (unwired shells copy the path instead).
		const links = attachTerminalLinks(term, {
			openUrl: (url) => {
				void openUrl(url).catch((error) => notify('error', String(error)));
			},
			openFile: (path, line, column) => {
				if (this.onOpenFile) this.onOpenFile(path, line, column);
				else void copyLinkFallback(path).catch(() => undefined);
			}
		});
		// The right mouse button follows the Terminal Right-Click setting (VS Code's
		// terminal.integrated.rightClickBehavior): the menu by default, smart copy/paste
		// (copy the selection, paste with none), plain paste, or swallowed. The
		// workbench's catch-all (main.ts) already keeps the browser's own menu down.
		element.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			event.stopPropagation();
			const behavior = settings.terminalRightClickBehavior;
			if (behavior === 'nothing') return;
			if (behavior === 'paste' || (behavior === 'copyPaste' && !term.hasSelection())) {
				void readText().then((text) => { if (text) term.paste(text); }).catch(() => undefined);
				return;
			}
			if (behavior === 'copyPaste') {
				void writeText(term.getSelection()).catch(() => undefined);
				term.clearSelection();
				return;
			}
			// A link under the cursor leads the menu: the two actions that speak for it.
			const link: DetectedLink | null = links.hoveredLink();
			const entries: MenuEntry[] = [];
			if (link) {
				entries.push(
					{ label: t('terminal.menu.openLink'), run: () => { links.open(link); term.focus(); } },
					{ label: t('terminal.menu.copyLink'), run: () => { links.copy(link); term.focus(); } },
					'separator'
				);
			}
			entries.push(
				{ label: t('terminal.menu.copy'), keybinding: 'Ctrl+Shift+C', disabled: !term.hasSelection(),
					run: () => { void writeText(term.getSelection()).catch(() => undefined); term.focus(); } },
				{ label: t('terminal.menu.paste'), keybinding: 'Ctrl+Shift+V',
					run: () => { void readText().then((text) => { if (text) term.paste(text); }).catch(() => undefined); term.focus(); } },
				{ label: t('terminal.menu.selectAll'), run: () => { term.selectAll(); term.focus(); } },
				'separator',
				{ label: t('terminal.menu.clear'), run: () => { term.clear(); term.focus(); } }
			);
			showContextMenu(event.clientX, event.clientY, entries);
		});
		return { term, fit, search, links, element };
	}

	/** The lifetime listeners every session carries from birth: its shell's exit, and the
	 *  shared geometry's changes (another frontend resized the terminal — §8.6 #5 — and
	 *  this one deforms along; the echo back is a same-size resize the backend ignores). */
	private async wireLifetime(session: Session): Promise<void> {
		session.unlisten.push(await listen(`studio://pty-exit-${session.id}`, () => {
			session.exited = true;
			session.term.write('\r\n\x1b[90m[The terminal process has exited. Press any key to close it.]\x1b[0m\r\n');
			const disposable = session.term.onKey(() => {
				disposable.dispose();
				void this.remove(session);
			});
			this.renderList();
		}));
		session.unlisten.push(await listen<{ cols: number; rows: number }>(`studio://pty-resized-${session.id}`, (event) => {
			const size = event.payload;
			if (typeof size?.cols !== 'number' || typeof size?.rows !== 'number') return;
			if (size.cols !== session.term.cols || size.rows !== session.term.rows) {
				session.term.resize(size.cols, size.rows);
			}
		}));
	}

	/** The live wiring every session gets once its shell exists: keys write the shell, a
	 *  resize rides the debounced `pty_resize` (the shared terminal's geometry follows the
	 *  frontmost viewport, §8.6 #5). */
	private wireShared(session: Session): void {
		session.term.onData((data) => {
			void ptyWrite(session.id, data);
			if (data.includes('\r')) window.setTimeout(() => this.onCommandEntered?.(), 800);
		});
		session.term.onResize(({ cols, rows }) => this.resize(session.id, cols, rows));
	}

	/** One new shell. `cwd` spawns it IN the folder (the Explorer's "Open in Integrated
	 *  Terminal"); without one the backend opens it at the workspace root, the plain
	 *  new-terminal behavior. */
	async create(cwd?: string): Promise<void> {
		const { term, fit, search, links, element } = await this.makeTerm();
		const id = await this.nextFreeId();
		const row = el('div', 'row');
		const session: Session = { id, name: 'shell', term, fit, search, links, element, row, exited: false, unlisten: [], outputUnlisten: null, attached: false };
		this.sessions.push(session);
		this.activate(session);
		fit.fit();

		// The lifetime listeners go up BEFORE the shell starts: its first prompt arrives
		// within milliseconds of the spawn and would otherwise be lost. The output listener
		// rides the page-follow instead (subscribeOutput) — its first take is here, before
		// the spawn, for exactly the same reason.
		await this.wireLifetime(session);
		await this.subscribeOutput(session, false).then(() => {
			// A session spawned while the page is away (§6.6) starts without its output
			// subscription: the next return takes it with the tail catch-up.
			if (!this.follow.shouldSubscribeNew()) this.dropOutput(session);
		});

		let shellName: string;
		try {
			// The Terminal Shell setting rides every creation, so a Settings change reaches
			// the next terminal without a restart.
			shellName = await ptyCreate(id, term.cols, term.rows, settings.terminalShell, cwd);
		} catch (error) {
			notify('error', String(error));
			term.write(`\x1b[31m${String(error)}\x1b[0m\r\n`);
			session.exited = true;
			this.renderList();
			return;
		}
		session.name = shellName;
		this.wireShared(session);
		this.renderList();
		term.focus();
	}

	/** The next session id of this page: the random base stepped past every id the
	 *  instance's live list holds (`pickSessionId`), so a spawn never asks the backend
	 *  for a number a running shell — this page's own, another window's, an adopted
	 *  one — already owns. The backend refuses a live replacement regardless; the check
	 *  keeps that refusal unobservable. */
	private async nextFreeId(): Promise<number> {
		const id = pickSessionId(this.nextId, await liveSessionIds());
		this.nextId = id + 1;
		return id;
	}

	/** Adopt a terminal the instance already runs (§8.6 #5): the PC's shell, its 64 KB
	 *  tail replayed, its output followed live, its input shared — never a second shell
	 *  spawned beside it. */
	private async adopt(info: PtySessionInfo): Promise<void> {
		const { term, fit, search, links, element } = await this.makeTerm();
		const row = el('div', 'row');
		const session: Session = {
			id: info.id, name: info.name || 'shell', term, fit, search, links, element, row,
			exited: false, unlisten: [], outputUnlisten: null, attached: true
		};
		this.sessions.push(session);
		// Adoption never steals the active terminal — the first one into an empty view is
		// the active one, later arrivals take their row.
		if (!this.active) this.activate(session);

		await this.wireLifetime(session);
		this.wireShared(session);
		await this.subscribeOutput(session, true).then(() => {
			if (!this.follow.shouldSubscribeNew()) this.dropOutput(session);
		});
		// §8.6 #5: the attacher's viewport governs the shared geometry — fit resizes the
		// session when it differs, and every other frontend showing it deforms along.
		fit.fit();
		this.renderList();
	}

	/** Resizing a ConPTY is expensive, and a sash drag crosses a cell boundary many times in a
	 *  row - only the last of a burst of resizes is sent to the backend. */
	private resize(id: number, cols: number, rows: number): void {
		const previous = this.resizeTimers.get(id);
		if (previous !== undefined) window.clearTimeout(previous);
		this.resizeTimers.set(id, window.setTimeout(() => {
			this.resizeTimers.delete(id);
			void ptyResize(id, cols, rows).catch(() => undefined);
		}, 100));
	}

	/** Take a session's output subscription. `catchUp` (a return after the subscription was
	 *  actually dropped) repaints from the backend's 64 KB tail first — the buffer still
	 *  holds the older half of it, and appending would duplicate every line. The
	 *  subscription goes up BEFORE the tail is fetched, holding what arrives while the
	 *  snapshot is in flight: the old order (tail, then listen) lost every byte that
	 *  crossed the gap between the snapshot and the subscription. */
	private async subscribeOutput(session: Session, catchUp: boolean): Promise<void> {
		if (session.outputUnlisten || session.exited) return;
		if (!catchUp) {
			session.outputUnlisten = await listen<string>(`studio://pty-output-${session.id}`, (event) => session.term.write(event.payload));
			return;
		}
		const held: string[] = [];
		let holding = true;
		const unlisten = await listen<string>(`studio://pty-output-${session.id}`, (event) => {
			if (holding) held.push(event.payload);
			else session.term.write(event.payload);
		});
		session.outputUnlisten = unlisten;
		session.term.reset();
		try {
			session.term.write(await ptyTail(session.id));
		} catch {
			/* the session died while away: the exit listener owns that */
		}
		holding = false;
		for (const chunk of held) session.term.write(chunk);
	}

	private dropOutput(session: Session): void {
		session.outputUnlisten?.();
		session.outputUnlisten = null;
	}

	/** §6.6 (the remote terminal page): whether THIS frontend is looking at the terminal
	 *  page. The follow state machine owns the grace and the catch-up; the desktop panel
	 *  never calls this with false (its terminals are always local). `graceMs` is the
	 *  tests' dial (the remote's own driver rides the default). */
	setOutputFollow(following: boolean, graceMs: number = FOLLOW_GRACE_MS): void {
		this.follow.setFollowing(following, graceMs);
	}

	/** Whether a session's output subscription is held (the page-follow tests' seam). */
	outputSubscribed(id: number): boolean {
		return this.sessions.some((session) => session.id === id && session.outputUnlisten !== null);
	}

	private activate(session: Session): void {
		this.active = session;
		for (const other of this.sessions) other.element.hidden = other !== session;
		this.renderList();
		requestAnimationFrame(() => {
			session.fit.fit();
			session.term.focus();
		});
	}

	private async kill(session: Session | null = this.active): Promise<void> {
		if (!session) return;
		if (!session.exited) await ptyKill(session.id).catch(() => undefined);
		await this.remove(session);
	}

	private async remove(session: Session): Promise<void> {
		// The exit listener and a session-sync retire can both name a dying session; the
		// second call is a no-op.
		if (!this.sessions.includes(session)) return;
		const pending = this.resizeTimers.get(session.id);
		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.resizeTimers.delete(session.id);
		}
		this.dropOutput(session);
		for (const unlisten of session.unlisten) unlisten();
		session.links.dispose();
		session.term.dispose();
		session.element.remove();
		const index = this.sessions.indexOf(session);
		if (index !== -1) this.sessions.splice(index, 1);
		if (this.active === session) {
			this.active = null;
			const next = this.sessions[Math.min(index, this.sessions.length - 1)];
			if (next) this.activate(next);
			else this.onEmpty?.();
		}
		this.renderList();
	}

	private renderList(): void {
		this.list.innerHTML = '';
		this.list.hidden = this.sessions.length < 2;
		for (const session of this.sessions) {
			const row = el('div', 'row' + (session === this.active ? ' active' : ''), [
				el('span', 'icon', [icon('terminal')]),
				el('span', 'label', [session.name + (session.exited ? ' (exited)' : '')])
			]);
			row.title = session.name;
			row.appendChild(el('div', 'actions', [actionButton('trash', 'Kill Terminal', () => void this.kill(session))]));
			row.addEventListener('click', () => this.activate(session));
			// Right-clicking a session's row activates it first (the way VS Code focuses a
			// terminal tab on its context menu), then offers the row's two actions.
			row.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.activate(session);
				showContextMenu(event.clientX, event.clientY, [
					{ label: t('terminal.menu.newTerminal'), run: () => void this.create() },
					'separator',
					{ label: t('terminal.menu.kill'), run: () => void this.kill(session) }
				]);
			});
			this.list.appendChild(row);
		}
	}
}
