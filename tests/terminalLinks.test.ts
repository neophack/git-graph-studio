// The terminal's link layer (module 11): every URL and path a shell prints is a link —
// detected per buffer line, hovered with a hint, ctrl+clicked into the opener or the editor
// group (a pathless frontend copies instead), and served by the context menu when a link
// sits under the cursor. The find bar (Ctrl+F over the shell, @xterm/addon-search) and the
// copy-on-select / clear / select-all / run-selected commands ride the same view, so their
// tests live here too.
import { beforeEach, describe, expect, it } from 'vitest';

import { TerminalView } from '../src/features/terminal';
import { detectLinks, resolveTerminalPath } from '../src/features/terminal/links';
import { toCellColumn } from '../src/features/terminal/wcwidth';
import { DEFAULT_SETTINGS, SETTING_DEFS, updateSetting } from '../src/platform/settings';
import { setLocale, t } from '../src/platform/i18n';
import { backend } from './tauriMock';
import { flush, menuLabels, menuItem, rightClick } from './helpers';

/** The fake xterm instances the setup mock records, newest last. */
function terms(): MockTerm[] {
	return (globalThis as unknown as { __xterms: MockTerm[] }).__xterms as MockTerm[];
}

interface MockTerm {
	lines: string[];
	linkProviders: { provideLinks(y: number, callback: (links: MockLink[] | undefined) => void): void }[];
	addons: { calls?: { direction: string; term: string; options?: Record<string, unknown> }[]; findNext?: unknown; findPrevious?: unknown }[];
	keyHandler: ((event: KeyboardEvent) => boolean) | null;
	selection: string;
	pasted: string[];
	selectAllCalled: number;
	cleared: number;
	triggerSelection(): void;
}

interface MockLink {
	text: string;
	range: { start: { x: number; y: number }; end: { x: number; y: number } };
	activate(event: MouseEvent): void;
	hover(event: MouseEvent): void;
	leave(): void;
}

/** The search addon loaded into a terminal (the find bar's engine). */
function searchOf(term: MockTerm): NonNullable<MockTerm['addons'][number]> {
	const addon = term.addons.find((candidate) => typeof candidate.findNext === 'function');
	if (!addon) throw new Error('no search addon loaded');
	return addon as NonNullable<MockTerm['addons'][number]>;
}

/** Feed one buffer line through the view's registered link provider and take the links. */
function linksFor(term: MockTerm, row = 1): MockLink[] {
	let captured: MockLink[] | undefined;
	term.linkProviders[0]!.provideLinks(row, (links) => { captured = links; });
	return captured ?? [];
}

/** The scripted backend: a plain shell answers `pty_create`, writes and kills. */
beforeEach(() => {
	backend.on('pty_create', () => 'git-bash');
	backend.on('pty_write', () => null);
	backend.on('pty_kill', () => null);
});

/** A view whose element is on the page (the DOM-facing tests read the hint, the menus and
 *  the find bar through `document`). */
async function shownView(): Promise<TerminalView> {
	const view = new TerminalView();
	document.body.appendChild(view.element);
	await view.shown();
	return view;
}

describe('link detection (the pure scan)', () => {
	it('classifies a URL, and strips the sentence punctuation around it', () => {
		const links = detectLinks('see https://example.com/docs?x=1, and (https://other.io/page_(en)) done.');
		expect(links).toHaveLength(2);
		expect(links[0]).toMatchObject({ kind: 'url', target: 'https://example.com/docs?x=1' });
		expect(links[1]).toMatchObject({ kind: 'url', target: 'https://other.io/page_(en)' });
	});

	it('classifies Windows, MSYS and workspace-relative paths, with :line:col parsed off', () => {
		const links = detectLinks('at C:\\repo\\src\\app.ts:12:5 then /c/Users/me/proj/main.rs(42,7) and src/foo.ts:3 also ./bar/baz.ts');
		expect(links).toHaveLength(4);
		expect(links[0]).toMatchObject({ kind: 'path', target: 'C:\\repo\\src\\app.ts', line: 12, column: 5 });
		expect(links[1]).toMatchObject({ kind: 'path', target: '/c/Users/me/proj/main.rs', line: 42, column: 7 });
		expect(links[2]).toMatchObject({ kind: 'path', target: 'src/foo.ts', line: 3, column: undefined });
		expect(links[3]).toMatchObject({ kind: 'path', target: './bar/baz.ts', line: undefined });
	});

	it('does not link inside prose that only looks path-shaped', () => {
		// `refs/heads/main` (no extension), `a/b` (too plain), an scp-style remote, and a
		// POSIX path glued to a word all stay plain text.
		expect(detectLinks('push refs/heads/main and a/b to git@host:org/repo.git')).toEqual([]);
		expect(detectLinks('word/dev/null tail')).toEqual([]);
	});

	it('reports char offsets, so the provider can build cell ranges', () => {
		const line = 'open src/app.ts now';
		const links = detectLinks(line);
		expect(links[0]!.start).toBe(line.indexOf('src/app.ts'));
		expect(links[0]!.end).toBe(links[0]!.start + 'src/app.ts'.length);
	});
});

describe('the cell-width walk (wcwidth.ts, the link range converter)', () => {
	it('counts one cell for plain text, two for full-width characters, none for marks', () => {
		expect(toCellColumn('abc', 3)).toBe(3);
		expect(toCellColumn('错误', 2)).toBe(4);
		expect(toCellColumn('错误 at', 5)).toBe(7);
		expect(toCellColumn('\uFF21x', 3)).toBe(3); // fullwidth A paints two cells
		expect(toCellColumn('e\u0301x', 3)).toBe(2); // a combining acute paints none
		expect(toCellColumn('a\u200bb', 3)).toBe(2); // a zero-width space paints none
	});

	it('walks a surrogate pair whole — one emoji character, two cells', () => {
		expect(toCellColumn('🚀x', 3)).toBe(3);
		expect(toCellColumn('🚀x', 2)).toBe(2); // the half-pair index counts nothing
	});
});

describe('path resolution (the wiring site\'s vocabulary)', () => {
	it('unmaps the MSYS drive spelling, joins the workspace root, passes absolute paths as written', () => {
		expect(resolveTerminalPath('/c/Users/me/proj/main.rs', null)).toBe('C:\\Users\\me\\proj\\main.rs');
		expect(resolveTerminalPath('/d', null)).toBe('D:\\');
		expect(resolveTerminalPath('src\\app.ts', 'C:\\repo')).toBe('C:\\repo\\src\\app.ts');
		expect(resolveTerminalPath('src/app.ts', 'C:\\repo\\sub/')).toBe('C:\\repo\\sub\\src\\app.ts');
		expect(resolveTerminalPath('C:\\other\\file.ts', 'C:\\repo')).toBe('C:\\other\\file.ts');
		expect(resolveTerminalPath('/usr/local/bin/x', '/repo')).toBe('/usr/local/bin/x');
	});
});

describe('the link provider over the view', () => {
	it('feeds a buffer line through and produces classified links with cell ranges', async () => {
		const view = new TerminalView();
		await view.shown();
		const term = terms()[0]!;
		term.lines[0] = 'error at C:\\repo\\src\\app.ts:12:5, see https://example.com/docs';
		const links = linksFor(term);
		expect(links).toHaveLength(2);
		expect(links[0]!.text).toBe('C:\\repo\\src\\app.ts:12:5');
		// Cell positions are 1-based over the line's chars: [start, end) covers start+1..end.
		expect(links[0]!.range).toEqual({ start: { x: 10, y: 1 }, end: { x: 32, y: 1 } });
		expect(links[1]!.text).toBe('https://example.com/docs');
	});

	it('cell ranges survive full-width characters before and inside the link', async () => {
		const view = new TerminalView();
		await view.shown();
		const term = terms()[0]!;
		term.lines[0] = '错误 at C:\\src\\main.rs:10';
		const [link] = linksFor(term);
		expect(link!.text).toBe('C:\\src\\main.rs:10');
		// 错 and 误 paint two cells each: the path begins at string index 6 but cell
		// column 8, so the 1-based underline covers cells 9..25 — exactly the path,
		// not two cells to its left (the misalignment this fixes).
		expect(link!.range).toEqual({ start: { x: 9, y: 1 }, end: { x: 25, y: 1 } });

		term.lines[0] = '路径 /c/proj/测试.ts:2';
		const [wide] = linksFor(term);
		expect(wide!.text).toBe('/c/proj/测试.ts:2');
		// The wide characters INSIDE the link text count too: five cells precede the
		// link, and its 15 code units (测、试 two of them wide) paint 17 cells — 6..22.
		expect(wide!.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 22, y: 1 } });
		await view.killActive();
	});

	it('a ctrl+clicked URL crosses the opener; a plain click opens nothing', async () => {
		const view = new TerminalView();
		await view.shown();
		const term = terms()[0]!;
		term.lines[0] = 'docs: https://example.com/guide';
		const [link] = linksFor(term);
		const plain = new MouseEvent('mouseup', { ctrlKey: false });
		link!.activate(plain);
		await flush();
		expect(backend.opened).toEqual([]);
		const modified = new MouseEvent('mouseup', { ctrlKey: true });
		link!.activate(modified);
		await flush();
		expect(backend.opened).toEqual(['https://example.com/guide']);
		await view.killActive();
	});

	it('a ctrl+clicked path reaches the wired onOpenFile with the raw target and line/col', async () => {
		const view = new TerminalView();
		const opened: { path: string; line?: number; column?: number }[] = [];
		view.onOpenFile = (path, line, column) => opened.push({ path, line, column });
		await view.shown();
		const term = terms()[0]!;
		term.lines[0] = 'at src/main.rs:30';
		const [link] = linksFor(term);
		link!.activate(new MouseEvent('mouseup', { ctrlKey: true }));
		expect(opened).toEqual([{ path: 'src/main.rs', line: 30, column: undefined }]);
		await view.killActive();
	});

	it('with no callback wired (the remote shell), a path link copies instead of opening', async () => {
		const view = new TerminalView();
		await view.shown();
		const term = terms()[0]!;
		term.lines[0] = 'at src/main.rs:30';
		const [link] = linksFor(term);
		link!.activate(new MouseEvent('mouseup', { ctrlKey: true }));
		await flush();
		expect(backend.opened).toEqual([]);
		// The fallback copies the path itself (no line/column) and says so.
		expect(backend.clipboard).toEqual(['src/main.rs']);
		await view.killActive();
	});

	it('a hovered link shows the hint (target + the ctrl+click key), leaving hides it', async () => {
		const view = await shownView();
		const term = terms()[0]!;
		term.lines[0] = 'see https://example.com/guide';
		const [link] = linksFor(term);
		link!.hover(new MouseEvent('mousemove', { clientX: 40, clientY: 60 }));
		const hint = document.querySelector<HTMLElement>('.terminal-link-hint');
		expect(hint).not.toBeNull();
		expect(hint!.textContent).toContain('https://example.com/guide');
		expect(hint!.textContent).toContain(t('terminal.link.hint'));
		link!.leave();
		expect(document.querySelector<HTMLElement>('.terminal-link-hint')!.hidden).toBe(true);
		await view.killActive();
	});
});

describe('the context menu over a hovered link', () => {
	it('leads with Open Link / Copy Link when a link is under the cursor', async () => {
		const view = new TerminalView();
		const opened: string[] = [];
		view.onOpenFile = (path) => opened.push(path);
		document.body.appendChild(view.element);
		await view.shown();
		const term = terms()[0]!;
		term.lines[0] = 'edit src/app.ts:5 next';
		const [link] = linksFor(term);
		link!.hover(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }));
		rightClick(document.querySelector('.terminal-instance')!);
		expect(menuLabels()).toEqual(['Open Link', 'Copy Link', 'Copy', 'Paste', 'Select All', 'Clear']);
		menuItem('Open Link')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(opened).toEqual(['src/app.ts']);
		rightClick(document.querySelector('.terminal-instance')!);
		menuItem('Copy Link')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		expect(backend.clipboard).toEqual(['src/app.ts:5']);
		await view.killActive();
	});

	it('keeps the plain four-entry menu when no link is hovered', async () => {
		const view = await shownView();
		rightClick(document.querySelector('.terminal-instance')!);
		expect(menuLabels()).toEqual(['Copy', 'Paste', 'Select All', 'Clear']);
		await view.killActive();
	});
});

describe('the find bar (Ctrl+F over the shell)', () => {
	it('labels its toggles and tooltips in both language tables', () => {
		for (const key of ['terminal.find.caseSensitive', 'terminal.find.wholeWord', 'terminal.find.regex', 'terminal.find.previous', 'terminal.find.next', 'terminal.find.close', 'terminal.menu.openLink', 'terminal.menu.copyLink', 'terminal.link.hint'] as const) {
			expect(t(key)).not.toBe(key);
		}
		setLocale('zh-cn');
		try {
			expect(t('terminal.menu.openLink')).toBe('打开链接');
			expect(t('terminal.find.regex')).toBe('使用正则表达式');
		} finally {
			setLocale('en');
		}
	});

	it('opens with showFind, drives the addon with the query and the toggles, closes on Escape', async () => {
		const view = await shownView();
		const term = terms()[0]!;
		view.showFind();
		const bar = document.querySelector<HTMLElement>('.terminal-find-bar')!;
		expect(bar.hidden).toBe(false);
		const search = searchOf(term);
		const input = bar.querySelector<HTMLInputElement>('.terminal-find-input')!;
		input.value = 'panic';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		expect(search.calls).toEqual([{ direction: 'next', term: 'panic', options: expect.objectContaining({ caseSensitive: false }) }]);
		// The case toggle re-runs with the option flipped.
		(bar.querySelector<HTMLElement>('.terminal-find-btn.toggle')!).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(search.calls.at(-1)!.options).toMatchObject({ caseSensitive: true });
		// Enter finds next; Shift+Enter finds previous.
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		expect(search.calls.at(-1)!.direction).toBe('next');
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
		expect(search.calls.at(-1)!.direction).toBe('previous');
		// Ctrl+F inside the shell opens the bar too; Escape closes it back into the shell.
		expect(term.keyHandler!(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))).toBe(false);
		expect(document.querySelector<HTMLElement>('.terminal-find-bar')!.hidden).toBe(false);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		expect(document.querySelector<HTMLElement>('.terminal-find-bar')!.hidden).toBe(true);
		await view.killActive();
	});

	it('a query the buffer cannot answer flashes the input instead of throwing', async () => {
		const view = await shownView();
		view.showFind();
		const bar = document.querySelector<HTMLElement>('.terminal-find-bar')!;
		// The mock answers findNext true; a false answer (no results) is the addon's own
		// contract — drive it through a stub to see the flash class land.
		const term = terms()[0]!;
		const addon = searchOf(term) as { findNext: (query: string, options?: unknown) => boolean };
		addon.findNext = () => false;
		const input = bar.querySelector<HTMLInputElement>('.terminal-find-input')!;
		input.value = 'nothing-here';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		expect(input.classList.contains('no-results')).toBe(true);
		await view.killActive();
	});
});

describe('the new terminal settings', () => {
	it('registers scrollback, copy-on-select and font size with defaults from the view', () => {
		for (const key of ['terminalScrollback', 'terminalCopyOnSelect', 'terminalFontSize'] as const) {
			const def = SETTING_DEFS.find((candidate) => candidate.key === key);
			expect(def, key).toBeDefined();
			expect(DEFAULT_SETTINGS[key]).toBeDefined();
		}
		expect(DEFAULT_SETTINGS.terminalScrollback).toBe(5000);
		expect(DEFAULT_SETTINGS.terminalFontSize).toBe(14);
		expect(DEFAULT_SETTINGS.terminalCopyOnSelect).toBe(false);
	});

	it('labels the three settings in both language tables', () => {
		for (const key of ['settings.terminalScrollback', 'settings.terminalCopyOnSelect', 'settings.terminalFontSize'] as const) {
			expect(t(key)).not.toBe(key);
			expect(t(`${key}.description` as 'settings.terminalScrollback.description')).not.toBe(`${key}.description`);
		}
		setLocale('zh-cn');
		try {
			expect(t('settings.terminalScrollback')).toBe('终端回滚行数');
			expect(t('settings.terminalCopyOnSelect')).toBe('终端：选中即复制');
		} finally {
			setLocale('en');
		}
	});

	it('new terminals read scrollback and font size from the settings', async () => {
		updateSetting('terminalScrollback', 1234);
		updateSetting('terminalFontSize', 17);
		const view = new TerminalView();
		await view.shown();
		const options = (terms()[0] as unknown as { options: Record<string, unknown> }).options;
		expect(options).toMatchObject({ scrollback: 1234, fontSize: 17 });
		updateSetting('terminalScrollback', DEFAULT_SETTINGS.terminalScrollback);
		updateSetting('terminalFontSize', DEFAULT_SETTINGS.terminalFontSize);
		await view.killActive();
	});
});

describe('copy on select and the viewport commands', () => {
	it('copyOnSelect writes the selection to the clipboard only while the setting says so', async () => {
		const view = new TerminalView();
		await view.shown();
		const term = terms()[0]!;
		term.selection = 'printed output';
		term.triggerSelection();
		await flush();
		expect(backend.clipboard).toEqual([]);
		updateSetting('terminalCopyOnSelect', true);
		term.triggerSelection();
		await flush();
		expect(backend.clipboard).toEqual(['printed output']);
		updateSetting('terminalCopyOnSelect', DEFAULT_SETTINGS.terminalCopyOnSelect);
		await view.killActive();
	});

	it('clear and select-all touch the term; runSelectedText writes the selection + Enter', async () => {
		const view = new TerminalView();
		await view.shown();
		const term = terms()[0]!;
		view.clearActive();
		expect(term.cleared).toBe(1);
		view.selectAllActive();
		expect(term.selectAllCalled).toBe(1);
		// Nothing selected: nothing crosses the wire.
		await view.runSelectedText();
		expect(backend.callsTo('pty_write')).toEqual([]);
		term.selection = 'npm test';
		await view.runSelectedText();
		expect(backend.callsTo('pty_write')).toContainEqual({ id: backend.callsTo('pty_create')[0]!.id, data: 'npm test\r' });
		await view.killActive();
	});
});
