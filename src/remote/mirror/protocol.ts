// The DOM replica's wire shapes (docs/ggs-remote-plan.md §22): the PC's desktop window is the
// one real Git Graph Studio frontend, and a remote browser shows a live copy of its DOM —
// a snapshot, then batches of mutations — while its pointer, wheel and keyboard input
// travels back to be replayed on the PC. Both halves ride ordinary app events through the
// Relay: the PC emits `MIRROR_DOWN` (every viewer listens, each reads what is addressed to
// it or to everyone), a viewer emits `MIRROR_UP` to the `main` window only.
//
// URLs inside the copy are canonical: the PC's own app assets become `APP_TOKEN<path>` and
// any package-asset root (`ggs://localhost/`, `http://ggs.localhost/`, a remote token
// route) becomes `GGS_TOKEN<path>`; each viewer maps them onto its own authorized routes.

export const MIRROR_DOWN = 'studio://mirror-down';
export const MIRROR_UP = 'studio://mirror-up';

/** The PC's app-asset root inside the copy (`<root>/assets/x.css` → `APP_TOKEN + 'assets/x.css'`). */
export const APP_TOKEN = '\u0001app/';
/** A package-asset root inside the copy. */
export const GGS_TOKEN = '\u0001ggs/';

/** A viewer says hello again this often; the PC forgets one it has not heard for `VIEWER_TTL_MS`. */
export const HELLO_EVERY_MS = 10_000;
export const VIEWER_TTL_MS = 35_000;

/** The synthetic pointer id every replayed pointer event carries. */
export const SYNTH_POINTER_ID = 9001;

/** One serialized node. `t`: `e` element, `x` text, `c` comment. */
export interface SNode {
	i: number;
	t: 'e' | 'x' | 'c';
	/** Element tag (lower case for HTML), or the text / comment data. */
	n: string;
	/** Namespace, when not XHTML (SVG, MathML). */
	ns?: string;
	a?: Record<string, string>;
	k?: SNode[];
	/** A form control's live value (`value` property, not the attribute). */
	v?: string;
	/** A checkbox's / radio's live `checked`. */
	ck?: boolean;
	/** Scroll position `[top, left]`, when not at the origin. */
	sc?: [number, number];
	/** A style element whose rules were inserted through the CSSOM (no text to copy). */
	css?: string;
	/** An iframe's document, when it is same-origin and loaded. */
	doc?: SDoc;
}

export interface SDoc {
	/** The document's own id (the target of `adopted` ops). */
	d: number;
	/** The documentElement's serialization. */
	html: SNode;
	/** The text of the document's adopted style sheets, in order (CodeMirror's style-mod). */
	adopted: string;
}

export type MirrorOp =
	| { o: 'add'; p: number; b: number | null; n: SNode }
	| { o: 'rm'; i: number }
	| { o: 'attr'; i: number; k: string; v: string | null }
	| { o: 'text'; i: number; v: string }
	| { o: 'val'; i: number; v: string; ck?: boolean }
	/** `e`: the scroller sits at its end — the viewer pins its own end (its fonts may make
	 *  the content a little taller or shorter than the PC's). */
	| { o: 'scroll'; i: number; t: number; l: number; e?: 1 }
	| { o: 'css'; i: number; v: string }
	| { o: 'adopted'; d: number; v: string }
	| { o: 'doc'; i: number; doc: SDoc | null }
	| { o: 'vp'; w: number; h: number };

export interface Viewport {
	w: number;
	h: number;
}

/** PC → viewers. `to` names one viewer, or `*`. */
export type DownMessage =
	| { k: 'snap'; to: string; seq: number; root: number; doc: SDoc; vp: Viewport }
	| { k: 'ops'; to: '*'; seq: number; ops: MirrorOp[] }
	| { k: 'clip'; to: string; text: string };

/** Keyboard modifiers as a bit set: 1 ctrl, 2 shift, 4 alt, 8 meta. */
export type Mods = number;

/** Where on its target an input lands: fractions of the target's box (the copy's fonts can
 *  differ from the PC's, so the PC re-reads the box on its own layout), plus the caret hint
 *  inside a text node when there is one. */
export interface Spot {
	i: number;
	fx: number;
	fy: number;
	/** A text node id and offset under the point. */
	ci?: number;
	co?: number;
}

/** Viewer → PC. `from` is the viewer's frontend id (`remote/<n>`). */
export type UpMessage =
	| { k: 'hello'; from: string; vw: number; vh: number; touch: boolean }
	| { k: 'bye'; from: string }
	| { k: 'resnap'; from: string }
	| ({ k: 'ptr'; from: string; ev: 'down' | 'move' | 'up' | 'hover' | 'ctx'; b: number; m: Mods; d: number } & Spot)
	| ({ k: 'wheel'; from: string; dx: number; dy: number; m: Mods } & Spot)
	| { k: 'key'; from: string; key: string; code: string; m: Mods }
	| { k: 'text'; from: string; v: string }
	| { k: 'sel'; from: string; i: number; v: string }
	| { k: 'copy'; from: string };

/** An up message before the viewer stamps its `from` on it. */
export type UpPayload = UpMessage extends infer M ? (M extends unknown ? Omit<M, 'from'> : never) : never;

export function modsOf(event: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): Mods {
	return (event.ctrlKey ? 1 : 0) | (event.shiftKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
}

/** The package-asset roots a copied URL can carry (the same set `extHost.ts` localizes). */
const GGS_ROOT = /^(?:ggs:\/\/localhost\/|https?:\/\/ggs\.localhost\/|https?:\/\/[^\s"'<>/]+(?:\/u\/[^\s"'<>/]+)?\/w\/[^\s"'<>/]+\/ggs\/[^\s"'<>/]+\/)/;

/** One absolute URL in canonical form: the app root and the package roots become tokens,
 *  anything else (data:, https:) stays as it is. */
export function canonicalUrl(absolute: string, appRoot: string): string {
	if (appRoot && absolute.startsWith(appRoot)) return APP_TOKEN + absolute.slice(appRoot.length);
	const ggs = GGS_ROOT.exec(absolute);
	if (ggs) return GGS_TOKEN + absolute.slice(ggs[0].length);
	return absolute;
}

/** Resolve a URL as the document that holds it would, then canonicalize it. */
export function canonicalize(raw: string, base: string, appRoot: string): string {
	const value = raw.trim();
	if (value === '' || value.startsWith('#') || /^(?:data|blob|javascript|about|mailto):/i.test(value)) return raw;
	try {
		return canonicalUrl(new URL(value, base).href, appRoot);
	} catch {
		return raw;
	}
}

/** Every `url(...)` inside a piece of CSS, canonicalized against `base`. */
export function canonicalizeCss(css: string, base: string, appRoot: string): string {
	if (!css.includes('url(')) return css;
	return css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g, (whole, quote: string, url: string) => {
		const next = canonicalize(url, base, appRoot);
		return next === url ? whole : `url(${quote || '"'}${next}${quote || '"'})`;
	});
}

/** A viewer's side: tokens back to real URLs. */
export function localizeTokens(text: string, appBase: string, ggsBase: string): string {
	if (!text.includes('\u0001')) return text;
	return text.split(APP_TOKEN).join(appBase).split(GGS_TOKEN).join(ggsBase);
}
