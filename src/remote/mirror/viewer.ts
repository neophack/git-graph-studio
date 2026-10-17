// The browser half of the DOM replica (protocol.ts): the PC window's tree rebuilt inside a
// sandboxed frame that runs no script — nothing of the copy executes here, it is a
// picture made of DOM — and kept current by the PC's batches. Every same-origin frame of
// the PC (an extension's webview page) is rebuilt the same way inside its own frame
// element. A gap in the batch sequence asks for a fresh snapshot; a page reload is simply
// a new snapshot, the PC never notices.
//
// The copy is laid out at the PC window's own size and scaled to fit, so a point in the
// copy is a point on the PC; input (viewerInput.ts) reports spots relative to their
// targets anyway, which survives the small layout drift different fonts bring.
//
// A webview stream's copy (§22.6, webviewCopy.ts) is fluid instead: one extension page laid
// out at the host's own size — a phone reads the chat at the phone's width, not a scaled
// PC sidebar — and scrolled here, by the viewer, sticking to the end of a scroller that is
// at its end as the PC's page grows (the PC's own scroll positions mean nothing in a copy
// laid out at another width).

import { applyDelta, localizeTokens, scriptUrl, type CaretState, type DownMessage, type FocusEntry, type MirrorOp, type SDoc, type SNode, type StrDelta, type Viewport } from './protocol';

const XLINK = 'http://www.w3.org/1999/xlink';
/** The copy's frame sandbox. `allow-same-origin` is what lets THIS page read and write the
 *  copy's DOM; `allow-scripts` is NOT for the copy — nothing of it executes, the recorder
 *  empties every script, strips every `on*` attribute and drops `javascript:` URLs — but
 *  for the viewer's own listeners: WebKit (Safari, and the phone's browsers built on it)
 *  treats a listener this page registered on the sandboxed document as that document's own
 *  script execution and silently blocks every one of them without `allow-scripts` (Chromium
 *  runs them), which left the copy a dead picture in Safari — no tap, no key, no scroll
 *  ever reached the PC (2026-10-17: Safari 的 Claude 页面输入框不能输入、new session 没
 *  反应). The copy still runs nothing: the serialized tree carries nothing executable. */
const COPY_SANDBOX = 'allow-same-origin allow-scripts';
/** The element names the copy never instantiates. Because the sandbox runs scripts, the
 *  viewer cannot lean on the recorder alone: a script element (HTML or SVG — the SVG one's
 *  nodeName is lower-case, which the recorder once missed) built and connected through the
 *  DOM executes, and so does one that receives its text after connecting; a plugin
 *  element nests a document of its own. Each stands in the copy as an inert, hidden
 *  placeholder that keeps the node id the later ops address. */
const INERT_TAGS = new Set(['script', 'object', 'embed', 'applet']);
const INERT_TAG = 'ggs-inert';
/** The copy is a picture: no caret blinking where the PC has none, no text selection
 *  fighting the replayed one, pinch-zoom kept for phones — and the PC window's own
 *  minimize / maximize / close never show: a remote page has no window to drive, and a
 *  tap on them would replay into the PC's real controls. */
const BASE_CSS = 'ggs-inert{display:none!important}html{touch-action:pinch-zoom}.window-controls{display:none!important}*{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none}';
/** A fluid copy scrolls natively under the finger. */
const FLUID_CSS = 'ggs-inert{display:none!important}*{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none}';
/** No native caret in the copy — the painted bar is the PC's. Its own sheet, so the page's
 *  own `caret-color` stays readable for that bar (caretColor lifts it for the read). */
const HIDE_CARETS_CSS = '*{caret-color:transparent!important}';
/** A fluid copy looks for its scrollers again at most this often while it knows none. */
const SCROLLER_SCAN_MS = 1000;
/** …but stops after this many empty hunts until a rebuild or a scroll back to the end:
 *  a copy whose scroller is never at its end (the viewer reading history up-page) must
 *  not walk its whole document every second forever. */
const SCAN_MISS_CAP = 10;
/** How often a fluid copy reports a scroller's position while it scrolls. */
const SCROLL_REPORT_MS = 100;

/** The marker classes the mirrored focus wears (2026-10-13, the owner's direction: 远程不
 *  额外画光标和边框——镜像把焦点状态解析进副本自己的显示): the focused element carries
 *  `mirror-focus` (and `mirror-focus-visible` when the PC's engine matched it so), its
 *  ancestors `mirror-focus-within`, and every `:focus` rule of the copy's own sheets gains
 *  a class variant right beside it (deriveFocusRules) — Claude's composer border is drawn
 *  by Claude's own CSS, matched through the marker, never painted by the viewer. */
const FOCUS_CLASS = 'mirror-focus';
const FOCUS_VISIBLE_CLASS = 'mirror-focus-visible';
const FOCUS_WITHIN_CLASS = 'mirror-focus-within';
const FOCUS_PSEUDOS: Array<[RegExp, string]> = [
	[/:focus-within/g, `.${FOCUS_WITHIN_CLASS}`],
	[/:focus-visible/g, `.${FOCUS_VISIBLE_CLASS}`],
	[/:focus(?!-)/g, `.${FOCUS_CLASS}`]
];

/** Split a selector list on its top-level commas — outside parens, brackets and strings. */
function selectorsOf(selectorText: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote = '';
	let start = 0;
	for (let at = 0; at < selectorText.length; at += 1) {
		const ch = selectorText[at];
		if (quote) {
			if (ch === '\\') at += 1;
			else if (ch === quote) quote = '';
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(' || ch === '[') depth += 1;
		else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
		else if (ch === ',' && depth === 0) {
			out.push(selectorText.slice(start, at));
			start = at + 1;
		}
	}
	out.push(selectorText.slice(start));
	return out;
}

/** One selector with every `:focus` pseudo exchanged for its marker class — `null` when
 *  the selector carries none (or is already a derived one). */
function focusVariant(selector: string): string | null {
	if (!selector.includes(':focus') || selector.includes('mirror-focus')) return null;
	let out = selector;
	for (const [pattern, cls] of FOCUS_PSEUDOS) out = out.replace(pattern, cls);
	return out;
}

/** A sheet or grouping rule the derivation inserts into (@media, a nested style rule). */
type RuleParent = CSSStyleSheet | CSSGroupingRule;

/** An element scrolled to (within a couple of pixels of) its end. */
function atEnd(el: Element): boolean {
	return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
}

function scrollable(el: Element): boolean {
	if (el.scrollHeight <= el.clientHeight + 1) return false;
	if (el === el.ownerDocument.scrollingElement) return true;
	const overflow = el.ownerDocument.defaultView?.getComputedStyle(el).overflowY ?? '';
	return overflow === 'auto' || overflow === 'scroll';
}

/** An empty standards-mode document (a frame's initial about:blank is in quirks mode, which
 *  would lay the copy out differently from the PC). An engine without `document.write`
 *  keeps the document it has. */
function resetDoc(doc: Document): void {
	try {
		doc.open();
		doc.write('<!DOCTYPE html><html><head></head><body></body></html>');
		doc.close();
	} catch {
		// jsdom and friends: the existing document is reused as it is.
	}
}

export interface ViewerDeps {
	appBase: string;
	ggsBase: string;
	/** Ask the PC for a fresh snapshot (a gap in the sequence). */
	resnap(): void;
	/** A document of the copy came to life: the input layer attaches to it. */
	onDocument?(doc: Document): void;
	/** The first snapshot is on screen. */
	onReady?(): void;
	/** The PC answered a copy with its selection. */
	onClipboard?(text: string): void;
	/** The mirrored caret moved (or left): its position in the viewer page's own viewport
	 *  coordinates. The keyboard proxy rides it (viewerInput.ts), so an IME's candidate
	 *  window anchors where the typing is — not at the proxy's hideout corner. */
	onCaret?(point: { x: number; y: number; h: number } | null): void;
	/** The webview stream this viewer copies (absent: the whole window). */
	stream?: string;
	/** Lay the copy out at the host's size and scroll it here (a webview stream's copy). */
	fluid?: boolean;
	/** A fluid copy's scroller moved (§22.6): the fraction of its scroll range, and whether it
	 *  sits at its end. The PC puts its own scroller at the same place, so a page that renders
	 *  its content around the scroll position (a virtualized list: git-graph-rs) renders it
	 *  where the viewer is looking — the copy's local scroll would otherwise wander into the
	 *  rows the PC never rendered. */
	onScroll?(id: number, fraction: number, end: boolean): void;
}

export class MirrorViewer {
	private nodes = new Map<number, Node>();
	private ids = new WeakMap<Node, number>();
	private adoptedStyles = new Map<number, HTMLStyleElement>();
	/** The canonical (pre-`localize`) strings this copy last received, by node id — the
	 *  bases the PC's deltas apply against. An entry dies with its node. */
	private canonText = new Map<number, string>();
	private canonAttr = new Map<number, Map<string, string>>();
	private canonVal = new Map<number, string>();
	private canonCss = new Map<number, string>();
	private canonAdopted = new Map<number, string>();
	private frame: HTMLIFrameElement | null = null;
	private seq: number | null = null;
	/** The document this copy last filled. A frame re-parented through a detach (the layout
	 *  host's device-class switch moves the workbench part out of the DOM and back) has its
	 *  browsing context DISCARDED and reborn — the element then answers a different, empty
	 *  document, and the content written into the old one is gone. */
	private liveDoc: Document | null = null;
	/** A snapshot arrived while the fresh frame had no browsing context (its host was
	 *  detached): the drop is remembered here, and checkContext re-asks once the frame is
	 *  back in the document with a live context — seq-null alone would mute every probe. */
	private snapPending = false;
	private readonly onFrameLoad = () => this.checkContext();
	private viewport: Viewport = { w: 1, h: 1 };
	private ready = false;
	/** A fluid copy's scrollers that sit at their end: they follow the content's growth. */
	private stuck = new Set<Element>();
	private lastScan = 0;
	/** Consecutive scroller scans that found nothing: the hunt for a page's (late-rendering)
	 *  scroller stops after this many — a copy whose scroller is never at its end (the
	 *  viewer scrolled up to read history) used to walk the whole document every second
	 *  forever. A rebuild or a viewer scroll to the end re-arms it. */
	private scanMisses = 0;
	/** The mirrored caret (the phone-mirror cursor): the last caret op's fields, painted
	 *  into whichever document of the copy holds the editable. */
	private caret: CaretState | null = null;
	private caretEl: HTMLElement | null = null;
	/** Each copy document's caret-hiding sheet, and the caret colour resolved per editable
	 *  (cleared whenever a sheet of the copy changes — the read restyles the document). */
	private caretHide = new WeakMap<Document, HTMLStyleElement>();
	private caretColors = new WeakMap<Element, string>();
	/** The mirrored focus chain (the last focus op / snapshot's `focus`): the elements
	 *  currently wearing the marker classes, so a batch that rewrites a class attribute
	 *  (React re-rendering the focused wrapper) re-receives them afterwards. */
	private focus: FocusEntry[] = [];
	private marked: Element[] = [];
	/** Rules a sheet gained from the focus derivation, by sheet with the container each
	 *  was inserted into: removed before the sheet is derived again (its text was
	 *  replaced, or it loaded). */
	private derived = new WeakMap<CSSStyleSheet, Array<[RuleParent, CSSRule]>>();
	/** Each document's <link> load listener (a frame's document is reset and refilled, not
	 *  recreated). The refill's `document.open()` erases a document's listeners in spec
	 *  engines (Chromium measured), so every fill re-attaches it — removed first, for the
	 *  engines that keep listeners across an open. */
	private loadHooks = new WeakMap<Document, () => void>();
	/** A fluid copy's scroll reports waiting for their throttle (node id → fraction, end). */
	private scrollReport = new Map<number, [number, boolean]>();
	/** The scroll positions THIS copy applied (the end-pin's write, a snapshot's restore):
	 *  the scroll events they cause are not the viewer scrolling and are never reported —
	 *  a programmatic pin that crossed as a report would claim the stream's scroll
	 *  ownership on the PC for a machine act and hold it against every real viewer
	 *  (§9.2). A WeakMap: the marked elements die with their document. */
	private ownScrolls = new WeakMap<Element, number>();
	private scrollTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly onResize = () => this.layout();

	constructor(
		private readonly host: HTMLElement,
		private readonly me: string,
		private readonly deps: ViewerDeps
	) {
		host.ownerDocument.defaultView?.addEventListener('resize', this.onResize);
		host.ownerDocument.defaultView?.visualViewport?.addEventListener('resize', this.onResize);
	}

	/** The id of a node of the copy (what input reports name). */
	idOf(node: Node): number | undefined {
		return this.ids.get(node);
	}

	get scale(): number {
		const width = this.host.clientWidth || 1;
		const height = this.host.clientHeight || 1;
		return Math.min(width / this.viewport.w, height / this.viewport.h);
	}

	get root(): Document | null {
		return this.frame?.contentDocument ?? null;
	}

	dispose(): void {
		this.caretEl?.remove();
		this.caretEl = null;
		this.caret = null;
		this.focus = [];
		this.marked = [];
		if (this.scrollTimer !== null) clearTimeout(this.scrollTimer);
		this.scrollTimer = null;
		this.scrollReport.clear();
		this.host.ownerDocument.defaultView?.removeEventListener('resize', this.onResize);
		this.host.ownerDocument.defaultView?.visualViewport?.removeEventListener('resize', this.onResize);
		this.frame?.remove();
		this.frame = null;
		this.seq = null;
		this.liveDoc = null;
		this.canonText.clear();
		this.canonAttr.clear();
		this.canonVal.clear();
		this.canonCss.clear();
		this.canonAdopted.clear();
	}

	receive(message: DownMessage): void {
		if (!message) return;
		// One event carries every stream: this viewer reads its own only.
		if (('w' in message ? message.w : undefined) !== this.deps.stream) return;
		if (message.k === 'snap') {
			if (message.to !== this.me) return;
			// The snapshot carries the state the PC holds right now (caret, focus): both
			// cross as ops only on change, so this is a fresh viewer's starting state.
			this.caret = message.caret ?? null;
			this.focus = message.focus ?? [];
			this.snapshot(message.doc, message.vp, message.seq);
			return;
		}
		if (message.k === 'clip') {
			if (message.to === this.me) this.deps.onClipboard?.(message.text);
			return;
		}
		if (message.k !== 'ops' || this.seq === null) return;
		// Every batch doubles as the cheap health probe: a frame whose context a re-parent
		// rebuilt empty must ask for a fresh snapshot, not apply ops onto its dead tree.
		this.checkContext();
		if (this.seq === null) return;
		if (message.seq <= this.seq) return;
		if (message.seq !== this.seq + 1) {
			this.seq = null;
			this.deps.resnap();
			return;
		}
		this.seq = message.seq;
		for (const op of message.ops) {
			try {
				this.apply(op);
			} catch {
				// One op that cannot land (a node the copy lost) spoils the rest: start over.
				this.seq = null;
				this.deps.resnap();
				return;
			}
		}
		this.stick();
		this.paintCaret();
		// The page may have rewritten a marked element's class attribute in this batch
		// (React re-rendering the focused wrapper): the markers go back on afterwards.
		this.applyFocus();
	}

	private snapshot(doc: SDoc, vp: Viewport, seq: number): void {
		this.nodes.clear();
		this.ids = new WeakMap();
		this.adoptedStyles.clear();
		this.canonText.clear();
		this.canonAttr.clear();
		this.canonVal.clear();
		this.canonCss.clear();
		this.canonAdopted.clear();
		this.frame?.remove();
		this.seq = null;
		this.liveDoc = null;
		const frame = this.host.ownerDocument.createElement('iframe');
		frame.className = this.deps.fluid ? 'mirror-frame webview-copy-frame' : 'mirror-frame';
		frame.setAttribute('sandbox', COPY_SANDBOX);
		if (!this.deps.fluid) frame.setAttribute('scrolling', 'no');
		// The re-parent probe (checkContext): a frame moved through a detach is reborn, and
		// its fresh about:blank navigation fires load on the element — the moment the copy's
		// loss is noticed.
		frame.addEventListener('load', this.onFrameLoad);
		this.stuck.clear();
		this.lastScan = 0;
		this.scanMisses = 0;
		if (this.scrollTimer !== null) clearTimeout(this.scrollTimer);
		this.scrollTimer = null;
		this.scrollReport.clear();
		this.host.appendChild(frame);
		this.frame = frame;
		this.viewport = { w: Math.max(1, vp.w), h: Math.max(1, vp.h) };
		this.layout();
		const target = frame.contentDocument;
		if (!target) {
			this.snapPending = true;
			return;
		}
		this.snapPending = false;
		this.fillDoc(target, doc);
		this.liveDoc = target;
		this.seq = seq;
		this.stick();
		// The rebuilt copy starts from the state the snapshot carried: the caret bar and
		// the focus markers go on now, not when the PC's state next changes.
		this.paintCaret();
		this.applyFocus();
		if (!this.ready) {
			this.ready = true;
			this.deps.onReady?.();
		}
	}

	/** A frame whose browsing context was discarded and reborn — its pane re-parented through
	 *  a detach (a device-class switch adopts the workbench part into the next arrangement by
	 *  removing it and re-attaching it) — answers a different, EMPTY document, and nothing
	 *  refills it: the written copy would sit blank forever (2026-10-16, 切换窗口尺寸后
	 *  Claude 页面空白). The reborn frame's own load event, the batches that keep naming the
	 *  stream and the layout switch's resize nudge all land here; the answer is a fresh
	 *  snapshot — asked for only once the frame is back IN the document, so the rebuilt copy
	 *  lands in a context the next move does not take with it. */
	private checkContext(): void {
		const frame = this.frame;
		if (!frame) return;
		if (this.snapPending) {
			if (!frame.isConnected) return;
			let ready: Document | null = null;
			try {
				ready = frame.contentDocument ?? null;
			} catch {
				ready = null;
			}
			if (!ready) return;
			this.snapPending = false;
			this.deps.resnap();
			return;
		}
		if (this.seq === null || this.liveDoc === null) return;
		if (!frame.isConnected) return;
		let doc: Document | null = null;
		try {
			doc = frame.contentDocument ?? null;
		} catch {
			doc = null;
		}
		if (doc === this.liveDoc) return;
		this.seq = null;
		this.liveDoc = null;
		this.deps.resnap();
	}

	/** Size the frame to the PC's viewport and scale it into the host, centred. */
	layout(): void {
		this.checkContext();
		const frame = this.frame;
		if (!frame) return;
		if (this.deps.fluid) {
			frame.style.width = '100%';
			frame.style.height = '100%';
			frame.style.transform = '';
			frame.style.left = '0px';
			frame.style.top = '0px';
			this.stick();
			this.paintCaret();
			return;
		}
		const scale = this.scale;
		const { w, h } = this.viewport;
		frame.style.width = `${w}px`;
		frame.style.height = `${h}px`;
		frame.style.transform = `scale(${scale})`;
		frame.style.left = `${Math.max(0, (this.host.clientWidth - w * scale) / 2)}px`;
		frame.style.top = '0px';
		// The bar lives in the copy's own coordinates, but the proxy rides the caret in THIS
		// page's viewport — a re-fit re-maps it.
		this.paintCaret();
	}

	private localize(text: string): string {
		return localizeTokens(text, this.deps.appBase, this.deps.ggsBase);
	}

	/** Replace a document's whole content with a serialized one. */
	private fillDoc(doc: Document, sdoc: SDoc): void {
		resetDoc(doc);
		const later: (() => void)[] = [];
		const html = this.build(sdoc.html, doc, later);
		if (doc.documentElement) doc.replaceChild(html, doc.documentElement);
		else doc.appendChild(html);
		this.register(doc, sdoc.d);
		const base = doc.createElement('style');
		base.textContent = this.deps.fluid ? FLUID_CSS : BASE_CSS;
		if (this.deps.fluid) {
			// The viewer's own scrolling: a scroller left at its end keeps following, and every
			// scroller's position reaches the PC (a virtualized list renders its window there).
			doc.addEventListener('scroll', (event) => {
				const el = event.target instanceof (doc.defaultView?.Element ?? Element) ? (event.target as Element) : doc.scrollingElement;
				if (!el) return;
				if (atEnd(el)) this.stuck.add(el);
				else this.stuck.delete(el);
				// A scroll that reaches the end re-arms the scroller hunt (the cap above
				// stops it while the viewer reads history up-page).
				if (atEnd(el)) this.scanMisses = 0;
				// A scroll this copy applied itself (the end-pin, a snapshot's restore) is
				// not the viewer's: it reports nothing, so it can neither yank the PC's
				// scroller nor take the §9.2 lease a real viewer's scrolls need.
				if (this.ownScrolls.get(el) === el.scrollTop) this.ownScrolls.delete(el);
				else this.reportScroll(el);
				// The copy scrolled natively: the caret's bar rides the content, but the
				// proxy rides this page's viewport — re-map it.
				this.paintCaret();
			}, { capture: true, passive: true });
		}
		const adopted = doc.createElement('style');
		adopted.textContent = this.localize(sdoc.adopted);
		const hideCarets = doc.createElement('style');
		hideCarets.textContent = HIDE_CARETS_CSS;
		this.caretHide.set(doc, hideCarets);
		(doc.head ?? doc.documentElement).append(base, hideCarets, adopted);
		this.adoptedStyles.set(sdoc.d, adopted);
		this.canonAdopted.set(sdoc.d, sdoc.adopted);
		for (const run of later) run();
		// The sheets are in (the <link> ones still loading — their own listener re-runs
		// this): mirror the page's own :focus rules onto the marker classes now.
		this.deriveFocusRules(doc);
		let onLoad = this.loadHooks.get(doc);
		if (!onLoad) {
			onLoad = () => {
				this.deriveFocusRules(doc);
				// The sheet may restyle the editable (its caret colour, its box): repaint.
				this.paintCaret();
			};
			this.loadHooks.set(doc, onLoad);
		}
		doc.removeEventListener('load', onLoad, true);
		doc.addEventListener('load', onLoad, true);
		this.deps.onDocument?.(doc);
	}

	private register(node: Node, id: number): void {
		this.nodes.set(id, node);
		this.ids.set(node, id);
	}

	private release(node: Node): void {
		const id = this.ids.get(node);
		if (id !== undefined) {
			this.nodes.delete(id);
			this.adoptedStyles.delete(id);
			this.canonText.delete(id);
			this.canonAttr.delete(id);
			this.canonVal.delete(id);
			this.canonCss.delete(id);
			// A document's own id keys the adopted-sheet base (fillDoc's register): a frame
			// whose document left must take that base with it, or the entry outlives the
			// frame until the next full snapshot.
			this.canonAdopted.delete(id);
		}
		if (node.nodeName === 'IFRAME') {
			const inner = (node as HTMLIFrameElement).contentDocument;
			if (inner) this.release(inner);
		}
		for (let child = node.firstChild; child; child = child.nextSibling) this.release(child);
	}

	private setAttr(el: Element, name: string, value: string): void {
		if (el.nodeName === 'IFRAME' && (name === 'src' || name === 'srcdoc' || name === 'sandbox')) return;
		// The copy's own lock, whatever the wire carries: no handler, no refresh, no URL
		// that runs script (an `href`, a `formaction`, an SVG animation's `to`/`values`).
		if (/^on/i.test(name) || name.toLowerCase() === 'http-equiv' || scriptUrl(value)) {
			el.removeAttribute(name);
			return;
		}
		try {
			if (name.startsWith('xlink:')) el.setAttributeNS(XLINK, name, value);
			else el.setAttribute(name, value);
		} catch {
			// A name the HTML parser would never produce (framework attributes): skipped.
		}
	}

	/** One serialized node as a live node of `doc`. Work that needs the node connected (a
	 *  frame's document, scroll positions, select values) is queued on `later`. */
	private build(s: SNode, doc: Document, later: (() => void)[]): Node {
		if (s.t === 'x') {
			const text = doc.createTextNode(this.localize(s.n));
			this.register(text, s.i);
			this.canonText.set(s.i, s.n);
			return text;
		}
		if (s.t === 'c') {
			const comment = doc.createComment('');
			this.register(comment, s.i);
			return comment;
		}
		let el: Element;
		try {
			el = INERT_TAGS.has(s.n.toLowerCase()) ? doc.createElement(INERT_TAG) : s.ns ? doc.createElementNS(s.ns, s.n) : doc.createElement(s.n);
		} catch {
			el = doc.createElement('span');
		}
		this.register(el, s.i);
		if (s.a) {
			for (const [name, value] of Object.entries(s.a)) this.setAttr(el, name, this.localize(value));
			let bases = this.canonAttr.get(s.i);
			if (!bases) {
				bases = new Map();
				this.canonAttr.set(s.i, bases);
			}
			for (const [name, value] of Object.entries(s.a)) bases.set(name, value);
		}
		if (el.nodeName === 'IFRAME') {
			el.setAttribute('sandbox', COPY_SANDBOX);
			el.setAttribute('scrolling', 'no');
			const inner = s.doc;
			later.push(() => {
				const target = (el as HTMLIFrameElement).contentDocument;
				if (target && inner) this.fillDoc(target, inner);
			});
		}
		for (const child of s.k ?? []) el.appendChild(this.build(child, doc, later));
		if (s.css !== undefined) {
			el.textContent = this.localize(s.css);
			this.canonCss.set(s.i, s.css);
		}
		if (s.v !== undefined || s.ck !== undefined) {
			const control = el as HTMLInputElement;
			if (s.v !== undefined) this.canonVal.set(s.i, s.v);
			later.push(() => {
				if (s.v !== undefined) control.value = s.v;
				if (s.ck !== undefined) control.checked = s.ck;
			});
		}
		if (s.sc) {
			const [top, left] = s.sc;
			later.push(() => {
				// The restore is this copy's own write too (the end-pin's marker above).
				if (el.scrollTop !== top) this.ownScrolls.set(el, top);
				el.scrollTop = top;
				el.scrollLeft = left;
			});
		}
		return el;
	}

	private need(id: number): Node {
		const node = this.nodes.get(id);
		if (!node) throw new Error(`mirror node ${id} is unknown`);
		return node;
	}

	/** The full string an op carries: itself, or its delta applied to the base this copy
	 *  holds for the target. A delta without a base cannot land — throw, and the batch's
	 *  failure asks for a fresh snapshot (the honest recovery from divergence). */
	private resolve(id: number, value: string, op: MirrorOp, base: string | undefined): string {
		// Only the string-bearing ops carry a delta (`MirrorOp` unions it in); the fields are
		// read through the delta shape rather than narrowing the union member by member.
		const { p, s } = op as StrDelta;
		if (p === undefined && s === undefined) return value;
		if (base === undefined) throw new Error(`mirror delta for ${id} has no base`);
		return applyDelta(base, { v: value, p, s });
	}

	private apply(op: MirrorOp): void {
		switch (op.o) {
			case 'add': {
				const parent = this.need(op.p);
				const doc = parent.nodeType === 9 ? (parent as Document) : parent.ownerDocument!;
				const later: (() => void)[] = [];
				const node = this.build(op.n, doc, later);
				if (parent.nodeType === 9) {
					const current = (parent as Document).documentElement;
					if (current) {
						this.release(current);
						parent.replaceChild(node, current);
					} else {
						parent.appendChild(node);
					}
				} else {
					const before = op.b === null ? null : this.nodes.get(op.b) ?? null;
					parent.insertBefore(node, before && before.parentNode === parent ? before : null);
				}
				for (const run of later) run();
				return;
			}
			case 'rm': {
				const node = this.nodes.get(op.i);
				if (!node) return;
				this.release(node);
				node.parentNode?.removeChild(node);
				return;
			}
			case 'attr': {
				const el = this.need(op.i) as Element;
				if (op.v === null) {
					el.removeAttribute(op.k);
					this.canonAttr.get(op.i)?.delete(op.k);
					return;
				}
				const next = this.resolve(op.i, op.v, op, this.canonAttr.get(op.i)?.get(op.k));
				let bases = this.canonAttr.get(op.i);
				if (!bases) {
					bases = new Map();
					this.canonAttr.set(op.i, bases);
				}
				bases.set(op.k, next);
				this.setAttr(el, op.k, this.localize(next));
				return;
			}
			case 'text': {
				const node = this.need(op.i) as CharacterData;
				const next = this.resolve(op.i, op.v, op, this.canonText.get(op.i));
				this.canonText.set(op.i, next);
				node.data = this.localize(next);
				if (node.parentNode?.nodeName === 'STYLE') this.deriveFocusRules(node.ownerDocument!);
				return;
			}
			case 'val': {
				const control = this.need(op.i) as HTMLInputElement;
				const next = this.resolve(op.i, op.v, op, this.canonVal.get(op.i));
				this.canonVal.set(op.i, next);
				control.value = next;
				if (op.ck !== undefined) control.checked = op.ck;
				return;
			}
			case 'caret': {
				this.caret = op.i === undefined && op.ci === undefined ? null : { ...op };
				this.paintCaret();
				return;
			}
			case 'focus': {
				this.focus = op.f ?? [];
				this.applyFocus();
				return;
			}
			case 'scroll': {
				const el = this.need(op.i) as Element;
				if (this.deps.fluid) {
					// Laid out at another width, the PC's offsets mean nothing here; its
					// page scrolling to the end (a chat following its stream) does.
					if (op.e) this.stuck.add(el);
					return;
				}
				el.scrollLeft = op.l;
				el.scrollTop = op.e ? el.scrollHeight : op.t;
				return;
			}
			case 'css': {
				const style = this.need(op.i) as Element;
				const next = this.resolve(op.i, op.v, op, this.canonCss.get(op.i));
				this.canonCss.set(op.i, next);
				style.textContent = this.localize(next);
				this.deriveFocusRules(style.ownerDocument!);
				return;
			}
			case 'adopted': {
				const style = this.adoptedStyles.get(op.d);
				if (!style) return;
				const next = this.resolve(op.d, op.v, op, this.canonAdopted.get(op.d));
				this.canonAdopted.set(op.d, next);
				style.textContent = this.localize(next);
				this.deriveFocusRules(style.ownerDocument!);
				return;
			}
			case 'doc': {
				const frame = this.need(op.i) as HTMLIFrameElement;
				const inner = frame.contentDocument;
				if (!inner) return;
				this.release(inner);
				if (op.doc) this.fillDoc(inner, op.doc);
				else resetDoc(inner);
				return;
			}
			case 'vp':
				this.viewport = { w: Math.max(1, op.w), h: Math.max(1, op.h) };
				this.layout();
				return;
		}
	}

	/** Wear the mirrored focus (2026-10-13, the owner's direction: the copy adds no
	 *  visuals of its own): the chain's focused element carries the marker classes, its
	 *  ancestors the within-one, and the copy's own `:focus` rules — mirrored onto those
	 *  classes by `deriveFocusRules` — paint exactly what the PC's engine paints (Claude's
	 *  composer border among them). Called after every batch: a class attribute the page
	 *  rewrote mid-batch gets its markers back here. */
	private applyFocus(): void {
		for (const el of this.marked) {
			if (el.nodeType !== 1 || !el.isConnected) continue;
			el.classList.remove(FOCUS_CLASS, FOCUS_VISIBLE_CLASS, FOCUS_WITHIN_CLASS);
		}
		this.marked = [];
		for (const entry of this.focus) {
			const el = this.nodes.get(entry.i);
			if (!el || el.nodeType !== 1 || !el.isConnected) continue;
			const target = el as Element;
			target.classList.add(FOCUS_CLASS);
			if (entry.v === 1) target.classList.add(FOCUS_VISIBLE_CLASS);
			this.marked.push(target);
			for (let up = target.parentElement; up; up = up.parentElement) {
				up.classList.add(FOCUS_WITHIN_CLASS);
				this.marked.push(up);
			}
		}
	}

	/** For every style rule of the copy's own sheets whose selector carries a `:focus`
	 *  pseudo, insert the same rule with the pseudo exchanged for the marker class RIGHT
	 *  AFTER it — adjacent, so equal-specificity ties keep the sheet's own order — into
	 *  the same container (@media, a nesting parent). The page's own declarations then
	 *  paint the focused state; nothing here authors any visual of its own. Re-runs drop
	 *  the rules a previous pass inserted before deriving again. */
	private deriveFocusRules(doc: Document): void {
		this.caretColors = new WeakMap();
		let sheets: CSSStyleSheet[];
		try {
			sheets = Array.from(doc.styleSheets) as CSSStyleSheet[];
		} catch {
			return;
		}
		for (const sheet of sheets) {
			try {
				const prior = this.derived.get(sheet);
				if (prior) {
					for (const [container, rule] of prior) {
						const rules = container.cssRules;
						for (let at = 0; at < rules.length; at += 1) {
							if (rules[at] !== rule) continue;
							try {
								container.deleteRule(at);
							} catch {
								// Already gone with a text swap: nothing to remove.
							}
							break;
						}
					}
				}
				const inserted: Array<[RuleParent, CSSRule]> = [];
				this.deriveInto(sheet, sheet.cssRules, inserted);
				if (inserted.length) this.derived.set(sheet, inserted);
				else this.derived.delete(sheet);
			} catch {
				// A sheet this context cannot read or write: its focus rules stay unmirrored.
			}
		}
	}

	private deriveInto(container: RuleParent, rules: CSSRuleList, out: Array<[RuleParent, CSSRule]>): void {
		for (let at = 0; at < rules.length; at += 1) {
			const rule = rules[at];
			const style = rule as CSSStyleRule;
			const selector = typeof style.selectorText === 'string' ? style.selectorText : '';
			if (selector.includes(':focus')) {
				const variants = selectorsOf(selector)
					.map(focusVariant)
					.filter((variant): variant is string => variant !== null);
				if (variants.length) {
					try {
						container.insertRule(`${variants.join(',')}{${style.style?.cssText ?? ''}}`, at + 1);
						out.push([container, container.cssRules[at + 1]]);
						// The inserted rule is not itself a candidate: step past it.
						at += 1;
					} catch {
						// A selector this engine rejects: that rule stays unmirrored, harmless.
					}
				}
			}
			// A rule with children of its own (@media, a nested style rule — every rule is
			// a grouping in a nesting-aware engine, usually with an empty list) carries
			// them into the derivation with their own container.
			const group = rule as CSSRule & { cssRules?: CSSRuleList };
			if (group.cssRules && group.cssRules.length > 0) this.deriveInto(group as RuleParent, group.cssRules, out);
		}
	}

	/** Paint the mirrored caret: a blinking bar inside the copy's document, at the position
	 *  measured in the COPY's own layout (its fonts are what the viewer sees; for a fluid
	 *  copy its width is, too — the offsets are width-independent either way). No editable
	 *  or a lost node means no bar. */
	private paintCaret(): void {
		let doc: Document | null = null;
		let x = 0;
		let y = 0;
		let h = 0;
		let color = '';
		if (this.caret?.i !== undefined) {
			const el = this.nodes.get(this.caret.i) as HTMLInputElement | HTMLTextAreaElement | undefined;
			if (!el || !el.isConnected || el.ownerDocument === null) return this.clearCaret();
			doc = el.ownerDocument;
			const measured = measureCaret(el, this.caret.s ?? el.value.length);
			x = measured.x;
			y = measured.y;
			h = measured.h;
			color = this.caretColor(el);
		} else if (this.caret?.ci !== undefined) {
			const node = this.nodes.get(this.caret.ci);
			if (!node || !node.isConnected || (node.nodeType !== 3 && node.nodeType !== 1)) return this.clearCaret();
			doc = node.ownerDocument;
			const view = doc?.defaultView ?? null;
			if (!doc || !view) return this.clearCaret();
			// The block the caret paints in (its line height, its colour): the element itself
			// for an element anchor, a text node's parent — walked past inline wrappers.
			let host: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
			while (host && host !== doc.documentElement && view.getComputedStyle(host).display === 'inline' && host.parentElement) host = host.parentElement;
			// The range's rect is exact where engines give one — a text offset or a child
			// boundary (an empty editable anchors on itself); a host-box fallback (the caret
			// before the first character) covers the engines that do not.
			let rect: { left: number; top: number; height: number } | null = null;
			try {
				const range = doc.createRange();
				const span = node.nodeType === 3 ? node.nodeValue?.length ?? 0 : node.childNodes.length;
				range.setStart(node, Math.min(this.caret.co ?? 0, span));
				range.collapse(true);
				const box = range.getBoundingClientRect();
				if (box && (box.width || box.height || box.left || box.top)) {
					rect = { left: box.left, top: box.top, height: box.height };
				}
			} catch {
				rect = null;
			}
			if (!rect) {
				const hostBox = host?.getBoundingClientRect();
				if (!hostBox || !host) return this.clearCaret();
				// The caret before the first character sits at the content box's corner, past
				// the border and the padding (Claude's empty composer: 14px in, 10px down).
				const hs = view.getComputedStyle(host);
				const inset = (a: string, b: string) => (parseFloat(a) || 0) + (parseFloat(b) || 0);
				rect = { left: hostBox.left + inset(hs.borderLeftWidth, hs.paddingLeft), top: hostBox.top + inset(hs.borderTopWidth, hs.paddingTop), height: 0 };
			}
			const line = host ? parseFloat(view.getComputedStyle(host).lineHeight) || 0 : 0;
			x = rect.left;
			y = rect.top;
			h = rect.height || line || 16;
			color = host ? this.caretColor(host) : '';
		} else {
			return this.clearCaret();
		}
		if (!doc) return this.clearCaret();
		let bar = this.caretEl;
		if (!bar || bar.ownerDocument !== doc) {
			this.caretEl?.remove();
			bar = makeCaret(doc);
			this.caretEl = bar;
		}
		// Viewport → document coordinates (the bar is absolutely positioned in the copy).
		const view = doc.defaultView!;
		bar.style.transform = `translate(${x + view.scrollX}px, ${y + view.scrollY}px)`;
		const barHeight = Math.max(h, 10);
		bar.style.height = `${barHeight}px`;
		bar.style.background = color || 'currentColor';
		this.reportCaret(doc, x, y, barHeight);
	}

	/** The colour the PC's engine paints this editable's caret in: the page's own
	 *  `caret-color`, else its text colour — skipping transparent ones, because Claude's
	 *  composer types in transparent text (a mirror layer draws the visible characters) and
	 *  a bar in that colour was invisible (2026-10-13: the copy's composer showed no caret).
	 *  The copy's caret-hiding sheet is lifted for the read; the answer is cached until a
	 *  sheet changes, because that lift restyles the whole document. Empty: the bar's own currentColor. */
	private caretColor(el: Element): string {
		const known = this.caretColors.get(el);
		if (known !== undefined) return known;
		const view = el.ownerDocument.defaultView;
		if (!view) return '';
		const hide = this.caretHide.get(el.ownerDocument);
		// Detached for the read (an engine-independent way to lift a sheet: jsdom honours
		// neither `media` nor `disabled`), back in the same place right after.
		const parent = hide?.parentNode ?? null;
		const next = hide?.nextSibling ?? null;
		hide?.remove();
		let color = '';
		try {
			const style = view.getComputedStyle(el);
			color = [style.getPropertyValue('caret-color'), style.color].find((value) => !!value && value !== 'auto' && !transparent(value)) ?? '';
		} finally {
			if (hide && parent) parent.insertBefore(hide, next);
		}
		this.caretColors.set(el, color);
		return color;
	}

	private clearCaret(): void {
		this.caretEl?.remove();
		this.caretEl = null;
		this.deps.onCaret?.(null);
	}

	/** The caret's position told to the input layer, mapped from the copy's own document
	 *  into the viewer page's viewport: up through every frame the copy nests in (a webview
	 *  page inside the window copy), each hop offset by its frame's box and scaled by the
	 *  ratio of that frame's laid-out width to its content viewport (the window copy's own
	 *  fit scale). */
	private reportCaret(doc: Document, x: number, y: number, h: number): void {
		const onCaret = this.deps.onCaret;
		if (!onCaret) return;
		const top = this.host.ownerDocument;
		let px = x;
		let py = y;
		let cur: Document | null = doc;
		for (let hop = 0; cur && cur !== top && hop < 8; hop += 1) {
			const win: Window | null = cur.defaultView ?? null;
			const frameEl: Element | null = win?.frameElement ?? null;
			if (!win || !frameEl) break;
			const box = frameEl.getBoundingClientRect();
			const ratio = win.innerWidth > 0 ? box.width / win.innerWidth : 1;
			px = box.left + px * ratio;
			py = box.top + py * ratio;
			cur = frameEl.ownerDocument ?? null;
		}
		onCaret({ x: px, y: py, h });
	}

	/** A fluid copy's end-following: every scroller at its end is pinned there again after
	 * the content changed. The copy starts at the end (a chat is read from its latest
	 * message), and while no scroller is known the copy looks for them now and then — the
	 * page's scroller often appears only once its content renders. Only a scroller that
	 * already sits at its end is taken: a page's own scrolled position (a virtualized list
	 * restored at the PC's offset, git-graph-rs among them) is left where the PC had it,
	 * never dragged into the unrendered space its spacers stand in for. */
	private stick(): void {
		if (!this.deps.fluid) return;
		const doc = this.root;
		if (!doc) return;
		const now = Date.now();
		if (this.stuck.size === 0 && this.scanMisses < SCAN_MISS_CAP && now - this.lastScan >= SCROLLER_SCAN_MS) {
			this.lastScan = now;
			for (const el of Array.from(doc.querySelectorAll('*'))) if (scrollable(el) && atEnd(el)) this.stuck.add(el);
			if (doc.scrollingElement && scrollable(doc.scrollingElement) && atEnd(doc.scrollingElement)) this.stuck.add(doc.scrollingElement);
			if (this.stuck.size === 0) this.scanMisses += 1;
		}
		for (const el of [...this.stuck]) {
			if (!el.isConnected) {
				this.stuck.delete(el);
				continue;
			}
			// Marked as this copy's own write: the scroll event it causes reports nothing.
			if (el.scrollTop !== el.scrollHeight) this.ownScrolls.set(el, el.scrollHeight);
			el.scrollTop = el.scrollHeight;
		}
	}

	/** Queue a fluid scroller's position for the PC (throttled: a fling fires scroll events
	 * at display rate). Laid out at another width, the copy's pixels mean nothing there —
	 * the position travels as a fraction of the scroll range. */
	private reportScroll(el: Element): void {
		if (!this.deps.onScroll) return;
		const id = this.ids.get(el);
		if (id === undefined) return;
		const range = el.scrollHeight - el.clientHeight;
		if (range <= 0) return;
		this.scrollReport.set(id, [Math.min(1, Math.max(0, el.scrollTop / range)), atEnd(el)]);
		if (this.scrollTimer === null) this.scrollTimer = setTimeout(() => this.flushScrollReport(), SCROLL_REPORT_MS);
	}

	private flushScrollReport(): void {
		this.scrollTimer = null;
		const report = this.deps.onScroll;
		if (!report) {
			this.scrollReport.clear();
			return;
		}
		for (const [id, [fraction, end]] of this.scrollReport) report(id, fraction, end);
		this.scrollReport.clear();
	}
}

/** The blink style + one bar element, appended to the copy's document (idempotent). */
/** A computed colour that paints nothing. */
function transparent(color: string): boolean {
	return color === 'transparent' || /^rgba\(.*,\s*0(?:\.0+)?\)$/.test(color.trim());
}

function makeCaret(doc: Document): HTMLElement {
	let style = doc.getElementById('mirror-caret-style');
	if (!style) {
		style = doc.createElement('style');
		style.id = 'mirror-caret-style';
		style.textContent =
			'.mirror-caret{position:absolute;width:2px;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483647;animation:mirror-caret-blink 1.06s steps(1) infinite}@keyframes mirror-caret-blink{50%{opacity:0}}';
		(doc.head ?? doc.documentElement).appendChild(style);
	}
	const bar = doc.createElement('div');
	bar.className = 'mirror-caret';
	(doc.body ?? doc.documentElement).appendChild(bar);
	return bar;
}

/** Where a control's caret sits, measured in the copy's own layout: a mirror div with the
 *  control's fonts and box, the text up to the offset, and a marker span — the classic
 *  textarea-caret trick, run against the copy so its fonts decide. */
function measureCaret(
	el: HTMLInputElement | HTMLTextAreaElement,
	at: number
): { x: number; y: number; h: number } {
	const doc = el.ownerDocument!;
	const view = doc.defaultView!;
	const cs = view.getComputedStyle(el);
	const mirror = doc.createElement('div');
	const styles = [
		'font-family',
		'font-size',
		'font-weight',
		'font-style',
		'letter-spacing',
		'line-height',
		'padding-top',
		'padding-right',
		'padding-bottom',
		'padding-left',
		'border-top-width',
		'border-left-width',
		'text-indent',
		'word-break',
		'overflow-wrap',
		'box-sizing'
	]
		.map((name) => `${name}:${cs.getPropertyValue(name)}`)
		.join(';');
	mirror.setAttribute(
		'style',
		`position:absolute;top:0;left:0;visibility:hidden;white-space:${el.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre'};width:${el.clientWidth}px;${styles}`
	);
	mirror.appendChild(doc.createTextNode(el.value.slice(0, at)));
	const mark = doc.createElement('span');
	mark.textContent = '​';
	mirror.appendChild(mark);
	(doc.body ?? doc.documentElement).appendChild(mirror);
	const mirrorBox = mirror.getBoundingClientRect();
	const markBox = mark.getBoundingClientRect();
	mirror.remove();
	const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
	const box = el.getBoundingClientRect();
	return {
		x: box.left + (markBox.left - mirrorBox.left) - el.scrollLeft,
		y: box.top + (markBox.top - mirrorBox.top) - el.scrollTop,
		h: markBox.height || line
	};
}
