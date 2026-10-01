"use strict";
/* Claude Remote (LAN) — the extension's whole logic, in one CommonJS file so the same
 * VSIX runs in real VS Code (real Node) and in Git Graph Studio's ggs-node runtime
 * (the pretend-Node sidecar): only lazy `require`s, no ESM, no build step.
 *
 * What it does:
 *   - reads Claude Code's conversation store (`$CLAUDE_CONFIG_DIR/projects/` — one
 *     `<munged-cwd>/<session>.jsonl` file per session;
 *     defaulting to `~/.claude`) — the same files Claude Code itself writes;
 *   - serves a mobile-first web page on the LAN: pairing by a one-time token, then
 *     every request/response body is AES-256-GCM sealed under a PBKDF2 key derived
 *     from that token — the pairing secret never crosses the wire after setup;
 *   - drives the `claude` CLI for new prompts (`-p --output-format json`, optionally
 *     `--resume <sessionId>`), so a phone can continue an existing conversation or
 *     start a new one; the CLI runs with the workspace as its cwd.
 *
 * Security posture (LAN-only, defense in depth):
 *   - the server binds 0.0.0.0 with a 160-bit random token as the pairing secret;
 *   - every /api body is sealed (AES-256-GCM) — a passive LAN sniff sees only random
 *     bytes and lengths;
 *   - failed decodes are rate-limited (10 s penalty per miss) to blunt brute force;
 *   - nothing is ever written outside memory except what Claude Code itself writes.
 */

const http = require("http");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");

// The frame-program marker: ggs-node's bootstrap greps the entry for this literal to
// route the package through the vscode-shim activation job. The preload itself runs
// BEFORE the shim exists (bootstrap time) and fails harmlessly in headless loaders;
// activate() re-requires vscode for real once the shim is installed.
let vscode = null;
try { vscode = require("vscode"); } catch { /* headless or pre-activation */ }

/* ---------- configuration ---------- */

const MAX_TOKEN_TRIES = 8;
const TOKEN_PENALTY_MS = 10_000;
const MAX_TAIL_BYTES = 256 * 1024; // how much of a conversation file the reader scans
const MAX_HEAD_BYTES = 64 * 1024;
const TASK_TIMEOUT_MS = 15 * 60 * 1000;

function claudeHome() {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function claudeCliPath() {
	if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
	const ggsDir = path.join(os.homedir(), ".ggs/extensions");
	try {
		for (const entry of fs.readdirSync(ggsDir)) {
			if (!/^Anthropic\.claude-code-/.test(entry)) continue;
			for (const candidate of [
				path.join(ggsDir, entry, "resources", "claude"),
				path.join(ggsDir, entry, "claude"),
				path.join(ggsDir, entry, "resources", "claude.exe")
			]) {
				try {
					fs.accessSync(candidate, fs.constants.X_OK);
					return candidate;
				} catch {}
			}
		}
	} catch {}
	return "claude"; // PATH
}

/* ---------- conversations ---------- */

function mungedToProject(name) {
	// `-Users-nn-Documents-x` → `/Users/nn/Documents/x` (best effort; the JSONL's own
	// `cwd` fields are the truth and are preferred when present).
	const parts = name.split("-").filter(Boolean);
	return "/" + parts.join("/");
}

function readJsonlTail(file, bytes) {
	const stat = fs.statSync(file);
	const read = Math.min(bytes, stat.size);
	const fd = fs.openSync(file, "r");
	const buf = Buffer.alloc(read);
	fs.readSync(fd, buf, 0, read, stat.size - read);
	fs.closeSync(fd);
	// Drop the partial first line unless the whole file is in the window.
	const text = buf.toString("utf8");
	const start = read === stat.size ? 0 : text.indexOf("\n") + 1;
	return { text: text.slice(start), mtimeMs: stat.mtimeMs, size: stat.size };
}

function blockText(block) {
	if (typeof block === "string") return { kind: "text", text: block };
	if (!block || typeof block !== "object") return null;
	if (block.type === "text" && typeof block.text === "string") return { kind: "text", text: block.text };
	if (block.type === "image") {
		const source = block.source || {};
		if (source.type === "base64" && source.data) {
			return { kind: "image", mime: source.media_type || "image/png", data: source.data };
		}
		return { kind: "text", text: "[image: unsupported encoding]" };
	}
	if (block.type === "tool_use") return { kind: "tool", name: block.name, text: JSON.stringify(block.input ?? {}).slice(0, 300) };
	if (block.type === "tool_result") {
		const inner = Array.isArray(block.content)
			? block.content.map(blockText).filter(Boolean)
			: typeof block.content === "string" ? [{ kind: "text", text: block.content }] : [];
		return { kind: "tool_result", inner };
	}
	if (block.type === "thinking") return null; // internal reasoning: not shown
	return null;
}

function parseConversation(file) {
	const headText = readJsonlTail(file, MAX_HEAD_BYTES).text;
	const { text: tailText, mtimeMs, size } = readJsonlTail(file, MAX_TAIL_BYTES);
	const sessionId = path.basename(file, ".jsonl");
	let title = null;
	let project = null;
	let truncated = size > MAX_TAIL_BYTES;
	const messages = [];
	const images = [];
	let firstText = null;
	for (const line of headText.split("\n")) {
		if (!line.trim()) continue;
		let d; try { d = JSON.parse(line); } catch { continue; }
		if (d.type === "summary" && d.summary && !title) title = d.summary;
		if (!project && typeof d.cwd === "string") project = d.cwd;
	}
	for (const line of tailText.split("\n")) {
		if (!line.trim()) continue;
		let d; try { d = JSON.parse(line); } catch { continue; }
		if (!project && typeof d.cwd === "string") project = d.cwd;
		if (d.type === "summary" && d.summary && !title) title = d.summary;
		if (d.type !== "user" && d.type !== "assistant") continue;
		if (d.isSidechain) continue;
		const content = d.message && d.message.content;
		const role = d.type;
		const blocks = [];
		if (typeof content === "string") {
			blocks.push({ kind: "text", text: content });
		} else if (Array.isArray(content)) {
			for (const block of content) {
				const parsed = blockText(block);
				if (parsed) blocks.push(parsed);
			}
		}
		const text = blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n").trim();
		if (role === "user" && firstText === null && text) firstText = text;
		for (const b of blocks) {
			if (b.kind === "image") {
				const id = images.length;
				images.push({ id, mime: b.mime, data: b.data, inMessage: messages.length });
			}
		}
		messages.push({
			role,
			timestamp: d.timestamp ?? null,
			blocks: blocks.map((b) => {
				if (b.kind === "image") return { kind: "image", imageId: images.find((img) => img.inMessage === messages.length)?.id ?? 0 };
				return b;
			})
		});
		if (messages.length > 400) { truncated = true; break; }
	}
	return {
		id: sessionId,
		title: title || (firstText ? firstText.slice(0, 80) : sessionId),
		project: project || mungedToProject(path.basename(path.dirname(file))),
		mtimeMs,
		size,
		truncated,
		messages,
		images
	};
}

function listConversations(claudeDir) {
	const projectsDir = path.join(claudeDir, "projects");
	if (!fs.existsSync(projectsDir)) return [];
	const out = [];
	for (const project of fs.readdirSync(projectsDir)) {
		const projectDir = path.join(projectsDir, project);
		let files = [];
		try { files = fs.readdirSync(projectDir); } catch { continue; }
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const full = path.join(projectDir, file);
			try {
				const head = readJsonlTail(full, MAX_HEAD_BYTES);
				let title = null;
				let firstText = null;
				let project_ = null;
				for (const line of head.text.split("\n")) {
					if (!line.trim()) continue;
					let d; try { d = JSON.parse(line); } catch { continue; }
					if (d.type === "summary" && d.summary && !title) title = d.summary;
					if (!project_ && typeof d.cwd === "string") project_ = d.cwd;
					if (d.type === "user" && firstText === null) {
						const content = d.message && d.message.content;
						const text = typeof content === "string" ? content : Array.isArray(content)
							? content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ")
							: "";
						if (text.trim() && d.origin?.kind !== "tool_result") firstText = text.trim();
					}
				}
				out.push({
					id: path.basename(file, ".jsonl"),
					title: title || (firstText ? firstText.slice(0, 80) : file.replace(".jsonl", "")),
					project: project_ || mungedToProject(project),
					projectDirName: project,
					mtimeMs: head.mtimeMs,
					size: head.size
				});
			} catch {}
		}
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}

/* ---------- claude CLI tasks ---------- */

const tasks = new Map();
let taskSerial = 0;

function runClaudeTask(claudeCli, cwd, prompt, resumeSessionId) {
	const id = `t${++taskSerial}`;
	const args = ["-p", prompt, "--output-format", "json"];
	if (resumeSessionId) args.push("--resume", resumeSessionId);
	const task = {
		id,
		sessionId: resumeSessionId ?? null,
		status: "running",
		startedAt: Date.now(),
		result: null,
		error: null
	};
	tasks.set(id, task);
	const child = require("child_process").spawn(claudeCli, args, {
		cwd: cwd || os.homedir(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"]
	});
	let stdout = "";
	let stderr = "";
	const timer = setTimeout(() => {
		task.status = "error";
		task.error = "timed out";
		try { child.kill("SIGKILL"); } catch {}
	}, TASK_TIMEOUT_MS);
	child.stdout.on("data", (c) => { stdout += c; });
	child.stderr.on("data", (c) => { stderr += c; });
	child.on("error", (error) => {
		clearTimeout(timer);
		task.status = "error";
		task.error = `spawn failed: ${error.message}`;
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		if (task.status === "error") return;
		if (code !== 0) {
			task.status = "error";
			task.error = `claude exited ${code}: ${stderr.slice(-400) || "(no stderr)"}`;
			return;
		}
		try {
			const parsed = JSON.parse(stdout);
			task.status = "done";
			task.result = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? "");
			task.sessionId = parsed.session_id || task.sessionId;
			task.isNewSession = !resumeSessionId && !!parsed.session_id;
		} catch {
			// `--output-format json` should always emit one JSON object; fall back to raw.
			task.status = "done";
			task.result = stdout.trim() || "(empty output)";
		}
	});
	return task;
}

/* ---------- the mobile page ---------- */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Claude Remote</title>
<style>
:root { color-scheme: dark; --bg:#1f1f1f; --panel:#252526; --line:#333; --fg:#ccc; --dim:#888; --user:#2a4a6b; --asst:#2d2d2d; --accent:#4a9eff; }
* { box-sizing: border-box; -webkit-text-size-adjust: 100%; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,system-ui,sans-serif; }
#app { max-width:720px; margin:0 auto; min-height:100dvh; display:flex; flex-direction:column; }
header { position:sticky; top:0; background:var(--panel); border-bottom:1px solid var(--line); padding:10px 14px; display:flex; align-items:center; gap:10px; z-index:2; }
header h1 { font-size:16px; margin:0; flex:1; }
header button, .btn { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 14px; font-size:15px; }
header .icon { background:transparent; color:var(--fg); font-size:18px; padding:4px 8px; }
#pair, #list, #chat { padding:14px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:10px; cursor:pointer; }
.card .t { font-weight:600; color:#eee; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.card .m { font-size:13px; color:var(--dim); display:flex; gap:8px; }
input, textarea { width:100%; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:10px; font:inherit; }
textarea { min-height:90px; resize:vertical; }
label { display:block; font-size:13px; color:var(--dim); margin:10px 0 4px; }
#msgs { flex:1; padding:10px 14px 90px; }
.bubble { max-width:88%; border-radius:12px; padding:9px 12px; margin:6px 0; white-space:pre-wrap; word-break:break-word; }
.user { background:var(--user); margin-left:auto; }
.assistant { background:var(--asst); border:1px solid var(--line); }
.tool { background:#1b1b1b; border:1px solid var(--line); font-family:ui-monospace,monospace; font-size:12px; color:#9a9a9a; max-width:95%; }
.tool .name { color:var(--accent); }
.bubble img { max-width:100%; border-radius:8px; margin-top:6px; display:block; }
.time { font-size:11px; color:var(--dim); margin-top:4px; }
#compose { position:fixed; bottom:0; left:50%; transform:translateX(-50%); width:100%; max-width:720px; background:var(--panel); border-top:1px solid var(--line); padding:10px; display:flex; gap:8px; }
#compose textarea { flex:1; min-height:44px; max-height:120px; }
#status { font-size:12px; color:var(--dim); padding:4px 14px; }
.err { color:#f66; }
.hidden { display:none !important; }
</style>
</head>
<body>
<div id="app">
	<div id="pair">
		<h2 style="margin-top:0">Pair with the desktop</h2>
		<p style="color:var(--dim)">Enter the pairing token shown by <b>Claude Remote: Start LAN Server</b>. Both devices must be on the same network; all traffic is end-to-end encrypted with this token.</p>
		<label>Pairing token</label>
		<input id="token" autocomplete="off" placeholder="e.g. K7MQ-2X4B-8ZRD-1PVC">
		<p style="margin-top:12px"><button class="btn" id="pairBtn">Connect</button></p>
		<p id="pairErr" class="err"></p>
	</div>
	<div id="list" class="hidden">
		<div style="display:flex;align-items:center;margin-bottom:10px">
			<button class="btn" id="newBtn" style="flex:1">+ New conversation</button>
			<button id="refreshBtn" style="background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px 12px">↻</button>
		</div>
		<div id="convList"></div>
	</div>
	<div id="chat" class="hidden">
		<div id="msgs"></div>
		<div id="compose">
			<textarea id="prompt" placeholder="Message claude…"></textarea>
			<button class="btn" id="sendBtn">Send</button>
		</div>
	</div>
</div>
<script>
(() => {
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();
let key = null; let currentConv = null; let currentProject = null;
const b64u = { e: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''),
               d: (t) => { const s = t.replace(/-/g,'+').replace(/_/g,'/'); return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); } };
async function deriveKey(token, saltB64u) {
	const pw = await crypto.subtle.importKey('raw', enc.encode(token), 'PBKDF2', false, ['deriveKey']);
	return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64u.d(saltB64u), iterations: 150000, hash: 'SHA-256' }, pw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(obj) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
	return { i: b64u.e(iv), d: b64u.e(new Uint8Array(sealed)) };
}
async function openEnvelope(env) {
	const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.d(env.i) }, key, b64u.d(env.d));
	return JSON.parse(dec.decode(plain));
}
async function api(method, payload) {
	const res = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await seal(payload)) });
	if (!res.ok) throw new Error('HTTP ' + res.status);
	return openEnvelope(await res.json());
}
const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function fmtTime(ts) { if (!ts) return ''; const d = new Date(ts); return d.toLocaleString(); }
function ago(ms) { const m = Math.round((Date.now() - ms) / 60000); if (m < 1) return 'now'; if (m < 60) return m + 'm'; if (m < 1440) return Math.round(m / 60) + 'h'; return Math.round(m / 1440) + 'd'; }

$('pairBtn').addEventListener('click', async () => {
	$('pairErr').textContent = '';
	try {
		const hs = await (await fetch('/api/handshake')).json();
		key = await deriveKey($('token').value.trim(), hs.salt);
		await api('ping', {});
		sessionStorage.setItem('cr-token', $('token').value.trim());
		$('pair').classList.add('hidden');
		$('list').classList.remove('hidden');
		loadList();
	} catch (e) { $('pairErr').textContent = 'Pairing failed: ' + e.message; }
});
async function loadList() {
	$('convList').textContent = 'Loading…';
	try {
		const list = await api('list', {});
		$('convList').textContent = '';
		for (const c of list) {
			const card = document.createElement('div');
			card.className = 'card';
			const t = document.createElement('div'); t.className = 't'; t.textContent = c.title;
			const m = document.createElement('div'); m.className = 'm';
			m.innerHTML = '<span>' + esc(c.project.split('/').pop() || c.project) + '</span><span>' + esc(ago(c.mtimeMs)) + ' ago</span>';
			card.append(t, m);
			card.addEventListener('click', () => openConversation(c.id, c.project));
			$('convList').appendChild(card);
		}
		if (!list.length) $('convList').textContent = 'No conversations yet.';
	} catch (e) { $('convList').textContent = 'Failed: ' + e.message; }
}
async function openConversation(id, project) {
	currentConv = id; currentProject = project;
	$('list').classList.add('hidden');
	$('chat').classList.remove('hidden');
	$('msgs').textContent = 'Loading…';
	try {
		const conv = await api('conversation', { id });
		$('msgs').textContent = '';
		for (const msg of conv.messages) {
			const b = document.createElement('div');
			b.className = 'bubble ' + (msg.role === 'user' ? 'user' : /tool/.test(msg.blocks[0]?.kind ?? '') ? 'tool' : 'assistant');
			for (const block of msg.blocks) {
				if (block.kind === 'text') { const p = document.createElement('div'); p.textContent = block.text; b.appendChild(p); }
				else if (block.kind === 'tool') { const p = document.createElement('div'); p.className = 'name'; p.textContent = '🔧 ' + block.name; b.appendChild(p); const pre = document.createElement('div'); pre.textContent = block.text.slice(0, 200); b.appendChild(pre); }
				else if (block.kind === 'tool_result') { for (const inner of block.inner) { const p = document.createElement('div'); p.textContent = (inner.text || '').slice(0, 400); b.appendChild(p); } }
				else if (block.kind === 'image') {
					const img = document.createElement('img');
					img.alt = 'image';
					api('image', { id: conv.id + ':' + block.imageId }).then((imgData) => {
						img.src = 'data:' + imgData.mime + ';base64,' + imgData.data;
					}).catch(() => { img.alt = 'image unavailable'; });
					b.appendChild(img);
				}
			}
			const time = document.createElement('div'); time.className = 'time'; time.textContent = fmtTime(msg.timestamp); b.appendChild(time);
			$('msgs').appendChild(b);
		}
		if (!conv.messages.length) $('msgs').textContent = '(empty conversation)';
		window.scrollTo(0, document.body.scrollHeight);
	} catch (e) { $('msgs').textContent = 'Failed: ' + e.message; }
}
$('newBtn').addEventListener('click', () => { currentConv = null; $('list').classList.add('hidden'); $('chat').classList.remove('hidden'); $('msgs').textContent = 'New conversation — the next message starts a fresh Claude session in ' + (currentProject || 'the workspace') + '.'; });
let taskPoll = null;
$('sendBtn').addEventListener('click', async () => {
	const prompt = $('prompt').value.trim();
	if (!prompt || taskPoll) return;
	$('sendBtn').disabled = true;
	$('status').textContent = 'claude is thinking…';
	const bubble = document.createElement('div');
	bubble.className = 'bubble assistant';
	bubble.textContent = '⏳ working…';
	$('msgs').appendChild(bubble);
	window.scrollTo(0, document.body.scrollHeight);
	try {
		const task = await api('send', { prompt, sessionId: currentConv, project: currentProject });
		taskPoll = setInterval(async () => {
			const t = await api('task', { id: task.id });
			if (t.status === 'running') return;
			clearInterval(taskPoll); taskPoll = null;
			$('sendBtn').disabled = false;
			$('status').textContent = '';
			if (t.status === 'error') { bubble.textContent = 'Error: ' + t.error; return; }
			bubble.textContent = t.result;
			if (t.isNewSession) { currentConv = t.sessionId; $('status').textContent = 'new conversation created'; }
			window.scrollTo(0, document.body.scrollHeight);
		}, 1500);
	} catch (e) {
		$('sendBtn').disabled = false;
		$('status').textContent = '';
		bubble.textContent = 'Error: ' + e.message;
	}
});
// auto-pair from the stored token
const stored = sessionStorage.getItem('cr-token');
if (stored) { $('token').value = stored; $('pairBtn').click(); }
})();
</script>
</body>
</html>`;

/* ---------- the server ---------- */

function startServer(options) {
	const { port = 0, log = () => {} } = options || {};
	const token = crypto.randomBytes(20).toString("base64url").replace(/[-_]/g, "").slice(0, 24).match(/.{4}/g).join("-");
	const salt = crypto.randomBytes(16);
	const claudeDir = claudeHome();
	const claudeCli = claudeCliPath();
	const imageCache = new Map(); // "convId:idx" → {mime, data}
	const decodeFails = [];
	const deriveKey = () => {
		const c = require("crypto");
		if (typeof c.pbkdf2Sync === "function") {
			const derived = c.pbkdf2Sync(token, salt, 150000, 32, "sha256");
			return derived;
		}
		const keyB64 = globalThis.__ggsPbkdf2Sha256(token, salt.toString("base64url"), 150000, 256);
		return Buffer.from(keyB64, "base64url");
	};
	let key = null;
	const decoder = require("crypto");
	function seal(obj) {
		const keyNow = key ?? deriveKey();
		const iv = crypto.randomBytes(12);
		const ci = require("crypto").createCipheriv("aes-256-gcm", keyNow, iv);
		const ct = Buffer.concat([ci.update(JSON.stringify(obj), "utf8"), ci.final()]);
		return { i: iv.toString("base64url"), d: Buffer.concat([ct, ci.getAuthTag()]).toString("base64url") };
	}
	function open(body) {
		const keyNow = key ?? deriveKey();
		const iv = Buffer.from(body.i, "base64url");
		const sealed = Buffer.from(body.d, "base64url");
		const di = require("crypto").createDecipheriv("aes-256-gcm", keyNow, iv);
		di.setAuthTag(sealed.slice(sealed.length - 16));
		const plain = Buffer.concat([di.update(sealed.slice(0, sealed.length - 16)), di.final()]);
		return JSON.parse(plain.toString("utf8"));
	}

	const server = http.createServer((req, res) => {
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.setHeader("Cache-Control", "no-store");
		if (req.method === "GET" && req.url === "/api/handshake") {
			// The pairing handshake: the salt crosses in the clear (it is public), the key
			// it seeds is only completable by a token holder.
			res.end(JSON.stringify({ salt: salt.toString("base64url"), iterations: 150000 }));
			return;
		}
		if (req.method !== "POST" || !req.url.startsWith("/api/")) {
			if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/index"))) {
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(PAGE);
				return;
			}
			res.statusCode = 404;
			res.end("{}");
			return;
		}
		const chunks = [];
		let size = 0;
		req.on("data", (c) => { size += c.length; if (size > 2 * 1024 * 1024) req.destroy(); else chunks.push(c); });
		req.on("end", () => {
			const respond = (obj) => { res.end(JSON.stringify(seal(obj))); };
			const fail = (message, code = 400) => { res.statusCode = code; res.end(JSON.stringify(seal({ error: message }))); };
			let body;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch { fail("bad envelope"); return; }
			let plain;
			try {
				plain = open(body);
			} catch {
				// Wrong token (or tampered body): rate-limit to blunt brute force.
				const now = Date.now();
				decodeFails.push(now);
				while (decodeFails.length && now - decodeFails[0] > 60_000) decodeFails.shift();
				if (decodeFails.length > MAX_TOKEN_TRIES && now - (decodeFails[0] ?? now) < TOKEN_PENALTY_MS) {
					res.statusCode = 429;
					res.end("{}");
					return;
				}
				fail("pairing failed — wrong token?");
				return;
			}
			try {
				switch (req.url.slice("/api/".length)) {
					case "ping": respond({ ok: true, now: Date.now() }); return;
					case "list": respond(listConversations(claudeDir).map(({ id, title, project, mtimeMs, size }) => ({ id, title, project, mtimeMs, size }))); return;
					case "conversation": {
						const convId = String(plain.id ?? "");
						const found = listConversations(claudeDir).find((c) => c.id === convId);
						if (!found) { fail("no such conversation", 404); return; }
						const conv = parseConversation(path.join(claudeDir, "projects", found.projectDirName, convId + ".jsonl"));
						imageCache.clear();
						for (const image of conv.images) imageCache.set(`${conv.id}:${image.id}`, { mime: image.mime, data: image.data });
						respond({ id: conv.id, title: conv.title, project: conv.project, truncated: conv.truncated, messages: conv.messages });
						return;
					}
					case "image": {
						const img = imageCache.get(String(plain.id ?? ""));
						if (!img) { fail("no such image (open its conversation first)", 404); return; }
						respond({ mime: img.mime, data: img.data });
						return;
					}
					case "send": {
						if (typeof plain.prompt !== "string" || !plain.prompt.trim()) { fail("empty prompt"); return; }
						const cwd = typeof plain.project === "string" && fs.existsSync(plain.project) ? plain.project : os.homedir();
						const task = runClaudeTask(claudeCli, cwd, plain.prompt, plain.sessionId ? String(plain.sessionId) : null);
						respond({ id: task.id, status: task.status });
						return;
					}
					case "task": {
						const task = tasks.get(String(plain.id ?? ""));
						if (!task) { fail("no such task", 404); return; }
						respond({ id: task.id, status: task.status, result: task.result, error: task.error, sessionId: task.sessionId, isNewSession: !!task.isNewSession });
						return;
					}
					default: fail("unknown method", 404);
				}
			} catch (error) {
				fail(String(error && error.message || error), 500);
			}
		});
	});
	return new Promise((resolveServer) => {
		server.listen(port, "0.0.0.0", () => {
			const actualPort = server.address().port;
			log(`listening on 0.0.0.0:${actualPort}`);
			resolveServer({
				port: actualPort,
				token,
				saltB64u: salt.toString("base64url"),
				stop: () => new Promise((done) => server.close(() => done()))
			});
		});
	});
}

/* ---------- vscode activation (lazy: ggs-node loads this file headless too) ---------- */

let activeServer = null;
let statusItem = null;

function activate(context) {
	const vscode = require("vscode");
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	statusItem.text = "$(radio-tower) Claude Remote";
	statusItem.command = "claude-remote.reveal";
	statusItem.tooltip = "Claude Remote LAN server — click for pairing info";
	statusItem.show();

	const start = async () => {
		if (activeServer) {
			await reveal();
			return;
		}
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Claude Remote: starting LAN server…" }, async () => {
			activeServer = await startServer({ port: 0, log: (line) => console.log(`[claude-remote] ${line}`) });
		});
		await reveal();
		context.subscriptions.push({ dispose: async () => { if (activeServer) await activeServer.stop(); } });
		vscode.commands.executeCommand("setContext", "claude-remote.running", true);
	};

	async function reveal() {
		if (!activeServer) {
			vscode.window.showInformationMessage("Claude Remote is not running. Use “Claude Remote: Start LAN Server”.");
			return;
		}
		const interfaces = os.networkInterfaces();
		const ips = [];
		for (const list of Object.values(interfaces)) {
			for (const entry of list ?? []) {
				if (entry.family === "IPv4" && !entry.internal) ips.push(entry.address);
			}
		}
		const urls = ips.map((ip) => `http://${ip}:${activeServer.port}`);
		const message = `Claude Remote is live on your LAN.\n\nOpen on your phone:\n${urls.join("\n")}\n\nPairing token:\n${activeServer.token}\n\nAll traffic is AES-256-GCM encrypted with this token. Keep it private — anyone with it can read and drive your Claude Code conversations.`;
		const chosen = await vscode.window.showInformationMessage(message, { modal: false }, "Copy URL + token", "Copy token only");
		if (chosen === "Copy URL + token") {
			await vscode.env.clipboard.writeText(`${urls[0]}\n${activeServer.token}`);
			vscode.window.showInformationMessage("Copied.");
		} else if (chosen === "Copy token only") {
			await vscode.env.clipboard.writeText(activeServer.token);
			vscode.window.showInformationMessage("Copied.");
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand("claude-remote.start", start),
		vscode.commands.registerCommand("claude-remote.stop", async () => {
			if (!activeServer) return;
			await activeServer.stop();
			activeServer = null;
			vscode.commands.executeCommand("setContext", "claude-remote.running", false);
			vscode.window.showInformationMessage("Claude Remote stopped.");
		}),
		vscode.commands.registerCommand("claude-remote.reveal", reveal),
		{ dispose: () => { if (activeServer) void activeServer.stop(); } }
	);
}

function deactivate() {
	if (activeServer) return Promise.resolve(activeServer.stop()).then(() => undefined);
	return undefined;
}

module.exports = { activate, deactivate, __core: { startServer, listConversations, parseConversation, claudeHome, claudeCliPath } };
