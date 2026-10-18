// The image viewer's geometry, pure and DOM-free: the view transform (scale, pan offset,
// quarter-turn rotation, flips), the fit scale, the pan bounds and their rubber band, the
// zoom anchored on a point, the zoom ladder the buttons and keys step through, and the
// screen → image-pixel mapping the pixel inspector reads. Every coordinate here is relative
// to the viewport's CENTRE (the image sits centred at x = y = 0), so a resize never moves
// what the user looks at.

export type Rotation = 0 | 90 | 180 | 270;

export interface Size {
	width: number;
	height: number;
}

export interface ImageTransform {
	/** Screen pixels per image pixel. */
	scale: number;
	/** The image centre's offset from the viewport centre, in screen pixels. */
	x: number;
	y: number;
	rotation: Rotation;
	flipH: boolean;
	flipV: boolean;
}

/** The zoom ladder: what the zoom menu offers, beside Fit. */
export const ZOOM_PRESETS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;
/** One button / key / wheel notch step. */
export const ZOOM_STEP = 1.25;

export function identity(): ImageTransform {
	return { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false };
}

/** The image's on-screen footprint at scale 1: a quarter turn swaps the sides. */
export function rotatedSize(natural: Size, rotation: Rotation): Size {
	return rotation === 90 || rotation === 270 ? { width: natural.height, height: natural.width } : natural;
}

/** The scale that shows the whole image inside the view (contain). A small image is
 *  never blown up past 100% unless `upscale` asks for it — a 16 px icon "fitted" to a
 *  1200 px pane is a blur, not a view. */
export function fitScale(view: Size, natural: Size, rotation: Rotation, upscale = false): number {
	const footprint = rotatedSize(natural, rotation);
	if (footprint.width <= 0 || footprint.height <= 0 || view.width <= 0 || view.height <= 0) return 1;
	const contain = Math.min(view.width / footprint.width, view.height / footprint.height);
	return upscale ? contain : Math.min(1, contain);
}

/** The scale that fills the view's width (the long-screenshot reading mode). */
export function fitWidthScale(view: Size, natural: Size, rotation: Rotation): number {
	const footprint = rotatedSize(natural, rotation);
	return footprint.width > 0 && view.width > 0 ? view.width / footprint.width : 1;
}

/** The legal zoom range: an eighth of the smaller of fit and 100% at the bottom, 64× (or
 *  eight fits, for a tiny image in a huge pane) at the top — far enough to read pixels. */
export function scaleLimits(fit: number): { min: number; max: number } {
	return { min: Math.max(0.005, Math.min(fit, 1) / 8), max: Math.max(64, fit * 8) };
}

export function clampScale(scale: number, fit: number): number {
	const { min, max } = scaleLimits(fit);
	return Math.min(max, Math.max(min, scale));
}

/** How far the image centre may move from the viewport centre on each axis: zero while
 *  that side of the image fits inside the view (it stays centred), half the overhang
 *  otherwise (an edge never leaves its viewport edge). */
export function panLimits(view: Size, natural: Size, t: ImageTransform): { x: number; y: number } {
	const footprint = rotatedSize(natural, t.rotation);
	return {
		x: Math.max(0, (footprint.width * t.scale - view.width) / 2),
		y: Math.max(0, (footprint.height * t.scale - view.height) / 2)
	};
}

export function clampPan(view: Size, natural: Size, t: ImageTransform): ImageTransform {
	const limit = panLimits(view, natural, t);
	return { ...t, x: Math.max(-limit.x, Math.min(limit.x, t.x)), y: Math.max(-limit.y, Math.min(limit.y, t.y)) };
}

/** A drag past a pan limit: the overshoot is damped (the iOS rubber band), so the edge
 *  shows it is an edge while the finger still feels attached. */
export function rubberBand(value: number, limit: number, dimension: number): number {
	if (Math.abs(value) <= limit) return value;
	const sign = value < 0 ? -1 : 1;
	const over = Math.abs(value) - limit;
	const span = Math.max(1, dimension);
	return sign * (limit + (1 - 1 / ((over * 0.55) / span + 1)) * span);
}

/** Scale to `next` keeping the image point under (px, py) — viewport-centre relative —
 *  under it. */
export function zoomAround(t: ImageTransform, next: number, px: number, py: number): ImageTransform {
	const ratio = next / t.scale;
	return { ...t, scale: next, x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio };
}

/** One step up or down the zoom ladder. The step lands exactly on 100% and on the fit
 *  scale when it would cross them — the two scales a user steps toward on purpose. */
export function stepZoom(scale: number, direction: 1 | -1, fit: number): number {
	const raw = direction > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP;
	let next = raw;
	for (const anchor of [1, fit]) {
		if (direction > 0 && scale < anchor * 0.999 && raw > anchor * 1.001) next = Math.min(next, anchor);
		if (direction < 0 && scale > anchor * 1.001 && raw < anchor * 0.999) next = Math.max(next, anchor);
	}
	return clampScale(next, fit);
}

/** A wheel delta as a zoom factor: one 100-unit mouse notch is exactly one ladder step,
 *  a trackpad's small pixel deltas glide; a single event never jumps more than 2×. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
	const units = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
	const factor = Math.pow(ZOOM_STEP, -units / 100);
	return Math.min(2, Math.max(0.5, factor));
}

export function rotateBy(rotation: Rotation, quarterTurns: number): Rotation {
	return ((((rotation + quarterTurns * 90) % 360) + 360) % 360) as Rotation;
}

/** The CSS transform of an image element centred in the viewport. */
export function cssTransform(t: ImageTransform): string {
	const sx = t.scale * (t.flipH ? -1 : 1);
	const sy = t.scale * (t.flipV ? -1 : 1);
	return `translate(${round(t.x)}px, ${round(t.y)}px) rotate(${t.rotation}deg) scale(${sx}, ${sy})`;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

/** The image pixel under a viewport point (top-left relative), or null outside the image —
 *  the exact inverse of `cssTransform`: un-translate, un-rotate, un-scale. */
export function screenToImage(view: Size, natural: Size, t: ImageTransform, px: number, py: number): { x: number; y: number } | null {
	const dx = px - view.width / 2 - t.x;
	const dy = py - view.height / 2 - t.y;
	// The inverse of a quarter turn, spelled exactly (no trigonometric drift at 90°).
	let rx = dx;
	let ry = dy;
	if (t.rotation === 90) { rx = dy; ry = -dx; }
	else if (t.rotation === 180) { rx = -dx; ry = -dy; }
	else if (t.rotation === 270) { rx = -dy; ry = dx; }
	const ix = rx / (t.scale * (t.flipH ? -1 : 1)) + natural.width / 2;
	const iy = ry / (t.scale * (t.flipV ? -1 : 1)) + natural.height / 2;
	if (ix < 0 || iy < 0 || ix >= natural.width || iy >= natural.height) return null;
	return { x: Math.floor(ix), y: Math.floor(iy) };
}

/** A width:height ratio in its simplest whole form (16:9), or as `n.nn:1` when the
 *  reduced pair is too large to read as a ratio. */
export function aspectRatio(width: number, height: number): string {
	if (width <= 0 || height <= 0) return '—';
	const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
	const divisor = gcd(width, height);
	const w = width / divisor;
	const h = height / divisor;
	if (w <= 32 && h <= 32) return `${w}:${h}`;
	return width >= height ? `${(width / height).toFixed(2)}:1` : `1:${(height / width).toFixed(2)}`;
}

/** The zoom as the toolbar prints it. */
export function zoomPercent(scale: number): string {
	const percent = scale * 100;
	return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}

/** The image files a folder listing holds, in the order a file manager shows them (natural
 *  name order, so `img2` precedes `img10`). */
export function naturalSort(names: string[]): string[] {
	const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
	return [...names].sort(collator.compare);
}
