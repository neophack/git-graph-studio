// The PC half of the DOM replica (protocol.ts): every node of the desktop window — and of
// every same-origin frame inside it, the extension webview pages (Claude Code's chat) among
// them — gets a stable id; a snapshot serializes the tree, and from then on the
// MutationObservers' records become batches of ops. What no observer reports is polled:
// form-control values, scroll positions (scroll events), CSSOM-inserted rules and adopted
// style sheets (CodeMirror's style-mod), the viewport size. Nothing here runs unless a
// remote viewer is attached: `start` and `stop` bracket the whole cost.
//
// The wire economy (2026-10-13, the owner's direction: 1/10 of the mirror traffic): the
// pages' own animations and re-render storms are not information — a viewer needs the
// settled states and the core content, not every intermediate frame. Four levers, all
// optional through `{ legacy: true }` for the A/B tests:
//  - string deltas: a changed text, attribute, control value or style sheet crosses as the
//    edit against the last value the viewers hold (`stringDelta`), so a streamed chat token
//    is the token, not the paragraph again;
//  - animation sampling: an attribute a script rewrites per frame (changes < ATTR_RAPID_MS
//    apart) is an animation loop — it crosses at ~1 Hz while it runs, and its settled value
//    always lands (a page's CSS keyframe animations never mutate the DOM and were always
//    free);
//  - storm folding: pending churn (childList nodes added plus removed) past STORM_CHURN is
//    a re-render storm (a virtualized list scrolling: git-graph-rs, CodeMirror's window) —
//    the intermediate renders are held up to `STORM_HOLD_MS` and collapse into one settled
//    batch, exactly the frames a passing viewer never reads;
//  - cadence tiers: a quiet period's first change leaves at 50 ms; continuous background
//    traffic coalesces at `STREAM_FLUSH_MS`; replayed input still flushes immediately, so
//    interactivity keeps the fast floor.

import { canonicalize, canonicalizeCss, stringDelta, type MirrorOp, type SDoc, type SNode, type Viewport } from './protocol';

const XHTML = 'http://www.w3.org/1999/xhtml';
/** A quiet period's first change crosses this fast (the responsive floor). */
const FLUSH_MS = 50;
/** Continuous background traffic (a chat streaming, a page's own timers) coalesces at this
 *  cadence instead: the per-message frame and envelope overhead dwarfs a delta's payload,
 *  and 2 Hz is a picture's refresh, not a renderer's — a streamed reply still reads as
 *  typing. Input never waits — the host flushes on every replayed input message, so
 *  interactivity keeps the 50 ms floor. */
const STREAM_FLUSH_MS = 500;
/** Values, CSSOM rules and adopted sheets are re-read this often. */
const POLL_MS = 400;
/** An attribute a script rewrites sooner than this is an animation loop — a copy is a
 *  picture, not a renderer, so its mid-states cross at ~1 Hz while the loop runs and its
 *  settled value always lands (a page's CSS keyframe animations never mutate the DOM and
 *  were always free). */
const ATTR_ANIM_MS = 1000;
/** Two changes of one attribute closer together than this begin to look like a script
 *  driving it per frame; the third inside a run is where throttling starts. */
const ATTR_RAPID_MS = 100;
/** A flush whose pending churn (nodes added plus removed, other records as one) passes
 *  this is a re-render storm… */
const STORM_CHURN = 24;
/** …whose intermediate renders are held this long before one settled flush goes out: a
 *  scroll fling replaces its whole window per frame, and the rows a passing viewer never
 *  reads are the bulk of the mirror's pre-economy traffic. The cap is also the worst-case
 *  delay a stormy content change (a folder's tree filling in) can wait. */
const STORM_HOLD_MS = 600;
const URL_ATTRS = new Set(['src', 'href', 'poster', 'action', 'data', 'xlink:href', 'background']);
/** Elements whose content never crosses: inert in the copy, bytes for nothing. */
const EMPTIED = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE']);

interface Watched {
	observer: MutationObserver;
	unlisten: () => void;
	adoptedKey: string;
	adoptedText: string;
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function isControl(node: Node): node is Control {
	const name = node.nodeName;
	return name === 'INPUT' || name === 'TEXTAREA' || name === 'SELECT';
}

function rulesText(sheet: CSSStyleSheet | null | undefined): string {
	if (!sheet) return '';
	try {
		return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
	} catch {
		return '';
	}
}

function ruleCount(sheet: CSSStyleSheet | null | undefined): number {
	try {
		return sheet?.cssRules.length ?? 0;
	} catch {
		return 0;
	}
}

/** The app's own asset root (`http://tauri.localhost/`); none for a document without a
 *  hierarchical base (an `about:blank` one). */
function appRootOf(doc: Document): string {
	try {
		const root = new URL('/', doc.baseURI);
		return root.protocol === 'about:' ? '' : root.href;
	} catch {
		return '';
	}
}

/** An element scrolled to (within a pixel of) its end. */
function atEnd(el: Element): boolean {
	return el.scrollHeight > el.clientHeight + 1 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
}

/** One animated attribute's send bookkeeping. */
interface AttrHeat {
	/** When its value last crossed (0: never since the recorder started). */
	lastSent: number;
	/** When it last changed at all — the rapid-run detector's clock. */
	lastChange: number;
	/** Changes closer together than `ATTR_RAPID_MS`, consecutive: 2 is a running animation. */
	rapid: number;
	/** A newer value is waiting out the animation window. */
	pending: boolean;
	/** The flush sequence that last saw it in the change set (the settle pass skips those). */
	at: number;
}

export interface RecorderOptions {
	/** The pre-economy wire: full values every change, every flush, no holds. For the A/B
	 *  traffic tests only — the app always runs the economy. */
	legacy?: boolean;
}

export class DomRecorder {
	private ids = new WeakMap<Node, number>();
	private nodes = new Map<number, Node>();
	private nextId = 1;
	private watched = new Map<Document, Watched>();
	private records: MutationRecord[] = [];
	private scrolled = new Set<Element>();
	private controls = new Set<Control>();
	private sentValues = new WeakMap<Control, string>();
	/** The last control VALUE the viewers hold (the delta base; `sentValues` keys the poll). */
	private sentControlText = new WeakMap<Control, string>();
	/** The last canonical text of a text node the viewers hold. */
	private sentTexts = new WeakMap<Node, string>();
	/** The last canonical attribute values an element's viewers hold. */
	private sentAttrs = new WeakMap<Element, Map<string, string>>();
	/** Style elements filled through the CSSOM only: rule count and last sent text. */
	private cssomStyles = new Map<HTMLStyleElement, { rules: number; text: string }>();
	private attrHeat = new WeakMap<Element, Map<string, AttrHeat>>();
	/** Elements with an attribute waiting out its animation window. */
	private deferredAttrs = new Set<Element>();
	private loadHooked = new WeakSet<HTMLIFrameElement>();
	private frameDocs = new Map<HTMLIFrameElement, Document | null>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastFlush = 0;
	private flushSeq = 0;
	/** Whether the last batch carried nothing — the next change then leaves at the fast
	 *  cadence instead of the streaming one. */
	private lastEmpty = true;
	private stormSince = 0;
	private viewport: Viewport = { w: 0, h: 0 };
	private seq = 0;
	private running = false;
	private readonly appRoot: string;
	private readonly onResize = () => this.schedule();

	constructor(
		private readonly root: Document,
		private readonly sink: (ops: MirrorOp[], seq: number) => void,
		private readonly options: RecorderOptions = {}
	) {
		this.appRoot = appRootOf(root);
	}

	private get legacy(): boolean {
		return this.options.legacy === true;
	}

	get active(): boolean {
		return this.running;
	}

	/** The node behind an id the viewer named, while it is still part of the copy. */
	nodeOf(id: number): Node | undefined {
		return this.nodes.get(id);
	}

	idOf(node: Node): number | undefined {
		return this.ids.get(node);
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.viewport = this.readViewport();
		this.root.defaultView?.addEventListener('resize', this.onResize);
		this.pollTimer = setInterval(() => this.poll(), POLL_MS);
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		for (const watched of this.watched.values()) {
			watched.observer.disconnect();
			watched.unlisten();
		}
		this.watched.clear();
		this.root.defaultView?.removeEventListener('resize', this.onResize);
		if (this.flushTimer !== null) clearTimeout(this.flushTimer);
		if (this.pollTimer !== null) clearInterval(this.pollTimer);
		if (this.settleTimer !== null) clearTimeout(this.settleTimer);
		this.flushTimer = null;
		this.pollTimer = null;
		this.settleTimer = null;
		this.ids = new WeakMap();
		this.nodes.clear();
		this.records = [];
		this.scrolled.clear();
		this.controls.clear();
		this.cssomStyles.clear();
		this.frameDocs.clear();
		this.sentValues = new WeakMap();
		this.sentControlText = new WeakMap();
		this.sentTexts = new WeakMap();
		this.sentAttrs = new WeakMap();
		this.attrHeat = new WeakMap();
		this.deferredAttrs.clear();
		this.loadHooked = new WeakSet();
		this.stormSince = 0;
		this.lastEmpty = true;
	}

	/** The whole tree as it stands, after the pending changes went out to the viewers
	 *  already watching (the snapshot's `seq` is the last batch it includes). */
	snapshot(): { seq: number; root: number; doc: SDoc; vp: Viewport } {
		this.start();
		this.flush();
		// The serialization below re-seeds every baseline with the CURRENT values — so
		// every value a viewer could still be missing (an animated attribute waiting out
		// its sample window) must cross first, or the next delta would compute against a
		// base the other viewers never received.
		const forced: MirrorOp[] = [];
		this.settleAttrs(forced, true);
		this.emit(forced);
		const doc = this.serializeDoc(this.root);
		this.viewport = this.readViewport();
		return { seq: this.seq, root: doc.d, doc, vp: this.viewport };
	}

	private readViewport(): Viewport {
		const win = this.root.defaultView;
		return { w: Math.round(win?.innerWidth ?? 0), h: Math.round(win?.innerHeight ?? 0) };
	}

	private assign(node: Node): number {
		let id = this.ids.get(node);
		if (id === undefined) {
			id = this.nextId++;
			this.ids.set(node, id);
			this.nodes.set(id, node);
		}
		return id;
	}

	/** Forget a node and everything under it (its frames' documents too). */
	private release(node: Node): void {
		const id = this.ids.get(node);
		if (id !== undefined) {
			this.ids.delete(node);
			this.nodes.delete(id);
		}
		if (node.nodeName === 'IFRAME') this.releaseFrame(node as HTMLIFrameElement);
		for (let child = node.firstChild; child; child = child.nextSibling) this.release(child);
	}

	private releaseFrame(frame: HTMLIFrameElement): void {
		const doc = this.frameDocs.get(frame);
		this.frameDocs.delete(frame);
		if (!doc) return;
		this.unwatch(doc);
		this.release(doc);
	}

	// ---- the delta bases ----

	private attrBase(el: Element, name: string): string | undefined {
		return this.sentAttrs.get(el)?.get(name);
	}

	private setAttrBase(el: Element, name: string, value: string | undefined): void {
		let map = this.sentAttrs.get(el);
		if (!map) {
			if (value === undefined) return;
			map = new Map();
			this.sentAttrs.set(el, map);
		}
		if (value === undefined) map.delete(name);
		else map.set(name, value);
	}

	// ---- observing ----

	private watch(doc: Document): void {
		if (this.watched.has(doc)) return;
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				this.records.push(record);
				// The animation detector reads change times as they happen: a flush only
				// every 250 ms would otherwise hide a 60 Hz rewrite as one lazy change.
				if (record.type === 'attributes' && record.attributeName) this.noteAttrChange(record.target as Element, record.attributeName);
			}
			this.schedule();
		});
		observer.observe(doc, { childList: true, subtree: true, attributes: true, characterData: true });
		const onScroll = (event: Event) => {
			const target = event.target;
			const el = target instanceof (doc.defaultView?.Element ?? Element) ? (target as Element) : doc.scrollingElement;
			if (el) this.scrolled.add(el);
			this.schedule();
		};
		const onInput = () => this.schedule();
		doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
		doc.addEventListener('input', onInput, true);
		doc.addEventListener('change', onInput, true);
		// The caret moves without mutating anything — its own event rides the same
		// schedule, so a phone typing into the mirror sees the cursor land live.
		doc.addEventListener('selectionchange', onInput, true);
		this.watched.set(doc, {
			observer,
			adoptedKey: this.adoptedKey(doc),
			adoptedText: this.adoptedText(doc),
			unlisten: () => {
				doc.removeEventListener('scroll', onScroll, { capture: true });
				doc.removeEventListener('input', onInput, true);
				doc.removeEventListener('change', onInput, true);
				doc.removeEventListener('selectionchange', onInput, true);
			}
		});
	}

	private unwatch(doc: Document): void {
		const watched = this.watched.get(doc);
		if (!watched) return;
		watched.observer.disconnect();
		watched.unlisten();
		this.watched.delete(doc);
	}

	/** Arm the flush tick. While a storm is held the re-check runs on the base step — the
	 *  cadence formula would degrade to a 0 ms hot loop once `lastFlush` stales past it. */
	private armTick(wait: number): void {
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			if (this.stormy()) {
				this.armTick(FLUSH_MS);
				return;
			}
			this.flush();
		}, wait);
	}

	private schedule(): void {
		if (!this.running || this.flushTimer !== null) return;
		const cadence = !this.legacy && !this.lastEmpty ? STREAM_FLUSH_MS : FLUSH_MS;
		this.armTick(Math.max(0, cadence - (Date.now() - this.lastFlush)));
	}

	/** Pull the observers' pending records into the recorder's own list (they normally
	 *  arrive as microtasks; reading them here makes the storm check independent of the
	 *  engine's delivery timing). */
	private harvest(): void {
		for (const watched of this.watched.values()) for (const record of watched.observer.takeRecords()) this.records.push(record);
	}

	/** Whether the pending records are a re-render storm whose intermediate states wait:
	 *  past `STORM_HOLD_MS` the flush always goes out. The churn is nodes added plus
	 *  removed — one innerHTML swap of a virtualized window is a single childList record
	 *  carrying every row. */
	private stormy(): boolean {
		if (this.legacy) return false;
		this.harvest();
		let churn = 0;
		for (const record of this.records) {
			churn += record.type === 'childList' ? record.addedNodes.length + record.removedNodes.length : 1;
		}
		if (churn < STORM_CHURN) return false;
		if (this.stormSince === 0) this.stormSince = Date.now();
		return Date.now() - this.stormSince < STORM_HOLD_MS;
	}

	// ---- serializing ----

	private adoptedSheets(doc: Document): CSSStyleSheet[] {
		return ((doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []) as CSSStyleSheet[];
	}

	private adoptedKey(doc: Document): string {
		const sheets = this.adoptedSheets(doc);
		return `${sheets.length}:${sheets.reduce((sum, sheet) => sum + ruleCount(sheet), 0)}`;
	}

	private adoptedText(doc: Document): string {
		return canonicalizeCss(this.adoptedSheets(doc).map((sheet) => rulesText(sheet)).join('\n'), doc.baseURI, this.appRoot);
	}

	private serializeDoc(doc: Document): SDoc {
		this.watch(doc);
		const d = this.assign(doc);
		const html = doc.documentElement ? this.serialize(doc.documentElement) : null;
		const adopted = this.adoptedText(doc);
		const watched = this.watched.get(doc);
		if (watched) watched.adoptedText = adopted;
		return {
			d,
			html: html ?? { i: this.assign(doc.createElement('html')), t: 'e', n: 'html' },
			adopted
		};
	}

	private attrs(el: Element): Record<string, string> | undefined {
		const tag = el.nodeName;
		const base = el.ownerDocument.baseURI;
		let out: Record<string, string> | undefined;
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name;
			if (name.startsWith('on')) continue;
			if (tag === 'IFRAME' && (name === 'src' || name === 'srcdoc' || name === 'sandbox')) continue;
			if (tag === 'SCRIPT' && name === 'src') continue;
			if (tag === 'META' && name === 'http-equiv') return undefined;
			if (tag === 'LINK' && name === 'href' && /\b(?:modulepreload|preload|prefetch)\b/i.test(el.getAttribute('rel') ?? '')) continue;
			(out ??= {})[name] = this.attrValue(name, attr.value, base);
		}
		return out;
	}

	private attrValue(name: string, value: string, base: string): string {
		if (URL_ATTRS.has(name)) return canonicalize(value, base, this.appRoot);
		if (name === 'style') return canonicalizeCss(value, base, this.appRoot);
		if (name === 'srcset') {
			return value
				.split(',')
				.map((part) => {
					const [url, ...rest] = part.trim().split(/\s+/);
					return [canonicalize(url ?? '', base, this.appRoot), ...rest].join(' ');
				})
				.join(', ');
		}
		return value;
	}

	private serialize(node: Node): SNode | null {
		switch (node.nodeType) {
			case 3: {
				const parent = node.parentNode?.nodeName;
				const text = node.nodeValue ?? '';
				const value = parent === 'STYLE' ? canonicalizeCss(text, node.ownerDocument?.baseURI ?? '', this.appRoot) : text;
				this.sentTexts.set(node, value);
				return { i: this.assign(node), t: 'x', n: value };
			}
			case 8:
				return { i: this.assign(node), t: 'c', n: '' };
			case 1:
				break;
			default:
				return null;
		}
		const el = node as Element;
		const tag = el.nodeName;
		const out: SNode = { i: this.assign(el), t: 'e', n: el.namespaceURI === XHTML ? el.localName : el.tagName };
		if (el.namespaceURI && el.namespaceURI !== XHTML) {
			out.ns = el.namespaceURI;
			out.n = el.localName;
		}
		const attrs = this.attrs(el);
		if (attrs) {
			out.a = attrs;
			for (const [name, value] of Object.entries(attrs)) this.setAttrBase(el, name, value);
		}
		if (tag === 'META' && el.hasAttribute('http-equiv')) {
			// A copied CSP would govern the viewer's own loads: the tag crosses empty.
			out.n = 'meta';
			delete out.a;
			return out;
		}
		if (!EMPTIED.has(tag) && tag !== 'IFRAME') {
			const children: SNode[] = [];
			for (let child = el.firstChild; child; child = child.nextSibling) {
				const s = this.serialize(child);
				if (s) children.push(s);
			}
			if (children.length) out.k = children;
		}
		if (tag === 'STYLE') {
			const style = el as HTMLStyleElement;
			if ((style.textContent ?? '').trim() === '' && ruleCount(style.sheet) > 0) {
				out.css = canonicalizeCss(rulesText(style.sheet), el.ownerDocument.baseURI, this.appRoot);
				this.cssomStyles.set(style, { rules: ruleCount(style.sheet), text: out.css });
			} else if ((style.textContent ?? '').trim() === '') {
				this.cssomStyles.set(style, { rules: 0, text: '' });
			}
		}
		if (isControl(el)) {
			this.controls.add(el);
			out.v = el.value;
			if (el instanceof (el.ownerDocument.defaultView?.HTMLInputElement ?? HTMLInputElement) && (el.type === 'checkbox' || el.type === 'radio')) out.ck = el.checked;
			this.sentValues.set(el, this.valueKey(el));
			this.sentControlText.set(el, el.value);
		}
		if (el.scrollTop || el.scrollLeft) out.sc = [el.scrollTop, el.scrollLeft];
		if (tag === 'IFRAME') {
			const frame = el as HTMLIFrameElement;
			this.hookFrame(frame);
			const doc = this.frameDoc(frame);
			this.frameDocs.set(frame, doc);
			if (doc) out.doc = this.serializeDoc(doc);
		}
		return out;
	}

	private frameDoc(frame: HTMLIFrameElement): Document | null {
		try {
			return frame.contentDocument ?? null;
		} catch {
			return null;
		}
	}

	/** A frame that (re)loads swaps its whole document: the copy rebuilds it. */
	private hookFrame(frame: HTMLIFrameElement): void {
		if (this.loadHooked.has(frame)) return;
		this.loadHooked.add(frame);
		frame.addEventListener('load', () => {
			if (!this.running) return;
			const id = this.ids.get(frame);
			if (id === undefined) return;
			const before = this.frameDocs.get(frame) ?? null;
			const now = this.frameDoc(frame);
			if (before && before !== now) {
				this.unwatch(before);
				this.release(before);
			}
			this.frameDocs.set(frame, now);
			this.flush();
			this.emit([{ o: 'doc', i: id, doc: now ? this.serializeDoc(now) : null }]);
		});
	}

	private valueKey(control: Control): string {
		const checked = control instanceof (control.ownerDocument.defaultView?.HTMLInputElement ?? HTMLInputElement) ? (control as HTMLInputElement).checked : false;
		return `${control.value}\u0000${checked ? 1 : 0}`;
	}

	// ---- batching ----

	private emit(ops: MirrorOp[]): void {
		if (!ops.length) return;
		this.seq += 1;
		this.sink(ops, this.seq);
	}

	/** An attribute's animation window: `true` when its change waits — a run of changes
	 *  quicker than `ATTR_RAPID_MS` (a script driving it per frame), past its second
	 *  change, sooner than `ATTR_ANIM_MS` after the last one that did cross. The first
	 *  changes of any sequence cross at once: a hover flip or a busy flag is not an
	 *  animation, and its removal must land. */
	private throttled(el: Element, heat: AttrHeat): boolean {
		if (this.legacy) return false;
		const now = Date.now();
		if (heat.rapid < 2 || now - heat.lastSent >= ATTR_ANIM_MS) {
			heat.lastSent = now;
			heat.pending = false;
			return false;
		}
		heat.pending = true;
		this.deferredAttrs.add(el);
		this.armSettle(Math.max(1, ATTR_ANIM_MS - (now - heat.lastSent) + 1));
		return true;
	}

	/** Count an attribute change as it happens (the observer callback): two changes closer
	 *  than `ATTR_RAPID_MS` are a run; the run's third is where throttling starts. */
	private noteAttrChange(el: Element, name: string): void {
		const heat = this.heatFor(el, name);
		const now = Date.now();
		heat.rapid = now - heat.lastChange < ATTR_RAPID_MS ? heat.rapid + 1 : 0;
		heat.lastChange = now;
	}

	/** A settled value must land even if nothing else ever mutates again: one timer that
	 *  flushes (the settle pass inside) once the animation window has passed. */
	private settleTimer: ReturnType<typeof setTimeout> | null = null;

	private armSettle(delay: number): void {
		if (this.settleTimer !== null || !this.running) return;
		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			if (this.running && this.deferredAttrs.size > 0) this.flush();
		}, delay);
	}

	private heatFor(el: Element, name: string): AttrHeat {
		let map = this.attrHeat.get(el);
		if (!map) {
			map = new Map();
			this.attrHeat.set(el, map);
		}
		let heat = map.get(name);
		if (!heat) {
			heat = { lastSent: 0, lastChange: 0, rapid: 0, pending: false, at: 0 };
			map.set(name, heat);
		}
		return heat;
	}

	/** Land the settled values of animated attributes: those whose change streak ended
	 *  (or kept running past the window — a sustained animation is sampled, not dropped).
	 *  `forced` (a snapshot about to re-seed the bases) ignores the sample window and the
	 *  same-flush guard: whatever is pending crosses now, to every viewer. Answers the
	 *  earliest remaining window of what still waits, so the trailing flush lands the
	 *  value the moment it is due (not a full window later). */
	private settleAttrs(ops: MirrorOp[], forced = false): number | null {
		if (this.deferredAttrs.size === 0) return null;
		const now = Date.now();
		let next: number | null = null;
		for (const el of Array.from(this.deferredAttrs)) {
			const heats = this.attrHeat.get(el);
			if (!heats || !el.isConnected) {
				this.deferredAttrs.delete(el);
				continue;
			}
			let waiting = false;
			for (const [name, heat] of heats) {
				if (!heat.pending) continue;
				// Touched by this flush's change set, or inside its sample window: still
				// waiting — a skipped settle must not drop the pending value on the floor.
				if (!forced && (heat.at === this.flushSeq || now - heat.lastSent < ATTR_ANIM_MS)) {
					waiting = true;
					const remain = ATTR_ANIM_MS - (now - heat.lastSent);
					if (next === null || remain < next) next = Math.max(1, remain);
					continue;
				}
				heat.pending = false;
				heat.lastSent = now;
				const id = this.ids.get(el);
				if (id === undefined || !el.isConnected) continue;
				const raw = el.getAttribute(name);
				if (raw === null) {
					if (this.attrBase(el, name) !== undefined) {
						ops.push({ o: 'attr', i: id, k: name, v: null });
						this.setAttrBase(el, name, undefined);
					}
					continue;
				}
				const value = this.attrValue(name, raw, el.ownerDocument.baseURI);
				if (this.attrBase(el, name) === value) continue;
				const base = this.attrBase(el, name);
				ops.push({ o: 'attr', i: id, k: name, ...(this.legacy ? { v: value } : stringDelta(base, value)) });
				this.setAttrBase(el, name, value);
			}
			if (!waiting) this.deferredAttrs.delete(el);
		}
		return next;
	}

	/** Turn everything observed since the last batch into one batch of ops (plus `extra`,
	 *  what a poll already read). A direct call always flushes; the scheduled path holds
	 *  re-render storms (`stormy`). */
	flush(extra: MirrorOp[] = []): void {
		if (!this.running) return;
		this.lastFlush = Date.now();
		this.stormSince = 0;
		this.flushSeq += 1;
		this.harvest();
		const records = this.records;
		this.records = [];
		const ops: MirrorOp[] = [];
		const added = new Set<Node>();
		const attrs = new Map<Element, Set<string>>();
		const texts = new Set<Node>();
		for (const record of records) {
			if (record.type === 'childList') {
				for (const node of Array.from(record.removedNodes)) {
					const id = this.ids.get(node);
					if (id === undefined) continue;
					ops.push({ o: 'rm', i: id });
					this.release(node);
				}
				for (const node of Array.from(record.addedNodes)) added.add(node);
			} else if (record.type === 'attributes') {
				const el = record.target as Element;
				const names = attrs.get(el) ?? new Set<string>();
				names.add(record.attributeName ?? '');
				attrs.set(el, names);
			} else if (record.type === 'characterData') {
				texts.add(record.target);
			}
		}
		for (const node of added) {
			if (!node.isConnected || this.ids.has(node)) continue;
			const parent = node.parentNode;
			if (!parent || this.ids.get(parent) === undefined) continue;
			let covered = false;
			for (let up: Node | null = parent; up; up = up.parentNode) {
				if (added.has(up) && !this.ids.has(up)) {
					covered = true;
					break;
				}
			}
			if (covered) continue;
			const s = this.serialize(node);
			if (!s) continue;
			let before: number | null = null;
			for (let next = node.nextSibling; next; next = next.nextSibling) {
				const id = this.ids.get(next);
				if (id !== undefined && id !== s.i) {
					before = id;
					break;
				}
			}
			ops.push({ o: 'add', p: this.ids.get(parent)!, b: before, n: s });
		}
		for (const node of texts) {
			const id = this.ids.get(node);
			if (id === undefined || !node.isConnected) continue;
			const text = node.nodeValue ?? '';
			const value = node.parentNode?.nodeName === 'STYLE' ? canonicalizeCss(text, node.ownerDocument?.baseURI ?? '', this.appRoot) : text;
			const base = this.sentTexts.get(node);
			if (!this.legacy && base === value) continue;
			this.sentTexts.set(node, value);
			ops.push({ o: 'text', i: id, ...(this.legacy ? { v: value } : stringDelta(base, value)) });
		}
		for (const [el, names] of attrs) {
			const id = this.ids.get(el);
			if (id === undefined || !el.isConnected) continue;
			for (const name of names) {
				if (!name || name.startsWith('on')) continue;
				if (el.nodeName === 'IFRAME' && (name === 'src' || name === 'srcdoc' || name === 'sandbox')) continue;
				const heat = this.heatFor(el, name);
				heat.at = this.flushSeq;
				const raw = el.getAttribute(name);
				if (raw === null) {
					if (this.attrBase(el, name) === undefined) continue;
					if (this.throttled(el, heat)) continue;
					ops.push({ o: 'attr', i: id, k: name, v: null });
					this.setAttrBase(el, name, undefined);
					continue;
				}
				const value = this.attrValue(name, raw, el.ownerDocument.baseURI);
				if (!this.legacy && this.attrBase(el, name) === value) {
					// Changed away and back within the batch: the viewers hold this already.
					heat.pending = false;
					continue;
				}
				if (this.throttled(el, heat)) continue;
				const base = this.attrBase(el, name);
				ops.push({ o: 'attr', i: id, k: name, ...(this.legacy ? { v: value } : stringDelta(base, value)) });
				this.setAttrBase(el, name, value);
			}
		}
		// Anything still waiting out its window must land even if nothing ever mutates
		// again: one settle flush armed for the earliest due moment.
		const settleWait = this.settleAttrs(ops);
		if (settleWait !== null) this.armSettle(settleWait);
		this.pollInto(ops);
		for (const op of extra) ops.push(op);
		for (const el of this.scrolled) {
			const id = this.ids.get(el);
			if (id === undefined || !el.isConnected) continue;
			ops.push(atEnd(el) ? { o: 'scroll', i: id, t: el.scrollTop, l: el.scrollLeft, e: 1 } : { o: 'scroll', i: id, t: el.scrollTop, l: el.scrollLeft });
		}
		this.scrolled.clear();
		const viewport = this.readViewport();
		if (viewport.w !== this.viewport.w || viewport.h !== this.viewport.h) {
			this.viewport = viewport;
			ops.push({ o: 'vp', w: viewport.w, h: viewport.h });
		}
		this.lastEmpty = ops.length === 0;
		this.emit(ops);
	}

	/** What no observer reports: values, CSSOM-only styles, adopted sheets, dead frames. */
	/** The caret state as last sent (a bare string key; `''` = no caret). */
	private lastCaret = '';

	/** Append the caret op when the focused editable's selection changed. */
	private caretInto(ops: MirrorOp[]): void {
		const op = this.readCaret();
		const c = op as Extract<MirrorOp, { o: 'caret' }> | null;
		const key = c ? `${c.i ?? ''}:${c.s ?? ''}:${c.e ?? ''}:${c.ci ?? ''}:${c.co ?? ''}` : '';
		if (key === this.lastCaret) return;
		this.lastCaret = key;
		ops.push(op ?? { o: 'caret' });
	}

	/** The focused editable's caret, following the active-element chain into the focused
	 *  same-origin frame (a webview's chat composer). `null` when nothing editable holds
	 *  it — non-text controls (a checkbox) hold focus without a caret. */
	private readCaret(): Extract<MirrorOp, { o: 'caret' }> | null {
		let doc: Document | null = this.root;
		for (let hop = 0; doc && hop < 8; hop += 1) {
			const el = doc.activeElement as HTMLElement | null;
			if (!el) return null;
			const tag = el.tagName;
			if (tag === 'TEXTAREA' || (tag === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color', 'image'].includes((el as HTMLInputElement).type))) {
				const i = this.ids.get(el);
				if (i === undefined) return null;
				const control = el as HTMLInputElement;
				const s = control.selectionStart ?? control.value.length;
				const e = control.selectionEnd ?? s;
				return { o: 'caret', i, s, e };
			}
			if (contentEditable(el)) {
				const selection = doc.getSelection();
				const node = selection?.anchorNode ?? null;
				// The anchor is a text node at its offset, or an element at its child index —
				// an empty editable (the Claude composer before its first character) anchors
				// on itself, and that boundary paints as well: the bare element case once
				// meant "no caret", and typing into the empty composer showed no cursor.
				if (!node || (node.nodeType !== 3 && node.nodeType !== 1)) return null;
				const ci = this.ids.get(node);
				return ci === undefined ? null : { o: 'caret', ci, co: selection!.anchorOffset };
			}
			// Descend into the focused same-origin frame the recorder also watches.
			if (tag === 'IFRAME') {
				const inner = (el as HTMLIFrameElement).contentDocument;
				if (inner && this.watched.has(inner)) {
					doc = inner;
					continue;
				}
			}
			return null;
		}
		return null;
	}

	private pollInto(ops: MirrorOp[]): void {
		for (const control of this.controls) {
			if (!control.isConnected) {
				this.controls.delete(control);
				continue;
			}
			const key = this.valueKey(control);
			if (this.sentValues.get(control) === key) continue;
			this.sentValues.set(control, key);
			const id = this.ids.get(control);
			if (id === undefined) continue;
			const isInput = control instanceof (control.ownerDocument.defaultView?.HTMLInputElement ?? HTMLInputElement);
			const base = this.sentControlText.get(control);
			this.sentControlText.set(control, control.value);
			const delta = this.legacy ? { v: control.value } : stringDelta(base, control.value);
			ops.push(isInput ? { o: 'val', i: id, ...delta, ck: (control as HTMLInputElement).checked } : { o: 'val', i: id, ...delta });
		}
		this.caretInto(ops);
		for (const [style, entry] of this.cssomStyles) {
			if (!style.isConnected) {
				this.cssomStyles.delete(style);
				continue;
			}
			if ((style.textContent ?? '').trim() !== '') continue;
			const rules = ruleCount(style.sheet);
			if (rules === entry.rules) continue;
			entry.rules = rules;
			const id = this.ids.get(style);
			if (id === undefined) continue;
			const text = canonicalizeCss(rulesText(style.sheet), style.ownerDocument.baseURI, this.appRoot);
			ops.push({ o: 'css', i: id, ...(this.legacy ? { v: text } : stringDelta(entry.text, text)) });
			entry.text = text;
		}
		for (const [doc, watched] of this.watched) {
			if (doc !== this.root && !doc.defaultView) {
				this.unwatch(doc);
				continue;
			}
			const key = this.adoptedKey(doc);
			if (key === watched.adoptedKey) continue;
			watched.adoptedKey = key;
			const d = this.ids.get(doc);
			if (d !== undefined) {
				const text = this.adoptedText(doc);
				ops.push({ o: 'adopted', d, ...(this.legacy ? { v: text } : stringDelta(watched.adoptedText, text)) });
				watched.adoptedText = text;
			}
		}
	}

	private poll(): void {
		if (!this.running) return;
		if (this.stormy()) {
			this.schedule();
			return;
		}
		const ops: MirrorOp[] = [];
		this.pollInto(ops);
		if (ops.length) {
			// One batch: the pending mutations first, the polled values after them.
			this.flush(ops);
			return;
		}
		const viewport = this.readViewport();
		if (viewport.w !== this.viewport.w || viewport.h !== this.viewport.h) this.flush();
	}
}

/** Whether an element is content-editable, by the attribute chain: `isContentEditable`
 *  answers undefined in some engines (jsdom), and the composer is often a nested
 *  editable inside a host that carries the attribute. */
function contentEditable(el: Element): boolean {
	for (let node: Element | null = el; node; node = node.parentElement) {
		const value = node.getAttribute('contenteditable');
		if (value === null || value === 'inherit') continue;
		if (value === 'false') return false;
		return true; // '', 'true', 'plaintext-only'
	}
	return false;
}
