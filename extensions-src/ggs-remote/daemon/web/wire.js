// The daemon pages' slice of ggs-remote/1 (docs/ggs-remote-plan.md §6): the 20-byte frame
// header and just enough MessagePack for the control messages the window picker exchanges
// (maps, arrays, strings, numbers, booleans, nil, bin). The workbench's full codec is
// src/remote/frame.ts; both are held to the same test vectors.

export const T = {
	HELLO: 0x01, HELLO_ACK: 0x02, WINDOWS: 0x03, ATTACH: 0x04, ATTACHED: 0x05, DETACH: 0x06, SPAWN: 0x07,
	SPAWNED: 0x09, INSTANCE_CLOSE: 0x0a, INSTANCE_RESTART: 0x0b, PING: 0x51, PONG: 0x52, NOTICE: 0x60, CLOSE: 0x7f
};
const ENC_MSGPACK = 2 << 2;
const COMPRESSED = 0x01;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export function encodeMsgpack(value) {
	const out = [];
	const push = (...bytes) => out.push(...bytes);
	const u16 = (n) => push((n >> 8) & 0xff, n & 0xff);
	const u32 = (n) => push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
	const write = (v) => {
		if (v === null || v === undefined) push(0xc0);
		else if (v === false) push(0xc2);
		else if (v === true) push(0xc3);
		else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
			if (v < 0x80) push(v);
			else if (v < 0x100) push(0xcc, v);
			else if (v < 0x10000) { push(0xcd); u16(v); }
			else if (v < 0x100000000) { push(0xce); u32(v); }
			else { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, v); push(0xcb, ...new Uint8Array(view.buffer)); }
		} else if (typeof v === 'number') {
			if (Number.isInteger(v) && v >= -32) push(v & 0xff);
			else if (Number.isInteger(v) && v >= -0x80000000) { push(0xd2); u32(v >>> 0); }
			else { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, v); push(0xcb, ...new Uint8Array(view.buffer)); }
		} else if (typeof v === 'string') {
			const bytes = utf8.encode(v);
			if (bytes.length < 32) push(0xa0 | bytes.length);
			else if (bytes.length < 0x100) push(0xd9, bytes.length);
			else if (bytes.length < 0x10000) { push(0xda); u16(bytes.length); }
			else { push(0xdb); u32(bytes.length); }
			push(...bytes);
		} else if (Array.isArray(v)) {
			if (v.length < 16) push(0x90 | v.length);
			else { push(0xdc); u16(v.length); }
			v.forEach(write);
		} else if (v instanceof Uint8Array) {
			if (v.length < 0x100) push(0xc4, v.length);
			else { push(0xc6); u32(v.length); }
			push(...v);
		} else {
			const entries = Object.entries(v).filter(([, x]) => x !== undefined);
			if (entries.length < 16) push(0x80 | entries.length);
			else { push(0xde); u16(entries.length); }
			for (const [k, x] of entries) { write(k); write(x); }
		}
	};
	write(value);
	return new Uint8Array(out);
}

export function decodeMsgpack(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let at = 0;
	const str = (n) => { const s = fromUtf8.decode(bytes.subarray(at, at + n)); at += n; return s; };
	const arr = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(read()); return a; };
	const map = (n) => { const m = {}; for (let i = 0; i < n; i++) { const k = read(); m[k] = read(); } return m; };
	const bin = (n) => { const b = bytes.slice(at, at + n); at += n; return b; };
	function read() {
		const b = bytes[at++];
		if (b < 0x80) return b;
		if (b >= 0xe0) return b - 0x100;
		if ((b & 0xf0) === 0x80) return map(b & 0x0f);
		if ((b & 0xf0) === 0x90) return arr(b & 0x0f);
		if ((b & 0xe0) === 0xa0) return str(b & 0x1f);
		let n;
		switch (b) {
			case 0xc0: return null;
			case 0xc2: return false;
			case 0xc3: return true;
			case 0xc4: n = bytes[at]; at += 1; return bin(n);
			case 0xc5: n = view.getUint16(at); at += 2; return bin(n);
			case 0xc6: n = view.getUint32(at); at += 4; return bin(n);
			case 0xca: n = view.getFloat32(at); at += 4; return n;
			case 0xcb: n = view.getFloat64(at); at += 8; return n;
			case 0xcc: return bytes[at++];
			case 0xcd: n = view.getUint16(at); at += 2; return n;
			case 0xce: n = view.getUint32(at); at += 4; return n;
			case 0xcf: n = Number(view.getBigUint64(at)); at += 8; return n;
			case 0xd0: n = view.getInt8(at); at += 1; return n;
			case 0xd1: n = view.getInt16(at); at += 2; return n;
			case 0xd2: n = view.getInt32(at); at += 4; return n;
			case 0xd3: n = Number(view.getBigInt64(at)); at += 8; return n;
			case 0xd9: n = bytes[at]; at += 1; return str(n);
			case 0xda: n = view.getUint16(at); at += 2; return str(n);
			case 0xdb: n = view.getUint32(at); at += 4; return str(n);
			case 0xdc: n = view.getUint16(at); at += 2; return arr(n);
			case 0xdd: n = view.getUint32(at); at += 4; return arr(n);
			case 0xde: n = view.getUint16(at); at += 2; return map(n);
			case 0xdf: n = view.getUint32(at); at += 4; return map(n);
			default: throw new Error(`msgpack: unsupported byte 0x${b.toString(16)}`);
		}
	}
	return read();
}

export function encodeFrame(type, body, stream = 0) {
	const payload = body === undefined ? new Uint8Array(0) : encodeMsgpack(body);
	const out = new Uint8Array(20 + payload.length);
	const view = new DataView(out.buffer);
	out[0] = type;
	out[1] = body === undefined ? 0 : ENC_MSGPACK;
	view.setUint32(8, stream, true);
	view.setUint32(16, payload.length, true);
	out.set(payload, 20);
	return out;
}

/** Every frame of one message (the daemon may pack several). Compressed control frames do not
 *  occur on the picker's link (it never declares deflate), so they are skipped. */
export function decodeFrames(buffer) {
	const bytes = new Uint8Array(buffer);
	const view = new DataView(buffer);
	const frames = [];
	for (let at = 0; at + 20 <= bytes.length;) {
		const len = view.getUint32(at + 16, true);
		const flags = bytes[at + 1];
		const payload = bytes.subarray(at + 20, at + 20 + len);
		frames.push({
			type: bytes[at],
			flags,
			stream: view.getUint32(at + 8, true),
			seq: view.getUint32(at + 12, true),
			body: (flags & 0x0c) === ENC_MSGPACK && !(flags & COMPRESSED) && len > 0 ? decodeMsgpack(payload) : null
		});
		at += 20 + len;
	}
	return frames;
}
