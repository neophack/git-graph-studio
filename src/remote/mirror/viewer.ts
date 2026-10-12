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

import { localizeTokens, type DownMessage, type MirrorOp, type SDoc, type SNode, type Viewport } from './protocol';

const XLINK = 'http://www.w3.org/1999/xlink';
/** The copy is a picture: no caret blinking where the PC has none, no text selection
 *  fighting the replayed one, pinch-zoom kept for phones. */
const BASE_CSS = 'html{touch-action:pinch-zoom}*{caret-color:transparent!important;-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none}';

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
}

export class MirrorViewer {
	private nodes = new Map<number, Node>();
	private ids = new WeakMap<Node, number>();
	private adoptedStyles = new Map<number, HTMLStyleElement>();
	private frame: HTMLIFrameElement | null = null;
	private seq: number | null = null;
	private viewport: Viewport = { w: 1, h: 1 };
	private ready = false;
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

	receive(message: DownMessage): void {
		if (!message) return;
		if (message.k === 'snap') {
			if (message.to !== this.me) return;
			this.snapshot(message.doc, message.vp, message.seq);
			return;
		}
		if (message.k === 'clip') {
			if (message.to === this.me) this.deps.onClipboard?.(message.text);
			return;
		}
		if (message.k !== 'ops' || this.seq === null) return;
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
	}

	private snapshot(doc: SDoc, vp: Viewport, seq: number): void {
		this.nodes.clear();
		this.ids = new WeakMap();
		this.adoptedStyles.clear();
		this.frame?.remove();
		const frame = this.host.ownerDocument.createElement('iframe');
		frame.className = 'mirror-frame';
		frame.setAttribute('sandbox', 'allow-same-origin');
		frame.setAttribute('scrolling', 'no');
		this.host.appendChild(frame);
		this.frame = frame;
		this.viewport = { w: Math.max(1, vp.w), h: Math.max(1, vp.h) };
		this.layout();
		const target = frame.contentDocument;
		if (!target) return;
		this.fillDoc(target, doc);
		this.seq = seq;
		if (!this.ready) {
			this.ready = true;
			this.deps.onReady?.();
		}
	}

	/** Size the frame to the PC's viewport and scale it into the host, centred. */
	layout(): void {
		const frame = this.frame;
		if (!frame) return;
		const scale = this.scale;
		const { w, h } = this.viewport;
		frame.style.width = `${w}px`;
		frame.style.height = `${h}px`;
		frame.style.transform = `scale(${scale})`;
		frame.style.left = `${Math.max(0, (this.host.clientWidth - w * scale) / 2)}px`;
		frame.style.top = '0px';
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
		base.textContent = BASE_CSS;
		const adopted = doc.createElement('style');
		adopted.textContent = this.localize(sdoc.adopted);
		(doc.head ?? doc.documentElement).append(base, adopted);
		this.adoptedStyles.set(sdoc.d, adopted);
		for (const run of later) run();
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
		}
		if (node.nodeName === 'IFRAME') {
			const inner = (node as HTMLIFrameElement).contentDocument;
			if (inner) this.release(inner);
		}
		for (let child = node.firstChild; child; child = child.nextSibling) this.release(child);
	}

	private setAttr(el: Element, name: string, value: string): void {
		if (el.nodeName === 'IFRAME' && (name === 'src' || name === 'srcdoc' || name === 'sandbox')) return;
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
			return text;
		}
		if (s.t === 'c') {
			const comment = doc.createComment('');
			this.register(comment, s.i);
			return comment;
		}
		let el: Element;
		try {
			el = s.ns ? doc.createElementNS(s.ns, s.n) : doc.createElement(s.n);
		} catch {
			el = doc.createElement('span');
		}
		this.register(el, s.i);
		for (const [name, value] of Object.entries(s.a ?? {})) this.setAttr(el, name, this.localize(value));
		if (el.nodeName === 'IFRAME') {
			el.setAttribute('sandbox', 'allow-same-origin');
			el.setAttribute('scrolling', 'no');
			const inner = s.doc;
			later.push(() => {
				const target = (el as HTMLIFrameElement).contentDocument;
				if (target && inner) this.fillDoc(target, inner);
			});
		}
		for (const child of s.k ?? []) el.appendChild(this.build(child, doc, later));
		if (s.css !== undefined) el.textContent = this.localize(s.css);
		if (s.v !== undefined || s.ck !== undefined) {
			const control = el as HTMLInputElement;
			later.push(() => {
				if (s.v !== undefined) control.value = s.v;
				if (s.ck !== undefined) control.checked = s.ck;
			});
		}
		if (s.sc) {
			const [top, left] = s.sc;
			later.push(() => {
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
				if (op.v === null) el.removeAttribute(op.k);
				else this.setAttr(el, op.k, this.localize(op.v));
				return;
			}
			case 'text':
				(this.need(op.i) as CharacterData).data = this.localize(op.v);
				return;
			case 'val': {
				const control = this.need(op.i) as HTMLInputElement;
				control.value = op.v;
				if (op.ck !== undefined) control.checked = op.ck;
				return;
			}
			case 'scroll': {
				const el = this.need(op.i) as Element;
				el.scrollLeft = op.l;
				el.scrollTop = op.e ? el.scrollHeight : op.t;
				return;
			}
			case 'css':
				(this.need(op.i) as Element).textContent = this.localize(op.v);
				return;
			case 'adopted': {
				const style = this.adoptedStyles.get(op.d);
				if (style) style.textContent = this.localize(op.v);
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
}
