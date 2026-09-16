import { describe, expect, it, vi } from 'vitest';

import { attachPageKeys, basename, closeContextMenu, confirmDialog, dirname, el, icon, isMenuOpen, joinPath, matchesQuery, MAX_SCROLL_PX, notify, pageScrollTop, quickInput, quickPick, relativeTo, showContextMenu, showMenuBelow, toPosix, VirtualScroll, type QuickPickItem, type QuickPickSource } from '../src/ui';
import { click, flush, hover, key, menuItem, menuLabels, notificationButton, notifications, texts, type } from './helpers';

describe('dom & path helpers', () => {
	it('builds elements and codicons', () => {
		const node = el('div', 'a b', ['x', null, icon('files')]);
		expect(node.className).toBe('a b');
		expect(node.textContent).toBe('x');
		expect(node.querySelector('.codicon-files')).not.toBeNull();
	});

	it('handles both path spellings', () => {
		expect(basename('C:\\repo\\src\\main.ts')).toBe('main.ts');
		expect(basename('/repo/src/')).toBe('src');
		expect(dirname('/repo/src/main.ts')).toBe('/repo/src');
		expect(joinPath('C:\\repo', 'a.txt')).toBe('C:\\repo\\a.txt');
		expect(joinPath('/repo/', 'a.txt')).toBe('/repo/a.txt');
		expect(toPosix('a\\b\\c')).toBe('a/b/c');
		expect(relativeTo('C:\\repo', 'C:\\repo\\src\\x.ts')).toBe('src/x.ts');
		expect(relativeTo('/repo', '/other/x')).toBe('/other/x');
		expect(relativeTo('/repo', '/repo')).toBe('');
	});

	it('matches quick pick queries word by word', () => {
		expect(matchesQuery('src/main.ts', 'main src')).toBe(true);
		expect(matchesQuery('src/main.ts', 'MAIN')).toBe(true);
		expect(matchesQuery('src/main.ts', 'rust')).toBe(false);
	});
});

describe('notifications', () => {

	it('pauses the auto-dismiss of an info toast while hovered and resumes afterwards', () => {
		vi.useFakeTimers();
		try {
			notify('info', 'Hover me');
			const toast = document.querySelector('#notifications .notification')!;
			toast.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
			vi.advanceTimersByTime(60_000);
			expect(notifications()).toEqual(['Hover me']);
			toast.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
			vi.advanceTimersByTime(8_000);
			expect(notifications()).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});	it('shows toasts with the kind icon and closes them', () => {
		notify('error', 'Boom');
		expect(notifications()).toEqual(['Boom']);
		expect(document.querySelector('#notifications .codicon-error')).not.toBeNull();
		click(document.querySelector('#notifications .action-btn'));
		expect(notifications()).toEqual([]);
	});

	it('runs actions and dismisses', () => {
		let ran = false;
		notify('info', 'Do it?', [{ label: 'Yes', run: () => { ran = true; } }]);
		click(notificationButton('Yes'));
		expect(ran).toBe(true);
		expect(notifications()).toEqual([]);
	});

	it('confirmDialog resolves with the choice', async () => {
		const pending = confirmDialog('Sure?', 'Delete');
		click(notificationButton('Delete'));
		expect(await pending).toBe(true);
		const cancelled = confirmDialog('Sure?', 'Delete');
		click(notificationButton('Cancel'));
		expect(await cancelled).toBe(false);
	});

	it('confirmDialog cancels when the toast is dismissed with its close button', async () => {
		const pending = confirmDialog('Sure?', 'Delete');
		const buttons = document.querySelectorAll('#notifications .notification .action-btn');
		click(buttons[buttons.length - 1]!);
		expect(await pending).toBe(false);
	});
});

describe('menus', () => {
	it('renders entries, separators, checkmarks and runs items', () => {
		let ran = '';
		showContextMenu(10, 10, [
			{ label: 'One', keybinding: 'Ctrl+1', run: () => { ran = 'one'; } },
			'separator',
			{ label: 'Two', checked: true, run: () => { ran = 'two'; } },
			{ label: 'Off', disabled: true, run: () => { ran = 'off'; } }
		]);
		expect(isMenuOpen()).toBe(true);
		expect(menuLabels()).toEqual(['One', 'Two', 'Off']);
		expect(document.querySelectorAll('.context-menu .separator')).toHaveLength(1);
		expect(menuItem('Two')!.querySelector('.check .codicon-check')).not.toBeNull();
		expect(menuItem('One')!.querySelector('.keybinding')!.textContent).toBe('Ctrl+1');
		expect(menuItem('Off')!.classList.contains('disabled')).toBe(true);
		click(menuItem('One'));
		expect(ran).toBe('one');
		expect(isMenuOpen()).toBe(false);
	});

	it('opens submenus on hover and closes everything on Escape', () => {
		let ran = '';
		showContextMenu(10, 10, [{ label: 'Branch', submenu: [{ label: 'Create Branch...', run: () => { ran = 'create'; } }] }]);
		hover(menuItem('Branch'));
		expect(document.querySelectorAll('.context-menu')).toHaveLength(2);
		expect(menuLabels()).toEqual(['Create Branch...']);
		click(menuItem('Create Branch...'));
		expect(ran).toBe('create');
		expect(document.querySelectorAll('.context-menu')).toHaveLength(0);

		showMenuBelow(document.getElementById('titlebar')!, [{ label: 'A', run: () => undefined }]);
		key(document, 'Escape');
		expect(isMenuOpen()).toBe(false);
	});

	it('walks items with the arrow keys and runs them with Enter, as VS Code menus do', () => {
		let ran = '';
		showContextMenu(10, 10, [
			{ label: 'One', run: () => { ran = 'one'; } },
			{ label: 'Off', disabled: true, run: () => { ran = 'off'; } },
			{ label: 'More', submenu: [{ label: 'Deep', run: () => { ran = 'deep'; } }] }
		]);
		key(document, 'ArrowDown');
		expect(menuItem('One')!.classList.contains('focused')).toBe(true);
		// Disabled items are skipped; the walk wraps around.
		key(document, 'ArrowDown');
		expect(menuItem('More')!.classList.contains('focused')).toBe(true);
		key(document, 'ArrowDown');
		expect(menuItem('One')!.classList.contains('focused')).toBe(true);
		key(document, 'ArrowUp');
		// Right opens the submenu with its first item focused; Left closes it again.
		key(document, 'ArrowRight');
		expect(document.querySelectorAll('.context-menu')).toHaveLength(2);
		expect(menuItem('Deep')!.classList.contains('focused')).toBe(true);
		key(document, 'ArrowLeft');
		expect(document.querySelectorAll('.context-menu')).toHaveLength(1);
		key(document, 'ArrowRight');
		key(document, 'Enter');
		expect(ran).toBe('deep');
		expect(isMenuOpen()).toBe(false);
	});

	it('closes on an outside mousedown', () => {
		showContextMenu(10, 10, [{ label: 'A', run: () => undefined }]);
		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		expect(isMenuOpen()).toBe(false);
		closeContextMenu();
	});
});

describe('quick input', () => {
	it('resolves the typed value on Enter and validates', async () => {
		const pending = quickInput({ placeholder: 'Name', validate: (v) => (v === '' ? 'Required' : null) });
		const input = document.querySelector<HTMLInputElement>('.quick-input input')!;
		expect(input.placeholder).toBe('Name');
		key(input, 'Enter');
		expect(document.querySelector('.quick-input .hint')!.textContent).toBe('Required');
		type(input, 'feature');
		key(input, 'Enter');
		expect(await pending).toBe('feature');
		expect(document.querySelector('.quick-input')).toBeNull();
	});

	it('resolves null on Escape', async () => {
		const pending = quickInput({});
		key(document.querySelector('.quick-input input')!, 'Escape');
		expect(await pending).toBeNull();
	});

	it('filters a pick list and navigates with the keyboard', async () => {
		const pending = quickPick([
			{ label: 'main', value: 'main', description: 'HEAD' },
			{ label: 'feature', value: 'feature' },
			{ label: 'release', value: 'release' }
		], 'Pick');
		const input = document.querySelector<HTMLInputElement>('.quick-input input')!;
		expect(document.querySelectorAll('.quick-input .row')).toHaveLength(3);
		type(input, 'r');
		expect(Array.from(document.querySelectorAll('.quick-input .row .label')).map((e) => e.textContent)).toEqual(['feature', 'release']);
		key(input, 'ArrowDown');
		key(input, 'Enter');
		expect(await pending).toBe('release');
	});

	it('picks by click and offers free text when allowed', async () => {
		const pending = quickInput({ items: (query) => (query === 'x' ? [] : [{ label: 'A', value: 'a' }]), allowFreeText: true });
		click(document.querySelector('.quick-input .row'));
		expect(await pending).toBe('a');
		const free = quickInput({ items: () => [], allowFreeText: true });
		const input = document.querySelector<HTMLInputElement>('.quick-input input')!;
		type(input, 'typed');
		key(input, 'Enter');
		expect(await free).toBe('typed');
		await flush();
	});

	it('fills a chunked source in progressively and bolds the matched characters', async () => {
		const source: QuickPickSource = {
			query: async (query, onPartial) => {
				onPartial([{ label: 'main.ts', value: 'file:main.ts', highlights: [[0, 4]] }]);
				await new Promise((resolve) => setTimeout(resolve, 0));
				return [
					{ label: 'main.rs', value: 'file:main.rs', highlights: [[0, 4]] },
					{ label: 'main.ts', value: 'file:main.ts', highlights: [[0, 4]] }
				].filter((item) => query === '' || item.label.includes(query));
			}
		};
		const pending = quickInput({ items: source });
		// The first partial is applied synchronously, while the scan is still running…
		expect(texts('.quick-input .row .label')).toEqual(['main.ts']);
		expect(document.querySelector('.quick-input .row .label b')!.textContent).toBe('main');
		// …then the final list replaces it, ranked by the source.
		await flush();
		expect(texts('.quick-input .row .label')).toEqual(['main.rs', 'main.ts']);
		key(document.querySelector<HTMLInputElement>('.quick-input input')!, 'ArrowDown');
		key(document.querySelector<HTMLInputElement>('.quick-input input')!, 'Enter');
		expect(await pending).toBe('file:main.ts');
	});

	it('shows a status line while a source is still gathering its results', async () => {
		let resolveQuery: ((items: QuickPickItem[]) => void) | null = null;
		const pending = quickInput({
			items: {
				query: () => new Promise((resolve) => {
					resolveQuery = resolve;
				}),
				status: () => 'Reading the file list…'
			}
		});
		await flush();
		expect(document.querySelector('.quick-input .scm-empty')!.textContent).toBe('Reading the file list…');
		resolveQuery!([{ label: 'a', value: 'a' }]);
		await flush();
		expect(texts('.quick-input .row .label')).toEqual(['a']);
		key(document.querySelector<HTMLInputElement>('.quick-input input')!, 'Escape');
		expect(await pending).toBeNull();
	});

	it('settles the searching state when a source fails instead of sticking on it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const pending = quickInput({
				items: {
					// A rejected scan (the backend listing failed) must not leave the empty
					// state claiming a search that will never finish.
					query: () => Promise.reject(new Error('listing failed'))
				}
			});
			await flush();
			await flush();
			expect(document.querySelector('.quick-input .scm-empty')!.textContent).toBe('No results');
			expect(warn).toHaveBeenCalledTimes(1);
			key(document.querySelector<HTMLInputElement>('.quick-input input')!, 'Escape');
			expect(await pending).toBeNull();
		} finally {
			warn.mockRestore();
		}
	});
});

describe('page keys over a virtual scroll range', () => {
	/** A scroller stub for the headless DOM: fixed viewport, scroll writes snap to whole
	 *  pixels the way the engines' do. */
	function scrollerStub(clientHeight: number, scrollHeight: number): { element: HTMLElement; top: () => number } {
		const element = document.createElement('div');
		let raw = 0;
		Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight });
		Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight });
		Object.defineProperty(element, 'scrollTop', {
			configurable: true,
			get: () => raw,
			set: (v: number) => { raw = Math.max(0, Math.min(scrollHeight - clientHeight, Math.round(v))); }
		});
		document.body.appendChild(element);
		return { element, top: () => raw };
	}

	it('moves exactly one viewport of document rows a press — past the height ceiling, never the scaled leap', () => {
		// Fits the ceiling: the range is the identity, a page is the viewport outright.
		const small = scrollerStub(380, 1_900_000);
		const identity = new VirtualScroll(100_000, 19, 361);
		const keys = attachPageKeys(small.element, { range: () => identity, rowHeight: () => 19 });
		small.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
		expect(small.top()).toBe(380);
		small.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
		expect(small.top()).toBe(760); // the second page is exactly the first again
		small.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', cancelable: true }));
		expect(small.top()).toBe(380);
		keys.dispose();

		// 2M lines × 19 px = 38 M px over the 32 M px headless ceiling: one scrollbar pixel
		// stands for ~1.19 document pixels, and the native page key would overshoot the page
		// by that factor — rows the reader never sees.
		const huge = scrollerStub(380, MAX_SCROLL_PX);
		const scaled = new VirtualScroll(2_000_000, 19, 361);
		attachPageKeys(huge.element, { range: () => scaled, rowHeight: () => 19 });
		huge.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
		expect(huge.top()).toBe(320); // 380 document pixels, mapped back through the scale
		huge.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
		expect(huge.top()).toBe(640); // row quantisation keeps the second page exact
	});

	it('passes Ctrl/Meta/Alt chords through and makes the scroller focusable', () => {
		const { element, top } = scrollerStub(380, 1_900_000);
		attachPageKeys(element, { range: () => new VirtualScroll(100_000, 19, 361), rowHeight: () => 19 });
		// The keys can only reach a scroller that takes focus.
		expect(element.tabIndex).toBe(0);
		// Ctrl+PageUp/Down are the workbench's editor-tab keys: not consumed here.
		const event = new KeyboardEvent('keydown', { key: 'PageDown', ctrlKey: true, cancelable: true });
		element.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(top()).toBe(0);
	});

	it('pageScrollTop clamps at the document edges', () => {
		const { element } = scrollerStub(380, 1_900_000);
		const range = new VirtualScroll(100_000, 19, 361);
		expect(pageScrollTop(range, element, -1, 19)).toBe(0); // PageUp at the head
		element.scrollTop = 1_899_000; // near the bottom
		const last = pageScrollTop(range, element, 1, 19);
		expect(last).toBeLessThanOrEqual(1_900_000 - 380 + 361); // never past the padded end
		expect(last).toBeGreaterThan(1_899_000);
	});
});
