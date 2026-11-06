// The terminal's find bar (module 11, the VS Code terminal parity pass): Ctrl+F inside the
// terminal opens a small bar over the shell — @xterm/addon-search does the finding, this
// file only the DOM (input, the three option toggles, next/prev/close) — and Esc closes it
// back into the shell. The visual vocabulary mirrors the editor find widget's
// (.cm-find-widget in shell.css) without importing it: a terminal must never reach into the
// editor module. The bar serves the view's ACTIVE session — its delegates re-read on every
// call, so a session switch mid-search searches the new shell.

import type { Terminal } from '@xterm/xterm';
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';

import { el, icon } from '../../platform/ui/index';
import { t } from '../../platform/i18n';

/** The session-facing half the view provides: the active terminal and its search addon
 *  (or nulls while no shell runs), plus the way back into the shell after a close. */
export interface TerminalFindHost {
	term(): Terminal | null;
	search(): SearchAddon | null;
	focusTerminal(): void;
}

export interface TerminalFindBar {
	readonly element: HTMLElement;
	open(): void;
	close(): void;
	toggle(): void;
}

/** How long the no-results flash keeps the input's border red. */
const FLASH_MS = 400;

export function mountTerminalFindBar(host: HTMLElement, find: TerminalFindHost): TerminalFindBar {
	const options: Required<Pick<ISearchOptions, 'caseSensitive' | 'wholeWord' | 'regex'>> = {
		caseSensitive: false,
		wholeWord: false,
		regex: false
	};

	const input = el('input', 'terminal-find-input') as HTMLInputElement;
	input.placeholder = t('find.placeholder');
	input.spellcheck = false;

	// Highlight-all rides the search options' decorations; the colours follow the theme's
	// editor find tokens with the Dark Modern defaults standing in where a variable is
	// absent (jsdom, an unthemed page).
	const searchOptions = (): ISearchOptions => ({
		...options,
		decorations: {
			matchBackground: cssVar('--vscode-editor-findMatchHighlightBackground', 'rgba(234, 92, 0, 0.33)'),
			matchOverviewRuler: cssVar('--vscode-editorOverviewRuler-findMatchForeground', 'rgba(234, 92, 0, 0.5)'),
			activeMatchBackground: cssVar('--vscode-editor-findMatchBackground', 'rgba(234, 92, 0, 0.62)'),
			activeMatchColorOverviewRuler: cssVar('--vscode-editorOverviewRuler-findMatchForeground', 'rgba(234, 92, 0, 1)')
		}
	});

	let flashTimer = 0;
	/** Run one find and flash the input when the buffer holds no match. */
	const run = (direction: 'next' | 'previous'): boolean => {
		const addon = find.search();
		const query = input.value;
		if (!addon || query === '') return false;
		const found = direction === 'next'
			? addon.findNext(query, searchOptions())
			: addon.findPrevious(query, searchOptions());
		input.classList.remove('no-results');
		if (!found) {
			input.classList.add('no-results');
			window.clearTimeout(flashTimer);
			flashTimer = window.setTimeout(() => input.classList.remove('no-results'), FLASH_MS);
		}
		return found;
	};

	const toggleButton = (name: string, key: 'caseSensitive' | 'wholeWord' | 'regex'): HTMLButtonElement => {
		const titleKey = `terminal.find.${key}` as 'terminal.find.caseSensitive';
		const button = el('button', 'terminal-find-btn toggle', [icon(name)]) as HTMLButtonElement;
		button.title = t(titleKey);
		button.setAttribute('aria-label', button.title);
		button.addEventListener('click', () => {
			options[key] = !options[key];
			button.classList.toggle('active', options[key]);
			run('next'); // re-run so the highlights answer the new option at once
		});
		return button;
	};

	const button = (name: string, titleKey: 'terminal.find.previous' | 'terminal.find.next' | 'terminal.find.close', run_: () => void): HTMLButtonElement => {
		const button = el('button', 'terminal-find-btn', [icon(name)]) as HTMLButtonElement;
		button.title = t(titleKey);
		button.setAttribute('aria-label', button.title);
		button.addEventListener('click', run_);
		return button;
	};

	const close = (): void => {
		element.hidden = true;
		find.search()?.clearDecorations();
		find.focusTerminal();
	};

	const open = (): void => {
		element.hidden = false;
		input.focus();
		input.select();
	};

	input.addEventListener('input', () => void run('next'));
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			run(event.shiftKey ? 'previous' : 'next');
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close();
		}
	});

	const row = el('div', 'terminal-find-row', [
		input,
		toggleButton('case-sensitive', 'caseSensitive'),
		toggleButton('whole-word', 'wholeWord'),
		toggleButton('regex', 'regex'),
		el('span', 'terminal-find-spacer'),
		button('chevron-up', 'terminal.find.previous', () => void run('previous')),
		button('chevron-down', 'terminal.find.next', () => void run('next')),
		button('close', 'terminal.find.close', close)
	]);
	const element = el('div', 'terminal-find-bar', [row]);
	element.hidden = true;
	host.appendChild(element);

	return { element, open, close, toggle: () => (element.hidden ? open() : close()) };
}

function cssVar(name: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value || fallback;
}
