// The fast code viewer's line fetching: a failed `viewer_lines` call must not wedge the
// affected lines — the next refresh re-requests them and the rows render. A cold window is
// two deliveries (plain rows, then `viewer_highlight` colors), and the outline is the
// backend's third, `viewer_symbols`, asked for after the rows are up.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FastView } from '../src/fastView';
import { settings, updateSetting } from '../src/settings';
import { backend } from './tauriMock';
import { flush } from './helpers';

/** A viewer whose viewport is 380px — 20 rows of 19px — since jsdom lays nothing out and
 *  the model would otherwise never know how many rows to show. */
function mount(): FastView {
	const view = new FastView(document.getElementById('editorGroup')!);
	view.scroll.setViewport(380);
	return view;
}

const OPEN = { docId: 7, lineCount: 100, language: 'plaintext', syntaxName: 'Plain Text' };

const linesResult = (start: number, end: number, tokensPending = false) => ({
	startLine: start,
	lineCount: end - start + 1,
	tokensPending,
	lines: Array.from({ length: end - start + 1 }, (_, i) => [`line ${start + i}`, []] as [string, [number, number, string][]])
});

describe('the fast viewer', () => {
	it('retries a failed line fetch on the next refresh instead of leaving the rows blank', async () => {
		backend.on('viewer_open', () => OPEN);
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		let fail = true;
		backend.on('viewer_lines', ({ start, end }) => {
			if (fail) throw new Error('transient backend error');
			return linesResult(start as number, end as number);
		});
		const view = mount();
		expect(await view.openFile('C:\\repo\\big.txt')).toBe(true);
		await flush();
		// The fetch ran and failed: nothing rendered yet.
		expect(backend.callsTo('viewer_lines').length).toBe(1);
		expect(view.root.querySelectorAll('.fast-row').length).toBe(0);

		fail = false;
		view.revealLine(0); // the same window — a refresh must re-request it
		await flush();
		expect(backend.callsTo('viewer_lines').length).toBe(2);
		expect(view.root.querySelectorAll('.fast-row').length).toBeGreaterThan(0);
		view.dispose();
	});

	it('fills the viewport a drag ended on once the in-flight window lands', async () => {
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: 100_000 }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		// The first fetch hangs until the test releases it, the way a slow window on a huge
		// file does; later fetches answer immediately.
		let holdNext = true;
		let release: ((value: unknown) => void) | null = null;
		backend.on('viewer_lines', ({ start, end }) => {
			if (!holdNext) return linesResult(start as number, end as number);
			holdNext = false;
			return new Promise((resolve) => {
				release = resolve as (value: unknown) => void;
			});
		});
		const view = mount();
		await view.openFile('C:\\repo\\huge.txt');
		await flush();
		expect(backend.callsTo('viewer_lines').length).toBe(1);

		// Drag to the middle of the file while that first window is still in flight: the
		// scroll must not pile a second fetch on top of it.
		const held = release!;
		view.revealLine(50_000);
		await flush();
		expect(backend.callsTo('viewer_lines').length).toBe(1);

		// The drag ends (no more scroll events); the in-flight window lands far away. The
		// landing itself must fetch the lines the viewport is still missing.
		held(linesResult(0, 30));
		await flush();
		const calls = backend.callsTo('viewer_lines');
		expect(calls.length).toBe(2);
		// The reveal centred the line (Zed's go-to-line strategy): the top is 9 rows above
		// it, and the window is the viewport plus ten rows of overscan on each side.
		expect(view.scroll.top).toBe(49_991);
		expect(calls[1]).toMatchObject({ start: 49_981, end: 50_021 });
		expect(view.root.querySelector('.fast-row[data-line="50000"]')).not.toBeNull();
		view.dispose();
	});

	it('scrolls a multi-million-line file to its end - no layout clamp stands in the way', async () => {
		// 2,000,000 lines at 19 px is 38M px of document, past the engines' ~33.5M px
		// layout clamp. Nothing is that tall here: the model owns the position in rows and
		// the rows are placed relative to the viewport, so the last line is a position like
		// any other.
		const LINES = 2_000_000;
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: LINES }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		backend.on('viewer_lines', ({ start, end }) => linesResult(start as number, end as number));
		const view = mount();
		await view.openFile('C:\\repo\\huge.txt');
		await flush();
		expect(view.scroll.maxScrollTop()).toBe(LINES - 1);
		// The scrollbar dragged to its bottom is the last row at the viewport's top (Zed's
		// scroll_beyond_last_line = one_page): it fetches and renders there.
		view.scroll.setTop(view.scroll.maxScrollTop());
		await flush();
		const last = view.root.querySelector<HTMLElement>(`.fast-row[data-line="${LINES - 1}"]`)!;
		expect(last).not.toBeNull();
		expect(last.style.top).toBe('0px');
		// Every rendered row sits within the viewport-and-overscan band above it.
		for (const row of Array.from(view.root.querySelectorAll<HTMLElement>('.fast-row'))) {
			const top = Number.parseInt(row.style.top, 10);
			expect(top).toBeGreaterThanOrEqual(-10 * 19);
			expect(top).toBeLessThanOrEqual(0);
		}
		// The surface scrolls nothing natively: the drawn scrollbar is the only one.
		expect(view.root.querySelector('.scrollbar.vertical')).not.toBeNull();
		view.dispose();
	});

	it('adopts the staged open\'s exact line count when the tail lands', async () => {
		// A huge file opens on its head: the count the scroller starts with is an estimate,
		// and the background tail's landing event replaces it in place.
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: 1_900_000 }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		backend.on('viewer_lines', ({ start, end }) => linesResult(start as number, end as number));
		const view = mount();
		await view.openFile('C:\\repo\\huge.txt');
		await flush();
		expect(view.lineCount).toBe(1_900_000);
		backend.emit('studio://viewer-lines', { docId: view.docId, lineCount: 2_000_000 });
		await flush();
		// The model's range follows the exact count.
		expect(view.lineCount).toBe(2_000_000);
		expect(view.scroll.rowCount).toBe(2_000_000);
		expect(view.scroll.maxScrollTop()).toBe(1_999_999);
		// Another document's landing is not this one's business.
		backend.emit('studio://viewer-lines', { docId: 999, lineCount: 50 });
		await flush();
		expect(view.lineCount).toBe(2_000_000);
		view.dispose();
	});

	it('serves the indexed family end to end: open, fetch, find, close', async () => {
		// The memory-bounded mode: enormous files never build a rope — every request goes
		// to the indexed command family, find included.
		backend.on('indexed_open', () => ({ ...OPEN, docId: 5 }));
		backend.on('indexed_close', () => undefined);
		backend.on('indexed_find', () => ({ matches: [{ line: 3, startCol: 0, endCol: 2 }], capped: false, lineCount: 100 }));
		backend.on('indexed_lines', ({ start, end }) => linesResult(start as number, end as number));
		const view = mount();
		expect(await view.openFile('C:\repo\huge.log', { indexed: true })).toBe(true);
		await flush();
		expect(view.root.querySelectorAll('.fast-row').length).toBeGreaterThan(0);
		expect(backend.callsTo('indexed_open')).toHaveLength(1);
		expect(backend.callsTo('viewer_open')).toHaveLength(0);
		expect(backend.callsTo('viewer_symbols')).toHaveLength(0); // no outline without a rope
		// The find bar scans through the indexed backend.
		view.openFind();
		const input = view.root.querySelector<HTMLInputElement>('.cm-find-input')!;
		input.value = 'line';
		input.dispatchEvent(new Event('input'));
		await new Promise((resolve) => setTimeout(resolve, 350)); // the find debounce
		expect(backend.callsTo('indexed_find').length).toBeGreaterThanOrEqual(1);
		expect(backend.callsTo('viewer_find')).toHaveLength(0);
		view.dispose();
		expect(backend.callsTo('indexed_close').length).toBe(1);
	});

	it('paints a cold window as plain text, then colors it when viewer_highlight lands', async () => {
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: 100_000 }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		// The backend serves a drag past every checkpoint as text-now-colors-later; the
		// colors hang until the test releases them, the way a long catch-up parse does.
		backend.on('viewer_lines', ({ start, end }) => linesResult(start as number, end as number, true));
		let releaseColors: ((value: unknown) => void) | null = null;
		backend.on('viewer_highlight', () => new Promise((resolve) => {
			releaseColors = resolve as (value: unknown) => void;
		}));
		const view = mount();
		await view.openFile('C:\\repo\\huge.rs');
		view.revealLine(50_000);
		await flush();
		// Delivery one: the rows are on screen at once, plain (no token spans), with the
		// color pass asked for but not yet answered.
		const row = view.root.querySelector('.fast-row[data-line="50000"]')!;
		expect(row).not.toBeNull();
		expect(row.querySelector('.fast-code span')).toBeNull();
		expect(backend.callsTo('viewer_highlight').length).toBe(1);

		// Delivery two: the tokens land and re-render the same rows in place.
		releaseColors!({
			startLine: 49_990,
			lineCount: 100_000,
			tokensPending: false,
			lines: Array.from({ length: 21 }, (_, i) => {
				const line = 49_990 + i;
				return [`let v${line} = ${line};`, [[0, 3, 'storage.type.rust']] as [number, number, string][]];
			})
		});
		await flush();
		const colored = view.root.querySelector('.fast-row[data-line="50000"] .fast-code span')!;
		expect(colored).not.toBeNull();
		expect(colored.textContent).toBe('let');
		view.dispose();
	});

	it('keeps the newer range queued when an older highlight walk is superseded', async () => {
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: 100_000 }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		// The first window fetch hangs like a slow open; later ones answer pending.
		let releaseWindow: ((value: unknown) => void) | null = null;
		backend.on('viewer_lines', ({ start, end }) => {
			if (!releaseWindow) {
				return new Promise((resolve) => {
					releaseWindow = resolve as (value: unknown) => void;
				});
			}
			return linesResult(start as number, end as number, true);
		});
		// The first color walk hangs, then comes back superseded — a newer window bumped
		// the backend's generation while it ran.
		let releaseColors: ((resolve: (value: unknown) => void) => void) | null = null;
		backend.on('viewer_highlight', () => new Promise((_resolve, reject) => {
			releaseColors = (resolve) => {
				resolve(undefined);
				reject(new Error('superseded'));
			};
		}));
		const view = mount();
		await view.openFile('C:\\repo\\huge.rs');
		await flush();
		expect(backend.callsTo('viewer_lines').length).toBe(1);

		// Drag while the first window is in flight; release it — the landing fetch serves
		// the dragged-to window pending and queues its colors.
		view.revealLine(50_000);
		await flush();
		releaseWindow!(linesResult(0, 30, true));
		await flush();
		const queued = backend.callsTo('viewer_highlight');
		expect(queued.length).toBe(1);

		// The superseded rejection must not drop the queued range: the pump re-issues it.
		releaseColors!(() => undefined);
		await flush();
		const pumped = backend.callsTo('viewer_highlight');
		expect(pumped.length).toBe(2);
		expect(pumped[1]).toMatchObject({ start: 49_981, end: 50_021 });
		view.dispose();
	});

	it('fills the outline from viewer_symbols after the rows are up', async () => {
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: 200 }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_lines', ({ start, end }) => linesResult(start as number, end as number));
		backend.on('viewer_symbols', () => [{ kind: 'function', name: 'alpha', line: 3 }]);
		const view = mount();
		await view.openFile('C:\\repo\\huge.rs');
		await flush();
		const item = view.root.querySelector('.fast-outline-item') as HTMLElement;
		expect(item).not.toBeNull();
		expect(item.title).toBe('alpha — line 4');
		// The open itself never waited on the outline scan.
		const opens = backend.callsTo('viewer_open');
		expect(opens.length).toBe(1);
		expect((opens[0] as Record<string, unknown>)['symbols']).toBeUndefined();
		view.dispose();
	});
});

describe('the fast viewer wheel (scroll/)', () => {
	/** The distances asserted below are the model's at sensitivity 1 (Zed's default): a
	 *  notch is the system's lines per notch, three on Windows. */
	let heldSensitivity: number;
	beforeEach(() => {
		heldSensitivity = settings.mouseWheelScrollSensitivity;
		settings.mouseWheelScrollSensitivity = 1;
	});
	afterEach(() => {
		settings.mouseWheelScrollSensitivity = heldSensitivity;
	});

	async function openHuge(): Promise<FastView> {
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: 100_000 }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		backend.on('viewer_lines', ({ start, end }) => linesResult(start as number, end as number));
		const view = mount();
		await view.openFile('C:\\repo\\huge.txt');
		await flush();
		return view;
	}

	it('lands a wheel notch at once: three rows, Alt four times that, no frames to wait for', async () => {
		const view = await openHuge();
		const scroller = view.root.querySelector<HTMLElement>('.fast-scroll')!;
		const notch = new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, cancelable: true });
		scroller.dispatchEvent(notch);
		expect(notch.defaultPrevented).toBe(true);
		// Chromium's 100 px notch is the system's three lines: the view moved three rows,
		// in the same task — Zed scrolls the wheel without easing.
		expect(view.scroll.top).toBe(3);
		expect(view.root.querySelector<HTMLElement>('.fast-row[data-line="3"]')!.style.top).toBe('0px');
		scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, altKey: true, cancelable: true }));
		expect(view.scroll.top).toBe(3 + 3 * settings.fastScrollSensitivity);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(view.scroll.top).toBe(3 + 3 * settings.fastScrollSensitivity); // nothing glides afterwards
		scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, deltaMode: 0, cancelable: true }));
		expect(view.scroll.top).toBe(3 * settings.fastScrollSensitivity);
		view.dispose();
	});

	it('a trackpad\'s pixels scroll by the row height, fractions kept', async () => {
		const view = await openHuge();
		const scroller = view.root.querySelector<HTMLElement>('.fast-scroll')!;
		scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 9.5, deltaMode: 0, cancelable: true }));
		expect(view.scroll.top).toBeCloseTo(0.5);
		// The rows follow to the pixel (snapped): row 0 sits ten pixels up.
		expect(view.root.querySelector<HTMLElement>('.fast-row[data-line="0"]')!.style.top).toBe('-10px');
		view.dispose();
	});
});

describe('the fast viewer page keys (scroll/)', () => {
	function page(scroller: HTMLElement, key: 'PageUp' | 'PageDown', mods: { ctrl?: boolean } = {}): KeyboardEvent {
		const event = new KeyboardEvent('keydown', { key, ctrlKey: mods.ctrl ?? false, cancelable: true });
		scroller.dispatchEvent(event);
		return event;
	}

	async function openWith(lineCount: number): Promise<FastView> {
		backend.on('viewer_open', () => ({ ...OPEN, lineCount }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		backend.on('viewer_lines', ({ start, end }) => linesResult(start as number, end as number));
		const view = mount();
		await view.openFile('C:\\repo\\big.txt');
		await flush();
		return view;
	}

	it('pages a viewport less one anchor row - never short, never skipped', async () => {
		const view = await openWith(100_000);
		const scroller = view.root.querySelector<HTMLElement>('.fast-scroll')!;
		// A 380 px viewport is 20 rows: a page is 19 (Zed's ScrollAmount::Page keeps the
		// last row of the old screen as the first of the new).
		page(scroller, 'PageDown');
		expect(view.scroll.top).toBe(19);
		await flush();
		page(scroller, 'PageDown');
		expect(view.scroll.top).toBe(38);
		await flush();
		page(scroller, 'PageUp');
		expect(view.scroll.top).toBe(19);
		page(scroller, 'PageUp');
		expect(view.scroll.top).toBe(0);
		// At the document's head a PageUp is a no-op, not a negative position.
		page(scroller, 'PageUp');
		expect(view.scroll.top).toBe(0);
		// Each landing window was fetched from where the previous one ended (the open fetch
		// covered rows 0..30; the first page asks from 31, the second from 50).
		const calls = backend.callsTo('viewer_lines');
		expect(calls[1]).toMatchObject({ start: 31 });
		expect(calls[2]).toMatchObject({ start: 50 });
		view.dispose();
	});

	it('pages the same rows on a two-million-line document', async () => {
		const view = await openWith(2_000_000);
		const scroller = view.root.querySelector<HTMLElement>('.fast-scroll')!;
		view.scroll.setTop(1_500_000);
		await flush();
		page(scroller, 'PageDown');
		expect(view.scroll.top).toBe(1_500_019);
		page(scroller, 'PageDown');
		expect(view.scroll.top).toBe(1_500_038);
		await flush();
		expect(view.root.querySelector('.fast-row[data-line="1500038"]')).not.toBeNull();
		view.dispose();
	});

	it('leaves Ctrl+PageUp/Down to the workbench (Next / Previous Editor)', async () => {
		const view = await openWith(100_000);
		const scroller = view.root.querySelector<HTMLElement>('.fast-scroll')!;
		const event = page(scroller, 'PageDown', { ctrl: true });
		expect(event.defaultPrevented).toBe(false);
		expect(view.scroll.top).toBe(0);
		view.dispose();
	});
});

describe('the fast viewer whole-file find (docFind.ts)', () => {
	/** Wait out the find bar's 250 ms debounce with real time. */
	async function settle(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 300));
		await flush();
	}

	it('counts matches over the whole file, steps through them, and never offers replace', async () => {
		const file = ['needle one', 'plain', 'needle two', 'plain'];
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: file.length }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_lines', ({ start, end }) => ({
			startLine: start,
			lineCount: file.length,
			lines: file.slice(start, end + 1).map((text) => [text, []] as [string, [number, number, string][]])
		}));
		// The faithful viewer_find mock: single-line matches, 0-based lines, code-point columns.
		backend.on('viewer_find', ({ query }: { query: string }) => {
			const needle = String(query).toLowerCase();
			const matches: { line: number; startCol: number; endCol: number }[] = [];
			file.forEach((line, index) => {
				const chars = Array.from(line.toLowerCase());
				let at = 0;
				while (at + needle.length <= chars.length) {
					if (chars.slice(at, at + needle.length).join('') === needle) {
						matches.push({ line: index, startCol: at, endCol: at + needle.length });
						at += needle.length;
					} else at++;
				}
			});
			return { matches, capped: false };
		});
		const view = mount();
		await view.openFile('C:\repo\huge.txt');
		await flush();
		view.openFind();
		await flush();
		const bar = view.root.querySelector('.cm-find-widget') as HTMLElement;
		expect(bar.hidden).toBe(false);
		const input = bar.querySelector('.cm-find-input') as HTMLInputElement;
		input.value = 'needle';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(bar.querySelector('.cm-find-count')!.textContent).toBe('1 of 2');
		// The current match carries the stronger mark on its rendered row.
		const current = view.root.querySelector('mark.fast-match.current');
		expect(current?.textContent).toBe('needle');
		const next = [...bar.querySelectorAll('.cm-find-btn')].find((b) => (b as HTMLElement).title.startsWith('Next Match')) as HTMLElement;
		next.click();
		await settle();
		// Stepped to the match on line 2 — its row re-rendered with the current mark.
		expect(view.root.querySelector('mark.fast-match.current')?.textContent).toBe('needle');
		// A read-only surface: no replace row controls at all.
		expect(bar.querySelector('.cm-replace-row')!.childElementCount).toBe(0);
		view.dispose();
	});
});
