// The fast code viewer's line fetching: a failed `viewer_lines` call must not wedge the
// affected lines — the next refresh re-requests them and the rows render. A cold window is
// two deliveries (plain rows, then `viewer_highlight` colors), and the outline is the
// backend's third, `viewer_symbols`, asked for after the rows are up.

import { describe, expect, it } from 'vitest';

import { FastView } from '../src/fastView';
import { updateSetting } from '../src/settings';
import { MAX_SCROLL_PX } from '../src/ui';
import { backend } from './tauriMock';
import { flush } from './helpers';

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
		const view = new FastView(document.getElementById('editorGroup')!);
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
		const view = new FastView(document.getElementById('editorGroup')!);
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
		held(linesResult(0, 20));
		await flush();
		const calls = backend.callsTo('viewer_lines');
		expect(calls.length).toBe(2);
		expect(calls[1]).toMatchObject({ start: 49_990, end: 50_010 });
		expect(view.root.querySelector('.fast-row[data-line="50000"]')).not.toBeNull();
		view.dispose();
	});

	it('scrolls a multi-million-line file to its end, past the engines\' height clamp', async () => {
		// 2,000,000 lines at 19 px is 38M px of document; the engines clamp near 33.5M px,
		// which used to strand the tail behind a spacer the scrollbar could not move past.
		// The clamped, scaled range keeps the last lines reachable.
		const LINES = 2_000_000;
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: LINES }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		backend.on('viewer_lines', ({ start, end }) => linesResult(start as number, end as number));
		const view = new FastView(document.getElementById('editorGroup')!);
		await view.openFile('C:\\repo\\huge.txt');
		await flush();
		expect(Number.parseInt(view.root.querySelector<HTMLElement>('.fast-spacer')!.style.height, 10)).toBe(MAX_SCROLL_PX);
		// The scrollbar dragged to its bottom maps to the document's end: the final lines
		// fetch and render (the unscaled spacer ended ~300k lines short of them).
		const scroller = view.root.querySelector<HTMLElement>('.fast-scroll')!;
		scroller.scrollTop = MAX_SCROLL_PX;
		scroller.dispatchEvent(new Event('scroll'));
		await flush();
		expect(view.root.querySelector(`.fast-row[data-line="${LINES - 10}"]`)).not.toBeNull();
		// And they render *in the viewport*, not merely fetched: each row's content offset
		// sits within a viewport-and-overscan band of the scroll position (a row placed at
		// its bare document offset lands `scrollTop` pixels above the viewport — blank).
		for (const row of Array.from(view.root.querySelectorAll<HTMLElement>('.fast-row'))) {
			const top = Number.parseInt(row.style.top, 10);
			expect(top).toBeGreaterThan(MAX_SCROLL_PX - 1000);
			expect(top).toBeLessThan(MAX_SCROLL_PX + 1000);
		}
		view.dispose();
	});

	it('adopts the staged open\'s exact line count when the tail lands', async () => {
		// A huge file opens on its head: the count the scroller starts with is an estimate,
		// and the background tail's landing event replaces it in place.
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: 1_900_000 }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		backend.on('viewer_lines', ({ start, end }) => linesResult(start as number, end as number));
		const view = new FastView(document.getElementById('editorGroup')!);
		await view.openFile('C:\\repo\\huge.txt');
		await flush();
		expect(view.lineCount).toBe(1_900_000);
		backend.emit('studio://viewer-lines', { docId: view.docId, lineCount: 2_000_000 });
		await flush();
		// The scroller's range follows: the spacer carries the exact count's height.
		expect(view.lineCount).toBe(2_000_000);
		expect(Number.parseInt(view.root.querySelector<HTMLElement>('.fast-spacer')!.style.height, 10)).toBeGreaterThan(1_999_000 * 19 / 2);
		// Another document's landing is not this one's business.
		backend.emit('studio://viewer-lines', { docId: 999, lineCount: 50 });
		await flush();
		expect(view.lineCount).toBe(2_000_000);
		view.dispose();
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
		const view = new FastView(document.getElementById('editorGroup')!);
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
		const view = new FastView(document.getElementById('editorGroup')!);
		await view.openFile('C:\\repo\\huge.rs');
		await flush();
		expect(backend.callsTo('viewer_lines').length).toBe(1);

		// Drag while the first window is in flight; release it — the landing fetch serves
		// the dragged-to window pending and queues its colors.
		view.revealLine(50_000);
		await flush();
		releaseWindow!(linesResult(0, 20, true));
		await flush();
		const queued = backend.callsTo('viewer_highlight');
		expect(queued.length).toBe(1);

		// The superseded rejection must not drop the queued range: the pump re-issues it.
		releaseColors!(() => undefined);
		await flush();
		const pumped = backend.callsTo('viewer_highlight');
		expect(pumped.length).toBe(2);
		expect(pumped[1]).toMatchObject({ start: 49_990, end: 50_010 });
		view.dispose();
	});

	it('fills the outline from viewer_symbols after the rows are up', async () => {
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: 200 }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_lines', ({ start, end }) => linesResult(start as number, end as number));
		backend.on('viewer_symbols', () => [{ kind: 'function', name: 'alpha', line: 3 }]);
		const view = new FastView(document.getElementById('editorGroup')!);
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

describe('the fast viewer smooth wheel glide (ui.ts)', () => {
	/** Pump frames until `done` holds (the 125 ms glide needs a handful of jsdom's ~16 ms
	 *  animation frames to land; the cap bounds a starved clock). */
	async function pumpUntil(done: () => boolean): Promise<void> {
		for (let i = 0; i < 50 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 16));
	}

	async function openHuge(): Promise<FastView> {
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: 100_000 }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_symbols', () => []);
		backend.on('viewer_lines', ({ start, end }) => linesResult(start as number, end as number));
		const view = new FastView(document.getElementById('editorGroup')!);
		await view.openFile('C:\\repo\\huge.txt');
		await flush();
		return view;
	}

	it('eases a wheel notch to its position instead of jumping it there', async () => {
		const view = await openHuge();
		const scroller = view.root.querySelector<HTMLElement>('.fast-scroll')!;
		const notch = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
		scroller.dispatchEvent(notch);
		// The notch is intercepted, and the glide starts from rest: before the first frame
		// the position has not moved at all — a native wheel would already have jumped.
		expect(notch.defaultPrevented).toBe(true);
		expect(scroller.scrollTop).toBe(0);
		// VS Code's notch distance everywhere: 120 px of browser delta × 50/40 = 150 px.
		await pumpUntil(() => scroller.scrollTop >= 150);
		expect(scroller.scrollTop).toBe(150);
		// Alt holds the fast-scroll factor (VS Code's fastScrollSensitivity, default 5).
		scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, altKey: true, cancelable: true }));
		await pumpUntil(() => scroller.scrollTop >= 150 + 750);
		expect(scroller.scrollTop).toBe(900);
		view.dispose();
	});

	it('stacks a second notch onto the running glide, and leaves the wheel alone when the setting is off', async () => {
		const view = await openHuge();
		const scroller = view.root.querySelector<HTMLElement>('.fast-scroll')!;
		scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }));
		await pumpUntil(() => scroller.scrollTop > 0);
		// Mid-glide: part of the way to the first notch, and the second re-targets the same
		// glide to 300 rather than restarting it from zero.
		const mid = scroller.scrollTop;
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(150);
		scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }));
		await pumpUntil(() => scroller.scrollTop >= 300);
		expect(scroller.scrollTop).toBe(300);
		view.dispose();

		// The setting off: the wheel is not prevented and nothing moves it but the platform.
		updateSetting('smoothScrolling', false);
		const plain = await openHuge();
		const off = plain.root.querySelector<HTMLElement>('.fast-scroll')!;
		const notch = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
		off.dispatchEvent(notch);
		expect(notch.defaultPrevented).toBe(false);
		// Plenty of frames for a glide that must not exist.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(off.scrollTop).toBe(0);
		updateSetting('smoothScrolling', true);
		plain.dispose();
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
		const view = new FastView(document.getElementById('editorGroup')!);
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
