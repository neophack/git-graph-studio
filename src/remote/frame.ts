// The ggs-remote/1 frame (docs/ggs-remote-plan.md §6.1–§6.2), the browser's copy of
// the daemon's own frame codec (its src/ws/frame.rs): a 20-byte little-endian header plus a
// payload, one or more frames per WebSocket message. Both are held to the same test vectors
// (daemon/tests/vectors/frames.json). Used by the remote workbench's transport and by the
// Relay page inside the instance.
import { decode as decodeMsgpack, encode as encodeMsgpack } from '@msgpack/msgpack';

export const HEADER_LEN = 20;
export const MAX_PAYLOAD = 1 << 20;
/** Payloads below this size are never compressed (§6.1). The mirror's op batches are the
 *  plentiful small frames of a remote session, and DOM JSON collapses 4–8× — the threshold
 *  sits low enough to catch them (2026-10-13, the wire-economy pass). */
export const COMPRESS_THRESHOLD = 256;

/** Frame types (§6.2). */
export const T = {
	HELLO: 0x01,
	HELLO_ACK: 0x02,
	WINDOWS: 0x03,
	ATTACH: 0x04,
	ATTACHED: 0x05,
	DETACH: 0x06,
	SPAWN: 0x07,
	SESSION_END: 0x08,
	SPAWNED: 0x09,
	INSTANCE_CLOSE: 0x0a,
	INSTANCE_RESTART: 0x0b,
	INVOKE: 0x10,
	RESULT: 0x11,
	CANCEL: 0x12,
	CHAN_DATA: 0x20,
	CHAN_CLOSE: 0x21,
	LISTEN: 0x30,
	UNLISTEN: 0x31,
	EVENT: 0x32,
	EMIT: 0x33,
	FETCH: 0x40,
	FETCH_DATA: 0x41,
	UPLOAD: 0x42,
	UPLOAD_ACK: 0x43,
	CREDIT: 0x50,
	PING: 0x51,
	PONG: 0x52,
	NOTICE: 0x60,
	CLOSE: 0x7f
} as const;

export const FLAG = { COMPRESSED: 0x01, FIN: 0x02, ERROR: 0x10, MORE: 0x20 } as const;

export enum Enc {
	Raw = 0,
	Json = 1,
	Msgpack = 2
}

export interface Frame {
	type: number;
	flags: number;
	session: number;
	stream: number;
	seq: number;
	payload: Uint8Array;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export function encOf(frame: Frame): Enc {
	return ((frame.flags & 0x0c) >> 2) as Enc;
}

export function makeFrame(type: number, enc: Enc, payload: Uint8Array | string = new Uint8Array(0), stream = 0, extraFlags = 0, session = 0): Frame {
	return {
		type,
		flags: (enc << 2) | extraFlags,
		session,
		stream,
		seq: 0,
		payload: typeof payload === 'string' ? utf8.encode(payload) : payload
	};
}

export function msgpackFrame(type: number, body: unknown, stream = 0): Frame {
	return makeFrame(type, Enc.Msgpack, encodeMsgpack(body), stream);
}

export function jsonFrame(type: number, body: unknown, stream = 0, extraFlags = 0, session = 0): Frame {
	return makeFrame(type, Enc.Json, JSON.stringify(body ?? null), stream, extraFlags, session);
}

export function encodeFrames(frames: Frame[]): Uint8Array {
	const total = frames.reduce((n, f) => n + HEADER_LEN + f.payload.length, 0);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	let at = 0;
	for (const f of frames) {
		out[at] = f.type;
		out[at + 1] = f.flags;
		view.setUint32(at + 4, f.session >>> 0, true);
		view.setUint32(at + 8, f.stream >>> 0, true);
		view.setUint32(at + 12, f.seq >>> 0, true);
		view.setUint32(at + 16, f.payload.length, true);
		out.set(f.payload, at + HEADER_LEN);
		at += HEADER_LEN + f.payload.length;
	}
	return out;
}

export function encodeFrame(frame: Frame): Uint8Array {
	return encodeFrames([frame]);
}

/** Every frame of one WebSocket message. Throws on a malformed header. */
export function decodeFrames(data: ArrayBuffer | Uint8Array): Frame[] {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const frames: Frame[] = [];
	let at = 0;
	while (at < bytes.length) {
		if (bytes.length - at < HEADER_LEN) throw new Error('truncated frame');
		if (bytes[at + 2] !== 0 || bytes[at + 3] !== 0) throw new Error('reserved header bytes are not zero');
		const len = view.getUint32(at + 16, true);
		if (len > MAX_PAYLOAD) throw new Error(`frame payload too large (${len})`);
		if (bytes.length - at - HEADER_LEN < len) throw new Error('truncated frame');
		frames.push({
			type: bytes[at],
			flags: bytes[at + 1],
			session: view.getUint32(at + 4, true),
			stream: view.getUint32(at + 8, true),
			seq: view.getUint32(at + 12, true),
			payload: bytes.slice(at + HEADER_LEN, at + HEADER_LEN + len)
		});
		at += HEADER_LEN + len;
	}
	return frames;
}

export function frameText(frame: Frame): string {
	return fromUtf8.decode(frame.payload);
}

export function frameJson<T = unknown>(frame: Frame): T {
	return JSON.parse(frameText(frame)) as T;
}

export function frameMsgpack<T = unknown>(frame: Frame): T {
	return decodeMsgpack(frame.payload) as T;
}

/** Whether the browser can speak compressed frames. With the fflate fallback below the
 *  answer is yes on every supported browser (§10.1's floor), so HELLO's `caps.deflate`
 *  advertises it unconditionally — the codec picks the platform streams when present and
 *  the fallback bundle otherwise (C0, §10.2 item 1). */
export function canDeflate(): boolean {
	return true;
}

/** One payload codec: the platform's `CompressionStream('deflate-raw')` when it exists
 *  (Chrome 103+, Firefox 113+, Safari 16.4+), else a lazily imported fflate (~8 KB gz) —
 *  fflate's `deflate`/`inflate` are raw DEFLATE with no zlib wrapper, byte-compatible with
 *  the streams' 'deflate-raw', so both sides of any pair cross-decode (the C0 acceptance
 *  test pins that). */
interface PayloadCodec {
	deflate(data: Uint8Array): Promise<Uint8Array>;
	inflate(data: Uint8Array): Promise<Uint8Array>;
}

const nativeCodec: PayloadCodec | null =
	typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
		? {
			async deflate(data) {
				return pump(new CompressionStream('deflate-raw' as CompressionFormat), data);
			},
			async inflate(data) {
				return pump(new DecompressionStream('deflate-raw' as CompressionFormat), data);
			}
		}
		: null;

let fallbackCodec: Promise<PayloadCodec> | null = null;

function codec(): Promise<PayloadCodec> {
	if (nativeCodec) return Promise.resolve(nativeCodec);
	return (fallbackCodec ??= import('fflate').then((fflate) => ({
		async deflate(data) {
			return fflate.deflateSync(data);
		},
		async inflate(data) {
			return fflate.inflateSync(data);
		}
	})));
}

async function pump(stream: CompressionStream | DecompressionStream, data: Uint8Array): Promise<Uint8Array> {
	const writer = stream.writable.getWriter();
	void writer.write(data as unknown as BufferSource);
	void writer.close();
	const chunks: Uint8Array[] = [];
	const reader = stream.readable.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value as Uint8Array);
	}
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

export async function inflate(frame: Frame): Promise<Frame> {
	if (!(frame.flags & FLAG.COMPRESSED)) return frame;
	const payload = await (await codec()).inflate(frame.payload);
	return { ...frame, flags: frame.flags & ~FLAG.COMPRESSED, payload };
}

/** Compress a frame's payload when it pays (§6.1): above the threshold, JSON / MessagePack. */
export async function deflate(frame: Frame): Promise<Frame> {
	if (frame.payload.length <= COMPRESS_THRESHOLD || encOf(frame) === Enc.Raw) return frame;
	const payload = await (await codec()).deflate(frame.payload);
	if (payload.length >= frame.payload.length) return frame;
	return { ...frame, flags: frame.flags | FLAG.COMPRESSED, payload };
}

/** Split a payload into MORE fragments of at most `max` bytes (§6.1). */
export function splitFrame(frame: Frame, max = MAX_PAYLOAD): Frame[] {
	if (frame.payload.length <= max) return [frame];
	const parts: Frame[] = [];
	for (let at = 0; at < frame.payload.length; at += max) {
		const last = at + max >= frame.payload.length;
		parts.push({
			...frame,
			flags: last ? frame.flags & ~FLAG.MORE : frame.flags | FLAG.MORE,
			payload: frame.payload.subarray(at, at + max)
		});
	}
	return parts;
}

/** Joins MORE fragment chains, keyed by session, stream and type. */
export class Reassembler {
	private partial = new Map<string, Uint8Array[]>();

	push(frame: Frame): Frame | null {
		const key = `${frame.session}:${frame.stream}:${frame.type}`;
		const more = (frame.flags & FLAG.MORE) !== 0;
		const chain = this.partial.get(key);
		if (!chain && !more) return frame;
		const parts = chain ?? [];
		parts.push(frame.payload);
		if (more) {
			this.partial.set(key, parts);
			return null;
		}
		this.partial.delete(key);
		const payload = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			payload.set(p, at);
			at += p.length;
		}
		return { ...frame, flags: frame.flags & ~FLAG.MORE, payload };
	}

	dropSession(session: number): void {
		for (const key of [...this.partial.keys()]) if (key.startsWith(`${session}:`)) this.partial.delete(key);
	}
}

/** The binary-INVOKE body (§6.3): u16 header length, a MessagePack `{c, h}`, then the bytes. */
export function encodeRawInvoke(cmd: string, body: Uint8Array, headers?: Record<string, string>): Uint8Array {
	const head = encodeMsgpack(headers ? { c: cmd, h: headers } : { c: cmd });
	const out = new Uint8Array(2 + head.length + body.length);
	new DataView(out.buffer).setUint16(0, head.length, true);
	out.set(head, 2);
	out.set(body, 2 + head.length);
	return out;
}

export function decodeRawInvoke(payload: Uint8Array): { c: string; h?: Record<string, string>; body: Uint8Array } {
	const len = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0, true);
	const head = decodeMsgpack(payload.subarray(2, 2 + len)) as { c: string; h?: Record<string, string> };
	return { ...head, body: payload.slice(2 + len) };
}

/** The placeholder a shimmed `Channel` serializes to; the Relay swaps in a real one (§6.3). */
export const CHANNEL_PREFIX = '__GGS_CHAN__:';
