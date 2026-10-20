// The image viewer (module 7): the pure geometry (fit, zoom about a point, the ladder,
// the screen → pixel inverse, the rubber band), the pointer gesture recognizer (tap,
// double tap, long press, pan, pinch), and the view an image file opens in — its toolbar,
// wheel, drag, keyboard, touch pinch / double tap / gallery swipe, the information panel,
// the folder gallery, the context menu and the in-place reload.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EditorGroup } from '../src/features/editor';
import { GestureRecognizer } from '../src/features/viewers/imageGestures';
import {
	aspectRatio, clampPan, fitScale, identity, naturalSort, panLimits, rotatedSize, rubberBand, screenToImage, stepZoom, wheelFactor, zoomAround,
	type ImageTransform
} from '../src/features/viewers/imageModel';
import type { ImageView } from '../src/features/viewers/imageView';
import { backend } from './tauriMock';
import { click, flush, key, menuItem, menuLabels, rightClick } from './helpers';

const REPO = 'C:\\repo';
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const VIEW = { width: 800, height: 600 };
const NATURAL = { width: 1600, height: 1200 };

beforeAll(() => {
	// jsdom has no 2D canvas (it logs every attempt): the pixel inspector simply reads nothing.
	HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
	vi.useRealTimers();
});

describe('image geometry', () => {
	it('fits contain-wise, never upscaling a small image, a quarter turn swapping the sides', () => {
		expect(fitScale(VIEW, NATURAL, 0)).toBe(0.5);
		expect(fitScale(VIEW, NATURAL, 90)).toBe(0.375);
		expect(fitScale(VIEW, { width: 16, height: 16 }, 0)).toBe(1);
		expect(fitScale(VIEW, { width: 16, height: 16 }, 0, true)).toBe(37.5);
		expect(rotatedSize(NATURAL, 270)).toEqual({ width: 1200, height: 1600 });
	});

	it('zooms about a point: the image pixel under it stays under it', () => {
		const t: ImageTransform = { ...identity(), scale: 0.5 };
		const before = screenToImage(VIEW, NATURAL, t, 600, 150)!;
		const after = zoomAround(t, 2, 600 - VIEW.width / 2, 150 - VIEW.height / 2);
		expect(screenToImage(VIEW, NATURAL, after, 600, 150)).toEqual(before);
	});

	it('maps the screen to image pixels through rotation and flips', () => {
		const t: ImageTransform = { ...identity(), scale: 0.375, rotation: 90 };
		// Rotated a quarter clockwise, the image's top-left corner sits at the top-right.
		const shown = rotatedSize(NATURAL, 90);
		const right = VIEW.width / 2 + (shown.width * 0.375) / 2 - 1;
		const top = VIEW.height / 2 - (shown.height * 0.375) / 2 + 1;
		const corner = screenToImage(VIEW, NATURAL, t, right, top)!;
		expect(corner.x).toBeLessThan(4);
		expect(corner.y).toBeLessThan(4);
		const flipped = screenToImage(VIEW, NATURAL, { ...identity(), scale: 0.5, flipH: true }, 1, 300)!;
		expect(flipped.x).toBeGreaterThan(NATURAL.width - 4);
		expect(screenToImage(VIEW, NATURAL, { ...identity(), scale: 0.5 }, 799, 1)).not.toBeNull();
		expect(screenToImage(VIEW, NATURAL, { ...identity(), scale: 0.25 }, 10, 10)).toBeNull(); // the margin
	});

	it('steps the zoom ladder, landing on 100% and on Fit when it crosses them', () => {
		expect(stepZoom(0.9, 1, 0.3)).toBe(1);
		expect(stepZoom(1.1, -1, 0.3)).toBe(1);
		expect(stepZoom(0.35, -1, 0.3)).toBe(0.3);
		expect(stepZoom(1, 1, 0.3)).toBe(1.25);
		expect(wheelFactor(-100, 0)).toBe(1.25);
		expect(wheelFactor(100, 0)).toBeCloseTo(0.8);
		expect(wheelFactor(-10_000, 0)).toBe(2); // one event never jumps past 2×
	});

	it('bounds the pan to the overhang and bands the overshoot', () => {
		const t: ImageTransform = { ...identity(), scale: 1, x: 900, y: -10 };
		expect(panLimits(VIEW, NATURAL, t)).toEqual({ x: 400, y: 300 });
		expect(clampPan(VIEW, NATURAL, t)).toMatchObject({ x: 400, y: -10 });
		expect(rubberBand(300, 400, 800)).toBe(300);
		const banded = rubberBand(900, 400, 800);
		expect(banded).toBeGreaterThan(400);
		expect(banded).toBeLessThan(900);
		expect(rubberBand(2000, 400, 800)).toBeGreaterThan(banded);
	});

	it('reads ratios and sorts names the way a file manager does', () => {
		expect(aspectRatio(1920, 1080)).toBe('16:9');
		expect(aspectRatio(1600, 1200)).toBe('4:3');
		expect(aspectRatio(1000, 3)).toBe('333.33:1');
		expect(naturalSort(['img10.png', 'img2.png', 'Img1.png'])).toEqual(['Img1.png', 'img2.png', 'img10.png']);
	});
});

function pointer(target: Element, type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
	// A pointer's last button releasing reports no buttons held; a chorded release (one
	// button of several lifting) reports the survivor — the real semantics the
	// recognizer's chord handling reads.
	const released = type === 'pointerup' || type === 'pointercancel';
	const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: released ? 0 : 1, ...init });
	target.dispatchEvent(event);
	return event;
}

describe('image gestures', () => {
	const recognizer = () => {
		const element = document.createElement('div');
		document.body.append(element);
		const calls: string[] = [];
		const record = (name: string) => (...args: unknown[]) => calls.push(`${name}(${args.map((a) => (typeof a === 'number' ? Math.round(a * 100) / 100 : a)).join(',')})`);
		new GestureRecognizer(element, {
			tap: record('tap'), doubleTap: record('doubleTap'), longPress: record('longPress'),
			panStart: record('panStart'), pan: record('pan'), pinchStart: record('pinchStart'), pinch: record('pinch'),
			end: (vx, vy, kind, cancelled) => calls.push(`end(${kind},${cancelled})`)
		});
		return { element, calls };
	};

	it('tells a mouse tap from a double tap', () => {
		const { element, calls } = recognizer();
		pointer(element, 'pointerdown', 50, 50);
		pointer(element, 'pointerup', 50, 50);
		pointer(element, 'pointerdown', 52, 50);
		pointer(element, 'pointerup', 52, 50);
		expect(calls).toEqual(['tap(50,50,mouse)', 'doubleTap(52,50,mouse)']);
	});

	it('waits out the double-tap window before a finger\'s single tap, and fires a long press', () => {
		vi.useFakeTimers();
		const { element, calls } = recognizer();
		pointer(element, 'pointerdown', 10, 10, { pointerType: 'touch' });
		pointer(element, 'pointerup', 10, 10, { pointerType: 'touch' });
		expect(calls).toEqual([]);
		vi.advanceTimersByTime(300);
		expect(calls).toEqual(['tap(10,10,touch)']);
		pointer(element, 'pointerdown', 20, 20, { pointerType: 'touch', pointerId: 2 });
		vi.advanceTimersByTime(600);
		pointer(element, 'pointerup', 20, 20, { pointerType: 'touch', pointerId: 2 });
		vi.advanceTimersByTime(600);
		expect(calls).toEqual(['tap(10,10,touch)', 'longPress(20,20,touch)']); // no tap after the press
	});

	it('reports a drag past the slop as pan steps', () => {
		const { element, calls } = recognizer();
		pointer(element, 'pointerdown', 10, 10);
		pointer(element, 'pointermove', 11, 10); // inside the slop
		pointer(element, 'pointermove', 30, 10);
		pointer(element, 'pointermove', 40, 15);
		pointer(element, 'pointerup', 40, 15);
		expect(calls).toEqual(['panStart(10,10,mouse)', 'pan(20,0,30,10)', 'pan(10,5,40,15)', 'end(mouse,false)']);
	});

	it('pinches about the two fingers\' centroid, carrying on as a pan when one lifts', () => {
		const { element, calls } = recognizer();
		const touch = (type: string, id: number, x: number, y: number) => pointer(element, type, x, y, { pointerType: 'touch', pointerId: id, isPrimary: id === 1 });
		touch('pointerdown', 1, 100, 100);
		touch('pointerdown', 2, 200, 100);
		touch('pointermove', 2, 300, 100);
		touch('pointerup', 2, 300, 100);
		touch('pointermove', 1, 110, 100);
		touch('pointerup', 1, 110, 100);
		expect(calls).toEqual(['pinchStart(150,100)', 'pinch(2,200,100,50,0)', 'panStart(100,100,touch)', 'pan(10,0,110,100)', 'end(touch,false)']);
	});

	it('a new press inside the double-tap window kills the pending tap instead of firing it mid-gesture', () => {
		vi.useFakeTimers();
		const { element, calls } = recognizer();
		pointer(element, 'pointerdown', 10, 10, { pointerType: 'touch' });
		pointer(element, 'pointerup', 10, 10, { pointerType: 'touch' });
		// The second finger lands before the window lapsed: the first tap's timer dies
		// with the press — it never fires underneath the drag that follows.
		pointer(element, 'pointerdown', 200, 200, { pointerType: 'touch', pointerId: 2 });
		vi.advanceTimersByTime(300);
		expect(calls).toEqual([]);
		pointer(element, 'pointermove', 260, 200, { pointerType: 'touch', pointerId: 2 });
		pointer(element, 'pointerup', 260, 200, { pointerType: 'touch', pointerId: 2 });
		expect(calls).toEqual(['panStart(200,200,touch)', 'pan(60,0,260,200)', 'end(touch,false)']);
		vi.useRealTimers();
	});

	it('a chorded mouse press and release neither resets nor ends the drag in flight', () => {
		// One mouse, several buttons: every button shares the one pointer id, so a
		// chorded press must not restart the gesture (mode press, samples wiped) and a
		// mid-chord release must not end it short (or fire a phantom tap).
		const { element, calls } = recognizer();
		pointer(element, 'pointerdown', 10, 10);
		pointer(element, 'pointermove', 40, 10); // the left button's drag
		pointer(element, 'pointerdown', 40, 10, { button: 1, buttons: 5 }); // the middle joins
		pointer(element, 'pointermove', 50, 10);
		pointer(element, 'pointerup', 50, 10, { button: 1, buttons: 1 }); // the middle lifts, the left holds
		pointer(element, 'pointermove', 60, 10);
		pointer(element, 'pointerup', 60, 10, { buttons: 0 }); // the last button: the gesture ends
		expect(calls).toEqual(['panStart(10,10,mouse)', 'pan(30,0,40,10)', 'pan(10,0,50,10)', 'pan(10,0,60,10)', 'end(mouse,false)']);
	});

	it('rebaselines the pinch when one of three fingers lifts — the next move is a step, not the old pair\'s jump', () => {
		const { element, calls } = recognizer();
		const touch = (type: string, id: number, x: number, y: number) => pointer(element, type, x, y, { pointerType: 'touch', pointerId: id, isPrimary: id === 1 });
		touch('pointerdown', 1, 100, 100);
		touch('pointerdown', 2, 150, 100); // the first pair's baseline: 50 px
		touch('pointerdown', 3, 400, 100);
		touch('pointerup', 1, 100, 100); // three → two: the remaining pair (250 px) is the fresh baseline
		touch('pointermove', 2, 152, 100); // 248/250 ≈ 1.0 — a step. Without the rebaseline: 248/50 ≈ 5×.
		touch('pointerup', 2, 152, 100);
		touch('pointerup', 3, 400, 100);
		const pinches = calls.filter((call) => call.startsWith('pinch('));
		expect(pinches).toHaveLength(1);
		const recorded = pinches[0]!;
		expect(Number(recorded.slice('pinch('.length, recorded.indexOf(',')))).toBeLessThan(1.1);
		expect(calls.at(-1)).toBe('end(touch,false)');
	});
});

function size(element: HTMLElement, width: number, height: number): void {
	Object.defineProperty(element, 'clientWidth', { configurable: true, value: width });
	Object.defineProperty(element, 'clientHeight', { configurable: true, value: height });
}

async function openImage(name = 'photo.png', natural = NATURAL) {
	backend.on('read_file_base64', () => PNG);
	const group = new EditorGroup(document.getElementById('editorGroup')!);
	group.setRoot(REPO);
	const path = `${REPO}\\${name}`;
	await group.openFile(path);
	await flush();
	const editors = (group as unknown as { open: { input: { kind: string; path?: string }; image?: ImageView; pane: HTMLElement }[] }).open;
	const editor = editors.find((e) => e.input.path === path)!;
	const root = editor.pane.querySelector<HTMLElement>('.image-viewer')!;
	const stage = root.querySelector<HTMLElement>('.image-viewer-stage')!;
	const image = root.querySelector<HTMLImageElement>('img.image-viewer-img')!;
	size(stage, VIEW.width, VIEW.height);
	Object.defineProperty(image, 'naturalWidth', { configurable: true, value: natural.width });
	Object.defineProperty(image, 'naturalHeight', { configurable: true, value: natural.height });
	image.dispatchEvent(new Event('load'));
	const button = (title: string) => [...root.querySelectorAll<HTMLButtonElement>('.image-viewer-toolbar button')].find((b) => b.title.startsWith(title))!;
	return { group, path, editors, root, stage, image, view: editor.image!, button, zoom: () => root.querySelector('.image-viewer-zoom')!.textContent };
}

describe('image viewer', () => {
	it('opens an image fitted, with the zoom, fit and 1:1 controls', async () => {
		const { root, image, view, button, zoom } = await openImage();
		expect(backend.callsTo('read_file')).toEqual([]); // never read as text
		// One decoded copy behind a blob URL where the platform has object URLs, the data URL otherwise.
		expect(image.src).toMatch(/^blob:|^data:image\/png;base64,/);
		expect(root.querySelector<HTMLImageElement>('.image-viewer-nav-thumb')!.src).toBe(image.src);
		expect(root.closest('.editor-pane')!.classList.contains('image-preview')).toBe(true);
		expect(view.state).toMatchObject({ scale: 0.5, mode: 'fit' });
		expect(zoom()).toBe('50%');
		expect(button('Fit to Window').getAttribute('aria-pressed')).toBe('true');
		click(button('Zoom In'));
		expect(view.state.scale).toBe(0.625);
		expect(button('Fit to Window').getAttribute('aria-pressed')).toBe('false');
		click(button('Actual Size'));
		expect(zoom()).toBe('100%');
		click(button('Fit to Window'));
		expect(view.state).toMatchObject({ scale: 0.5, x: 0, y: 0, mode: 'fit' });
		expect(root.querySelector('.image-viewer-status')!.textContent).toContain('1600 × 1200 px');
		expect(root.hasAttribute('data-owns-gestures')).toBe(true); // the phone's page pager yields to it
	});

	it('zooms with the wheel at the cursor, a notch a ladder step', async () => {
		const { stage, view, zoom } = await openImage();
		const notch = (deltaY: number, x = 600, y = 150) => {
			const event = new WheelEvent('wheel', { deltaY, clientX: x, clientY: y, cancelable: true });
			stage.dispatchEvent(event);
			return event;
		};
		const before = screenToImage(VIEW, NATURAL, view.state, 600, 150);
		expect(notch(-100).defaultPrevented).toBe(true);
		expect(zoom()).toBe('63%');
		expect(screenToImage(VIEW, NATURAL, view.state, 600, 150)).toEqual(before);
		notch(100);
		expect(view.state.mode).toBe('fit'); // back on the fit scale exactly
		const horizontal = new WheelEvent('wheel', { deltaX: 100, deltaY: 0, cancelable: true });
		stage.dispatchEvent(horizontal);
		expect(horizontal.defaultPrevented).toBe(false); // nothing to pan at fit: the page's
	});

	it('pans with a mouse drag, clamped to the image\'s edges', async () => {
		const { stage, view, button } = await openImage();
		click(button('Actual Size'));
		pointer(stage, 'pointerdown', 400, 300);
		pointer(stage, 'pointermove', 900, 300);
		pointer(stage, 'pointermove', 1400, 350);
		pointer(stage, 'pointerup', 1400, 350);
		expect(view.state).toMatchObject({ scale: 1, x: 400, y: 50 });
		// At fit there is nothing to pan: the drag is ignored, not banded.
		click(button('Fit to Window'));
		pointer(stage, 'pointerdown', 400, 300);
		pointer(stage, 'pointermove', 500, 300);
		pointer(stage, 'pointerup', 500, 300);
		expect(view.state).toMatchObject({ x: 0, y: 0, mode: 'fit' });
	});

	it('toggles Fit and 100% with a double click', async () => {
		const { stage, view } = await openImage();
		const dblclick = () => {
			for (let i = 0; i < 2; i++) {
				pointer(stage, 'pointerdown', 400, 300);
				pointer(stage, 'pointerup', 400, 300);
			}
		};
		dblclick();
		expect(view.state).toMatchObject({ scale: 1, mode: 'free' });
		await new Promise((resolve) => setTimeout(resolve, 300)); // a new click pair
		dblclick();
		expect(view.state).toMatchObject({ scale: 0.5, mode: 'fit' });
	});

	it('drives every action from the keyboard', async () => {
		const { root, view } = await openImage();
		key(root, 'r');
		expect(view.state).toMatchObject({ rotation: 90, scale: 0.375 });
		// Quarter-turned, the screen's horizontal flip is the image's vertical one.
		key(root, 'h');
		expect(view.state).toMatchObject({ flipH: false, flipV: true });
		key(root, 'R', { shiftKey: true });
		expect(view.state.rotation).toBe(0);
		key(root, '1');
		expect(view.state.scale).toBe(1);
		const panned = key(root, 'ArrowLeft');
		expect(panned.defaultPrevented).toBe(true);
		expect(view.state.x).toBe(120);
		key(root, '0');
		expect(view.state.mode).toBe('fit');
		key(root, 'w');
		expect(view.state).toMatchObject({ mode: 'fitWidth', scale: 0.5 });
		expect(key(root, 'w', { ctrlKey: true }).defaultPrevented).toBe(false); // chords stay the workbench's
		expect(key(root, 'Escape').defaultPrevented).toBe(false);
		key(root, 'b');
		expect(root.classList.contains('iv-bg-dark')).toBe(true);
		key(root, 'i');
		const info = root.querySelector<HTMLElement>('.image-viewer-info')!;
		expect(info.hidden).toBe(false);
		expect(info.textContent).toContain('1600 × 1200 px');
		expect(info.textContent).toContain('4:3');
		expect(info.textContent).toContain('1.92 MP');
	});

	it('pinches, springs back to Fit, and double-tap zooms with a finger', async () => {
		const { stage, view, root } = await openImage();
		const touch = (type: string, id: number, x: number, y: number) => pointer(stage, type, x, y, { pointerType: 'touch', pointerId: id, isPrimary: id === 1 });
		touch('pointerdown', 1, 300, 300);
		touch('pointerdown', 2, 500, 300);
		touch('pointermove', 2, 700, 300); // the fingers' distance doubles
		touch('pointerup', 2, 700, 300);
		touch('pointerup', 1, 300, 300);
		expect(view.state.scale).toBeCloseTo(1);
		expect(root.classList.contains('iv-touch')).toBe(true);
		// Pinched in past Fit: released, the image returns to Fit.
		touch('pointerdown', 1, 200, 300);
		touch('pointerdown', 2, 600, 300);
		touch('pointermove', 2, 220, 300);
		touch('pointerup', 2, 220, 300);
		touch('pointerup', 1, 200, 300);
		expect(view.state).toMatchObject({ scale: 0.5, mode: 'fit' });
		for (let i = 0; i < 2; i++) {
			touch('pointerdown', 1, 400, 300);
			touch('pointerup', 1, 400, 300);
		}
		expect(view.state.scale).toBe(1.25);
	});

	it('hides the chrome on a single finger tap', async () => {
		const { stage, root } = await openImage();
		pointer(stage, 'pointerdown', 400, 300, { pointerType: 'touch' });
		pointer(stage, 'pointerup', 400, 300, { pointerType: 'touch' });
		await new Promise((resolve) => setTimeout(resolve, 320));
		expect(root.classList.contains('iv-immersive')).toBe(true);
	});

	it('browses the folder\'s images in natural order, one tab at a time', async () => {
		backend.on('list_dir', () => [
			{ name: 'b.png', path: `${REPO}\\b.png`, isDir: false, size: 10 },
			{ name: 'a10.png', path: `${REPO}\\a10.png`, isDir: false, size: 20, modified: 1_700_000_000 },
			{ name: 'notes.txt', path: `${REPO}\\notes.txt`, isDir: false, size: 3 },
			{ name: 'a2.jpg', path: `${REPO}\\a2.jpg`, isDir: false, size: 30 },
			{ name: 'shots', path: `${REPO}\\shots`, isDir: true, size: 0 }
		]);
		const { root, view, group, editors } = await openImage('a10.png');
		await flush();
		expect(view.gallery.paths).toEqual([`${REPO}\\a2.jpg`, `${REPO}\\a10.png`, `${REPO}\\b.png`]);
		expect(root.querySelector('.image-viewer-counter')!.textContent).toBe('2 / 3');
		key(root, 'PageDown');
		await flush(8);
		expect(editors.map((e) => e.input.path)).toEqual([`${REPO}\\b.png`]);
		expect(group.activeInput).toEqual({ kind: 'file', path: `${REPO}\\b.png` });
	});

	it('swipes to the next image at Fit with a finger', async () => {
		backend.on('list_dir', () => [
			{ name: 'one.png', path: `${REPO}\\one.png`, isDir: false, size: 10 },
			{ name: 'two.png', path: `${REPO}\\two.png`, isDir: false, size: 10 }
		]);
		const { stage, editors } = await openImage('one.png');
		await flush();
		pointer(stage, 'pointerdown', 600, 300, { pointerType: 'touch' });
		pointer(stage, 'pointermove', 500, 300, { pointerType: 'touch' });
		pointer(stage, 'pointermove', 300, 305, { pointerType: 'touch' });
		pointer(stage, 'pointerup', 300, 305, { pointerType: 'touch' });
		await new Promise((resolve) => setTimeout(resolve, 260));
		await flush(8);
		expect(editors.map((e) => e.input.path)).toEqual([`${REPO}\\two.png`]);
	});

	it('a gesture landing inside the commit animation never drops the navigation the flick chose', async () => {
		backend.on('list_dir', () => [
			{ name: 'one.png', path: `${REPO}\\one.png`, isDir: false, size: 10 },
			{ name: 'two.png', path: `${REPO}\\two.png`, isDir: false, size: 10 }
		]);
		const { stage, editors } = await openImage('one.png');
		await flush();
		pointer(stage, 'pointerdown', 600, 300, { pointerType: 'touch' });
		pointer(stage, 'pointermove', 300, 300, { pointerType: 'touch' });
		pointer(stage, 'pointerup', 300, 300, { pointerType: 'touch' }); // committed: the exit runs 200 ms
		// The next flick starts before the exit finishes: it must wait, not kill the
		// pending navigation and snap the leaving image back (a fast flick-flick run
		// through a folder dropped every other image).
		pointer(stage, 'pointerdown', 600, 300, { pointerType: 'touch' });
		pointer(stage, 'pointermove', 500, 300, { pointerType: 'touch' });
		pointer(stage, 'pointerup', 500, 300, { pointerType: 'touch' });
		await new Promise((resolve) => setTimeout(resolve, 300));
		await flush(8);
		expect(editors.map((e) => e.input.path)).toEqual([`${REPO}\\two.png`]);
	});

	it('the pinch tracks the fingers’ midpoint: the content under it stays under it', async () => {
		const { stage, view } = await openImage();
		const touch = (type: string, id: number, x: number, y: number) => pointer(stage, type, x, y, { pointerType: 'touch', pointerId: id, isPrimary: id === 1 });
		const under = (x: number, y: number) => screenToImage({ width: VIEW.width, height: VIEW.height }, NATURAL, view.state, x, y)!;
		touch('pointerdown', 1, 300, 300);
		touch('pointerdown', 2, 500, 300);
		const before = under(400, 300); // the pair's midpoint
		// The pair zooms AND travels at once — the midpoint moves with it.
		touch('pointermove', 2, 700, 350);
		const after = under(500, 325); // the midpoint's new place
		expect(after.x).toBeCloseTo(before.x, 5);
		expect(after.y).toBeCloseTo(before.y, 5);
		touch('pointerup', 2, 700, 350);
		touch('pointerup', 1, 300, 300);
	});

	it('offers the whole action set on the context menu', async () => {
		const { stage, path } = await openImage();
		rightClick(stage);
		const labels = menuLabels();
		for (const label of ['Zoom In', 'Fit to Window', 'Rotate Left', 'Flip Vertical', 'Background', 'Pixel Grid', 'Copy Image', 'Copy Path', 'Open in Hex Viewer']) expect(labels).toContain(label);
		click(menuItem('Copy Path'));
		await flush();
		expect(backend.clipboard).toEqual([path]);
	});

	it('reloads in place when the file changes, keeping the view — and ignores an unchanged echo', async () => {
		const { group, path, image, view, button } = await openImage();
		click(button('Actual Size'));
		const reload = () => (group as unknown as { reloadIfClean: (p: string) => Promise<void> }).reloadIfClean(path);
		const src = image.src;
		await reload();
		expect(backend.callsTo('read_file_base64')).toHaveLength(2);
		expect(image.src).toBe(src); // same bytes: nothing re-decoded
		const edited = PNG.slice(0, -6) + 'AAAAAA';
		backend.on('read_file_base64', () => edited);
		await reload();
		expect(image.src).not.toBe(src);
		image.dispatchEvent(new Event('load'));
		expect(view.state).toMatchObject({ scale: 1, mode: 'free' });
	});

	it('shows a read failure in the stage', async () => {
		backend.on('read_file_base64', () => { throw `${REPO}\\huge.png: too large to preview`; });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\huge.png`);
		await flush();
		const message = document.querySelector<HTMLElement>('.image-viewer-message')!;
		expect(message.hidden).toBe(false);
		expect(message.classList.contains('error')).toBe(true);
		expect(message.textContent).toContain('too large to preview');
	});
});
