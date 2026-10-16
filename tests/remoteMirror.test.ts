// Remote Access, the DOM replica (module 19, docs/ggs-remote-plan.md §22): the PC window's
// recorder against the browser's viewer — the snapshot and every mutation kind landing in
// the copy, URLs crossing as tokens, a sequence gap asking for a fresh snapshot — the
// input replay on the PC (a tap as a full press-release-click, keys and text into the
// focused editable, a select's value), and the host's viewer lifecycle (hello earns a
// snapshot and a fit, a silent viewer is forgotten and the recorder stops with the last),
// and which UI a page runs (§22.5): the first viewer owns the window, a viewer of the other
// form factor — or a phone while the PC user has the window on screen — runs its own; and
// a page that runs its own still shows the PC's one live page of an extension webview
// (§22.6): the frame's stream copied into a fluid viewer, its input replayed into the frame.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomRecorder } from '../src/remote/mirror/recorder';
import { MirrorViewer } from '../src/remote/mirror/viewer';
import { InputReplayer, keyCodeFor } from '../src/remote/mirror/replay';
import { MirrorHost, fitFor } from '../src/remote/mirror/host';
import { isSpecialKey, ViewerInput } from '../src/remote/mirror/viewerInput';
import { modeUrl, requestedMode } from '../src/remote/mirror/uiMode';
import { coarsePointer } from '../src/remote/responsive';
import { APP_TOKEN, GGS_TOKEN, canonicalize, canonicalizeCss, localizeTokens, panelStream, viewStream, type DownMessage, type MirrorOp, type UpMessage } from '../src/remote/mirror/protocol';
import { parseStream, setWebviewFrameSource } from '../src/remote/mirror/webviewFrames';
import { mountScrollHint } from '../src/remote/mirror/webviewCopy';

/** A PC document of its own, so the copy and the original never share a tree. */
function pcDocument(body: string): Document {
	const doc = document.implementation.createHTMLDocument('pc');
	doc.body.innerHTML = body;
	return doc;
}

interface Rig {
	pc: Document;
	recorder: DomRecorder;
	viewer: MirrorViewer;
	host: HTMLElement;
	resnaps: number;
	sent: DownMessage[];
	copy(): Document;
}

function rig(body: string): Rig {
	const pc = pcDocument(body);
	const host = document.createElement('div');
	document.body.appendChild(host);
	const state = { resnaps: 0 };
	const sent: DownMessage[] = [];
	let viewer: MirrorViewer;
	const recorder = new DomRecorder(pc, (ops, seq) => {
		const message: DownMessage = { k: 'ops', to: '*', seq, ops };
		sent.push(message);
		viewer.receive(message);
	});
	viewer = new MirrorViewer(host, 'remote/1', {
		appBase: 'https://phone.example/w/i/v/1/main/',
		ggsBase: 'https://phone.example/w/i/ggs/tok/',
		resnap: () => state.resnaps++
	});
	const snap = recorder.snapshot();
	viewer.receive({ k: 'snap', to: 'remote/1', ...snap });
	return {
		pc,
		recorder,
		viewer,
		host,
		sent,
		get resnaps() {
			return state.resnaps;
		},
		copy: () => viewer.root!
	};
}

/** The copy's body markup, the base styles the viewer adds excluded. */
function bodyOf(doc: Document): string {
	return doc.body.innerHTML;
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('the replica protocol', () => {
	it('turns app and package roots into tokens and back', () => {
		const app = 'http://tauri.localhost/';
		expect(canonicalize('/assets/index-1.css', 'http://tauri.localhost/index.html', app)).toBe(`${APP_TOKEN}assets/index-1.css`);
		expect(canonicalize('ggs://localhost/pkg/webview/index.css', 'about:srcdoc', app)).toBe(`${GGS_TOKEN}pkg/webview/index.css`);
		expect(canonicalize('http://ggs.localhost/pkg/a.png', 'about:srcdoc', app)).toBe(`${GGS_TOKEN}pkg/a.png`);
		expect(canonicalize('data:image/png;base64,AA', app, app)).toBe('data:image/png;base64,AA');
		expect(canonicalizeCss('a{background:url(/theme/x.svg)}', 'http://tauri.localhost/', app)).toBe(`a{background:url("${APP_TOKEN}theme/x.svg")}`);
		expect(localizeTokens(`${APP_TOKEN}a.css ${GGS_TOKEN}b.js`, 'https://p/main/', 'https://p/ggs/t/')).toBe('https://p/main/a.css https://p/ggs/t/b.js');
	});

	it('drops foreign absolute URLs — a copy never loads an origin the PC page did not control', () => {
		const app = 'http://tauri.localhost/';
		expect(canonicalize('https://attacker.example/x.gif?d=secret', 'http://tauri.localhost/', app)).toBe('');
		expect(canonicalize('http://tracker.example/pixel.png', 'http://tauri.localhost/', app)).toBe('');
		expect(canonicalizeCss('a{background:url(https://evil.example/bg.css)}', 'http://tauri.localhost/', app)).toBe('a{background:url("")}');
		// The token roots and data: URLs keep crossing as before.
		expect(canonicalize('/assets/a.css', 'http://tauri.localhost/', app)).toBe(`${APP_TOKEN}assets/a.css`);
		expect(canonicalize('data:image/png;base64,AA', app, app)).toBe('data:image/png;base64,AA');
	});

	it('sizes a hidden PC window to the viewer, never below the desktop minimum (§11: the phone-sized fit is gone)', () => {
		expect(fitFor(1600, 900)).toEqual({ width: 1600, height: 900 });
		// A phone never mirrors (it runs its own workbench); an explicit phone-width viewer
		// still gets the desktop floor, the copy scales down on its screen.
		expect(fitFor(390, 844)).toEqual({ width: 800, height: Math.round((800 * 844) / 390) });
		expect(fitFor(700, 300)).toEqual({ width: 800, height: 500 });
	});

	it('sends special keys as keys and characters as text', () => {
		const key = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => isSpecialKey({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
		expect(key('Enter')).toBe(true);
		expect(key('ArrowUp')).toBe(true);
		expect(key('a')).toBe(false);
		expect(key('p', { ctrlKey: true })).toBe(true);
		// AltGr arrives as Ctrl+Alt on Windows: a character, typed as text.
		expect(key('@', { ctrlKey: true, altKey: true })).toBe(false);
		expect(key('Process')).toBe(false);
		expect(key('Shift')).toBe(false);
		expect(keyCodeFor('Enter')).toBe(13);
		expect(keyCodeFor('a')).toBe(65);
		expect(keyCodeFor('F5')).toBe(116);
	});
});

describe('the recorder and the viewer', () => {
	it('copies the snapshot, without scripts or event attributes', () => {
		const r = rig('<div id="a" class="x" onclick="evil()"><span>hello</span><script>boom()</script></div>');
		const copy = r.copy();
		expect(copy.getElementById('a')?.className).toBe('x');
		expect(copy.getElementById('a')?.hasAttribute('onclick')).toBe(false);
		expect(copy.querySelector('span')?.textContent).toBe('hello');
		expect(copy.querySelector('script')?.textContent).toBe('');
	});

	it('hides the PC window’s own controls — a remote page has no window to drive', () => {
		const r = rig('<div class="titlebar"><div class="window-controls"><div class="window-control close"></div></div></div>');
		const copy = r.copy();
		const controls = copy.querySelector('.window-controls')!;
		expect(copy.defaultView!.getComputedStyle(controls).display).toBe('none');
	});

	it('follows additions, removals, moves, text and attribute changes', () => {
		const r = rig('<ul id="list"><li id="one">1</li><li id="two">2</li></ul><p id="p">old</p>');
		const list = r.pc.getElementById('list')!;
		const three = r.pc.createElement('li');
		three.id = 'three';
		three.innerHTML = '<b>3</b>';
		list.appendChild(three);
		list.insertBefore(r.pc.getElementById('two')!, r.pc.getElementById('one'));
		r.pc.getElementById('p')!.firstChild!.nodeValue = 'new';
		r.pc.getElementById('p')!.setAttribute('data-state', 'busy');
		r.recorder.flush();
		expect(bodyOf(r.copy())).toBe(bodyOf(r.pc));
		r.pc.getElementById('one')!.remove();
		r.pc.getElementById('p')!.removeAttribute('data-state');
		r.recorder.flush();
		expect(bodyOf(r.copy())).toBe(bodyOf(r.pc));
		expect(r.resnaps).toBe(0);
	});

	it('keeps a node added and filled in the same batch whole', () => {
		const r = rig('<div id="root"></div>');
		const box = r.pc.createElement('section');
		r.pc.getElementById('root')!.appendChild(box);
		box.innerHTML = '<h1>Title</h1><p>Body</p>';
		box.appendChild(r.pc.createTextNode('tail'));
		r.recorder.flush();
		expect(bodyOf(r.copy())).toBe(bodyOf(r.pc));
	});

	it('mirrors the caret — a phone typing into the copy sees where it lands', () => {
		const r = rig('<textarea id="composer" class="chat-input">hello</textarea>');
		const pcBox = r.pc.getElementById('composer') as HTMLTextAreaElement;
		const copyBox = r.copy().getElementById('composer') as HTMLTextAreaElement;
		// Nothing focused yet: no caret op, no bar in the copy.
		r.recorder.flush();
		expect(r.copy().querySelector('.mirror-caret')).toBeNull();

		// The PC's composer takes focus (the tap's replay put it there): the caret op
		// crosses with the selection, and the copy grows a blinking bar. jsdom leaves a
		// detached document's activeElement alone on focus() — set it as the browser would.
		Object.defineProperty(r.pc, 'activeElement', { value: pcBox, configurable: true });
		pcBox.setSelectionRange(2, 2);
		r.recorder.flush();
		expect(copyBox.value).toBe('hello');
		expect(r.copy().querySelector('.mirror-caret')).not.toBeNull();

		// Typing moves it (a later value + caret batch re-positions the same bar).
		pcBox.value = 'hello world';
		pcBox.setSelectionRange(11, 11);
		r.recorder.flush();
		const bar = r.copy().querySelector('.mirror-caret')!;
		expect(r.copy().querySelectorAll('.mirror-caret').length).toBe(1);
		expect(bar.style.height).toMatch(/px$/);

		// Focus leaves the editable: the bar goes away.
		Object.defineProperty(r.pc, 'activeElement', { value: r.pc.body, configurable: true });
		r.recorder.flush();
		expect(r.copy().querySelector('.mirror-caret')).toBeNull();
	});

	it('mirrors a contenteditable caret through its text node', () => {
		const r = rig('<div id="editor" contenteditable="true">hi<span>there</span></div>');
		const editor = r.pc.getElementById('editor')!;
		Object.defineProperty(r.pc, 'activeElement', { value: editor, configurable: true });
		const text = editor.firstChild as Text;
		// A detached document has no window selection in jsdom — the browser's is stubbed
		// as the recorder reads it (anchorNode/anchorOffset of the live one).
		const selection = { anchorNode: text, anchorOffset: 1 };
		Object.defineProperty(r.pc, 'getSelection', { value: () => selection, configurable: true });
		r.recorder.flush();
		expect(r.copy().querySelector('.mirror-caret')).not.toBeNull();
	});

	it('mirrors the caret of an EMPTY contenteditable — the Claude composer before its first character', () => {
		// Claude Code's composer is [role="textbox"][contenteditable]; focused empty, its
		// selection anchors on the editable itself (an element, offset 0) — the case that
		// once crossed as "no caret", so typing into the fresh composer showed no cursor.
		const r = rig('<div id="composer" contenteditable="true" role="textbox"></div>');
		const composer = r.pc.getElementById('composer')!;
		Object.defineProperty(r.pc, 'activeElement', { value: composer, configurable: true });
		const selection = { anchorNode: composer, anchorOffset: 0 };
		Object.defineProperty(r.pc, 'getSelection', { value: () => selection, configurable: true });
		r.recorder.flush();
		expect(r.copy().querySelector('.mirror-caret')).not.toBeNull();
		// Text arrives: the anchor becomes a text node and the bar survives the change.
		composer.textContent = 'hi';
		selection.anchorNode = composer.firstChild as Text;
		selection.anchorOffset = 2;
		r.recorder.flush();
		expect(r.copy().querySelector('.mirror-caret')).not.toBeNull();
		// The text is deleted again: the anchor returns to the element, the bar stays.
		composer.textContent = '';
		selection.anchorNode = composer;
		selection.anchorOffset = 0;
		r.recorder.flush();
		expect(r.copy().querySelector('.mirror-caret')).not.toBeNull();
		// Focus leaves the editable: the bar goes away.
		Object.defineProperty(r.pc, 'activeElement', { value: r.pc.body, configurable: true });
		r.recorder.flush();
		expect(r.copy().querySelector('.mirror-caret')).toBeNull();
	});

	it('paints the caret in the page’s own caret-color — Claude’s composer types in transparent text, and a bar in the text colour was invisible (2026-10-13: 有橙色框但是没有光标)', () => {
		const r = rig('<style>#composer{color:rgba(0, 0, 0, 0);caret-color:rgb(1, 2, 3)}#plain{color:rgb(4, 5, 6)}</style><div id="composer" contenteditable="true" role="textbox"></div><div id="plain" contenteditable="true"></div>');
		const composer = r.pc.getElementById('composer')!;
		Object.defineProperty(r.pc, 'activeElement', { value: composer, configurable: true });
		const selection = { anchorNode: composer as Node, anchorOffset: 0 };
		Object.defineProperty(r.pc, 'getSelection', { value: () => selection, configurable: true });
		r.recorder.flush();
		const bar = r.copy().querySelector('.mirror-caret') as HTMLElement;
		expect(bar.style.background).toBe('rgb(1, 2, 3)');
		// The copy still shows no native caret of its own: the hiding sheet is back on.
		expect(r.copy().defaultView!.getComputedStyle(r.copy().getElementById('composer')!).getPropertyValue('caret-color')).toMatch(/^(?:transparent|rgba\(0, 0, 0, 0\))$/);
		// No caret-color of its own: the text colour paints it, as the PC's engine does.
		const plain = r.pc.getElementById('plain')!;
		Object.defineProperty(r.pc, 'activeElement', { value: plain, configurable: true });
		selection.anchorNode = plain;
		r.recorder.flush();
		expect((r.copy().querySelector('.mirror-caret') as HTMLElement).style.background).toBe('rgb(4, 5, 6)');
	});

	it('keeps the caret that lands in a text node the same batch adds — the poll’s earlier read (the node not yet known: “no caret”) never overrides the flush’s own', () => {
		const r = rig('<div id="composer" contenteditable="true" role="textbox"></div>');
		const composer = r.pc.getElementById('composer')!;
		Object.defineProperty(r.pc, 'activeElement', { value: composer, configurable: true });
		const selection = { anchorNode: composer as Node, anchorOffset: 0 };
		Object.defineProperty(r.pc, 'getSelection', { value: () => selection, configurable: true });
		r.recorder.flush();
		// The first character typed: a fresh text node holds the caret before any flush.
		composer.textContent = 'h';
		selection.anchorNode = composer.firstChild!;
		selection.anchorOffset = 1;
		(r.recorder as unknown as { poll(): void }).poll();
		const carets = r.sent.flatMap((message) => (message.k === 'ops' ? message.ops : [])).filter((op) => op.o === 'caret');
		expect(carets.at(-1)).toMatchObject({ o: 'caret', ci: expect.any(Number), co: 1 });
		expect(r.copy().querySelector('.mirror-caret')).not.toBeNull();
	});

	it('tells the page where the mirrored caret is — the keyboard proxy rides it, and the IME with it', () => {
		const points: ({ x: number; y: number; h: number } | null)[] = [];
		const pc = pcDocument('<textarea id="composer">hi</textarea>');
		const host = document.createElement('div');
		document.body.appendChild(host);
		let viewer: MirrorViewer;
		const recorder = new DomRecorder(pc, (ops, seq) => viewer.receive({ k: 'ops', to: '*', seq, ops }));
		viewer = new MirrorViewer(host, 'remote/1', {
			appBase: 'https://p/main/',
			ggsBase: 'https://p/ggs/t/',
			resnap: () => undefined,
			onCaret: (point) => points.push(point)
		});
		viewer.receive({ k: 'snap', to: 'remote/1', ...recorder.snapshot() });
		const box = pc.getElementById('composer') as HTMLTextAreaElement;
		Object.defineProperty(pc, 'activeElement', { value: box, configurable: true });
		box.setSelectionRange(1, 1);
		recorder.flush();
		const point = points[points.length - 1];
		expect(point).not.toBeNull();
		expect(Number.isFinite(point!.x)).toBe(true);
		expect(Number.isFinite(point!.y)).toBe(true);
		expect(point!.h).toBeGreaterThanOrEqual(10);
		// Focus leaves the editable: the position is withdrawn.
		Object.defineProperty(pc, 'activeElement', { value: pc.body, configurable: true });
		recorder.flush();
		expect(points[points.length - 1]).toBeNull();
	});

	it('positions the keyboard proxy at the caret it is told', () => {
		const page = document.implementation.createHTMLDocument('phone');
		const input = new ViewerInput({ idOf: () => 1 } as unknown as MirrorViewer, () => undefined, page);
		const proxy = page.querySelector('textarea.mirror-proxy') as HTMLTextAreaElement;
		input.caretAt({ x: 40.6, y: 90.2, h: 22 });
		expect(proxy.style.left).toBe('41px');
		expect(proxy.style.top).toBe('90px');
		expect(proxy.style.height).toBe('22px');
		expect(proxy.style.bottom).toBe('auto');
		// Below a line's height the proxy keeps a sane box for the IME to anchor to.
		input.caretAt({ x: 0, y: 0, h: 8 });
		expect(proxy.style.height).toBe('18px');
		input.caretAt(null);
		expect(proxy.style.left).toBe('');
		expect(proxy.style.top).toBe('');
		expect(proxy.style.height).toBe('');
		expect(proxy.style.bottom).toBe('');
	});

	it('carries the caret and focus a snapshot finds — a viewer attaching after the PC focused the input sees both at once (2026-10-13: neither crossed again, so a fresh copy showed an input the PC held focused with no cursor and no focus styles)', () => {
		const pc = pcDocument('<style>.box:focus-within{color:rgb(255, 0, 0)}</style><div class="box"><textarea id="composer">hello</textarea></div>');
		const host = document.createElement('div');
		document.body.appendChild(host);
		const viewer = new MirrorViewer(host, 'remote/9', { appBase: 'https://p/main/', ggsBase: 'https://p/ggs/', resnap: () => undefined });
		const recorder = new DomRecorder(pc, () => undefined);
		const box = pc.getElementById('composer') as HTMLTextAreaElement;
		// The PC held the input focused before any viewer attached.
		Object.defineProperty(pc, 'activeElement', { value: box, configurable: true });
		box.setSelectionRange(2, 2);
		const snap = recorder.snapshot();
		expect(snap.caret).toMatchObject({ i: expect.any(Number), s: 2, e: 2 });
		expect(snap.focus).toEqual([{ i: expect.any(Number) }]);
		viewer.receive({ k: 'snap', to: 'remote/9', ...snap });
		expect(viewer.root!.querySelector('.mirror-caret')).not.toBeNull();
		const copyBox = viewer.root!.querySelector('.box')!;
		expect(copyBox.classList.contains('mirror-focus-within')).toBe(true);
		expect(viewer.root!.getElementById('composer')!.classList.contains('mirror-focus')).toBe(true);
	});

	it('mirrors the focused element through the page’s own :focus CSS — the copy paints nothing on top of it (2026-10-13, the owner’s direction)', () => {
		const r = rig('<style>.box:focus-within{color:rgb(255, 0, 0)}#go:focus{color:rgb(0, 0, 255)}</style><div class="box"><div id="go" tabindex="0">go</div></div>');
		const go = r.pc.getElementById('go')!;
		Object.defineProperty(r.pc, 'activeElement', { value: go, configurable: true });
		r.recorder.flush();
		const focusOp = r.sent.flatMap((message) => (message.k === 'ops' ? message.ops : [])).find((op) => op.o === 'focus');
		expect(focusOp).toMatchObject({ o: 'focus', f: [{ i: expect.any(Number) }] });
		const copy = r.copy();
		const copyGo = copy.getElementById('go')!;
		expect(copyGo.classList.contains('mirror-focus')).toBe(true);
		expect(copy.querySelector('.box')!.classList.contains('mirror-focus-within')).toBe(true);
		// The page's own rules, mirrored onto the marker classes beside themselves, paint
		// the copy exactly as the PC's engine paints them.
		const selectors = Array.from(copy.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules, (rule) => (rule as CSSStyleRule).selectorText));
		expect(selectors).toContain('.box.mirror-focus-within');
		expect(selectors).toContain('#go.mirror-focus');
		expect(copy.defaultView!.getComputedStyle(copy.querySelector('.box')!).color).toBe('rgb(255, 0, 0)');
		expect(copy.defaultView!.getComputedStyle(copyGo).color).toBe('rgb(0, 0, 255)');
		// The page rewrites the focused wrapper's class attribute (a React re-render): the
		// markers are wiped by the attribute op and put back after the batch.
		copy.querySelector('.box')!;
		r.pc.querySelector('.box')!.setAttribute('class', 'box busy');
		r.recorder.flush();
		const rewritten = r.copy().querySelector('.box')!;
		expect(rewritten.className).toBe('box busy mirror-focus-within');
		// Focus leaves: the markers go, and the box's own colour returns.
		Object.defineProperty(r.pc, 'activeElement', { value: r.pc.body, configurable: true });
		r.recorder.flush();
		const settled = r.copy().querySelector('.box')!;
		expect(settled.classList.contains('mirror-focus-within')).toBe(false);
		expect(r.copy().defaultView!.getComputedStyle(settled).color).not.toBe('rgb(255, 0, 0)');
	});

	it('re-derives the focus rules of a frame refilled by a doc op once its late sheet loads — the refill’s document.open() erased the load listener and the reloaded chat’s focus border never showed', () => {
		const outer = document.createElement('iframe');
		document.body.appendChild(outer);
		const pc = outer.contentDocument!;
		pc.body.innerHTML = '<iframe id="wv"></iframe>';
		const wv = pc.getElementById('wv') as HTMLIFrameElement;
		wv.contentDocument!.body.innerHTML = '<div class="box"><div id="composer" contenteditable="true">hi</div></div>';
		const host = document.createElement('div');
		document.body.appendChild(host);
		let viewer: MirrorViewer;
		const recorder = new DomRecorder(pc, (ops, seq) => viewer.receive({ k: 'ops', to: '*', seq, ops }));
		viewer = new MirrorViewer(host, 'remote/1', { appBase: 'https://p/main/', ggsBase: 'https://p/ggs/', resnap: () => undefined });
		viewer.receive({ k: 'snap', to: 'remote/1', ...recorder.snapshot() });
		const copyDoc = viewer.root!.querySelector('iframe')!.contentDocument!;
		// Chromium's document.open() erases the document's listeners (measured); jsdom keeps
		// them, so the refill must be seen re-attaching its hook, not merely keeping one.
		const hooks = vi.spyOn(copyDoc, 'addEventListener');
		// The webview reloads: the recorder ships its document whole and the copy refills
		// the very same frame document.
		wv.dispatchEvent(new Event('load'));
		expect(viewer.root!.querySelector('iframe')!.contentDocument).toBe(copyDoc);
		expect(copyDoc.querySelector('.box')).not.toBeNull();
		expect(hooks).toHaveBeenCalledWith('load', expect.any(Function), true);
		// The page's stylesheet lands after the refill (a <link> finishing its load).
		const sheet = copyDoc.createElement('style');
		sheet.textContent = '.box:focus-within{color:rgb(255, 0, 0)}';
		copyDoc.head.appendChild(sheet);
		sheet.dispatchEvent(new Event('load'));
		const selectors = Array.from(copyDoc.styleSheets).flatMap((s) => Array.from(s.cssRules, (rule) => (rule as CSSStyleRule).selectorText));
		expect(selectors).toContain('.box.mirror-focus-within');
		recorder.stop();
		viewer.dispose();
		host.remove();
		outer.remove();
	});

	it('carries form values that no observer reports', () => {
		const r = rig('<input id="q" value="a"><input id="c" type="checkbox">');
		(r.pc.getElementById('q') as HTMLInputElement).value = 'typed';
		(r.pc.getElementById('c') as HTMLInputElement).checked = true;
		r.recorder.flush();
		expect((r.copy().getElementById('q') as HTMLInputElement).value).toBe('typed');
		expect((r.copy().getElementById('c') as HTMLInputElement).checked).toBe(true);
	});

	it('rewrites the PC asset URLs onto the viewer routes', () => {
		const pc = pcDocument('');
		const link = pc.createElement('link');
		link.rel = 'stylesheet';
		link.setAttribute('href', 'ggs://localhost/anthropic.claude-code/webview/index.css');
		pc.head.appendChild(link);
		const host = document.createElement('div');
		document.body.appendChild(host);
		const viewer = new MirrorViewer(host, 'remote/1', { appBase: 'https://p/main/', ggsBase: 'https://p/ggs/t/', resnap: () => undefined });
		const recorder = new DomRecorder(pc, () => undefined);
		viewer.receive({ k: 'snap', to: 'remote/1', ...recorder.snapshot() });
		expect(viewer.root!.querySelector('link')?.getAttribute('href')).toBe('https://p/ggs/t/anthropic.claude-code/webview/index.css');
	});

	it('drops a copied content-security policy, which would govern the viewer', () => {
		const pc = pcDocument('');
		const meta = pc.createElement('meta');
		meta.setAttribute('http-equiv', 'Content-Security-Policy');
		meta.setAttribute('content', "default-src 'none'");
		pc.head.appendChild(meta);
		const recorder = new DomRecorder(pc, () => undefined);
		const snap = recorder.snapshot();
		const head = snap.doc.html.k!.find((node) => node.n === 'head')!;
		const copied = head.k!.find((node) => node.n === 'meta')!;
		expect(copied.a).toBeUndefined();
	});

	it('asks for a fresh snapshot when a batch went missing, and ignores another viewer’s', () => {
		const r = rig('<p id="p">x</p>');
		const before = bodyOf(r.copy());
		r.viewer.receive({ k: 'snap', to: 'remote/2', seq: 99, root: 1, doc: { d: 1, html: { i: 1, t: 'e', n: 'html' }, adopted: '' }, vp: { w: 1, h: 1 } });
		expect(bodyOf(r.copy())).toBe(before);
		const gap: MirrorOp[] = [{ o: 'text', i: 12345, v: 'never' }];
		r.viewer.receive({ k: 'ops', to: '*', seq: 50, ops: gap });
		expect(r.resnaps).toBe(1);
		// Until the new snapshot lands, batches are not applied.
		r.pc.getElementById('p')!.textContent = 'later';
		r.recorder.flush();
		expect(r.copy().getElementById('p')?.textContent).toBe('x');
		r.viewer.receive({ k: 'snap', to: 'remote/1', ...r.recorder.snapshot() });
		expect(r.copy().getElementById('p')?.textContent).toBe('later');
	});

	it('stops observing when stopped, and starts clean', () => {
		const r = rig('<p id="p">x</p>');
		r.recorder.stop();
		r.pc.getElementById('p')!.textContent = 'unseen';
		const count = r.sent.length;
		r.recorder.flush();
		expect(r.sent.length).toBe(count);
		expect(r.recorder.active).toBe(false);
	});
});

describe('the input replay', () => {
	function replayRig(body: string) {
		const pc = pcDocument(body);
		// Replay needs a live window: the PC tree is mounted into the test's own document.
		document.body.innerHTML = body;
		const recorder = new DomRecorder(document, () => undefined);
		recorder.snapshot();
		const replayer = new InputReplayer(recorder, document);
		void pc;
		const id = (selector: string) => recorder.idOf(document.querySelector(selector)!)!;
		const send = (message: Record<string, unknown>) => replayer.handle({ from: 'remote/1', ...message } as UpMessage);
		return { recorder, replayer, id, send };
	}

	it('replays a tap as press, release and click, focusing what it lands on', () => {
		const { id, send } = replayRig('<button id="b">Go</button><input id="i">');
		const seen: string[] = [];
		const button = document.getElementById('b')!;
		for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) button.addEventListener(type, () => seen.push(type));
		send({ k: 'ptr', ev: 'down', b: 0, m: 0, d: 1, i: id('#b'), fx: 0.5, fy: 0.5 });
		send({ k: 'ptr', ev: 'up', b: 0, m: 0, d: 1, i: id('#b'), fx: 0.5, fy: 0.5 });
		expect(seen.filter((type) => !type.startsWith('pointer'))).toEqual(['mousedown', 'mouseup', 'click']);
		send({ k: 'ptr', ev: 'down', b: 0, m: 0, d: 1, i: id('#i'), fx: 0.5, fy: 0.5 });
		expect(document.activeElement?.id).toBe('i');
	});

	it('opens a context menu on a long press', () => {
		const { id, send } = replayRig('<div id="row">row</div>');
		const menu = vi.fn();
		document.getElementById('row')!.addEventListener('contextmenu', menu);
		send({ k: 'ptr', ev: 'ctx', b: 2, m: 0, d: 1, i: id('#row'), fx: 0.1, fy: 0.1 });
		expect(menu).toHaveBeenCalledTimes(1);
	});

	it('types text and keys into the focused field', () => {
		const { send } = replayRig('<input id="i">');
		const input = document.getElementById('i') as HTMLInputElement;
		input.focus();
		const keys: string[] = [];
		input.addEventListener('keydown', (event) => keys.push(`${event.key}:${(event as KeyboardEvent).keyCode}${event.ctrlKey ? '+ctrl' : ''}`));
		const typed = vi.fn();
		input.addEventListener('input', typed);
		send({ k: 'text', v: 'hi' });
		expect(input.value).toBe('hi');
		expect(typed).toHaveBeenCalled();
		send({ k: 'key', key: 'Enter', code: 'Enter', m: 0 });
		send({ k: 'key', key: 'p', code: 'KeyP', m: 1 });
		expect(keys).toEqual(['Enter:13', 'p:80+ctrl']);
	});

	it('sets a select’s value with the events a page listens for', () => {
		const { id, send } = replayRig('<select id="s"><option value="a">A</option><option value="b">B</option></select>');
		const changed = vi.fn();
		document.getElementById('s')!.addEventListener('change', changed);
		send({ k: 'sel', i: id('#s'), v: 'b' });
		expect((document.getElementById('s') as HTMLSelectElement).value).toBe('b');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('answers a copy with the focused field’s selection', () => {
		const { send } = replayRig('<input id="i" value="hello world">');
		const input = document.getElementById('i') as HTMLInputElement;
		input.focus();
		input.setSelectionRange(0, 5);
		expect(send({ k: 'copy' })).toBe('hello');
	});
});


describe('the host', () => {
	it('greets a viewer with a snapshot and a fit, and forgets a silent one', () => {
		document.body.innerHTML = '<p>pc</p>';
		const sent: DownMessage[] = [];
		const fit = vi.fn();
		const focus = vi.fn();
		let now = 0;
		const host = new MirrorHost(document, { send: (message) => sent.push(message), fit, focus, now: () => now });
		host.receive({ k: 'hello', from: 'remote/7', vw: 390, vh: 844, touch: true });
		expect(sent[0]).toMatchObject({ k: 'snap', to: 'remote/7' });
		// The desktop floor applies to every viewer (§11: no phone-sized window any more).
		expect(fit).toHaveBeenCalledWith(800, Math.round((800 * 844) / 390));
		expect(focus).toHaveBeenCalledWith(true);
		expect(host.viewerCount).toBe(1);
		// A repeated hello is a keepalive, not a second snapshot.
		host.receive({ k: 'hello', from: 'remote/7', vw: 390, vh: 844, touch: true });
		expect(sent.filter((message) => message.k === 'snap')).toHaveLength(1);
		// Input from a viewer the host does not know is ignored.
		host.receive({ k: 'text', from: 'remote/9', v: 'x' });
		now = 60_000;
		host.prune();
		expect(host.viewerCount).toBe(0);
		expect(focus).toHaveBeenLastCalledWith(false);
	});

	it('lets a reloaded page simply join again', () => {
		document.body.innerHTML = '<p id="p">pc</p>';
		const sent: DownMessage[] = [];
		const host = new MirrorHost(document, { send: (message) => sent.push(message), fit: () => undefined, focus: () => undefined, now: () => 0 });
		host.receive({ k: 'hello', from: 'remote/1', vw: 1200, vh: 800, touch: false });
		host.receive({ k: 'bye', from: 'remote/1' });
		host.receive({ k: 'hello', from: 'remote/2', vw: 1200, vh: 800, touch: false });
		const snaps = sent.filter((message) => message.k === 'snap');
		expect(snaps.map((message) => message.to)).toEqual(['remote/1', 'remote/2']);
	});
});

describe('one window, one UI', () => {
	it('pins a switch in the URL so a reload keeps it', () => {
		const page = 'https://pc:47615/w/abc/v/1/?frontend=1#x';
		expect(requestedMode(new URL(page).search)).toBe('frontend');
		const live = modeUrl(page, 'mirror');
		expect(requestedMode(new URL(live).search)).toBe('mirror');
		expect(new URL(live).searchParams.has('frontend')).toBe(false);
		expect(requestedMode('')).toBe('auto');
	});

	it('fits the window to its first viewer only; later viewers share the copy (§11: the own-UI redirect is gone)', () => {
		document.body.innerHTML = '<p>pc</p>';
		const sent: DownMessage[] = [];
		const fit = vi.fn();
		const host = new MirrorHost(document, { send: (message) => sent.push(message), fit, focus: () => undefined, now: () => 0 });
		host.receive({ k: 'hello', from: 'remote/1', vw: 1200, vh: 800, touch: false });
		expect(fit).toHaveBeenLastCalledWith(1200, 800);
		// A differently-sized viewer joining: no refit, no redirect — it watches the copy.
		host.receive({ k: 'hello', from: 'remote/2', vw: 1440, vh: 900, touch: false });
		expect(fit).toHaveBeenCalledTimes(1);
		// The owner leaves: the next viewer inherits the window.
		host.receive({ k: 'bye', from: 'remote/1' });
		expect(fit).toHaveBeenLastCalledWith(1440, 900);
	});
});

describe('webview streams (§22.6)', () => {
	afterEach(() => setWebviewFrameSource(null));

	it('names a view or a panel, and reads the name back', () => {
		expect(parseStream(viewStream('claudeVSCodeSidebar'))).toEqual({ view: 'claudeVSCodeSidebar' });
		expect(parseStream(panelStream('Anthropic.claude-code', 3))).toEqual({ extId: 'Anthropic.claude-code', panelId: 3 });
		expect(parseStream('panel:broken')).toBeNull();
		expect(parseStream('other:x')).toBeNull();
	});

	it('copies the PC frame into a fluid viewer live, and replays the copy’s typing into the frame', async () => {
		// The desktop window's chat frame: the one live page of the conversation.
		const frame = document.createElement('iframe');
		document.body.appendChild(frame);
		const pcDoc = frame.contentDocument!;
		pcDoc.body.innerHTML = '<div id="log"><p>first answer</p></div><textarea id="ask"></textarea>';
		const ensure = vi.fn();
		const stream = viewStream('chat');
		setWebviewFrameSource({ frameFor: (key) => (key === stream ? frame : null), ensure });
		const sent: DownMessage[] = [];
		const focus = vi.fn();
		const pc = new MirrorHost(document, { send: (message) => sent.push(message), fit: () => undefined, focus, now: () => 0 });
		// The remote page's copy, and a whole-window viewer that must ignore the stream.
		const pane = document.createElement('div');
		document.body.appendChild(pane);
		const copy = new MirrorViewer(pane, 'remote/3', { appBase: 'https://p/main/', ggsBase: 'https://p/ggs/', resnap: () => undefined, stream, fluid: true });
		const windowViewer = new MirrorViewer(document.createElement('div'), 'remote/3', { appBase: 'https://p/main/', ggsBase: 'https://p/ggs/', resnap: () => undefined });
		pc.receive({ k: 'hello', from: 'remote/3', w: stream, vw: 390, vh: 700, touch: true });
		await vi.waitFor(() => expect(sent.some((message) => message.k === 'snap')).toBe(true));
		expect(ensure).toHaveBeenCalledWith(stream);
		expect(focus).toHaveBeenCalledWith(true);
		const deliver = () => {
			for (const message of sent.splice(0)) {
				copy.receive(message);
				windowViewer.receive(message);
			}
		};
		deliver();
		expect(copy.root?.getElementById('log')?.textContent).toBe('first answer');
		expect(windowViewer.root).toBeNull();
		// The fluid copy fills its pane instead of scaling the PC's size.
		const copyFrame = pane.querySelector('iframe')!;
		expect(copyFrame.style.width).toBe('100%');
		expect(copyFrame.getAttribute('scrolling')).toBeNull();
		// The PC's page streams on: the copy follows.
		pcDoc.getElementById('log')!.insertAdjacentHTML('beforeend', '<p>streaming…</p>');
		await vi.waitFor(() => expect(sent.some((message) => message.k === 'ops')).toBe(true));
		deliver();
		expect(copy.root?.getElementById('log')?.textContent).toBe('first answerstreaming…');
		// The remote user taps the ask field and types: it lands in the PC's frame.
		const askId = copy.idOf(copy.root!.getElementById('ask')!)!;
		pc.receive({ k: 'ptr', from: 'remote/3', w: stream, ev: 'down', b: 0, m: 0, d: 1, i: askId, fx: 0.5, fy: 0.5 });
		pc.receive({ k: 'ptr', from: 'remote/3', w: stream, ev: 'up', b: 0, m: 0, d: 1, i: askId, fx: 0.5, fy: 0.5 });
		pc.receive({ k: 'text', from: 'remote/3', w: stream, v: 'why?' });
		expect((pcDoc.getElementById('ask') as HTMLTextAreaElement).value).toBe('why?');
		// The page leaving ends the stream and, with nobody watching, the focus emulation.
		pc.receive({ k: 'bye', from: 'remote/3', w: stream });
		expect(focus).toHaveBeenLastCalledWith(false);
	});

	it('a remote tap into the frame’s composer focuses it on the PC, and the copy shows the page’s own focus styles (2026-10-13: 远程点击后 PC 有光标和红边、副本没有)', async () => {
		// The desktop window's chat frame: Claude Code's composer shape — a contenteditable
		// inside a wrapper whose :focus-within rule draws the border.
		const frame = document.createElement('iframe');
		document.body.appendChild(frame);
		const pcDoc = frame.contentDocument!;
		pcDoc.head.innerHTML = '<style>.box:focus-within{color:rgb(255, 0, 0)}</style>';
		pcDoc.body.innerHTML = '<div class="box"><div id="composer" contenteditable="true" role="textbox">hi</div></div>';
		const stream = viewStream('chat');
		setWebviewFrameSource({ frameFor: (key) => (key === stream ? frame : null), ensure: () => undefined });
		const sent: DownMessage[] = [];
		const pc = new MirrorHost(document, { send: (message) => sent.push(message), fit: () => undefined, focus: () => undefined, now: () => 0 });
		const pane = document.createElement('div');
		document.body.appendChild(pane);
		const copy = new MirrorViewer(pane, 'remote/3', { appBase: 'https://p/main/', ggsBase: 'https://p/ggs/', resnap: () => undefined, stream, fluid: true });
		pc.receive({ k: 'hello', from: 'remote/3', w: stream, vw: 390, vh: 700, touch: true });
		await vi.waitFor(() => expect(sent.some((message) => message.k === 'snap')).toBe(true));
		const deliver = () => {
			for (const message of sent.splice(0)) copy.receive(message);
		};
		deliver();
		// The phone taps the composer: the replay focuses the PC's editable…
		const composerId = copy.idOf(copy.root!.getElementById('composer')!)!;
		pc.receive({ k: 'ptr', from: 'remote/3', w: stream, ev: 'down', b: 0, m: 0, d: 1, i: composerId, fx: 0.5, fy: 0.5 });
		pc.receive({ k: 'ptr', from: 'remote/3', w: stream, ev: 'up', b: 0, m: 0, d: 1, i: composerId, fx: 0.5, fy: 0.5 });
		expect(pcDoc.activeElement).toBe(pcDoc.getElementById('composer'));
		// …and the focus op crosses, so the copy wears the markers and the page's own rule
		// paints the wrapper exactly as the PC's engine paints it there.
		await vi.waitFor(() => expect(sent.some((message) => message.k === 'ops' && message.ops.some((op) => op.o === 'focus'))).toBe(true));
		deliver();
		const box = copy.root!.querySelector('.box')!;
		expect(copy.root!.getElementById('composer')!.classList.contains('mirror-focus')).toBe(true);
		expect(box.classList.contains('mirror-focus-within')).toBe(true);
		const selectors = Array.from(copy.root!.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules, (rule) => (rule as CSSStyleRule).selectorText));
		expect(selectors).toContain('.box.mirror-focus-within');
		expect(copy.root!.defaultView!.getComputedStyle(box).color).toBe('rgb(255, 0, 0)');
		copy.dispose();
		pane.remove();
		pc.receive({ k: 'bye', from: 'remote/3', w: stream });
	});

	it('recovers the copy when its pane re-parents and the frame is reborn empty — a device-class switch must not blank the chat (2026-10-16: 切换窗口尺寸后 Claude 页面空白)', async () => {
		const frame = document.createElement('iframe');
		document.body.appendChild(frame);
		const pcDoc = frame.contentDocument!;
		pcDoc.body.innerHTML = '<div id="log"><p>answer</p></div>';
		const stream = viewStream('chat');
		setWebviewFrameSource({ frameFor: () => frame, ensure: () => undefined });
		const sent: DownMessage[] = [];
		const pc = new MirrorHost(document, { send: (message) => sent.push(message), fit: () => undefined, focus: () => undefined, now: () => 0 });
		const pane = document.createElement('div');
		document.body.appendChild(pane);
		let copy: MirrorViewer;
		const resnaps: number[] = [];
		copy = new MirrorViewer(pane, 'remote/3', { appBase: 'https://p/main/', ggsBase: 'https://p/ggs/', resnap: () => { resnaps.push(resnaps.length); pc.receive({ k: 'resnap', from: 'remote/3', w: stream }); }, stream, fluid: true });
		pc.receive({ k: 'hello', from: 'remote/3', w: stream, vw: 390, vh: 700, touch: true });
		await vi.waitFor(() => expect(sent.some((message) => message.k === 'snap')).toBe(true));
		const deliver = () => {
			for (const message of sent.splice(0)) copy.receive(message);
		};
		deliver();
		expect(copy.root?.getElementById('log')?.textContent).toBe('answer');
		// The device-class switch: the layout host detaches the workbench part (the copy's
		// pane rides inside it) and re-attaches it into the next arrangement. A browser
		// discards the frame's browsing context on the detach and reborns it empty on the
		// attach; jsdom keeps the document, so the rebirth is emulated — a fresh empty
		// document under the same element, then the load its initial navigation fires.
		pcDoc.getElementById('log')!.insertAdjacentHTML('beforeend', '<p>streaming…</p>');
		const parent = pane.parentElement!;
		const copyFrame = pane.querySelector('iframe')!;
		parent.removeChild(pane);
		Object.defineProperty(copyFrame, 'contentDocument', { value: document.implementation.createHTMLDocument(), configurable: true });
		parent.appendChild(pane);
		copyFrame.dispatchEvent(new Event('load'));
		expect(resnaps).toHaveLength(1);
		// The PC answers the resnap with a snapshot, and the copy rebuilds whole — the
		// conversation is back, carrying what streamed meanwhile, not a blank pane.
		await vi.waitFor(() => expect(sent.some((message) => message.k === 'snap')).toBe(true));
		deliver();
		expect(copy.root?.getElementById('log')?.textContent).toBe('answerstreaming…');
		copy.dispose();
		pane.remove();
		pc.receive({ k: 'bye', from: 'remote/3', w: stream });
	});

	it('re-snapshots every viewer when the frame loads a new document', async () => {
		const frame = document.createElement('iframe');
		document.body.appendChild(frame);
		frame.contentDocument!.body.innerHTML = '<p>old</p>';
		let current: HTMLIFrameElement = frame;
		const stream = panelStream('acme.chat', 1);
		setWebviewFrameSource({ frameFor: () => current, ensure: () => undefined });
		const sent: DownMessage[] = [];
		const pc = new MirrorHost(document, { send: (message) => sent.push(message), fit: () => undefined, focus: () => undefined, now: () => 0 });
		pc.receive({ k: 'hello', from: 'remote/4', w: stream, vw: 390, vh: 700, touch: true });
		await vi.waitFor(() => expect(sent.filter((message) => message.k === 'snap')).toHaveLength(1));
		// The tab remounted: a new frame element with a new document.
		const next = document.createElement('iframe');
		document.body.appendChild(next);
		next.contentDocument!.body.innerHTML = '<p>new</p>';
		current = next;
		await vi.waitFor(() => expect(sent.filter((message) => message.k === 'snap')).toHaveLength(2), { timeout: 3000 });
		const last = sent.filter((message) => message.k === 'snap').at(-1)!;
		expect(last).toMatchObject({ to: 'remote/4', w: stream });
		pc.receive({ k: 'bye', from: 'remote/4', w: stream });
	});

	// jsdom lays nothing out: a scroller's metrics are stubbed per element, the scrollTop
	// setter recording what the code under test scrolled to (the yank under test, the sync).
	function stubScroller(el: HTMLElement, metrics: { top?: number; height?: number; view?: number }): { top(): number; grow(to: number): void } {
		let top = metrics.top ?? 0;
		let height = metrics.height ?? 5000;
		const view = metrics.view ?? 700;
		Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });
		Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
		Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => view });
		return { top: () => top, grow: (to: number) => { height = to; } };
	}

	/** A fluid copy of `body` over a host's share, with the copy's #scroller stubbed from
	 * `copyMetrics` while its document fills (the moment the end-scan runs). */
	async function fluidRig(body: string, copyMetrics: { top?: number; height?: number; view?: number }, pcMetrics?: { top?: number; height?: number; view?: number }) {
		const frame = document.createElement('iframe');
		document.body.appendChild(frame);
		frame.contentDocument!.body.innerHTML = body;
		const pcScroller = frame.contentDocument!.getElementById('scroller') as HTMLElement;
		if (pcMetrics) stubScroller(pcScroller, pcMetrics);
		const stream = viewStream('graph');
		setWebviewFrameSource({ frameFor: () => frame, ensure: () => undefined });
		const sent: DownMessage[] = [];
		const pc = new MirrorHost(document, { send: (message) => sent.push(message), fit: () => undefined, focus: () => undefined, now: () => 0 });
		const pane = document.createElement('div');
		document.body.appendChild(pane);
		let copyScroller: HTMLElement | null = null;
		let grow: (to: number) => void = () => undefined;
		const reports: Array<[number, number, boolean]> = [];
		const copy = new MirrorViewer(pane, 'remote/5', {
			appBase: 'https://p/main/', ggsBase: 'https://p/ggs/', resnap: () => undefined, stream, fluid: true,
			onScroll: (id, fraction, end) => reports.push([id, fraction, end]),
			onDocument: (doc) => {
				const el = doc.getElementById('scroller');
				if (el) {
					grow = stubScroller(el, copyMetrics).grow;
					copyScroller = el;
				}
			}
		});
		pc.receive({ k: 'hello', from: 'remote/5', w: stream, vw: 390, vh: 700, touch: true });
		await vi.waitFor(() => expect(sent.some((message) => message.k === 'snap')).toBe(true));
		const deliver = () => {
			for (const message of sent.splice(0)) copy.receive(message);
		};
		deliver();
		return { pc, copy, pane, frame, sent, deliver, reports, grow, scroller: () => copyScroller!, pcScroller };
	}

	it('leaves a virtualized list copy at the PC’s offset — never dragged into its unrendered end', async () => {
		// git-graph-rs renders the viewport plus a buffer, spacers standing in for the rest:
		// the copy must stay where the PC's page is, not be dragged to the bottom spacer.
		const rig = await fluidRig('<div id="scroller" style="overflow-y: auto"><div id="rows">r</div></div>', { top: 0, height: 5000, view: 700 });
		expect(rig.scroller().style.overflowY).toBe('auto');
		expect(rig.scroller().scrollTop).toBe(0);
		// The batch past the end-scan's window must not drag it either.
		rig.frame.contentDocument!.getElementById('rows')!.insertAdjacentHTML('beforeend', '<p>more</p>');
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await vi.waitFor(() => expect(rig.sent.some((message) => message.k === 'ops')).toBe(true));
		rig.deliver();
		expect(rig.scroller().scrollTop).toBe(0);
		rig.copy.dispose();
		rig.pane.remove();
		rig.pc.receive({ k: 'bye', from: 'remote/5', w: viewStream('graph') });
	});

	it('still pins a chat scroller the copy restored at its end, following its growth', async () => {
		const rig = await fluidRig('<div id="scroller" style="overflow-y: auto"><div id="log"><p>answer</p></div></div>', { top: 4800, height: 5000, view: 200 });
		// The end-scan opens on the first batch past its window: a scroller that sits at its
		// end (a chat read from its latest message) is pinned there.
		const pcLog = rig.frame.contentDocument!.getElementById('log')!;
		pcLog.insertAdjacentHTML('beforeend', '<p>x</p>');
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await vi.waitFor(() => expect(rig.sent.some((message) => message.k === 'ops')).toBe(true));
		rig.deliver();
		expect(rig.scroller().scrollTop).toBe(5000);
		// The content grows: the pinned scroller follows to the new end.
		rig.grow(6000);
		pcLog.insertAdjacentHTML('beforeend', '<p>streaming…</p>');
		await vi.waitFor(() => expect(rig.sent.some((message) => message.k === 'ops')).toBe(true));
		rig.deliver();
		expect(rig.copy.root?.getElementById('log')?.textContent).toBe('answerxstreaming…');
		expect(rig.scroller().scrollTop).toBe(6000);
		rig.copy.dispose();
		rig.pane.remove();
		rig.pc.receive({ k: 'bye', from: 'remote/5', w: viewStream('graph') });
	});

	it('reports a fluid copy’s scroll, and the PC renders the window there', async () => {
		const rig = await fluidRig('<div id="scroller" style="overflow-y: auto"><div id="rows">r</div></div>', { top: 1000, height: 5000, view: 1000 }, { height: 8000, view: 1000 });
		// The phone scrolls its own layout of the list: the position travels as a fraction.
		rig.scroller().dispatchEvent(new Event('scroll'));
		await vi.waitFor(() => expect(rig.reports.length).toBe(1));
		const [id, fraction, end] = rig.reports[0];
		expect(fraction).toBeCloseTo(0.25);
		expect(end).toBe(false);
		// The PC puts its own scroller at the same fraction of its range — a virtualized list
		// renders the rows the viewer is looking at.
		rig.pc.receive({ k: 'scroll', from: 'remote/5', w: viewStream('graph'), i: id, f: fraction });
		expect(rig.pcScroller.scrollTop).toBe(1750);
		rig.pc.receive({ k: 'scroll', from: 'remote/5', w: viewStream('graph'), i: id, f: fraction, e: 1 });
		expect(rig.pcScroller.scrollTop).toBe(7000);
		rig.copy.dispose();
		rig.pane.remove();
		rig.pc.receive({ k: 'bye', from: 'remote/5', w: viewStream('graph') });
	});

	// §9.2's scroll ownership. The clock is the rig's own: a lease is advanced by moving it.
	describe('scroll ownership (§9.2)', () => {
		/** A graph frame over a host's share with a movable clock, its PC scroller stubbed
		 *  (height 8000, view 1000 — fraction 0.5 is top 3500) and a button to click. */
		async function ownRig() {
			const frame = document.createElement('iframe');
			document.body.appendChild(frame);
			const pcDoc = frame.contentDocument!;
			pcDoc.body.innerHTML = '<div id="scroller" style="overflow-y: auto"><button id="row">commit</button></div>';
			const pcScroller = pcDoc.getElementById('scroller') as HTMLElement;
			stubScroller(pcScroller, { height: 8000, view: 1000 });
			let clicked = 0;
			pcDoc.getElementById('row')!.addEventListener('click', () => { clicked += 1; });
			const stream = viewStream('graph');
			setWebviewFrameSource({ frameFor: () => frame, ensure: () => undefined });
			const sent: DownMessage[] = [];
			let clock = 10_000;
			// jsdom cannot forge `isTrusted`, so the rig's events all count as the PC user's.
			const pc = new MirrorHost(document, { send: (message) => sent.push(message), fit: () => undefined, focus: () => undefined, now: () => clock, trusted: () => true });
			// A copy of the stream, to read the node ids the way a viewer names them (the
			// copy's ids ARE the PC's — that is the mirror's premise).
			const pane = document.createElement('div');
			document.body.appendChild(pane);
			const copy = new MirrorViewer(pane, 'remote/5', { appBase: 'https://p/main/', ggsBase: 'https://p/ggs/', resnap: () => undefined, stream, fluid: true });
			pc.receive({ k: 'hello', from: 'remote/5', w: stream, vw: 390, vh: 700, touch: true, device: 'phone-portrait' });
			await vi.waitFor(() => expect(sent.some((message) => message.k === 'snap')).toBe(true));
			for (const message of sent.splice(0)) copy.receive(message);
			const scrollerId = copy.idOf(copy.root!.getElementById('scroller')!)!;
			const rowId = copy.idOf(copy.root!.getElementById('row')!)!;
			const scroll = (f: number) => pc.receive({ k: 'scroll', from: 'remote/5', w: stream, i: scrollerId, f });
			/** The PC user's own wheel on the frame — the rig's `trusted` hook counts it as
			 *  the PC user's (jsdom cannot forge `isTrusted`, which the real host reads). */
			const pcWheel = () => {
				pcDoc.dispatchEvent(new Event('wheel'));
			};
			const owns = () => sent.filter((message): message is Extract<DownMessage, { k: 'own' }> => message.k === 'own');
			return {
				pc, sent, frame, pcScroller, scroll, pcWheel, owns,
				clicks: () => clicked,
				rowId: () => rowId,
				advance: (ms: number) => { clock += ms; },
				stop: () => {
					copy.dispose();
					pane.remove();
					pc.receive({ k: 'bye', from: 'remote/5', w: stream });
				}
			};
		}

		it('a lone viewer’s scroll drives the panel — today’s behavior unchanged', async () => {
			const rig = await ownRig();
			try {
				rig.scroll(0.5);
				expect(rig.pcScroller.scrollTop).toBe(3500);
				rig.scroll(0.75);
				expect(rig.pcScroller.scrollTop).toBe(5250);
			} finally {
				rig.stop();
			}
		});

		it('the PC user’s wheel owns the panel: the remote’s scroll is dropped and told who holds', async () => {
			const rig = await ownRig();
			try {
				rig.pcWheel();
				// The change is broadcast: every copy learns main holds.
				expect(rig.owns().at(-1)).toMatchObject({ k: 'own', to: '*', who: 'main', name: 'PC' });
				rig.scroll(0.5);
				expect(rig.pcScroller.scrollTop).toBe(0);
				// The dropped scroll is answered to its author alone, with the lease left.
				const told = rig.owns().at(-1)!;
				expect(told).toMatchObject({ to: 'remote/5', who: 'main', name: 'PC' });
				expect(told.ms).toBeGreaterThan(0);
				expect(told.ms).toBeLessThanOrEqual(3000);
			} finally {
				rig.stop();
			}
		});

		it('ownership transfers three seconds after the holder’s last interaction', async () => {
			const rig = await ownRig();
			try {
				rig.scroll(0.5);
				expect(rig.pcScroller.scrollTop).toBe(3500);
				rig.pcWheel();
				rig.scroll(0.75);
				expect(rig.pcScroller.scrollTop).toBe(3500); // still main’s panel
				rig.advance(3001);
				rig.scroll(0.75);
				expect(rig.pcScroller.scrollTop).toBe(5250);
				expect(rig.owns().at(-1)).toMatchObject({ to: '*', who: 'remote/5', name: 'phone-portrait' });
			} finally {
				rig.stop();
			}
		});

		it('a non-owner’s tap still replays during the lease, and does not take ownership', async () => {
			const rig = await ownRig();
			try {
				rig.pcWheel();
				rig.pc.receive({ k: 'ptr', from: 'remote/5', w: viewStream('graph'), ev: 'down', b: 0, m: 0, d: 1, i: rig.rowId(), fx: 0.5, fy: 0.5 });
				rig.pc.receive({ k: 'ptr', from: 'remote/5', w: viewStream('graph'), ev: 'up', b: 0, m: 0, d: 1, i: rig.rowId(), fx: 0.5, fy: 0.5 });
				expect(rig.clicks()).toBe(1);
				// The click was not a scroll: main still holds, and the next scroll still drops.
				rig.scroll(0.5);
				expect(rig.pcScroller.scrollTop).toBe(0);
				expect(rig.owns().at(-1)).toMatchObject({ who: 'main' });
			} finally {
				rig.stop();
			}
		});

		it('the PC user’s wheel takes the panel back from a scrolling remote', async () => {
			const rig = await ownRig();
			try {
				rig.scroll(0.5);
				expect(rig.pcScroller.scrollTop).toBe(3500);
				rig.pcWheel();
				rig.scroll(0.75);
				expect(rig.pcScroller.scrollTop).toBe(3500); // the remote cannot yank the PC’s view
			} finally {
				rig.stop();
			}
		});

		it('the follow hint pill names the owner and clears when the ownership comes home', async () => {
			const host = document.createElement('div');
			host.className = 'webview-copy';
			document.body.appendChild(host);
			const hint = mountScrollHint(host, 'remote/5');
			hint.receive({ k: 'own', to: 'remote/5', w: 'view:graph', who: 'main', name: 'PC', ms: 3000 });
			const pill = host.querySelector<HTMLElement>('.scroll-follow-hint')!;
			expect(pill.textContent).toBe('Scrolling follows the PC');
			hint.receive({ k: 'own', to: '*', w: 'view:graph', who: 'remote/9', name: 'tablet-landscape', ms: 3000 });
			expect(host.querySelector('.scroll-follow-hint')!.textContent).toBe('Scrolling follows a tablet');
			hint.receive({ k: 'own', to: '*', w: 'view:graph', who: 'remote/5', name: '', ms: 3000 });
			expect(host.querySelector('.scroll-follow-hint')).toBeNull();
			hint.dispose();
			host.remove();
		});
	});
});
