// Remote Access, the browser half (module 19, docs/ggs-remote-plan.md §17.3): the frame
// codec against the daemon's shared vectors, the transport over a fake WebSocket (HELLO /
// ATTACH, invokes, channels, events, credit, batching, close codes), the Tauri shims, and the
// Relay engine that runs inside the instance.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { webcrypto as nodeWebcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import { encode as encodeMsgpack } from '@msgpack/msgpack';
import {
	CHANNEL_PREFIX,
	decodeFrames,
	decodeRawInvoke,
	Enc,
	encodeFrame,
	encodeFrames,
	encodeRawInvoke,
	FLAG,
	type Frame,
	frameJson,
	frameMsgpack,
	frameText,
	jsonFrame,
	makeFrame,
	msgpackFrame,
	Reassembler,
	splitFrame,
	T
} from '../src/remote/frame';
import { Transport, basePathOf, instanceOf } from '../src/remote/transport';
import { RelayEngine } from '../src/remote/relay';
import { scopedStorage } from '../src/remote/storage';
import { withModifier } from '../src/remote/terminalKeys';
import { switcherItems } from '../src/remote/windowSwitcher';
import { setRemoteEnv } from '../src/remote/session';
import { windowedEditThreshold } from '../src/remote/openThreshold';
import { precacheList } from '../src/remote/precache';

const flush = () => new Promise((r) => setTimeout(r, 0));


describe('remote open thresholds', () => {
	it('drops to 512 KB in the remote build and honours the stored override', () => {
		const desktop = 8 * 1024 * 1024;
		document.documentElement.removeAttribute('data-remote-shell');
		expect(windowedEditThreshold(desktop)).toBe(desktop);
		document.documentElement.setAttribute('data-remote-shell', '');
		expect(windowedEditThreshold(desktop)).toBe(512 * 1024);
		localStorage.setItem('ggsr.windowedOpenBytes', String(2 * 1024 * 1024));
		expect(windowedEditThreshold(desktop)).toBe(2 * 1024 * 1024);
		localStorage.setItem('ggsr.windowedOpenBytes', '10'); // below the 64 KB floor
		expect(windowedEditThreshold(desktop)).toBe(512 * 1024);
		localStorage.removeItem('ggsr.windowedOpenBytes');
		document.documentElement.removeAttribute('data-remote-shell');
	});
});

describe('precache manifest', () => {
	it('picks the shell and only its hashed first-paint artifacts', () => {
		const html = [
			'<link rel="stylesheet" href="./theme/dark-modern.css">',
			'<script type="module" src="./assets/remote-hG8utRWo.js"></script>',
			'<link rel="modulepreload" href="./assets/preload-Ct5FWWRu.js">',
			'<link rel="modulepreload" href="./assets/msgpack-C7aVR-nU.js">',
			'<link rel="stylesheet" href="./assets/remote-CADskhhp.css">',
			'<img src="./assets/logo.svg">',
			'<link rel="manifest" href="manifest.webmanifest">'
		].join('');
		expect(precacheList(html)).toEqual([
			'assets/msgpack-C7aVR-nU.js',
			'assets/preload-Ct5FWWRu.js',
			'assets/remote-CADskhhp.css',
			'assets/remote-hG8utRWo.js',
			'remote.html'
		]);
		// The un-hashed theme css and the svg stay out: they revalidate, they do not persist.
	});
});

describe('frame codec', () => {
	it('matches the daemon test vectors', () => {
		const path = resolve(__dirname, '../extensions-src/ggs-remote/daemon/tests/vectors/frames.json');
		const vectors = JSON.parse(readFileSync(path, 'utf8')) as {
			name: string;
			hex: string;
			frames: { type: number; flags: number; session: number; stream: number; seq: number; payloadText?: string; payloadMsgpack?: unknown }[];
		}[];
		expect(vectors.length).toBeGreaterThan(5);
		for (const v of vectors) {
			const bytes = Uint8Array.from(v.hex.match(/../g)!.map((h) => parseInt(h, 16)));
			const frames = decodeFrames(bytes);
			expect(frames.length, v.name).toBe(v.frames.length);
			frames.forEach((frame, i) => {
				const want = v.frames[i];
				expect([frame.type, frame.flags, frame.session, frame.stream, frame.seq], v.name).toEqual([want.type, want.flags, want.session, want.stream, want.seq]);
				if (want.payloadMsgpack !== undefined) expect(frameMsgpack(frame), v.name).toEqual(want.payloadMsgpack);
				if (want.payloadText !== undefined && !(frame.flags & FLAG.COMPRESSED)) expect(frameText(frame), v.name).toBe(want.payloadText);
			});
			// Uncompressed vectors re-encode to the very same bytes.
			if (!frames.some((f) => f.flags & FLAG.COMPRESSED)) expect(Buffer.from(encodeFrames(frames)).toString('hex'), v.name).toBe(v.hex);
		}
	});

	it('rejects malformed headers', () => {
		expect(() => decodeFrames(new Uint8Array([1, 2, 3]))).toThrow(/truncated/);
		const bad = encodeFrame(makeFrame(T.PING, Enc.Raw));
		bad[2] = 1;
		expect(() => decodeFrames(bad)).toThrow(/reserved/);
	});

	it('splits and reassembles large payloads', () => {
		// A 2.5 MB payload is real allocation + three copies; the vm pool on a loaded
		// machine needs more than the default 5 s.
		const payload = new Uint8Array(2_500_000).map((_, i) => i % 251);
		const parts = splitFrame(makeFrame(T.RESULT, Enc.Raw, payload, 9));
		expect(parts.length).toBe(3);
		const joiner = new Reassembler();
		expect(joiner.push(parts[0])).toBeNull();
		expect(joiner.push(parts[1])).toBeNull();
		const whole = joiner.push(parts[2])!;
		expect(whole.payload).toEqual(payload);
		expect(whole.flags & FLAG.MORE).toBe(0);
	}, 30_000);

	it('round-trips the binary invoke body', () => {
		const body = new Uint8Array([1, 2, 3, 250]);
		const decoded = decodeRawInvoke(encodeRawInvoke('fs_write_chunk', body, { 'x-ggs-path': 'a' }));
		expect(decoded.c).toBe('fs_write_chunk');
		expect(decoded.h).toEqual({ 'x-ggs-path': 'a' });
		expect([...decoded.body]).toEqual([1, 2, 3, 250]);
	});
});

describe('workbench URLs', () => {
	it('find the base path and the instance', () => {
		expect(basePathOf('/w/ggs-12/v/0.1.10/remote.html')).toBe('/');
		expect(basePathOf('/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/w/ggs-12/v/0.1.10/remote.html')).toBe('/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/');
		expect(instanceOf('/w/ggs-12/v/0.1.10/remote.html')).toBe('ggs-12');
		expect(instanceOf('/windows')).toBeNull();
	});
});

/** A WebSocket stand-in that records what the transport sends. */
class FakeSocket {
	static OPEN = 1;
	readyState = 0;
	binaryType = 'blob';
	sent: Frame[][] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public url: string) {}
	send(data: Uint8Array) {
		this.sent.push(decodeFrames(data));
	}
	close() {
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	deliver(...frames: Frame[]) {
		const bytes = encodeFrames(frames);
		this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
	}
	frames(): Frame[] {
		return this.sent.flat();
	}
}

let seq = 0;
const down = (frame: Frame): Frame => ({ ...frame, seq: ++seq });

async function connected(navigate = vi.fn()) {
	let socket!: FakeSocket;
	const transport = new Transport({
		basePath: '/',
		instance: 'ggs-1',
		createSocket: (url) => {
			socket = new FakeSocket(url);
			return socket as unknown as WebSocket;
		},
		fetchSession: async () => ({ csrf: 'tok' }),
		navigate
	});
	const attached = transport.connect();
	await flush();
	socket.open();
	await flush();
	const hello = socket.frames().find((f) => f.type === T.HELLO)!;
	expect(frameMsgpack<{ proto: number; csrf: string }>(hello)).toMatchObject({ proto: 1, csrf: 'tok' });
	socket.deliver(down(msgpackFrame(T.HELLO_ACK, { sid: 's1', resumed: false, credit: 1 << 20 })));
	await flush();
	const attach = socket.frames().find((f) => f.type === T.ATTACH)!;
	expect(frameMsgpack(attach)).toEqual({ instance: 'ggs-1' });
	socket.deliver(down(msgpackFrame(T.ATTACHED, { instance: 'ggs-1', version: '0.1.10', assetBase: '/w/ggs-1/v/0.1.10/', ggsBase: '/w/ggs-1/ggs/tok/', frontendId: 'remote/3' })));
	const info = await attached;
	return { transport, socket, info, navigate };
}

describe('transport', () => {
	beforeEach(() => {
		seq = 0;
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	it('connects, says hello and attaches', async () => {
		const { info, socket } = await connected();
		expect(info.frontendId).toBe('remote/3');
		expect(socket.url).toMatch(/^ws:\/\/.*\/ws$/);
	});

	it('invokes and settles results, errors and raw bytes', async () => {
		const { transport, socket } = await connected();
		const ok = transport.call('list_dir', { path: '/repo' });
		const fail = transport.call('read_file', { path: '/nope' });
		const raw = transport.call('read_file_raw', { path: '/a' });
		await new Promise((r) => setTimeout(r, 20));
		const invokes = socket.frames().filter((f) => f.type === T.INVOKE);
		expect(invokes.map((f) => frameJson<{ c: string }>(f).c)).toEqual(['list_dir', 'read_file', 'read_file_raw']);
		expect(new Set(invokes.map((f) => f.stream)).size).toBe(3);
		expect(invokes.every((f) => f.stream % 2 === 1)).toBe(true);
		socket.deliver(
			down(jsonFrame(T.RESULT, ['a.rs'], invokes[0].stream)),
			down(jsonFrame(T.RESULT, { message: 'no such file' }, invokes[1].stream, FLAG.ERROR)),
			down(makeFrame(T.RESULT, Enc.Raw, new Uint8Array([7, 8]), invokes[2].stream))
		);
		await expect(ok).resolves.toEqual(['a.rs']);
		await expect(fail).rejects.toBe('no such file');
		expect([...new Uint8Array((await raw) as ArrayBuffer)]).toEqual([7, 8]);
	});

	it('batches small uplink frames after the first (leading edge, 16 ms)', async () => {
		const { transport, socket } = await connected();
		const before = socket.sent.length;
		void transport.call('pty_write', { id: 1, data: 'l' });
		void transport.call('pty_write', { id: 1, data: 's' });
		void transport.call('pty_write', { id: 1, data: '\r' });
		expect(socket.sent.length).toBe(before + 1);
		await new Promise((r) => setTimeout(r, 30));
		const batch = socket.sent[before + 1];
		expect(batch.length).toBe(2);
		expect(batch.map((f) => frameJson<{ a: { data: string } }>(f).a.data)).toEqual(['s', '\r']);
	});

	it('delivers channel messages and events', async () => {
		const { transport, socket } = await connected();
		const channelMessages: unknown[] = [];
		const stream = transport.allocStream();
		transport.registerChannel(stream, (m) => channelMessages.push(m));
		const events: unknown[] = [];
		const listenStream = transport.listen('studio://git-output', (e) => events.push(e.payload));
		await new Promise((r) => setTimeout(r, 20));
		const listen = socket.frames().find((f) => f.type === T.LISTEN)!;
		expect(frameMsgpack(listen)).toEqual({ event: 'studio://git-output' });
		expect(listen.stream).toBe(listenStream);
		socket.deliver(down(jsonFrame(T.CHAN_DATA, { kind: 'batch', n: 1 }, stream)), down(jsonFrame(T.EVENT, { event: 'studio://git-output', id: 4, payload: 'git status' }, listenStream)));
		await flush();
		expect(channelMessages).toEqual([{ kind: 'batch', n: 1 }]);
		expect(events).toEqual(['git status']);
	});

	it('grants credit every 256 KB consumed', async () => {
		const { socket } = await connected();
		socket.deliver(down(makeFrame(T.EVENT, Enc.Json, new Uint8Array(300 * 1024).fill(32), 99)));
		await flush();
		const credit = socket.frames().find((f) => f.type === T.CREDIT)!;
		expect(frameMsgpack<{ bytes: number; ackSeq: number }>(credit).bytes).toBeGreaterThanOrEqual(256 * 1024);
	});

	it('says so when the link drops and again when a retry lands', async () => {
		// The workbench must not look merely frozen while the retry loop queues frames:
		// onOffline fires on the drop, onOnline when the resumed link is back.
		const sockets: FakeSocket[] = [];
		const offline: number[] = [];
		const online: number[] = [];
		const handshake = (socket: FakeSocket): void => {
			socket.deliver(down(msgpackFrame(T.HELLO_ACK, { sid: 's1', resumed: false, credit: 1 << 20 })));
			socket.deliver(down(msgpackFrame(T.ATTACHED, { instance: 'ggs-1', version: '0.1.10', assetBase: '/', ggsBase: '/', frontendId: 'remote/1' })));
		};
		const transport = new Transport({
			basePath: '/',
			instance: 'ggs-1',
			createSocket: (url) => {
				const socket = new FakeSocket(url);
				sockets.push(socket);
				setTimeout(() => socket.open(), 0); // the browser's stack would
				return socket as unknown as WebSocket;
			},
			fetchSession: async () => ({ csrf: 'tok' }),
			onOffline: () => offline.push(Date.now()),
			onOnline: () => online.push(Date.now())
		});
		const attached = transport.connect();
		await flush();
		await flush(); // the socket's open timer, then its wiring, land before the frames
		handshake(sockets[0]!);
		await attached;
		expect(offline).toEqual([]);

		// The link dies without a terminal verdict: the banner hook fires at once, the
		// retry (first wait ~500 ms) opens a fresh socket and handshakes it again.
		sockets[0]!.onclose?.({ code: 1006, reason: '' });
		await flush();
		expect(offline).toHaveLength(1);
		await new Promise((r) => setTimeout(r, 700));
		await flush(); // the retry's socket opened and wired in the meantime
		handshake(sockets[1]!);
		await new Promise((r) => setTimeout(r, 50));
		expect(online).toHaveLength(1);
		expect(sockets).toHaveLength(2);
	});

	it('sends the browser to login on 4401 and to the picker on 4410', async () => {
		const first = await connected();
		first.socket.deliver(down(msgpackFrame(T.CLOSE, { code: 4410, reason: 'instance-exited' })));
		await flush();
		expect(first.navigate).toHaveBeenCalledWith('picker', 'instance-exited');
		const second = await connected();
		second.socket.onclose?.({ code: 4401, reason: 'credentials-changed' });
		expect(second.navigate).toHaveBeenCalledWith('login', 'credentials-changed');
	});

	it('pushes WINDOWS and notices to the shell', async () => {
		const { transport, socket } = await connected();
		const lists: unknown[] = [];
		const notices: unknown[] = [];
		transport.onWindows((l) => lists.push(l));
		transport.onNotice((n) => notices.push(n));
		socket.deliver(down(msgpackFrame(T.WINDOWS, { instances: [{ id: 'ggs-1', title: 'repo' }] })), down(msgpackFrame(T.NOTICE, { kind: 'close-blocked', instance: 'ggs-1', dirty: ['a.rs'] })));
		await flush();
		expect(lists).toEqual([[{ id: 'ggs-1', title: 'repo' }]]);
		expect(notices).toEqual([{ kind: 'close-blocked', instance: 'ggs-1', dirty: ['a.rs'] }]);
	});
});

describe('tauri shims', () => {
	it('route invoke and Channel through the transport', async () => {
		vi.stubGlobal('WebSocket', FakeSocket);
		const { transport, socket, info } = await connected();
		setRemoteEnv({ transport, attached: info, basePath: '/' });
		const core = await import('../src/remote/tauriShim/core');
		const channel = new core.Channel<{ n: number }>();
		const got: unknown[] = [];
		channel.onmessage = (m) => got.push(m);
		expect(JSON.stringify({ onEvent: channel })).toBe(`{"onEvent":"${CHANNEL_PREFIX}${channel.id}"}`);
		const result = core.invoke('search_start', { onEvent: channel });
		await new Promise((r) => setTimeout(r, 20));
		const invoke = socket.frames().filter((f) => f.type === T.INVOKE).pop()!;
		expect(frameJson<{ a: { onEvent: string } }>(invoke).a.onEvent).toBe(`${CHANNEL_PREFIX}${channel.id}`);
		socket.deliver(down(jsonFrame(T.CHAN_DATA, { n: 1 }, channel.id)), down(jsonFrame(T.RESULT, null, invoke.stream)));
		await expect(result).resolves.toBeNull();
		expect(got).toEqual([{ n: 1 }]);
		// Absolute: the URL lands in srcdoc webviews, where a root-relative one became file:///.
		expect(core.convertFileSrc('pkg-1.0.0', 'ggs')).toBe(`${location.origin}/w/ggs-1/ggs/tok/pkg-1.0.0`);
		setRemoteEnv(undefined);
	});
});

describe('relay engine', () => {
	function engine() {
		const sent: Frame[] = [];
		const listeners = new Map<string, (e: { event: string; id: number; payload: unknown }) => void>();
		const every: [string, (e: { event: string; id: number; payload: unknown }) => void][] = [];
		const unlistened: string[] = [];
		const channels: { onmessage: (m: unknown) => void }[] = [];
		const invoke = vi.fn(async (cmd: string, args?: unknown) => {
			if (cmd === 'fail') throw 'boom';
			if (cmd === 'raw') return new Uint8Array([1, 2]).buffer;
			return { cmd, args };
		});
		const relay = new RelayEngine({
			invoke: invoke as never,
			listen: (async (event: string, handler: (e: { event: string; id: number; payload: unknown }) => void) => {
				listeners.set(event, handler);
				every.push([event, handler]);
				return () => unlistened.push(event);
			}) as never,
			emit: vi.fn(async () => undefined) as never,
			emitTo: vi.fn(async () => undefined) as never,
			createChannel: (onmessage) => {
				const channel = { onmessage };
				channels.push(channel);
				return channel as never;
			},
			send: (bytes) => sent.push(...decodeFrames(bytes)),
			bufferedAmount: () => 0
		});
		/** Fire an event at every subscription (each session's own listener). */
		const fire = (event: string, payload: unknown) => {
			for (const [name, handler] of every) if (name === event) handler({ event, id: 1, payload });
		};
		return { relay, sent, listeners, unlistened, channels, invoke, fire };
	}

	it('runs invokes with revived channels and answers on the same session', async () => {
		const { relay, sent, channels, invoke } = engine();
		relay.receive(encodeFrame(jsonFrame(T.INVOKE, { c: 'search_start', a: { query: 'x', onEvent: `${CHANNEL_PREFIX}7` } }, 5, 0, 42)));
		await new Promise((r) => setTimeout(r, 10));
		expect(invoke).toHaveBeenCalledWith('search_start', expect.objectContaining({ query: 'x' }), { headers: { 'x-ggs-frontend': 'remote/42' } });
		const args = invoke.mock.calls[0][1] as { onEvent: unknown };
		expect(args.onEvent).toBe(channels[0]);
		channels[0].onmessage({ batch: 1 });
		const result = sent.find((f) => f.type === T.RESULT)!;
		expect([result.session, result.stream]).toEqual([42, 5]);
		const data = sent.find((f) => f.type === T.CHAN_DATA)!;
		expect([data.session, data.stream]).toEqual([42, 7]);
		expect(frameJson(data)).toEqual({ batch: 1 });
	});

	it('reports errors with the ERROR bit and raw results as RAW', async () => {
		const { relay, sent } = engine();
		relay.receive(encodeFrames([jsonFrame(T.INVOKE, { c: 'fail' }, 1, 0, 2), jsonFrame(T.INVOKE, { c: 'raw' }, 3, 0, 2)]));
		await new Promise((r) => setTimeout(r, 10));
		const error = sent.find((f) => f.stream === 1)!;
		expect(error.flags & FLAG.ERROR).toBeTruthy();
		expect(frameJson(error)).toEqual({ message: 'boom' });
		const raw = sent.find((f) => f.stream === 3)!;
		expect([...raw.payload]).toEqual([1, 2]);
	});

	it('forwards events, routes host requests to one session and ends sessions', async () => {
		const { relay, sent, listeners, unlistened, invoke } = engine();
		relay.receive(encodeFrame({ ...msgpackFrame(T.LISTEN, { event: 'ext-host-request' }, 9), session: 1 }));
		await new Promise((r) => setTimeout(r, 5));
		relay.receive(encodeFrame({ ...msgpackFrame(T.LISTEN, { event: 'ext-host-request' }, 11), session: 2 }));
		await new Promise((r) => setTimeout(r, 5));
		const handler = listeners.get('ext-host-request')!;
		handler({ event: 'ext-host-request', id: 1, payload: { frontend: 'remote', method: 'x' } });
		handler({ event: 'ext-host-request', id: 2, payload: { frontend: 'main', method: 'y' } });
		const events = sent.filter((f) => f.type === T.EVENT);
		// One delivery: the most recently attached session, and never a desktop-addressed one.
		expect(events.length).toBe(1);
		expect(events[0].session).toBe(2);
		relay.receive(encodeFrame({ ...makeFrame(T.SESSION_END, Enc.Raw), session: 2 }));
		await new Promise((r) => setTimeout(r, 5));
		expect(unlistened).toContain('ext-host-request');
		expect(invoke).toHaveBeenCalledWith('remote_host_frontend_gone', { frontend: 'remote/2' });
		expect(relay.sessionCount()).toBe(1);
	});

	it('hands a session-addressed host request to that session only — two users never cross', async () => {
		// Through a Hub two people are two sessions: the backend addresses what one person's
		// click caused (`remote/<n>`) and only that person's page may answer it.
		const { relay, sent, fire } = engine();
		relay.receive(encodeFrame({ ...msgpackFrame(T.LISTEN, { event: 'ext-host-request' }, 9), session: 1 }));
		await new Promise((r) => setTimeout(r, 5));
		relay.receive(encodeFrame({ ...msgpackFrame(T.LISTEN, { event: 'ext-host-request' }, 11), session: 2 }));
		await new Promise((r) => setTimeout(r, 5));
		fire('ext-host-request', { frontend: 'remote/1', method: 'webview.create' });
		fire('ext-host-request', { frontend: 'remote/2', method: 'webview.create' });
		fire('ext-host-request', { frontend: 'remote/2', method: 'webview.setHtml' });
		// An address whose session already left falls back to the owner (latest attached),
		// so the backend's request is still answered.
		fire('ext-host-request', { frontend: 'remote/9', method: 'notify' });
		fire('ext-host-request', { frontend: 'main', method: 'notify' });
		const delivered = sent.filter((f) => f.type === T.EVENT).map((f) => [f.session, (frameJson(f) as { payload: { method: string } }).payload.method]);
		expect(delivered).toEqual([[1, 'webview.create'], [2, 'webview.create'], [2, 'webview.setHtml'], [2, 'notify']]);
	});

	it('answers the daemon heartbeat', async () => {
		const { relay, sent } = engine();
		relay.receive(encodeFrame(makeFrame(T.PING, Enc.Raw, new Uint8Array(0), 77)));
		await new Promise((r) => setTimeout(r, 5));
		expect(sent.find((f) => f.type === T.PONG)?.stream).toBe(77);
	});

	it('coalesces terminal output', async () => {
		const { relay, sent, listeners } = engine();
		relay.receive(encodeFrame({ ...msgpackFrame(T.LISTEN, { event: 'studio://pty-output-5' }, 13), session: 4 }));
		await new Promise((r) => setTimeout(r, 5));
		const handler = listeners.get('studio://pty-output-5')!;
		for (const chunk of ['a', 'b', 'c']) handler({ event: 'studio://pty-output-5', id: 1, payload: chunk });
		expect(sent.filter((f) => f.type === T.EVENT).length).toBe(0);
		await new Promise((r) => setTimeout(r, 30));
		const events = sent.filter((f) => f.type === T.EVENT);
		expect(events.length).toBe(1);
		expect(frameJson<{ payload: string }>(events[0]).payload).toBe('abc');
	});
});

describe('remote helpers', () => {
	it('scopes storage keys per PC through a Hub', () => {
		const inner = window.localStorage;
		inner.clear();
		inner.setItem('other', '1');
		const scoped = scopedStorage(inner, '/u/abc/');
		scoped.setItem('layout', 'x');
		expect(inner.getItem('u:/u/abc/:layout')).toBe('x');
		expect(scoped.getItem('layout')).toBe('x');
		expect(scoped.length).toBe(1);
		scoped.clear();
		expect(inner.getItem('other')).toBe('1');
	});

	it('applies the sticky terminal modifiers', () => {
		expect(withModifier('c', 'ctrl')).toBe(String.fromCharCode(3));
		expect(withModifier('x', 'alt')).toBe(`${String.fromCharCode(27)}x`);
		expect(withModifier('x', null)).toBe('x');
	});

	it('lists the windows with summaries and the new-window entry', () => {
		const items = switcherItems(
			[
				{ id: 'a', title: 'repo', folders: ['/r'], version: '1', visible: true, remoteSessions: 1, startedAt: 0, state: 'ok', summary: { tabs: [{ path: '/r/a.rs', dirty: true, active: true }], dirty: 1, terminals: 2, scmChanges: 3 } },
				{ id: 'b', title: '', folders: [], version: '1', visible: false, remoteSessions: 0, startedAt: 0, state: 'unresponsive' }
			],
			'a'
		);
		expect(items.map((i) => i.value)).toEqual(['w:a', 'w:b', '\u0000new']);
		expect(items[0].detail).toContain('/r/a.rs');
		expect(items[1].icon).toBe('warning');
	});

	it('encodes control frames the daemon decodes (msgpack maps with string keys)', () => {
		const frame = msgpackFrame(T.SPAWN, { folder: '/repo', visible: false });
		expect([...frame.payload]).toEqual([...encodeMsgpack({ folder: '/repo', visible: false })]);
		expect(frame.flags).toBe(Enc.Msgpack << 2);
	});
});

describe('end-to-end encryption (the browser twin against the daemon vectors)', () => {
	// The committed vectors (daemon/tests/vectors/e2e.json, written by e2e.rs's ignored
	// generator) hold the Rust side's answers; every assertion here is the browser twin
	// reproducing them byte-for-byte — the two halves are one protocol.
	const vectors = JSON.parse(readFileSync(resolve(__dirname, '../extensions-src/ggs-remote/daemon/tests/vectors/e2e.json'), 'utf8')) as Record<string, string>;
	// jsdom ships no WebCrypto; Node's is the same standard.
	const subtle = (globalThis.crypto?.subtle ?? nodeWebcrypto.subtle) as SubtleCrypto;

	it('derives the same conversation key from the same seeds', async () => {
		const { ephemeral, sharedWith, conversationKey, decodeBase64 } = await import('../src/remote/e2e');
		const eph = ephemeral(decodeBase64(vectors.browserSeed!));
		expect(encodeB64(eph.public)).toBe(vectors.browserPub);
		const shared = sharedWith(eph.secret, decodeBase64(vectors.xPub!));
		expect(encodeB64(shared)).toBe(vectors.shared);
		const key = conversationKey(shared, eph.public, decodeBase64(vectors.xPub!));
		expect(encodeB64(key)).toBe(vectors.conversationKey);
	});

	it('verifies the signed parameters and rejects substitution', async () => {
		const { verifyParams, uuidFor, decodeBase64 } = await import('../src/remote/e2e');
		const edPub = decodeBase64(vectors.edPub!);
		expect(await uuidFor(edPub, subtle)).toBe(vectors.uuid);
		expect(await verifyParams({ edPub: vectors.edPub!, xPub: vectors.xPub!, sig: vectors.sig! }, vectors.uuid, subtle)).not.toBeNull();
		// A swapped X25519 half breaks the signature; a swapped Ed25519 half breaks the uuid.
		const wrong = { edPub: vectors.edPub!, xPub: encodeB64(decodeBase64(vectors.xPub!).map((b) => b ^ 1)), sig: vectors.sig! };
		expect(await verifyParams(wrong, vectors.uuid, subtle)).toBeNull();
		const wrongId = { edPub: encodeB64(edPub.map((b) => b ^ 1)), xPub: vectors.xPub!, sig: vectors.sig! };
		expect(await verifyParams(wrongId, vectors.uuid, subtle)).toBeNull();
	});

	it('opens what the daemon sealed, seals to the same bytes, and rides the envelope', async () => {
		const { ephemeral, sharedWith, conversationKey, open, seal, wrapFrame, unwrapFrame, decodeBase64 } = await import('../src/remote/e2e');
		const eph = ephemeral(decodeBase64(vectors.browserSeed!));
		const key = conversationKey(sharedWith(eph.secret, decodeBase64(vectors.xPub!)), eph.public, decodeBase64(vectors.xPub!));
		const nonce = decodeBase64(vectors.nonce!);
		const frame = decodeBase64(vectors.frame!);
		// Open the Rust-sealed box…
		const opened = await open(key, decodeBase64(vectors.sealed!), nonce, subtle);
		expect(encodeB64(opened!)).toBe(vectors.frame);
		// …seal the same plaintext to the same bytes (GCM is deterministic)…
		const sealed = await seal(key, frame, nonce, subtle);
		expect(encodeB64(sealed)).toBe(vectors.sealed);
		// …and ride the frame envelope both ways.
		const wrapped = await wrapFrame(frame, key, nonce, subtle);
		expect(encodeB64(wrapped)).toBe(vectors.envelope);
		const unwrapped = await unwrapFrame(decodeBase64(vectors.envelope!), key, subtle);
		expect(encodeB64(unwrapped!)).toBe(vectors.frame);
		// The wrong key opens nothing.
		expect(await unwrapFrame(decodeBase64(vectors.envelope!), new Uint8Array(32), subtle)).toBeNull();
	});
});

function encodeB64(bytes: Uint8Array): string {
	let raw = '';
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
