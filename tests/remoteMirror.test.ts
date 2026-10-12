// Remote Access, the DOM replica (module 19, docs/ggs-remote-plan.md §22): the PC window's
// recorder against the browser's viewer — the snapshot and every mutation kind landing in
// the copy, URLs crossing as tokens, a sequence gap asking for a fresh snapshot — the
// input replay on the PC (a tap as a full press-release-click, keys and text into the
// focused editable, a select's value), and the host's viewer lifecycle (hello earns a
// snapshot and a fit, a silent viewer is forgotten and the recorder stops with the last).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomRecorder } from '../src/remote/mirror/recorder';
import { MirrorViewer } from '../src/remote/mirror/viewer';
import { InputReplayer, keyCodeFor } from '../src/remote/mirror/replay';
import { MirrorHost, fitFor } from '../src/remote/mirror/host';
import { isSpecialKey } from '../src/remote/mirror/viewerInput';
import { enterPhone, leavePhone } from '../src/remote/mirror/phoneShell';
import { coarsePointer } from '../src/remote/responsive';
import { APP_TOKEN, GGS_TOKEN, canonicalize, canonicalizeCss, localizeTokens, type DownMessage, type MirrorOp, type UpMessage } from '../src/remote/mirror/protocol';

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
