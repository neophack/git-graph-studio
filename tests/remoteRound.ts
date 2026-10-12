// §17.3's remote round for the sweeps (docs/ggs-remote-plan.md): the same scripted backend,
// but every invoke the workbench makes crosses the remote wire first — the tauriShim's
// `invoke`, a Transport over a fake WebSocket, the frame codec, and the RelayEngine — before
// it reaches the handler map the desktop round answers from. What the round proves is the
// layer under the workbench: commands behave identically when their calls ride the wire.
//
// The form factors: 'tablet' keeps the desktop menu surfaces (the full sweep runs there);
// 'phone' swaps menus for sheets — the sweeps' desktop-shaped assertions do not all hold
// there, so phone stays the responsive suites' ground (tests/remoteResponsive.test.ts) and
// this helper only marks it for the flows that branch on the marker.
//
// The sweep runs no daemon, so the one HTTP call the remote workbench makes off-socket —
// the transfer entries' `api/download-ticket` POST — is answered here with a ticket URL:
// a Download click exercises the whole frontend flow, navigation being jsdom's no-op.
import { backend, dispatchScripted } from './tauriMock';
import { T, decodeFrames, encodeFrames, msgpackFrame, type Frame } from '../src/remote/frame';
import { Transport } from '../src/remote/transport';
import { RelayEngine } from '../src/remote/relay';
import { setRemoteEnv } from '../src/remote/session';
import { invoke as shimInvoke } from '../src/remote/tauriShim/core';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The far side of the workbench's WebSocket: bytes up become relay input, relay output
 *  becomes bytes down. */
class WireSocket {
	static OPEN = 1;
	readyState = 0;
	binaryType = 'arraybuffer';
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	toRelay: ((bytes: Uint8Array) => void) | null = null;
	constructor(public url: string) {}
	send(data: Uint8Array) {
		this.toRelay?.(data);
	}
	close() {
		this.readyState = 3;
		this.onclose?.({ code: 1000, reason: '' });
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
}

let previous: (() => void) | null = null;

/** Install the remote round: handshake a Transport against a RelayEngine wired to the
 *  scripted backend, point `backend.wire` at the shim's invoke, and mark the remote shell.
 *  Tears down whatever round came before (the global setup resets the backend per test, so
 *  each test re-installs its own). */
export async function installRemoteRound(formFactor: 'desktop' | 'tablet' | 'phone' = 'desktop'): Promise<void> {
	previous?.();
	previous = null;
	let socket!: WireSocket;
	let seq = 0;
	const down = (frames: Frame[]) => {
		const stamped = frames.map((frame) => ({ ...frame, seq: ++seq }));
		const bytes = encodeFrames(stamped);
		socket.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
	};
	const transport = new Transport({
		basePath: '/',
		instance: 'ggs-sweep',
		createSocket: (url) => {
			socket = new WireSocket(url);
			return socket as unknown as WebSocket;
		},
		fetchSession: async () => ({ csrf: 'sweep' }),
		navigate: () => undefined
	});
	const attached = transport.connect();
	await tick();
	socket.open();
	await tick();
	down([msgpackFrame(T.HELLO_ACK, { sid: 's1', resumed: false, credit: 1 << 20 })]);
	await tick();
	down([msgpackFrame(T.ATTACHED, { instance: 'ggs-sweep', version: '0.1.10', assetBase: '/w/ggs-sweep/v/0.1.10/', ggsBase: '/w/ggs-sweep/ggs/tok/', frontendId: 'remote/9' })]);
	const info = await attached;
	const relay = new RelayEngine({
		invoke: (async (cmd: string, args?: unknown) => {
			return dispatchScripted(cmd, args as Record<string, unknown>);
		}) as never,
		listen: (async () => () => undefined) as never,
		emit: (async () => undefined) as never,
		emitTo: (async () => undefined) as never,
		// The channel the relay hands a handler: pushes must forward down the wire (the
		// daemon-side shape of tauriMock's own Channel).
		createChannel: (forward: (message: unknown) => void) => ({ onmessage: (message: unknown) => forward(message) }) as never,
		send: (bytes: Uint8Array) => down(decodeFrames(bytes)),
		bufferedAmount: () => 0
	});
	socket.toRelay = (bytes) => relay.receive(bytes);
	setRemoteEnv({ transport, attached: info, basePath: '/' });
	// The daemon's only off-socket HTTP endpoint: the download ticket (§11.3).
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).endsWith('api/download-ticket')) {
			return new Response(JSON.stringify({ url: 'w/ggs-sweep/download?t=sweep' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		return realFetch(input, init);
	}) as typeof fetch;
	backend.wireChannel = (channel) => {
		const stream = transport.allocStream();
		transport.registerChannel(stream, (message) => channel.onmessage(message));
		channel.wireStream = stream;
	};
	document.documentElement.setAttribute('data-remote-shell', '');
	document.documentElement.dataset.formFactor = formFactor;
	backend.wire = shimInvoke;
	previous = () => {
		backend.wire = null;
		backend.wireChannel = null;
		globalThis.fetch = realFetch;
		document.documentElement.removeAttribute('data-remote-shell');
		delete document.documentElement.dataset.formFactor;
		try {
			transport.shutdown();
		} catch {
			/* already gone */
		}
	};
}

export function uninstallRemoteRound(): void {
	previous?.();
	previous = null;
}
