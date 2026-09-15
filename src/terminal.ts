// The Terminal view of the panel: xterm.js fronts over the backend's PTY sessions, with the
// view's actions (new / kill) and the terminal list on the right when more than one shell is
// open. The panel itself (tabs, maximize, hide) is panel.ts.

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

import { loadXterm } from './lazy';

import { actionButton, el, icon, notify } from './ui';
import { THEME_EVENT } from './settings';

interface Session {
	id: number;
	name: string;
	term: Terminal;
	fit: FitAddon;
	element: HTMLElement;
	row: HTMLElement;
	exited: boolean;
	unlisten: UnlistenFn[];
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

export class TerminalView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;
	private readonly host: HTMLElement;
	private readonly list: HTMLElement;
	private readonly sessions: Session[] = [];
	private active: Session | null = null;
	private readonly resizeTimers = new Map<number, number>();
	/** Unique across page reloads: the backend keys its sessions by this, and a reload must
	 *  not replace (and so close) the previous page's shells under the same numbers. */
	private nextId = Math.floor(Math.random() * 0x3fff_ffff);
	private visible = false;

	/** The user pressed Enter in a shell: the repository may have changed. */
	onCommandEntered: (() => void) | null = null;
	/** The last shell was closed: the panel may want to hide. */
	onEmpty: (() => void) | null = null;

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
		window.addEventListener('beforeunload', () => {
			for (const session of this.sessions) void invoke('pty_kill', { id: session.id });
		});
		// A theme switch retints the running terminals once the new stylesheet has loaded.
		window.addEventListener(THEME_EVENT, () => {
			const theme = terminalTheme();
			for (const session of this.sessions) session.term.options.theme = theme;
		});
	}

	/** The view became visible: make sure a shell is running and fits. */
	async shown(): Promise<void> {
		this.visible = true;
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

	/** Type a command into the active shell (the graph's interactive rebase / difftool). */
	async run(command: string): Promise<void> {
		if (!this.active || this.active.exited) await this.create();
		const session = this.active;
		if (!session || session.exited) return;
		await invoke('pty_write', { id: session.id, data: command + '\r' });
		session.term.focus();
	}

	focus(): void {
		this.active?.term.focus();
	}

	/* ---------- Sessions ---------- */

	private async create(): Promise<void> {
		// xterm is an async chunk: the first terminal pays for its load, the workbench never does.
		const { Terminal, FitAddon } = await loadXterm();
		const id = this.nextId++;
		const term = new Terminal({
			fontFamily: cssVar('--vscode-editor-font-family') || 'Consolas, monospace',
			fontSize: 14,
			lineHeight: 1,
			cursorBlink: true,
			cursorStyle: 'bar',
			scrollback: 5000,
			allowProposedApi: true,
			theme: terminalTheme()
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		const element = el('div', 'terminal-instance');
		this.host.appendChild(element);
		term.open(element);
		// VS Code's terminal clipboard keys: Ctrl+Shift+C copies the selection, Ctrl+Shift+V
		// pastes, and Ctrl+C copies too while text is selected (the interrupt goes to the
		// shell only with nothing selected). They stop here so the workbench's own bindings
		// (the Markdown preview on Ctrl+Shift+V, the editor's copy) never answer instead.
		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey) || event.altKey) return true;
			const key = event.key.toLowerCase();
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
			return true;
		});

		const row = el('div', 'row');
		const session: Session = { id, name: 'shell', term, fit, element, row, exited: false, unlisten: [] };
		this.sessions.push(session);
		this.activate(session);
		fit.fit();

		// The listeners go up BEFORE the shell starts: its first prompt arrives within
		// milliseconds of the spawn and would otherwise be lost.
		session.unlisten.push(await listen<string>(`studio://pty-output-${id}`, (event) => term.write(event.payload)));
		session.unlisten.push(await listen(`studio://pty-exit-${id}`, () => {
			session.exited = true;
			term.write('\r\n\x1b[90m[The terminal process has exited. Press any key to close it.]\x1b[0m\r\n');
			const disposable = term.onKey(() => {
				disposable.dispose();
				void this.remove(session);
			});
			this.renderList();
		}));

		let shellName: string;
		try {
			shellName = await invoke<string>('pty_create', { id, cols: term.cols, rows: term.rows });
		} catch (error) {
			notify('error', String(error));
			term.write(`\x1b[31m${String(error)}\x1b[0m\r\n`);
			session.exited = true;
			this.renderList();
			return;
		}
		session.name = shellName;
		term.onData((data) => {
			void invoke('pty_write', { id, data });
			if (data.includes('\r')) window.setTimeout(() => this.onCommandEntered?.(), 800);
		});
		term.onResize(({ cols, rows }) => this.resize(id, cols, rows));
		this.renderList();
		term.focus();
	}

	/** Resizing a ConPTY is expensive, and a sash drag crosses a cell boundary many times in a
	 *  row - only the last of a burst of resizes is sent to the backend. */
	private resize(id: number, cols: number, rows: number): void {
		const previous = this.resizeTimers.get(id);
		if (previous !== undefined) window.clearTimeout(previous);
		this.resizeTimers.set(id, window.setTimeout(() => {
			this.resizeTimers.delete(id);
			void invoke('pty_resize', { id, cols, rows }).catch(() => undefined);
		}, 100));
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
		if (!session.exited) await invoke('pty_kill', { id: session.id }).catch(() => undefined);
		await this.remove(session);
	}

	private async remove(session: Session): Promise<void> {
		const pending = this.resizeTimers.get(session.id);
		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.resizeTimers.delete(session.id);
		}
		for (const unlisten of session.unlisten) unlisten();
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
			this.list.appendChild(row);
		}
	}
}
