// Regenerates tests/vectors/frames.json — the ggs-remote/1 frame vectors the daemon
// (src/ws/frame.rs), the daemon pages (web/wire.js) and the workbench (src/remote/frame.ts)
// are all tested against. Run: node tests/vectors/generate-frames.mjs (from daemon/).
// The bytes are built by hand from the header layout (§6.1), not by any of the codecs under
// test; MessagePack payloads come from web/wire.js's encoder, which the Rust and TypeScript
// decoders must read back to the same value.
import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { encodeMsgpack } from '../../web/wire.js';

const ENC = { raw: 0, json: 1, msgpack: 2 };
const FLAG = { compressed: 0x01, fin: 0x02, error: 0x10, more: 0x20 };

function header(type, flags, session, stream, seq, len) {
	const out = Buffer.alloc(20);
	out[0] = type;
	out[1] = flags;
	out.writeUInt32LE(session, 4);
	out.writeUInt32LE(stream, 8);
	out.writeUInt32LE(seq, 12);
	out.writeUInt32LE(len, 16);
	return out;
}

function frame({ type, enc = 'raw', extra = 0, session = 0, stream = 0, seq = 0, payload = Buffer.alloc(0), compress = false }) {
	let body = Buffer.from(payload);
	let flags = (ENC[enc] << 2) | extra;
	if (compress) {
		body = deflateRawSync(body);
		flags |= FLAG.compressed;
	}
	return { bytes: Buffer.concat([header(type, flags, session, stream, seq, body.length), body]), flags };
}

const vectors = [];
function add(name, specs, describe) {
	const built = specs.map(frame);
	vectors.push({
		name,
		hex: Buffer.concat(built.map((b) => b.bytes)).toString('hex'),
		frames: specs.map((spec, i) => ({
			type: spec.type,
			flags: built[i].flags,
			session: spec.session ?? 0,
			stream: spec.stream ?? 0,
			seq: spec.seq ?? 0,
			...describe(spec, i)
		}))
	});
}

const text = (spec) => ({ payloadText: Buffer.from(spec.payload).toString('utf8') });
const msgpackOf = (value) => ({ payload: Buffer.from(encodeMsgpack(value)), enc: 'msgpack' });

const hello = { proto: 1, client: 'web', ver: '0.1.10', caps: { deflate: true, sw: false, clipboard: true }, formFactor: 'phone', dataSaver: false, csrf: 'abc' };
add('hello', [{ type: 0x01, ...msgpackOf(hello) }], () => ({ payloadMsgpack: hello }));

const invoke = '{"c":"list_dir","a":{"path":"C:/repo"}}';
add('invoke-json', [{ type: 0x10, enc: 'json', stream: 3, payload: Buffer.from(invoke) }], text);

add('result-error', [{ type: 0x11, enc: 'json', extra: FLAG.error, stream: 3, seq: 7, payload: Buffer.from('{"message":"no such file"}') }], text);

const big = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => `line ${i}`) });
add('chan-data-compressed', [{ type: 0x20, enc: 'json', stream: 5, seq: 8, payload: Buffer.from(big), compress: true }], () => ({ payloadText: big }));

add('relay-session', [{ type: 0x10, enc: 'json', session: 42, stream: 9, payload: Buffer.from('{"c":"boot_stage","a":{}}') }], text);

const windows = { instances: [{ id: 'ggs-1234', title: 'repo', folders: ['C:/repo'], version: '0.1.10', visible: true, remoteSessions: 1, state: 'ok', summary: { tabs: [{ path: 'C:/repo/a.rs', dirty: true, active: true }], terminals: 2, dirty: 1, scmChanges: 3 } }] };
add('windows', [{ type: 0x03, seq: 2, ...msgpackOf(windows) }], () => ({ payloadMsgpack: windows }));

add(
	'packed-keystrokes',
	[
		{ type: 0x10, enc: 'json', stream: 11, payload: Buffer.from('{"c":"pty_write","a":{"id":1,"data":"l"}}') },
		{ type: 0x10, enc: 'json', stream: 13, payload: Buffer.from('{"c":"pty_write","a":{"id":1,"data":"s"}}') },
		{ type: 0x51, stream: 0 }
	],
	(spec) => (spec.payload ? text(spec) : {})
);

add('fragment-head', [{ type: 0x11, enc: 'raw', extra: FLAG.more, stream: 15, seq: 20, payload: Buffer.from('first half|') }], text);

const close = { code: 4401, reason: 'credentials-changed' };
add('close', [{ type: 0x7f, ...msgpackOf(close) }], () => ({ payloadMsgpack: close }));

writeFileSync(new URL('./frames.json', import.meta.url), JSON.stringify(vectors, null, '\t') + '\n');
console.log(`wrote ${vectors.length} vectors`);
