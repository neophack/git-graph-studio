// The PC half of the DOM replica (protocol.ts): every node of the desktop window — and of
// every same-origin frame inside it, the extension webview pages (Claude Code's chat) among
// them — gets a stable id; a snapshot serializes the tree, and from then on the
// MutationObservers' records become batches of ops. What no observer reports is polled:
// form-control values, scroll positions (scroll events), CSSOM-inserted rules and adopted
// style sheets (CodeMirror's style-mod), the viewport size. Nothing here runs unless a
// remote viewer is attached: `start` and `stop` bracket the whole cost.

import { canonicalize, canonicalizeCss, type MirrorOp, type SDoc, type SNode, type Viewport } from './protocol';

const XHTML = 'http://www.w3.org/1999/xhtml';
/** Batches leave at most this often (the first change of a quiet period leaves at once). */
const FLUSH_MS = 50;
/** Values, CSSOM rules and adopted sheets are re-read this often. */
const POLL_MS = 400;
const URL_ATTRS = new Set(['src', 'href', 'poster', 'action', 'data', 'xlink:href', 'background']);
/** Elements whose content never crosses: inert in the copy, bytes for nothing. */
const EMPTIED = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE']);

interface Watched {
	observer: MutationObserver;
	unlisten: () => void;
	adoptedKey: string;
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

export class DomRecorder {
	private ids = new WeakMap<Node, number>();
	private nodes = new Map<number, Node>();
	private nextId = 1;
	private watched = new Map<Document, Watched>();
	private records: MutationRecord[] = [];
	private scrolled = new Set<Element>();
	private controls = new Set<Control>();
	private sentValues = new WeakMap<Control, string>();
	/** Style elements filled through the CSSOM only, with the rule count last sent. */
	private cssomStyles = new Map<HTMLStyleElement, number>();
	private loadHooked = new WeakSet<HTMLIFrameElement>();
	private frameDocs = new Map<HTMLIFrameElement, Document | null>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastFlush = 0;
	private viewport: Viewport = { w: 0, h: 0 };
	private seq = 0;
	private running = false;
	private readonly appRoot: string;
	private readonly onResize = () => this.schedule();

	constructor(
		private readonly root: Document,
		private readonly sink: (ops: MirrorOp[], seq: number) => void
	) {
		this.appRoot = appRootOf(root);
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
		this.flushTimer = null;
		this.pollTimer = null;
		this.ids = new WeakMap();
		this.nodes.clear();
		this.records = [];
		this.scrolled.clear();
		this.controls.clear();
		this.cssomStyles.clear();
		this.frameDocs.clear();
		this.sentValues = new WeakMap();
		this.loadHooked = new WeakSet();
	}

	/** The whole tree as it stands, after the pending changes went out to the viewers
	 *  already watching (the snapshot's `seq` is the last batch it includes). */
	snapshot(): { seq: number; root: number; doc: SDoc; vp: Viewport } {
		this.start();
		this.flush();
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

	// ---- observing ----

	private watch(doc: Document): void {
		if (this.watched.has(doc)) return;
		const observer = new MutationObserver((records) => {
			for (const record of records) this.records.push(record);
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

	private schedule(): void {
		if (!this.running || this.flushTimer !== null) return;
		const wait = Math.max(0, FLUSH_MS - (Date.now() - this.lastFlush));
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, wait);
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
		return {
			d,
			html: html ?? { i: this.assign(doc.createElement('html')), t: 'e', n: 'html' },
			adopted: this.adoptedText(doc)
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
				return { i: this.assign(node), t: 'x', n: parent === 'STYLE' ? canonicalizeCss(text, node.ownerDocument?.baseURI ?? '', this.appRoot) : text };
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
		if (attrs) out.a = attrs;
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
				this.cssomStyles.set(style, ruleCount(style.sheet));
			} else if ((style.textContent ?? '').trim() === '') {
				this.cssomStyles.set(style, 0);
			}
		}
		if (isControl(el)) {
			this.controls.add(el);
			out.v = el.value;
			if (el instanceof (el.ownerDocument.defaultView?.HTMLInputElement ?? HTMLInputElement) && (el.type === 'checkbox' || el.type === 'radio')) out.ck = el.checked;
			this.sentValues.set(el, this.valueKey(el));
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

	/** Turn everything observed since the last batch into one batch of ops (plus `extra`,
	 *  what a poll already read). */
	flush(extra: MirrorOp[] = []): void {
		if (!this.running) return;
		this.lastFlush = Date.now();
		for (const watched of this.watched.values()) for (const record of watched.observer.takeRecords()) this.records.push(record);
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
			ops.push({ o: 'text', i: id, v: node.parentNode?.nodeName === 'STYLE' ? canonicalizeCss(text, node.ownerDocument?.baseURI ?? '', this.appRoot) : text });
		}
		for (const [el, names] of attrs) {
			const id = this.ids.get(el);
			if (id === undefined || !el.isConnected) continue;
			for (const name of names) {
				if (!name || name.startsWith('on')) continue;
				if (el.nodeName === 'IFRAME' && (name === 'src' || name === 'srcdoc' || name === 'sandbox')) continue;
				const value = el.getAttribute(name);
				ops.push({ o: 'attr', i: id, k: name, v: value === null ? null : this.attrValue(name, value, el.ownerDocument.baseURI) });
			}
		}
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
			ops.push(isInput ? { o: 'val', i: id, v: control.value, ck: (control as HTMLInputElement).checked } : { o: 'val', i: id, v: control.value });
		}
		this.caretInto(ops);
		for (const [style, count] of this.cssomStyles) {
			if (!style.isConnected) {
				this.cssomStyles.delete(style);
				continue;
			}
			if ((style.textContent ?? '').trim() !== '') continue;
			const now = ruleCount(style.sheet);
			if (now === count) continue;
			this.cssomStyles.set(style, now);
			const id = this.ids.get(style);
			if (id !== undefined) ops.push({ o: 'css', i: id, v: canonicalizeCss(rulesText(style.sheet), style.ownerDocument.baseURI, this.appRoot) });
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
			if (d !== undefined) ops.push({ o: 'adopted', d, v: this.adoptedText(doc) });
		}
	}

	private poll(): void {
		if (!this.running) return;
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
