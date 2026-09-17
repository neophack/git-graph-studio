import { beforeEach, describe, expect, it } from 'vitest';

import { EditorView } from '@codemirror/view';

import { EditorGroup } from '../src/editor';
import { t } from '../src/i18n';
import { settings, updateSetting, DEFAULT_SETTINGS } from '../src/settings';
import { backend } from './tauriMock';
import { texts } from './helpers';


/** The plain-text file the tests open: nested brackets on one line, an indented block below. */
const FILE = 'C:\\repo\\code.txt';
const CONTENT = '(((x)))\nfn outer() {\n    let a = [1, (2)];\n}\n';

/** The plugins redraw on an animation frame (or a 0 ms timeout in jsdom); 50 ms covers both. */
const frame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe('editor decorations (M3 3.2)', () => {
	let group: EditorGroup;

	beforeEach(async () => {
		updateSetting('minimap', true);
		updateSetting('stickyScroll', true);
		updateSetting('bracketColors', true);
		const part = document.getElementById('editorGroup')!;
		part.innerHTML = '';
		backend.on('read_file', () => ({ contents: CONTENT, binary: false, size: CONTENT.length }));
		group = new EditorGroup(part);
		group.setRoot('C:\\repo');
		await group.openFile(FILE);
		await frame();
	});

	it('colours brackets by nesting depth, and the setting turns it off', async () => {
		// A plain-text file has no syntax tree, so every bracket counts: ((( is depth 0, 1, 2.
		const classes = Array.from(document.querySelectorAll('[class*="cm-bracket-"]')).map((e) => e.className);
		expect(classes).toContain('cm-bracket-0');
		expect(classes).toContain('cm-bracket-1');
		expect(classes).toContain('cm-bracket-2');

		updateSetting('bracketColors', false);
		await frame();
		expect(document.querySelectorAll('[class*="cm-bracket-"]').length).toBe(0);
		updateSetting('bracketColors', true);
		await frame();
		expect(document.querySelectorAll('.cm-bracket-0').length).toBeGreaterThan(0);
	});

	it('shows the minimap element, and the setting hides it', async () => {
		expect(document.querySelector('.cm-minimap')).not.toBeNull();
		expect(group.activeView!.dom.classList.contains('has-minimap')).toBe(true);

		updateSetting('minimap', false);
		await frame();
		expect((document.querySelector('.cm-minimap') as HTMLElement).style.display).toBe('none');
		expect(group.activeView!.dom.classList.contains('has-minimap')).toBe(false);
	});

	it('a minimap drag keeps the slider’s centre under the pointer', async () => {
		// jsdom has no layout, so the geometry the drag and the slider share is stubbed: a
		// 600 px painted map inside an 800 px column (shorter than the column — measuring
		// the drag against the column instead of the map is what parked the slider off the
		// pointer), a 6000 px scroll range and a 500 px viewport.
		const view = group.activeView!;
		const scroll = view.scrollDOM;
		const root = view.dom.querySelector('.cm-minimap') as HTMLElement;
		const canvas = view.dom.querySelector('.cm-minimap-canvas') as HTMLCanvasElement;
		const slider = view.dom.querySelector('.cm-minimap-slider') as HTMLElement;
		root.getBoundingClientRect = () => new DOMRect(900, 100, 86, 800);
		canvas.width = 84;
		canvas.height = 600;
		canvas.getBoundingClientRect = () => new DOMRect(901, 100, 84, 600);
		Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 6000 });
		Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
		let scrollTop = 0;
		Object.defineProperty(scroll, 'scrollTop', {
			configurable: true,
			get: () => scrollTop,
			// The browser clamps to the scrollable range; model that or the drag's ends cheat.
			set: (v: number) => { scrollTop = Math.max(0, Math.min(5500, v)); }
		});
		const sliderCentre = (): number => parseFloat(slider.style.top) + parseFloat(slider.style.height) / 2;

		root.dispatchEvent(new MouseEvent('mousedown', { clientY: 400 })); // mid-map
		scroll.dispatchEvent(new Event('scroll'));
		await frame();
		expect(scrollTop).toBe(2750); // 0.5 * 6000 - 250
		expect(sliderCentre()).toBeCloseTo(300); // the pointer's y on the map

		document.dispatchEvent(new MouseEvent('mousemove', { clientY: 250 })); // a quarter down
		scroll.dispatchEvent(new Event('scroll'));
		await frame();
		expect(scrollTop).toBe(1250); // 0.25 * 6000 - 250
		expect(sliderCentre()).toBeCloseTo(150);
		document.dispatchEvent(new MouseEvent('mouseup'));
	});

	it('the wheel over the minimap scrolls the editor (the overlay is not a dead strip)', async () => {
		// The map is the scroller's sibling: a wheel event on it never bubbles through the
		// smooth-wheel listener, so the strip used to scroll nothing at all.
		const view = group.activeView!;
		const scroll = view.scrollDOM;
		Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 6000 });
		Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
		let scrollTop = 0;
		Object.defineProperty(scroll, 'scrollTop', {
			configurable: true,
			get: () => scrollTop,
			set: (v: number) => { scrollTop = Math.max(0, Math.min(5500, v)); }
		});
		// The asserted distance is Zed's at sensitivity 1: a Chromium notch is the system's
		// three lines, times the line height.
		const sensitivity = settings.mouseWheelScrollSensitivity;
		settings.mouseWheelScrollSensitivity = 1;
		try {
			const minimap = view.dom.querySelector('.cm-minimap')!;
			const notch = new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, cancelable: true });
			minimap.dispatchEvent(notch);
			expect(notch.defaultPrevented).toBe(true);
			// The forwarded notch moves the editor's scroller three lines, at once.
			expect(scrollTop).toBe(3 * view.defaultLineHeight);
		} finally {
			settings.mouseWheelScrollSensitivity = sensitivity;
		}
	});

	it('the wheel over the editor is Zed\'s: a notch lands three lines at once, Alt four times that, a trackpad its pixels', async () => {
		// The wheel extension (editorExtras.ts over scroll/wheel.ts): no easing, no frames to
		// wait for. jsdom has no layout, so the range is stubbed the way the minimap drag
		// test stubs it.
		const view = group.activeView!;
		const scroll = view.scrollDOM;
		Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 6000 });
		Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
		let top = 0;
		Object.defineProperty(scroll, 'scrollTop', {
			configurable: true,
			get: () => top,
			set: (v: number) => { top = Math.max(0, Math.min(5500, v)); }
		});
		const sensitivity = settings.mouseWheelScrollSensitivity;
		settings.mouseWheelScrollSensitivity = 1;
		try {
			const line = view.defaultLineHeight;
			const notch = new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, cancelable: true });
			scroll.dispatchEvent(notch);
			expect(notch.defaultPrevented).toBe(true);
			expect(top).toBe(3 * line);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(top).toBe(3 * line); // nothing glides afterwards
			scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, altKey: true, cancelable: true }));
			expect(top).toBe(3 * line + 3 * line * settings.fastScrollSensitivity);
			// A trackpad's odd pixel count passes through as pixels.
			const before = top;
			scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: 7.5, deltaMode: 0, cancelable: true }));
			expect(top).toBe(before + 7.5);
			// Ctrl+wheel is the workbench's (zoom): left alone.
			const zoom = new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: true, cancelable: true });
			scroll.dispatchEvent(zoom);
			expect(zoom.defaultPrevented).toBe(false);
		} finally {
			settings.mouseWheelScrollSensitivity = sensitivity;
		}
	});

	it('sticky scroll stays hidden without a layout instead of throwing', async () => {
		// jsdom has no layout: posAtCoords throws and the overlay must hide, not crash.
		expect(() => updateSetting('stickyScroll', true)).not.toThrow();
		await frame();
		const overlay = document.querySelector('.cm-sticky') as HTMLElement | null;
		expect(overlay === null || overlay.style.display === 'none').toBe(true);
	});

	it('sticky scroll locates the top line from the scroller’s viewport rect', async () => {
		// posAtCoords takes viewport (client) coordinates, and the editor sits below the
		// titlebar / tabs — a y of 2 would land above the document and pin the overlay to
		// line 1 forever. The rect is stubbed non-zero so the coordinates handed over are
		// observable; the position stub stands in for the layout jsdom does not have.
		const view = group.activeView!;
		const rect = new DOMRect(100, 200, 800, 600);
		view.scrollDOM.getBoundingClientRect = () => rect;
		const calls: { x: number; y: number }[] = [];
		view.posAtCoords = ((coords: { x: number; y: number }) => {
			calls.push({ ...coords });
			return view.state.doc.line(3).from; // as if the viewport top sat inside the block
		}) as EditorView['posAtCoords'];
		view.scrollDOM.dispatchEvent(new Event('scroll'));
		await frame();
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]).toEqual({ x: rect.left + rect.width / 2, y: rect.top + 2 });
		const overlay = view.dom.querySelector('.cm-sticky') as HTMLElement;
		expect(overlay.style.display).not.toBe('none');
		expect(texts('.cm-sticky-line', overlay)).toEqual(['fn outer() {']);
	});

	it('minimap and bracket colours default to on, sticky scroll to off', () => {
		expect(DEFAULT_SETTINGS.minimap).toBe(true);
		expect(DEFAULT_SETTINGS.stickyScroll).toBe(false);
		expect(DEFAULT_SETTINGS.bracketColors).toBe(true);
		// The settings dialog renders a labelled row per setting once open (smoke: the keys
		// exist in the i18n table, so `t()` resolves rather than echoing the key).
		for (const key of ['minimap', 'stickyScroll', 'bracketColors']) {
			expect(t(`settings.${key}` as 'settings.minimap')).not.toBe(`settings.${key}`);
		}
	});
});
