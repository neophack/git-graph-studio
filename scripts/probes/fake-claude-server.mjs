// The fake Claude server: a local stand-in for the Anthropic API the claude-code sandbox
// (claude-code-sandbox.mjs) points every model call at — the sandbox's "logged in" account
// is a fake API key, and this server is what answers it, so a conversation inside the app
// costs nothing, touches no network beyond the loopback, and never reads the owner's
// credentials. It speaks the surfaces Claude Code actually calls (verified against the
// extension's bundled CLI 2.1.283): `HEAD /api/hello` (the health/auth probe — the first
// request every session makes), `POST /v1/messages?beta=true` streaming and plain, and
// `POST /v1/messages/count_tokens`. Replies carry the marker `FAKE-CLAUDE` so a harness
// can wait for them in the chat UI, and stream in a few chunks so the streaming UI is
// exercised, not just the final render.
//
// Beyond the API it doubles as the sandbox run's message board (CORS-open — the dev
// harness page posts its report from inside the app, which on macOS has no CDP to read
// it through): `POST /report` stores the last JSON body a probe polls back with
// `GET /report`, and `GET /requests` returns the request log.
//
//   node scripts/probes/fake-claude-server.mjs [--port 9400] [--log <file.jsonl>]
//     [--delay <ms>]       first-token delay, exercising the UI's pending state
//     [--tokens <n>]       reply length in filler sentences past the echoed prompt
//     [--marker <text>]    the reply marker (default "FAKE-CLAUDE")
//
// Prints `listening <port>` on stdout — the sandbox probe waits for that line.

import http from 'node:http';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.indexOf(name) === -1 ? fallback : args[args.indexOf(name) + 1]);
const port = Number(flag('--port', '0'));
const logFile = flag('--log', null);
const firstTokenDelay = Number(flag('--delay', '0'));
const fillerSentences = Number(flag('--tokens', '2'));
const marker = flag('--marker', 'FAKE-CLAUDE');

/** One line per request, to stdout and the optional JSONL file — the proof a sandbox
 * conversation really crossed this server, and the record of everything else Claude
 * Code tried to call (the 404s show which surfaces still phone the real cloud). */
const requests = [];
let report = null;
const logRequest = (entry) => {
	requests.push(entry);
	const line = JSON.stringify(entry);
	console.log(line);
	if (logFile) appendFileSync(logFile, line + '\n');
};

/** The last user text of a messages payload — claude prefixes its own system-reminder
 * blocks into the first user turn, so the typed prompt is the tail. */
const lastUserText = (payload) => {
	const users = (payload?.messages ?? []).filter((m) => m.role === 'user');
	for (let i = users.length - 1; i >= 0; i--) {
		const content = users[i].content;
		const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
		for (let j = blocks.length - 1; j >= 0; j--) {
			if (blocks[j].type === 'text' && (blocks[j].text ?? '').trim()) return blocks[j].text.trim();
		}
	}
	return '(empty prompt)';
};

const replyText = (payload) => {
	const echoed = lastUserText(payload).replace(/\s+/g, ' ').slice(0, 120);
	const filler = Array.from({ length: fillerSentences }, (_, i) =>
		`Filler sentence ${i + 2}: the reply is streamed from the local fake Claude server, not the cloud.`).join(' ');
	return `${marker}: you said "${echoed}". ${filler}`;
};

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = http.createServer(async (req, res) => {
	const started = Date.now();
	const url = new URL(req.url, `http://127.0.0.1:${req.socket.localPort}`);
	const path = url.pathname;
	const cors = {
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET, POST, OPTIONS',
		'access-control-allow-headers': '*'
	};
	if (req.method === 'OPTIONS') {
		res.writeHead(204, cors);
		res.end();
		logRequest({ t: started, method: 'OPTIONS', path, query: url.search, status: 204, ms: 0, auth: false, body: '' });
		return;
	}
	let body = '';
	for await (const chunk of req) body += chunk;
	const finish = (status, type, payload) => {
		const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
		res.writeHead(status, { 'content-type': type, ...cors });
		res.end(req.method === 'HEAD' ? undefined : text);
		logRequest({ t: started, method: req.method, path, query: url.search, status, ms: Date.now() - started,
			auth: Boolean(req.headers.authorization || req.headers['x-api-key']),
			body: body.slice(0, 400) });
	};

	if (path === '/api/hello') return finish(200, 'text/plain', 'ok');
	if (path === '/report') {
		if (req.method === 'POST') { report = JSON.parse(body || 'null'); return finish(200, 'application/json', { stored: true }); }
		return finish(200, 'application/json', report ?? { none: true });
	}
	if (path === '/requests') return finish(200, 'application/json', requests);
	if (path === '/v1/messages/count_tokens') return finish(200, 'application/json', { input_tokens: 17 });
	if (path === '/v1/models') {
		return finish(200, 'application/json', { data: [
			{ id: 'claude-sonnet-4-5-20250929', display_name: 'Fake Claude Sonnet 4.5 (sandbox)' },
			{ id: 'claude-opus-4-1-20250805', display_name: 'Fake Claude Opus 4.1 (sandbox)' }
		] });
	}
	if (path === '/v1/messages' && req.method === 'POST') {
		let payload = null;
		try { payload = JSON.parse(body); } catch { return finish(400, 'application/json', { error: { type: 'invalid_request_error', message: 'unparseable body' } }); }
		const text = replyText(payload);
		if (payload.stream) {
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...cors });
			logRequest({ t: started, method: req.method, path, query: url.search, status: 200, ms: Date.now() - started, stream: true,
				auth: Boolean(req.headers.authorization || req.headers['x-api-key']), body: body.slice(0, 400) });
			sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_fake_' + started, type: 'message', role: 'assistant',
				model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
			if (firstTokenDelay) await sleep(firstTokenDelay);
			sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
			// A few chunks, not one blob: the chat's streaming render is part of what the sandbox measures.
			const chunks = text.match(/.{1,40}/gs) ?? [text];
			for (const chunk of chunks) {
				sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } });
				await sleep(15);
			}
			sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
			sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 + fillerSentences } });
			sse(res, 'message_stop', { type: 'message_stop' });
			res.end();
			return;
		}
		return finish(200, 'application/json', { id: 'msg_fake_' + started, type: 'message', role: 'assistant', model: payload.model,
			content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 + fillerSentences } });
	}
	return finish(404, 'application/json', { error: { type: 'not_found_error', message: `the fake Claude server serves no ${req.method} ${path}` } });
});

server.listen(port, '127.0.0.1', () => console.log(`listening ${server.address().port}`));
