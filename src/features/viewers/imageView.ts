// The image viewer an image file opens in — one viewer for the desktop and the phone, the
// pointer it is driven by deciding the gestures, the form factor deciding the chrome.
//
// The image is drawn by the GPU, never re-laid-out: one transformed layer (scale, pan,
// quarter-turn rotation, flips — imageModel.ts's geometry) over a stage that never
// scrolls natively, so a zoom is a transform and a 20 000 px panorama pans as smoothly as
// an icon. Every input reaches the same model:
//
// - Desktop: the wheel zooms at the cursor (a mouse notch is one ladder step, a trackpad
//   glides; a trackpad pinch arrives as a Ctrl-wheel and zooms the same way), a drag pans,
//   a double click toggles Fit and 100%, the keyboard covers every action (+ − 0 1 W R ⇧R H
//   V G B I, the arrows pan or browse, PageUp/PageDown/Home/End browse the folder), the
//   right-click menu holds the whole set, and the status bar reads the pixel under the
//   cursor — its position and its colour, copyable.
// - Touch: two fingers pinch about their centroid while the centroid pans, one finger
//   pans with momentum and rubber-banded edges, a double tap zooms in at the tap (and back
//   to Fit), a long press opens the action sheet, a single tap hides the chrome for an
//   unobstructed view, and at Fit a horizontal swipe browses the folder's images with the
//   image following the finger. The stage owns its gestures (`data-owns-gestures`, which
//   the phone's horizontal page pager yields to) and `touch-action: none` keeps the
//   browser's own zoom and scroll out of it.
//
// The professional set rides both: the zoom ladder with Fit / Fit Width / presets, rotate
// and flip, four backgrounds (the transparency checkerboard at a constant screen size),
// a pixel grid past 1000%, nearest-neighbour rendering when zoomed in (or on demand), a
// navigator thumbnail with the visible region (drag it to move there), an information
// panel (name, folder, type, dimensions, megapixels, aspect ratio, size, modified), copy
// image / colour / path, the folder's images as a gallery (natural order, n / total), and
// a reload in place when the file changes on disk — the view kept when the size did not.

import { listDir, readFileBase64 } from '../../platform/ipc/fs';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { t, tf, type LocaleKey } from '../../platform/i18n';
import { imageMime } from '../../platform/markdown';
import { load as loadState, save as saveState } from '../../platform/state';
import { actionButton, basename, dirname, el, formatBytes, notify, showContextMenu, showMenuBelow, type MenuEntry } from '../../platform/ui/index';
import { GestureRecognizer, type PointerKind } from './imageGestures';
import {
	ZOOM_PRESETS, aspectRatio, clampPan, clampScale, cssTransform, fitScale, fitWidthScale, identity, naturalSort, panLimits,
	rotateBy, rotatedSize, rubberBand, scaleLimits, screenToImage, stepZoom, wheelFactor, zoomAround, zoomPercent,
	type ImageTransform, type Size
} from './imageModel';

type Background = 'checker' | 'dark' | 'light' | 'theme';
type Rendering = 'auto' | 'smooth' | 'pixelated';
type FitMode = 'fit' | 'fitWidth' | 'free';

interface Prefs {
	background: Background;
	grid: boolean;
	rendering: Rendering;
	info: boolean;
}

const PREFS_KEY = 'imageViewer';
const BACKGROUNDS: Background[] = ['checker', 'dark', 'light', 'theme'];
const BACKGROUND_KEYS: Record<Background, LocaleKey> = { checker: 'image.bg.checker', dark: 'image.bg.dark', light: 'image.bg.light', theme: 'image.bg.theme' };
const RENDERING_KEYS: Record<Rendering, LocaleKey> = { auto: 'image.render.auto', smooth: 'image.render.smooth', pixelated: 'image.render.pixelated' };
/** Past this scale the pixel grid draws (when on). */
const GRID_SCALE = 10;
/** Past this scale `auto` rendering switches to nearest-neighbour: individual pixels read. */
const PIXELATED_SCALE = 3;
/** The pixel inspector samples images up to this many pixels (a decoded copy is 4 B each). */
const SAMPLE_LIMIT = 40_000_000;
const ANIMATION_MS = 200;
const NAV_BOX = { width: 160, height: 120 };
/** A pan key moves this fraction of the view. */
const KEY_PAN = 0.15;

/** The viewer's preferences, shared by every image tab through the persisted app state:
 *  a background or grid change carries to the next image opened. */
function loadPrefs(): Prefs {
	const stored = loadState<Partial<Prefs>>(PREFS_KEY, {});
	return {
		background: BACKGROUNDS.includes(stored.background as Background) ? stored.background as Background : 'checker',
		grid: stored.grid !== false,
		rendering: stored.rendering === 'smooth' || stored.rendering === 'pixelated' ? stored.rendering : 'auto',
		info: stored.info === true
	};
}

function samePath(a: string, b: string): boolean {
	const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
	return norm(a) === norm(b);
}

/** A cheap identity of a payload: its length and a strided sample of its characters — what
 *  a reload compares instead of holding a second copy of the bytes. */
function fingerprint(base64: string): string {
	let hash = 2166136261;
	const stride = Math.max(1, Math.floor(base64.length / 4096));
	for (let i = 0; i < base64.length; i += stride) hash = Math.imul(hash ^ base64.charCodeAt(i), 16777619);
	for (let i = Math.max(0, base64.length - 1024); i < base64.length; i++) hash = Math.imul(hash ^ base64.charCodeAt(i), 16777619);
	return `${base64.length}:${(hash >>> 0).toString(16)}`;
}

function hex2(value: number): string {
	return value.toString(16).padStart(2, '0').toUpperCase();
}

/** The decoded bytes of a base64 payload: its length minus the padding. */
function decodedLength(base64: string): number {
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** A blob URL for the image (one decoded copy, shared by the image and its navigator
 *  thumbnail) — or the data URL where the platform has no object URLs. */
function imageUrl(base64: string, mime: string): string {
	if (typeof URL.createObjectURL !== 'function' || typeof atob !== 'function') return `data:${mime};base64,${base64}`;
	try {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return URL.createObjectURL(new Blob([bytes], { type: mime }));
	} catch {
		return `data:${mime};base64,${base64}`;
	}
}

function releaseUrl(url: string | null): void {
	if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

export interface ImageViewOptions {
	/** Browse to another image of the folder (the gallery); absent, there is no gallery. */
	onNavigate?: (path: string) => void;
	/** Open this file's bytes in the hex viewer. */
	onOpenHex?: () => void;
}

interface Point { x: number; y: number }

export class ImageView {
	readonly root: HTMLElement;
	private readonly stage: HTMLElement;
	private readonly canvas: HTMLElement;
	private readonly image: HTMLImageElement;
	private readonly grid: HTMLElement;
	private readonly nav: HTMLElement;
	private readonly navBox: HTMLElement;
	private readonly navThumb: HTMLImageElement;
	private readonly navRect: HTMLElement;
	private readonly hud: HTMLElement;
	private readonly message: HTMLElement;
	private readonly info: HTMLElement;
	private readonly infoBody: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly zoomButton: HTMLButtonElement;
	private readonly fitButton: HTMLButtonElement;
	private readonly gridButton: HTMLButtonElement;
	private readonly infoButton: HTMLButtonElement;
	private readonly galleryGroup: HTMLElement;
	private readonly counter: HTMLElement;
	private readonly prevButton: HTMLButtonElement;
	private readonly nextButton: HTMLButtonElement;
	private readonly edgePrev: HTMLButtonElement;
	private readonly edgeNext: HTMLButtonElement;
	private readonly statusDims: HTMLElement;
	private readonly statusCursor: HTMLElement;
	private readonly statusSwatch: HTMLElement;
	private readonly statusColor: HTMLElement;
	private readonly statusZoom: HTMLElement;
	private readonly gestures: GestureRecognizer;
	private readonly resize: ResizeObserver | null = null;
	private readonly mime: string;
	private readonly prefs = loadPrefs();

	private natural: Size = { width: 0, height: 0 };
	private t: ImageTransform = identity();
	private mode: FitMode = 'fit';
	private url: string | null = null;
	private bytes = 0;
	private modified: number | undefined;
	private siblings: string[] = [];
	private index = -1;
	/** A pan or pinch in flight: the transform is raw, the display rubber-banded. */
	private dragging = false;
	/** The gallery swipe's horizontal offset, while one is in flight or settling. */
	private swipe: number | null = null;
	/** A mouse drag over an image with nothing to pan: ignored, not banded. */
	private panIgnored = false;
	private pinchAt: Point | null = null;
	private inertia = 0;
	private animTimer: number | undefined;
	private hudTimer: number | undefined;
	private swipeTimer: number | undefined;
	private sampler: CanvasRenderingContext2D | null | undefined;
	private pointerAt: Point | null = null;
	private lastKind: PointerKind = 'mouse';
	private loadToken = 0;
	/** The shown bytes' fingerprint: a reload of the same file is a no-op. */
	private stamp = '';
	/** A reload in flight: keep the view when the new bytes decode to the same size. */
	private keepView = false;
	private disposed = false;

	constructor(private readonly path: string, private readonly options: ImageViewOptions = {}) {
		this.mime = imageMime(path) ?? 'image/png';
		const label = basename(path);

		// The layer the transform moves: the image, and the pixel grid drawn over it in the
		// image's own coordinates (its line width compensated to one screen pixel).
		this.image = el('img', 'image-viewer-img');
		this.image.alt = label;
		this.image.draggable = false;
		this.image.decoding = 'async';
		this.grid = el('div', 'image-viewer-grid');
		this.grid.hidden = true;
		this.canvas = el('div', 'image-viewer-canvas', [this.image, this.grid]);

		this.navThumb = el('img', 'image-viewer-nav-thumb');
		this.navThumb.alt = '';
		this.navThumb.draggable = false;
		this.navRect = el('div', 'image-viewer-nav-rect');
		this.navBox = el('div', 'image-viewer-nav-box', [this.navThumb, this.navRect]);
		this.nav = el('div', 'image-viewer-nav', [this.navBox]);
		this.nav.hidden = true;

		this.hud = el('div', 'image-viewer-hud');
		this.message = el('div', 'image-viewer-message', [t('image.loading')]);
		this.edgePrev = this.edgeButton('chevron-left', -1);
		this.edgeNext = this.edgeButton('chevron-right', 1);
		this.stage = el('div', 'image-viewer-stage', [this.canvas, this.edgePrev, this.edgeNext, this.nav, this.hud, this.message]);

		const button = (iconName: string, key: LocaleKey, shortcut: string, run: (event: MouseEvent) => void, extra = ''): HTMLButtonElement => {
			const b = actionButton(iconName, shortcut ? `${t(key)} (${shortcut})` : t(key), run);
			if (extra) b.classList.add(...extra.split(' '));
			return b;
		};
		const textButton = (text: string, title: string, run: (event: MouseEvent) => void, extra = ''): HTMLButtonElement => {
			const b = el('button', `action-btn image-viewer-text-btn${extra ? ' ' + extra : ''}`, [text]);
			b.title = title;
			b.setAttribute('aria-label', title);
			b.addEventListener('click', (event) => {
				event.stopPropagation();
				run(event);
			});
			return b;
		};
		const sep = () => el('span', 'image-viewer-sep');

		this.prevButton = button('chevron-left', 'image.previous', 'PgUp', () => this.browse(-1));
		this.nextButton = button('chevron-right', 'image.next', 'PgDn', () => this.browse(1));
		this.counter = el('span', 'image-viewer-counter');
		this.galleryGroup = el('span', 'image-viewer-group image-viewer-gallery', [this.prevButton, this.counter, this.nextButton, sep()]);
		this.galleryGroup.hidden = true;

		this.zoomButton = textButton('100%', t('image.zoomMenu'), (event) => this.showZoomMenu(event.currentTarget as HTMLElement), 'image-viewer-zoom');
		this.fitButton = button('screen-normal', 'image.fit', '0', () => this.fit(true));
		this.gridButton = button('table', 'image.grid', 'G', () => this.toggleGrid(), 'iv-desk');
		this.infoButton = button('info', 'image.info', 'I', () => this.toggleInfo());
		const flipV = button('mirror', 'image.flipV', 'V', () => this.flip('v'), 'iv-desk image-viewer-flip-v');
		this.toolbar = el('div', 'image-viewer-toolbar', [
			this.galleryGroup,
			el('span', 'image-viewer-group', [
				button('zoom-out', 'image.zoomOut', '−', () => this.zoomStep(-1), 'iv-desk'),
				this.zoomButton,
				button('zoom-in', 'image.zoomIn', '+', () => this.zoomStep(1), 'iv-desk'),
				this.fitButton,
				textButton('1:1', `${t('image.actualSize')} (1)`, () => this.zoomTo(1), 'iv-desk')
			]),
			sep(),
			el('span', 'image-viewer-group', [
				button('discard', 'image.rotateLeft', '⇧R', () => this.rotate(-1), 'iv-desk'),
				button('redo', 'image.rotateRight', 'R', () => this.rotate(1)),
				button('mirror', 'image.flipH', 'H', () => this.flip('h')),
				flipV
			]),
			sep(),
			el('span', 'image-viewer-group', [
				button('color-mode', 'image.background', 'B', () => this.cycleBackground()),
				this.gridButton,
				this.infoButton,
				button('ellipsis', 'image.more', '', (event) => showMenuBelow(event.currentTarget as HTMLElement, this.menu(null)))
			])
		]);
		this.toolbar.setAttribute('role', 'toolbar');
		this.toolbar.setAttribute('aria-label', label);

		this.infoBody = el('dl', 'image-viewer-info-body');
		const infoClose = actionButton('close', t('image.close'), () => this.toggleInfo(false));
		this.info = el('aside', 'image-viewer-info', [el('div', 'image-viewer-info-head', [el('span', '', [t('image.info')]), infoClose]), this.infoBody]);
		this.info.hidden = !this.prefs.info;

		this.statusDims = el('span', 'image-viewer-status-dims', [t('image.loading')]);
		this.statusCursor = el('span', 'image-viewer-status-cursor');
		this.statusSwatch = el('span', 'image-viewer-swatch');
		this.statusSwatch.hidden = true;
		this.statusColor = el('span', 'image-viewer-status-color');
		this.statusZoom = el('span', 'image-viewer-status-zoom');
		const status = el('div', 'image-viewer-status', [this.statusDims, el('span', 'image-viewer-spacer'), this.statusCursor, this.statusSwatch, this.statusColor, this.statusZoom]);

		this.root = el('div', 'image-viewer', [this.toolbar, el('div', 'image-viewer-body', [this.stage, this.info]), status]);
		this.root.tabIndex = 0;
		// The whole viewer owns its drags — the stage's pinch, pan and swipe, and the floating
		// toolbar pill above it — so the phone's page pager never claims one.
		this.root.dataset.ownsGestures = '';
		this.root.setAttribute('role', 'figure');
		this.root.setAttribute('aria-label', label);
		this.applyPrefs();
		this.updateTouchClass();

		this.image.addEventListener('load', () => this.onLoaded());
		this.image.addEventListener('error', () => {
			if (this.url) this.showMessage(t('image.decodeFailed'), true);
		});

		this.gestures = new GestureRecognizer(this.stage, {
			panStart: (_x, _y, kind) => this.panStart(kind),
			pan: (dx, dy) => this.panBy(dx, dy),
			pinchStart: () => this.beginDrag(),
			pinch: (factor, cx, cy, dx, dy) => this.pinch(factor, cx, cy, dx, dy),
			end: (vx, vy, kind, cancelled) => this.endDrag(vx, vy, kind, cancelled),
			tap: (_x, _y, kind) => {
				if (kind === 'touch') this.root.classList.toggle('iv-immersive');
			},
			doubleTap: (x, y, kind) => this.doubleTap(x, y, kind),
			longPress: (x, y) => {
				const rect = this.stage.getBoundingClientRect();
				showContextMenu(rect.left + x, rect.top + y, this.menu({ x, y }));
			}
		});

		this.stage.addEventListener('pointerdown', (e) => {
			this.lastKind = (e.pointerType || 'mouse') as PointerKind;
			this.updateTouchClass();
			this.stopInertia();
			if (this.lastKind === 'mouse') this.root.focus({ preventScroll: true });
		});
		this.stage.addEventListener('pointermove', (e) => {
			if (e.pointerType === 'touch' || this.gestures.active) return;
			this.inspect(this.local(e));
		});
		this.stage.addEventListener('pointerleave', () => this.inspect(null));
		this.stage.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
		this.stage.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			// A finger's long press opens the sheet itself (Android also fires this event for
			// it; iOS never does) — one menu, whichever browser.
			if (this.lastKind !== 'mouse') return;
			showContextMenu(e.clientX, e.clientY, this.menu(this.local(e)));
		});
		this.root.addEventListener('keydown', (e) => this.key(e));

		this.nav.addEventListener('pointerdown', (e) => {
			e.stopPropagation();
			e.preventDefault();
			try {
				this.nav.setPointerCapture(e.pointerId);
			} catch {
				// A synthetic event: nothing to capture.
			}
			this.navigateTo(e);
			const move = (m: PointerEvent) => this.navigateTo(m);
			const up = () => {
				this.nav.removeEventListener('pointermove', move);
				this.nav.removeEventListener('pointerup', up);
				this.nav.removeEventListener('pointercancel', up);
			};
			this.nav.addEventListener('pointermove', move);
			this.nav.addEventListener('pointerup', up);
			this.nav.addEventListener('pointercancel', up);
		});

		if (typeof ResizeObserver === 'function') {
			this.resize = new ResizeObserver(() => this.relayout());
			this.resize.observe(this.stage);
		}
	}

	// ---- lifecycle -------------------------------------------------------------------

	/** Read the file and show it; the gallery's folder listing follows in the background. */
	async load(): Promise<void> {
		await this.read(false);
		void this.loadSiblings();
	}

	/** The file changed on disk: show the new bytes, keeping the view when the size held. */
	async reload(): Promise<void> {
		await this.read(true);
	}

	dispose(): void {
		this.disposed = true;
		this.gestures.dispose();
		this.resize?.disconnect();
		this.stopInertia();
		window.clearTimeout(this.animTimer);
		window.clearTimeout(this.hudTimer);
		window.clearTimeout(this.swipeTimer);
		releaseUrl(this.url);
		this.url = null;
		this.sampler = null;
	}

	private async read(keep: boolean): Promise<void> {
		const token = ++this.loadToken;
		let data: string;
		try {
			data = await readFileBase64(this.path);
			if (typeof data !== 'string') throw new Error(t('image.decodeFailed'));
		} catch (error) {
			if (token === this.loadToken && !this.disposed) {
				const reason = error instanceof Error ? error.message : String(error);
				this.showMessage(t('image.loadFailed') + reason, true);
				this.statusDims.textContent = reason;
			}
			return;
		}
		if (token !== this.loadToken || this.disposed) return;
		// A reload of unchanged bytes (a watcher echo, a window refocus) changes nothing.
		const stamp = fingerprint(data);
		if (keep && stamp === this.stamp && this.url) return;
		this.stamp = stamp;
		this.bytes = decodedLength(data);
		const previous = this.url;
		this.url = imageUrl(data, this.mime);
		this.keepView = keep && this.natural.width > 0;
		this.sampler = undefined;
		this.image.src = this.url;
		this.navThumb.src = this.url;
		releaseUrl(previous);
		if (!this.keepView) this.showMessage(t('image.loading'), false);
		this.statusDims.textContent = formatBytes(this.bytes);
		this.renderInfo();
	}

	private onLoaded(): void {
		if (this.disposed) return;
		const previous = this.natural;
		// An SVG without an intrinsic size reports zero: give it a canvas to be drawn on.
		this.natural = { width: this.image.naturalWidth || 512, height: this.image.naturalHeight || 512 };
		const sameSize = previous.width === this.natural.width && previous.height === this.natural.height;
		if (!this.keepView || !sameSize) {
			this.t = identity();
			this.mode = 'fit';
		}
		this.keepView = false;
		this.applyMode();
		this.message.hidden = true;
		this.root.classList.add('loaded');
		this.render();
		this.renderStatus();
		this.renderInfo();
	}

	private async loadSiblings(): Promise<void> {
		if (!this.options.onNavigate) return;
		const folder = dirname(this.path);
		if (!folder) return;
		try {
			const entries = await listDir(folder);
			if (this.disposed || !Array.isArray(entries)) return;
			const own = entries.find((entry) => samePath(entry.path, this.path));
			if (own) {
				this.modified = own.modified;
				if (!this.bytes) this.bytes = own.size;
			}
			const images = entries.filter((entry) => !entry.isDir && imageMime(entry.name));
			const byName = new Map(images.map((entry) => [entry.name, entry.path]));
			this.siblings = naturalSort([...byName.keys()]).map((name) => byName.get(name)!);
			this.index = this.siblings.findIndex((path) => samePath(path, this.path));
			if (this.index < 0) this.siblings = [];
		} catch {
			this.siblings = [];
		}
		this.renderGallery();
		this.renderInfo();
	}

	// ---- geometry --------------------------------------------------------------------

	private viewSize(): Size {
		return { width: this.stage.clientWidth, height: this.stage.clientHeight };
	}

	private local(e: { clientX: number; clientY: number }): Point {
		const rect = this.stage.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private get loaded(): boolean {
		return this.natural.width > 0;
	}

	private currentFit(): number {
		return fitScale(this.viewSize(), this.natural, this.t.rotation);
	}

	private applyMode(): void {
		const view = this.viewSize();
		if (this.mode === 'fit') this.t = { ...this.t, scale: this.currentFit(), x: 0, y: 0 };
		else if (this.mode === 'fitWidth') this.t = clampPan(view, this.natural, { ...this.t, scale: fitWidthScale(view, this.natural, this.t.rotation), x: 0 });
		else this.t = clampPan(view, this.natural, this.t);
	}

	private relayout(): void {
		if (this.disposed || !this.loaded) return;
		const view = this.viewSize();
		if (view.width <= 0 || view.height <= 0) return; // a hidden tab: refit when it shows
		this.updateTouchClass();
		if (!this.dragging && this.swipe === null) this.applyMode();
		this.render();
	}

	private updateTouchClass(): void {
		const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
		const touch = coarse || this.lastKind === 'touch' || document.documentElement.hasAttribute('data-page-stack');
		this.root.classList.toggle('iv-touch', touch);
	}

	/** The transform as drawn: while a finger drags, the overshoot past the pan limits and
	 *  the zoom range is damped (the rubber band), the model itself staying raw. */
	private shown(view: Size): ImageTransform {
		if (!this.dragging) return this.t;
		const limits = panLimits(view, this.natural, this.t);
		return {
			...this.t,
			x: rubberBand(this.t.x, limits.x, view.width * 0.5),
			y: rubberBand(this.t.y, limits.y, view.height * 0.5)
		};
	}

	private swipeOffset(view: Size): number {
		if (this.swipe === null) return 0;
		// Where the folder has no neighbour the swipe resists, like any edge.
		const direction = this.swipe < 0 ? 1 : -1;
		return this.siblings[this.index + direction] ? this.swipe : rubberBand(this.swipe, 0, view.width * 0.4);
	}

	private render(animate = false): void {
		const view = this.viewSize();
		const shown = this.shown(view);
		const { width, height } = this.natural;
		const style = this.canvas.style;
		if (width > 0) {
			style.width = `${width}px`;
			style.height = `${height}px`;
			style.left = `${(view.width - width) / 2}px`;
			style.top = `${(view.height - height) / 2}px`;
		}
		window.clearTimeout(this.animTimer);
		this.canvas.classList.toggle('animating', animate);
		if (animate) this.animTimer = window.setTimeout(() => this.canvas.classList.remove('animating'), ANIMATION_MS + 40);
		style.transform = cssTransform({ ...shown, x: shown.x + this.swipeOffset(view) });
		this.root.style.setProperty('--iv-inv', String(1 / shown.scale));
		const pixelated = this.prefs.rendering === 'pixelated' || (this.prefs.rendering === 'auto' && shown.scale >= PIXELATED_SCALE);
		this.image.classList.toggle('pixelated', pixelated);
		this.grid.hidden = !(this.prefs.grid && shown.scale >= GRID_SCALE);
		const percent = zoomPercent(shown.scale);
		this.zoomButton.textContent = percent;
		this.statusZoom.textContent = percent;
		this.fitButton.classList.toggle('active', this.mode === 'fit');
		this.fitButton.setAttribute('aria-pressed', String(this.mode === 'fit'));
		const limits = panLimits(view, this.natural, this.t);
		this.stage.classList.toggle('can-pan', limits.x > 0.5 || limits.y > 0.5);
		this.renderNavigator(view, shown);
	}

	private renderNavigator(view: Size, shown: ImageTransform): void {
		const limits = panLimits(view, this.natural, this.t);
		const visible = this.loaded && (limits.x > 0.5 || limits.y > 0.5) && this.swipe === null;
		this.nav.hidden = !visible;
		if (!visible) return;
		const foot = rotatedSize(this.natural, this.t.rotation);
		const k = Math.min(NAV_BOX.width / foot.width, NAV_BOX.height / foot.height);
		const boxW = foot.width * k;
		const boxH = foot.height * k;
		this.navBox.style.width = `${boxW}px`;
		this.navBox.style.height = `${boxH}px`;
		const thumbW = this.natural.width * k;
		const thumbH = this.natural.height * k;
		const thumb = this.navThumb.style;
		thumb.width = `${thumbW}px`;
		thumb.height = `${thumbH}px`;
		thumb.left = `${(boxW - thumbW) / 2}px`;
		thumb.top = `${(boxH - thumbH) / 2}px`;
		thumb.transform = `rotate(${this.t.rotation}deg) scale(${this.t.flipH ? -1 : 1}, ${this.t.flipV ? -1 : 1})`;
		// The visible region in the rotated footprint's own units.
		const s = shown.scale;
		const left = (foot.width * s) / 2 - shown.x - view.width / 2;
		const top = (foot.height * s) / 2 - shown.y - view.height / 2;
		const x0 = Math.max(0, left / s);
		const y0 = Math.max(0, top / s);
		const x1 = Math.min(foot.width, (left + view.width) / s);
		const y1 = Math.min(foot.height, (top + view.height) / s);
		const rect = this.navRect.style;
		rect.left = `${x0 * k}px`;
		rect.top = `${y0 * k}px`;
		rect.width = `${Math.max(2, (x1 - x0) * k)}px`;
		rect.height = `${Math.max(2, (y1 - y0) * k)}px`;
	}

	/** A press or drag on the navigator: the view centres on that point of the image. */
	private navigateTo(e: PointerEvent): void {
		const rect = this.navBox.getBoundingClientRect();
		const foot = rotatedSize(this.natural, this.t.rotation);
		const k = Math.min(NAV_BOX.width / foot.width, NAV_BOX.height / foot.height);
		const u = (e.clientX - rect.left) / k;
		const v = (e.clientY - rect.top) / k;
		const s = this.t.scale;
		this.stopInertia();
		this.t = clampPan(this.viewSize(), this.natural, { ...this.t, x: (foot.width * s) / 2 - u * s, y: (foot.height * s) / 2 - v * s });
		if (this.mode === 'fit') this.mode = 'free';
		this.render();
	}

	// ---- actions ---------------------------------------------------------------------

	/** Zoom to a scale, anchored at a stage point (the centre when none). */
	zoomTo(scale: number, anchor?: Point, animate = true): void {
		const view = this.viewSize();
		const fit = this.currentFit();
		const next = clampScale(scale, fit);
		if (Math.abs(next - fit) < 1e-6) {
			this.fit(animate);
			return;
		}
		const at = anchor ?? { x: view.width / 2, y: view.height / 2 };
		this.stopInertia();
		this.mode = 'free';
		this.t = clampPan(view, this.natural, zoomAround(this.t, next, at.x - view.width / 2, at.y - view.height / 2));
		this.render(animate);
		this.flashHud();
	}

	zoomStep(direction: 1 | -1, anchor?: Point): void {
		this.zoomTo(stepZoom(this.t.scale, direction, this.currentFit()), anchor);
	}

	fit(animate = true): void {
		this.stopInertia();
		this.mode = 'fit';
		this.applyMode();
		this.render(animate);
	}

	fitWidth(): void {
		this.stopInertia();
		this.mode = 'fitWidth';
		const view = this.viewSize();
		const scale = fitWidthScale(view, this.natural, this.t.rotation);
		// Reading a long screenshot starts at its top.
		const top = panLimits(view, this.natural, { ...this.t, scale }).y;
		this.t = { ...this.t, scale, x: 0, y: top };
		this.render(true);
	}

	rotate(quarterTurns: number): void {
		this.stopInertia();
		// The flips apply before the rotation (cssTransform), so a turn is always the turn
		// the user sees, flipped or not.
		this.t = { ...this.t, rotation: rotateBy(this.t.rotation, quarterTurns) };
		if (this.mode === 'free' && this.t.scale <= this.currentFit()) this.mode = 'fit';
		this.applyMode();
		this.render(true);
		this.renderInfo();
	}

	flip(axis: 'h' | 'v'): void {
		// Flip the axis as it is SHOWN: a quarter-turned image's screen horizontal is its
		// stored vertical.
		const sideways = this.t.rotation === 90 || this.t.rotation === 270;
		const horizontal = (axis === 'h') !== sideways;
		this.t = horizontal ? { ...this.t, flipH: !this.t.flipH } : { ...this.t, flipV: !this.t.flipV };
		this.render(true);
	}

	resetView(): void {
		this.t = identity();
		this.fit(true);
		this.renderInfo();
	}

	private toggleGrid(): void {
		this.prefs.grid = !this.prefs.grid;
		this.persist();
		this.applyPrefs();
		this.render();
	}

	private toggleInfo(on = !this.prefs.info): void {
		this.prefs.info = on;
		this.persist();
		this.applyPrefs();
		this.renderInfo();
		// The stage changed width beside the panel.
		this.relayout();
	}

	private cycleBackground(): void {
		this.setBackground(BACKGROUNDS[(BACKGROUNDS.indexOf(this.prefs.background) + 1) % BACKGROUNDS.length]!);
	}

	private setBackground(background: Background): void {
		this.prefs.background = background;
		this.persist();
		this.applyPrefs();
		this.flashHud(t(BACKGROUND_KEYS[background]));
	}

	private setRendering(rendering: Rendering): void {
		this.prefs.rendering = rendering;
		this.persist();
		this.render();
	}

	private persist(): void {
		saveState(PREFS_KEY, this.prefs);
	}

	private applyPrefs(): void {
		for (const background of BACKGROUNDS) this.root.classList.toggle(`iv-bg-${background}`, this.prefs.background === background);
		this.gridButton.classList.toggle('active', this.prefs.grid);
		this.gridButton.setAttribute('aria-pressed', String(this.prefs.grid));
		this.infoButton.classList.toggle('active', this.prefs.info);
		this.infoButton.setAttribute('aria-pressed', String(this.prefs.info));
		this.info.hidden = !this.prefs.info;
	}

	private browse(direction: number): void {
		const target = this.siblings[this.index + direction];
		if (target) this.options.onNavigate?.(target);
	}

	private browseTo(index: number): void {
		const target = this.siblings[index];
		if (target && index !== this.index) this.options.onNavigate?.(target);
	}

	private async copyImage(): Promise<void> {
		try {
			if (!this.loaded) throw new Error(t('image.loading'));
			if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error(t('image.copyUnsupported'));
			const canvas = document.createElement('canvas');
			canvas.width = this.natural.width;
			canvas.height = this.natural.height;
			const context = canvas.getContext('2d');
			if (!context) throw new Error(t('image.copyUnsupported'));
			context.drawImage(this.image, 0, 0);
			// The item takes the PNG as a promise, created inside the click: Safari refuses
			// a clipboard write whose data arrives after the gesture ended.
			const png = new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('image.copyUnsupported')))), 'image/png'));
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
			notify('info', t('image.copied'));
		} catch (error) {
			notify('error', t('image.copyFailed') + (error instanceof Error ? error.message : String(error)));
		}
	}

	private async copyText(text: string): Promise<void> {
		try {
			await writeText(text);
			notify('info', t('image.copied'));
		} catch (error) {
			notify('error', String(error));
		}
	}

	// ---- input -----------------------------------------------------------------------

	private wheel(e: WheelEvent): void {
		if (!this.loaded) return;
		const view = this.viewSize();
		if (!e.deltaY) {
			// A purely horizontal wheel (a tilt wheel, a sideways trackpad stroke) pans —
			// and only when there is something to pan, else it stays the page's.
			const limits = panLimits(view, this.natural, this.t);
			if (!e.deltaX || limits.x <= 0) return;
			e.preventDefault();
			this.stopInertia();
			this.t = clampPan(view, this.natural, { ...this.t, x: this.t.x - e.deltaX });
			this.render();
			return;
		}
		// Every vertical wheel zooms at the cursor, and the Ctrl wheel (a trackpad pinch) is
		// swallowed here rather than zooming the whole window.
		e.preventDefault();
		this.zoomTo(this.t.scale * wheelFactor(e.deltaY, e.deltaMode), this.local(e), false);
	}

	private key(e: KeyboardEvent): void {
		if (e.altKey) return;
		const mod = e.ctrlKey || e.metaKey;
		if (mod) {
			if (e.key.toLowerCase() === 'c' && !e.shiftKey) {
				e.preventDefault();
				void this.copyImage();
			}
			return; // every other chord stays the workbench's (close tab, switch tab, …)
		}
		const view = this.viewSize();
		const limits = panLimits(view, this.natural, this.t);
		const pan = (dx: number, dy: number) => {
			this.stopInertia();
			this.t = clampPan(view, this.natural, { ...this.t, x: this.t.x + dx, y: this.t.y + dy });
			this.render(true);
		};
		const run: Record<string, () => void> = {
			// The zoom keys anchor at the cursor while it hovers the image, like the wheel.
			'+': () => this.zoomStep(1, this.pointerAt ?? undefined),
			'=': () => this.zoomStep(1, this.pointerAt ?? undefined),
			'-': () => this.zoomStep(-1, this.pointerAt ?? undefined),
			'_': () => this.zoomStep(-1, this.pointerAt ?? undefined),
			'0': () => this.fit(),
			'1': () => this.zoomTo(1),
			'2': () => this.zoomTo(2),
			'w': () => this.fitWidth(),
			'r': () => this.rotate(1),
			'R': () => this.rotate(-1),
			'h': () => this.flip('h'),
			'v': () => this.flip('v'),
			'g': () => this.toggleGrid(),
			'b': () => this.cycleBackground(),
			'i': () => this.toggleInfo(),
			'PageUp': () => this.browse(-1),
			'PageDown': () => this.browse(1),
			'Home': () => this.browseTo(0),
			'End': () => this.browseTo(this.siblings.length - 1),
			// The arrows pan while there is somewhere to pan, and browse the folder otherwise.
			'ArrowLeft': () => (limits.x > 0 ? pan(view.width * KEY_PAN, 0) : this.browse(-1)),
			'ArrowRight': () => (limits.x > 0 ? pan(-view.width * KEY_PAN, 0) : this.browse(1)),
			'ArrowUp': () => limits.y > 0 && pan(0, view.height * KEY_PAN),
			'ArrowDown': () => limits.y > 0 && pan(0, -view.height * KEY_PAN)
		};
		if (e.key === 'Escape') {
			// Escape leaves the immersive view; otherwise it stays the workbench's.
			if (!this.root.classList.contains('iv-immersive')) return;
			run.Escape = () => this.root.classList.remove('iv-immersive');
		}
		const action = run[e.key] ?? (e.key.length === 1 ? run[e.shiftKey ? e.key : e.key.toLowerCase()] : undefined);
		if (!action) return;
		e.preventDefault();
		e.stopPropagation();
		action();
	}

	private beginDrag(): void {
		this.stopInertia();
		this.dragging = true;
		this.canvas.classList.remove('animating');
		this.root.classList.add('iv-gesturing');
	}

	private panStart(kind: PointerKind): void {
		this.stopInertia();
		this.panIgnored = false;
		const view = this.viewSize();
		const limits = panLimits(view, this.natural, this.t);
		if (!this.loaded) {
			this.panIgnored = true;
			return;
		}
		// At Fit, a finger's horizontal drag is the gallery swipe.
		if (kind !== 'mouse' && limits.x < 1 && this.siblings.length > 1 && this.t.scale <= this.currentFit() * 1.01) {
			window.clearTimeout(this.swipeTimer);
			this.swipe = 0;
			this.canvas.classList.remove('animating');
			this.root.classList.add('iv-gesturing');
			return;
		}
		if (kind === 'mouse' && limits.x <= 0.5 && limits.y <= 0.5) {
			this.panIgnored = true;
			return;
		}
		this.beginDrag();
		if (kind === 'mouse') this.stage.classList.add('panning');
	}

	private panBy(dx: number, dy: number): void {
		if (this.panIgnored) return;
		if (this.swipe !== null) {
			this.swipe += dx;
			this.render();
			return;
		}
		this.t = { ...this.t, x: this.t.x + dx, y: this.t.y + dy };
		this.render();
	}

	private pinch(factor: number, cx: number, cy: number, dx: number, dy: number): void {
		if (!this.loaded) return;
		if (this.swipe !== null) {
			// A second finger landed mid-swipe: the swipe yields to the pinch.
			this.swipe = null;
			this.beginDrag();
		}
		const view = this.viewSize();
		const fit = this.currentFit();
		const { min, max } = scaleLimits(fit);
		// The pinch may overshoot the range a little — it springs back on release.
		const next = Math.min(max * 1.5, Math.max(Math.min(min, fit) * 0.5, this.t.scale * factor));
		this.mode = 'free';
		const zoomed = zoomAround(this.t, next, cx - view.width / 2, cy - view.height / 2);
		this.t = { ...zoomed, x: zoomed.x + dx, y: zoomed.y + dy };
		this.pinchAt = { x: cx, y: cy };
		this.render();
		this.flashHud();
	}

	private endDrag(vx: number, vy: number, kind: PointerKind, cancelled: boolean): void {
		this.root.classList.remove('iv-gesturing');
		this.stage.classList.remove('panning');
		if (this.panIgnored) {
			this.panIgnored = false;
			return;
		}
		if (this.swipe !== null) {
			this.finishSwipe(vx, cancelled);
			return;
		}
		if (!this.dragging) return;
		this.dragging = false;
		const view = this.viewSize();
		const fit = this.currentFit();
		const { min, max } = scaleLimits(fit);
		// Pinched out past Fit: back to Fit (the photo apps' bounce).
		if (this.t.scale < fit * 0.999 && (kind === 'touch' || this.t.scale < min)) {
			this.fit(true);
			return;
		}
		let settled = this.t;
		let sprung = false;
		if (settled.scale > max) {
			const at = this.pinchAt ?? { x: view.width / 2, y: view.height / 2 };
			settled = zoomAround(settled, max, at.x - view.width / 2, at.y - view.height / 2);
			sprung = true;
		}
		const clamped = clampPan(view, this.natural, settled);
		if (clamped.x !== settled.x || clamped.y !== settled.y) sprung = true;
		this.t = clamped;
		this.pinchAt = null;
		if (sprung) {
			// Released past an edge or the zoom range: spring back, no momentum.
			this.render(true);
			return;
		}
		this.render();
		if (!cancelled) this.fling(vx, vy);
	}

	private finishSwipe(vx: number, cancelled: boolean): void {
		const view = this.viewSize();
		const width = Math.max(1, view.width);
		const offset = this.swipe ?? 0;
		const direction = offset < 0 ? 1 : -1;
		const target = this.siblings[this.index + direction];
		const flung = Math.abs(vx) > 0.45 && Math.sign(vx) === Math.sign(offset);
		if (!cancelled && target && (Math.abs(offset) > width * 0.2 || flung)) {
			// The image leaves in the swipe's direction; the next one opens behind it.
			this.swipe = -direction * width * 1.05;
			this.render(true);
			this.swipeTimer = window.setTimeout(() => this.options.onNavigate?.(target), ANIMATION_MS);
			return;
		}
		this.swipe = 0;
		this.render(true);
		this.swipeTimer = window.setTimeout(() => {
			this.swipe = null;
			this.render();
		}, ANIMATION_MS);
	}

	private doubleTap(x: number, y: number, kind: PointerKind): void {
		if (!this.loaded) return;
		const fit = this.currentFit();
		if (kind === 'mouse') {
			// The desktop's double click: Fit ⇄ 100% (2× for an image that fits at 100%).
			if (this.mode === 'fit' || Math.abs(this.t.scale - fit) < 1e-3) this.zoomTo(Math.abs(fit - 1) < 1e-3 ? 2 : 1, { x, y });
			else this.fit(true);
			return;
		}
		if (this.t.scale > fit * 1.05) {
			this.fit(true);
			return;
		}
		this.zoomTo(Math.max(fit * 2.5, Math.min(1, fit * 4)), { x, y });
	}

	private fling(vx: number, vy: number): void {
		if (typeof requestAnimationFrame !== 'function' || Math.hypot(vx, vy) < 0.15) return;
		let last = performance.now();
		const step = (now: number): void => {
			if (this.disposed) return;
			const dt = Math.min(48, Math.max(1, now - last));
			last = now;
			const view = this.viewSize();
			const limits = panLimits(view, this.natural, this.t);
			let x = this.t.x + vx * dt;
			let y = this.t.y + vy * dt;
			if (Math.abs(x) >= limits.x) { x = Math.sign(x) * limits.x; vx = 0; }
			if (Math.abs(y) >= limits.y) { y = Math.sign(y) * limits.y; vy = 0; }
			this.t = { ...this.t, x, y };
			const decay = Math.pow(0.94, dt / 16);
			vx *= decay;
			vy *= decay;
			this.render();
			this.inertia = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
		};
		this.inertia = requestAnimationFrame(step);
	}

	private stopInertia(): void {
		if (this.inertia && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.inertia);
		this.inertia = 0;
	}

	// ---- inspection ------------------------------------------------------------------

	private pixelAt(point: Point | null): { x: number; y: number } | null {
		if (!point || !this.loaded) return null;
		return screenToImage(this.viewSize(), this.natural, this.t, point.x, point.y);
	}

	private colorAt(pixel: { x: number; y: number }): { r: number; g: number; b: number; a: number } | null {
		if (this.sampler === undefined) {
			this.sampler = null;
			if (this.natural.width * this.natural.height <= SAMPLE_LIMIT) {
				try {
					const canvas = document.createElement('canvas');
					canvas.width = this.natural.width;
					canvas.height = this.natural.height;
					const context = canvas.getContext('2d', { willReadFrequently: true });
					if (context) {
						context.drawImage(this.image, 0, 0, this.natural.width, this.natural.height);
						this.sampler = context;
					}
				} catch {
					this.sampler = null; // no 2D canvas, or a tainted SVG
				}
			}
		}
		if (!this.sampler) return null;
		try {
			const [r = 0, g = 0, b = 0, a = 0] = this.sampler.getImageData(pixel.x, pixel.y, 1, 1).data;
			return { r, g, b, a };
		} catch {
			this.sampler = null;
			return null;
		}
	}

	private colorText(color: { r: number; g: number; b: number; a: number }): string {
		return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}${color.a < 255 ? hex2(color.a) : ''}`;
	}

	private inspect(point: Point | null): void {
		this.pointerAt = point;
		const pixel = this.pixelAt(point);
		if (!pixel) {
			this.statusCursor.textContent = '';
			this.statusColor.textContent = '';
			this.statusSwatch.hidden = true;
			return;
		}
		this.statusCursor.textContent = `${pixel.x}, ${pixel.y}`;
		const color = this.colorAt(pixel);
		if (!color) {
			this.statusColor.textContent = '';
			this.statusSwatch.hidden = true;
			return;
		}
		this.statusSwatch.hidden = false;
		this.statusSwatch.style.background = `rgba(${color.r}, ${color.g}, ${color.b}, ${(color.a / 255).toFixed(3)})`;
		this.statusColor.textContent = `${this.colorText(color)}  rgba(${color.r}, ${color.g}, ${color.b}, ${(color.a / 255).toFixed(2)})`;
	}

	// ---- chrome ----------------------------------------------------------------------

	private edgeButton(iconName: string, direction: 1 | -1): HTMLButtonElement {
		const button = actionButton(iconName, t(direction < 0 ? 'image.previous' : 'image.next'), () => this.browse(direction));
		button.classList.add('image-viewer-edge', direction < 0 ? 'prev' : 'next');
		button.addEventListener('pointerdown', (e) => e.stopPropagation());
		button.hidden = true;
		return button;
	}

	private showMessage(text: string, error: boolean): void {
		this.message.textContent = text;
		this.message.classList.toggle('error', error);
		this.message.hidden = false;
	}

	private flashHud(text = zoomPercent(this.t.scale)): void {
		this.hud.textContent = text;
		this.hud.classList.add('visible');
		window.clearTimeout(this.hudTimer);
		this.hudTimer = window.setTimeout(() => this.hud.classList.remove('visible'), 800);
	}

	private renderGallery(): void {
		const has = this.siblings.length > 1 && this.index >= 0;
		this.galleryGroup.hidden = !has;
		this.counter.textContent = has ? tf('image.counter', this.index + 1, this.siblings.length) : '';
		this.prevButton.disabled = !has || this.index === 0;
		this.nextButton.disabled = !has || this.index === this.siblings.length - 1;
		this.edgePrev.hidden = !has || this.index === 0;
		this.edgeNext.hidden = !has || this.index === this.siblings.length - 1;
	}

	private renderStatus(): void {
		const { width, height } = this.natural;
		this.statusDims.textContent = `${width} × ${height} px  ·  ${formatBytes(this.bytes)}  ·  ${this.typeName()}`;
	}

	private typeName(): string {
		const subtype = this.mime.split('/')[1] ?? '';
		return subtype === 'svg+xml' ? 'SVG' : subtype === 'x-icon' ? 'ICO' : subtype.toUpperCase();
	}

	private renderInfo(): void {
		if (this.info.hidden) return;
		const { width, height } = this.natural;
		const rows: [LocaleKey, string][] = [
			['image.info.name', basename(this.path)],
			['image.info.folder', dirname(this.path)],
			['image.info.type', `${this.typeName()} (${this.mime})`],
			['image.info.dimensions', width ? `${width} × ${height} px` : '—'],
			['image.info.megapixels', width ? `${((width * height) / 1e6).toFixed(2)} MP` : '—'],
			['image.info.aspect', width ? aspectRatio(width, height) : '—'],
			['image.info.size', this.bytes ? `${formatBytes(this.bytes)} (${this.bytes.toLocaleString()} B)` : '—'],
			['image.info.modified', this.modified ? new Date(this.modified * 1000).toLocaleString() : '—'],
			['image.info.view', `${zoomPercent(this.t.scale)} · ${this.t.rotation}°${this.t.flipH ? ' ↔' : ''}${this.t.flipV ? ' ↕' : ''}`]
		];
		if (this.siblings.length > 1) rows.push(['image.info.position', tf('image.counter', this.index + 1, this.siblings.length)]);
		this.infoBody.replaceChildren(...rows.flatMap(([key, value]) => {
			const dd = el('dd', '', [value]);
			dd.title = value;
			return [el('dt', '', [t(key)]), dd];
		}));
	}

	private showZoomMenu(anchor: HTMLElement): void {
		const current = this.t.scale;
		const entries: MenuEntry[] = [
			{ label: t('image.fit'), keybinding: '0', checked: this.mode === 'fit', run: () => this.fit() },
			{ label: t('image.fitWidth'), keybinding: 'W', checked: this.mode === 'fitWidth', run: () => this.fitWidth() },
			'separator',
			...ZOOM_PRESETS.map((preset): MenuEntry => ({
				label: zoomPercent(preset),
				keybinding: preset === 1 ? '1' : preset === 2 ? '2' : undefined,
				checked: this.mode === 'free' && Math.abs(current - preset) < 1e-6,
				run: () => this.zoomTo(preset)
			}))
		];
		showMenuBelow(anchor, entries, 160);
	}

	/** The whole action set — the right-click menu, the long-press sheet and the toolbar's
	 *  "…" all show it. `point` is where it was opened (the colour under it is copyable). */
	private menu(point: Point | null): MenuEntry[] {
		const pixel = this.pixelAt(point);
		const color = pixel ? this.colorAt(pixel) : null;
		const gallery = this.siblings.length > 1;
		const entries: MenuEntry[] = [
			{ label: t('image.zoomIn'), keybinding: '+', run: () => this.zoomStep(1, point ?? undefined) },
			{ label: t('image.zoomOut'), keybinding: '−', run: () => this.zoomStep(-1, point ?? undefined) },
			{ label: t('image.fit'), keybinding: '0', checked: this.mode === 'fit', run: () => this.fit() },
			{ label: t('image.fitWidth'), keybinding: 'W', checked: this.mode === 'fitWidth', run: () => this.fitWidth() },
			{ label: t('image.actualSize'), keybinding: '1', run: () => this.zoomTo(1, point ?? undefined) },
			'separator',
			{ label: t('image.rotateLeft'), keybinding: 'Shift+R', run: () => this.rotate(-1) },
			{ label: t('image.rotateRight'), keybinding: 'R', run: () => this.rotate(1) },
			{ label: t('image.flipH'), keybinding: 'H', checked: this.t.flipH, run: () => this.flip('h') },
			{ label: t('image.flipV'), keybinding: 'V', checked: this.t.flipV, run: () => this.flip('v') },
			{ label: t('image.reset'), run: () => this.resetView() },
			'separator',
			{
				label: t('image.background'),
				submenu: BACKGROUNDS.map((background): MenuEntry => ({ label: t(BACKGROUND_KEYS[background]), checked: this.prefs.background === background, run: () => this.setBackground(background) }))
			},
			{
				label: t('image.rendering'),
				submenu: (['auto', 'smooth', 'pixelated'] as Rendering[]).map((rendering): MenuEntry => ({ label: t(RENDERING_KEYS[rendering]), checked: this.prefs.rendering === rendering, run: () => this.setRendering(rendering) }))
			},
			{ label: t('image.grid'), keybinding: 'G', checked: this.prefs.grid, run: () => this.toggleGrid() },
			{ label: t('image.info'), keybinding: 'I', checked: this.prefs.info, run: () => this.toggleInfo() },
			'separator',
			{ label: t('image.copyImage'), keybinding: 'Ctrl+C', disabled: !this.loaded, run: () => void this.copyImage() }
		];
		if (color) {
			const text = this.colorText(color);
			entries.push({ label: tf('image.copyColor', text), run: () => void this.copyText(text) });
		}
		entries.push({ label: t('image.copyPath'), run: () => void this.copyText(this.path) });
		if (gallery || this.options.onOpenHex) entries.push('separator');
		if (gallery) {
			entries.push(
				{ label: t('image.previous'), keybinding: 'PgUp', disabled: this.index <= 0, run: () => this.browse(-1) },
				{ label: t('image.next'), keybinding: 'PgDn', disabled: this.index >= this.siblings.length - 1, run: () => this.browse(1) }
			);
		}
		if (this.options.onOpenHex) entries.push({ label: t('image.openHex'), run: () => this.options.onOpenHex?.() });
		return entries;
	}

	// ---- inspection surface (tests, self-tests) --------------------------------------

	/** The view's current transform and fit mode. */
	get state(): Readonly<ImageTransform> & { mode: FitMode } {
		return { ...this.t, mode: this.mode };
	}

	/** The folder's images the gallery browses, and this one's place among them. */
	get gallery(): { paths: readonly string[]; index: number } {
		return { paths: this.siblings, index: this.index };
	}
}
