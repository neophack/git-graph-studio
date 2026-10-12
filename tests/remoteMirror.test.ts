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
import { isSpecialKey } from '../src/remote/mirror/viewerInput';
import { isPhoneWidth, modeUrl, requestedMode, wantsOwnUi } from '../src/remote/mirror/uiMode';
import { enterPhone, leavePhone } from '../src/remote/mirror/phoneShell';
import { coarsePointer } from '../src/remote/responsive';
import { APP_TOKEN, GGS_TOKEN, canonicalize, canonicalizeCss, localizeTokens, panelStream, viewStream, type DownMessage, type MirrorOp, type UpMessage } from '../src/remote/mirror/protocol';
import { parseStream, setWebviewFrameSource } from '../src/remote/mirror/webviewFrames';

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

	it('sizes a hidden PC window to the viewer: a phone 1:1, wider screens never below the desktop minimum', () => {
		expect(fitFor(1600, 900)).toEqual({ width: 1600, height: 900 });
		expect(fitFor(390, 844)).toEqual({ width: 390, height: 844 });
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
		expect(fit).toHaveBeenCalledWith(390, 844);
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

describe('one window, different UIs', () => {
	it('gives a phone its own UI while the PC user has the window on screen', () => {
		expect(isPhoneWidth(390)).toBe(true);
		expect(isPhoneWidth(1280)).toBe(false);
		// The PC keeps the desktop UI, the phone runs the phone app instead of a shrunken copy.
		expect(wantsOwnUi('auto', true, true)).toBe(true);
		// A hidden window is the phone's to lay out: the copy, 1:1.
		expect(wantsOwnUi('auto', true, false)).toBe(false);
		// A desktop browser watches the desktop UI as it is.
		expect(wantsOwnUi('auto', false, true)).toBe(false);
		// The URL forces either mode.
		expect(wantsOwnUi('mirror', true, true)).toBe(false);
		expect(wantsOwnUi('frontend', false, false)).toBe(true);
	});

	it('pins a switch in the URL so a reload keeps it', () => {
		const page = 'https://pc:47615/w/abc/v/1/?frontend=1#x';
		expect(requestedMode(new URL(page).search)).toBe('frontend');
		const live = modeUrl(page, 'mirror');
		expect(requestedMode(new URL(live).search)).toBe('mirror');
		expect(new URL(live).searchParams.has('frontend')).toBe(false);
		expect(requestedMode('')).toBe('auto');
	});

	it('fits the window to its first viewer only and sends the other form factor its own UI', () => {
		document.body.innerHTML = '<p>pc</p>';
		const sent: DownMessage[] = [];
		const fit = vi.fn();
		const host = new MirrorHost(document, { send: (message) => sent.push(message), fit, focus: () => undefined, now: () => 0 });
		host.receive({ k: 'hello', from: 'remote/1', vw: 390, vh: 844, touch: true });
		expect(fit).toHaveBeenLastCalledWith(390, 844);
		// A desktop browser joining a phone-shaped window: no refit, its own workbench.
		host.receive({ k: 'hello', from: 'remote/2', vw: 1440, vh: 900, touch: false });
		expect(fit).toHaveBeenCalledTimes(1);
		expect(sent).toContainEqual({ k: 'own', to: 'remote/2' });
		// A second phone shares the copy.
		host.receive({ k: 'hello', from: 'remote/3', vw: 400, vh: 800, touch: true });
		expect(sent.filter((message) => message.k === 'own')).toHaveLength(1);
		expect(fit).toHaveBeenCalledTimes(1);
		// The owner leaves: the next viewer inherits the window.
		host.receive({ k: 'bye', from: 'remote/1' });
		host.receive({ k: 'bye', from: 'remote/2' });
		expect(fit).toHaveBeenLastCalledWith(400, 800);
	});
});

describe('the phone mode of the PC window', () => {
	it('wears the phone shell while a phone watches, and gives the desktop back after', () => {
		const root = document.documentElement;
		const width = window.innerWidth;
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
		try {
			enterPhone();
			expect(root.hasAttribute('data-remote-shell')).toBe(true);
			expect(root.dataset['formFactor']).toBe('phone');
			// The clicks come from a finger, whatever the PC's own pointer is.
			expect(root.dataset['pointer']).toBe('coarse');
			expect(coarsePointer()).toBe(true);
		} finally {
			Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
			leavePhone();
		}
		expect(root.hasAttribute('data-remote-shell')).toBe(false);
		expect(root.dataset['formFactor']).toBeUndefined();
		expect(root.classList.contains('remote-shell')).toBe(false);
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
});
