"use strict";
/* Claude Code's conversation store, read-only: discovery (which sessions belong to the
 * workspace the editor has open), the session list (title, preview, activity) and the
 * transcript (a flat, display-ready item list).
 *
 * Claude Code writes one append-only JSONL file per session under
 * `<config>/projects/<munged-cwd>/<sessionId>.jsonl`. The config root is the one the
 * host's Claude Code uses — one store, never a mix: Git Graph Studio runs it under
 * `~/.ggs/claude` (its provider bridge's `CLAUDE_CONFIG_DIR`), VS Code under Claude's own
 * default `~/.claude`; an explicit `CLAUDE_CONFIG_DIR` wins on either, as it does for
 * Claude Code itself. A remote run resumes under the same root, so the provider, login
 * and history it continues are the ones the desktop wrote.
 *
 * Both readers are incremental: a file is re-read only from the byte the last parse
 * stopped at, so polling a live conversation costs its appended lines, not its history. */

const fs = require("fs");
const os = require("os");
const path = require("path");

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 96 * 1024;
const MAX_TRANSCRIPT_BYTES = 24 * 1024 * 1024; // no parse of a session ever reaches past this floor
const COLD_TAIL_BYTES = 512 * 1024; // a cold open parses only this much of the tail
const EXTEND_BACK_BYTES = 1024 * 1024; // one backward step when a wider window is asked
const RESULT_INLINE_CHARS = 3000; // a tool result longer than this ships a "more" handle
const RESULT_KEEP_CHARS = 256 * 1024;
const INPUT_INLINE_CHARS = 4000;
const THINKING_INLINE_CHARS = 6000;
// A session whose last record is mid-turn counts as busy only while its file is this fresh:
// a desktop window killed mid-turn must not hold a remote queue forever.
const BUSY_FRESH_MS = 3 * 60 * 1000;
// Parsed transcripts kept in memory (images and full tool results included): the least
// recently read beyond this are dropped and re-parsed on their next read.
const MAX_CACHED_TRANSCRIPTS = 8;

/* ---------- roots and workspace matching ---------- */

function samePathKey(p) {
	let key = path.resolve(String(p)).replace(/\\/g, "/").replace(/\/+$/, "");
	if (process.platform === "win32" || /^[a-zA-Z]:\//.test(key)) key = key.toLowerCase();
	return key;
}

function isInside(child, parent) {
	const c = samePathKey(child);
	const p = samePathKey(parent);
	return c === p || c.startsWith(p + "/");
}

/** Claude Code's project directory name for a cwd: every non-alphanumeric becomes `-`. */
function mungePath(p) {
	return String(p).replace(/[^a-zA-Z0-9]/g, "-");
}

/** Whose Claude Code this is: "ggs" (Git Graph Studio) or "claude" (VS Code and the rest). */
let host = "claude";

function setHost(kind) {
	host = kind === "ggs" ? "ggs" : "claude";
}

/** The host's Claude Code config root (whether or not it exists yet). */
function claudeRoot(env = process.env, kind = host) {
	if (env.CLAUDE_CONFIG_DIR) return path.resolve(env.CLAUDE_CONFIG_DIR);
	return kind === "ggs" ? path.join(os.homedir(), ".ggs", "claude") : path.join(os.homedir(), ".claude");
}

/** The store roots to read: the host's one root. */
function claudeRoots(env = process.env, kind = host) {
	return [claudeRoot(env, kind)];
}

/* ---------- text helpers ---------- */

const CONTEXT_TAGS = [
	["ide_selection", "selection"],
	["ide_opened_file", "file"],
	["ide_diagnostics", "diagnostics"],
	["system-reminder", null]
];

/** A human prompt as the user typed it: IDE context wrappers become chips, reminders vanish. */
function cleanPrompt(text) {
	const chips = [];
	let out = String(text);
	for (const [tag, chip] of CONTEXT_TAGS) {
		const re = new RegExp("<" + tag + ">[\\s\\S]*?</" + tag + ">", "g");
		out = out.replace(re, (match) => {
			if (chip) {
				const inner = match.replace(/<[^>]+>/g, "").trim();
				const file = inner.match(/(?:file|in)\s+([^\s:]+\.[A-Za-z0-9]+)/);
				chips.push(file ? chip + ": " + path.basename(file[1]) : chip);
			}
			return "";
		});
	}
	return { text: out.trim(), chips };
}

function clip(text, max) {
	const s = String(text ?? "");
	return s.length > max ? s.slice(0, max) : s;
}

function firstLine(text, max = 120) {
	const line = String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
	return clip(line.trim(), max);
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

/** A local slash-command record (`<command-name>/x</command-name>…`) → a one-line notice. */
function localCommandNotice(text) {
	const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
	if (name) {
		const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
		return (name[1].trim() + " " + (args ? args[1].trim() : "")).trim();
	}
	const stdout = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
	if (stdout) return stdout[1].replace(/\x1b\[[0-9;]*m/g, "").trim();
	return null;
}

function relTo(cwd, file) {
	if (!file) return "";
	if (cwd && isInside(file, cwd)) return path.relative(cwd, file).replace(/\\/g, "/") || path.basename(file);
	return String(file);
}

/** The one-line summary a tool row shows, per tool, ZCode/Claude-style. */
function toolSummary(name, input, cwd) {
	const i = input && typeof input === "object" ? input : {};
	switch (name) {
		case "Bash": case "PowerShell": return firstLine(i.description || i.command, 160);
		case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit":
			return relTo(cwd, i.file_path || i.notebook_path);
		case "Glob": return String(i.pattern ?? "");
		case "Grep": return String(i.pattern ?? "") + (i.path ? "  ·  " + relTo(cwd, i.path) : "");
		case "WebFetch": return String(i.url ?? "");
		case "WebSearch": return String(i.query ?? "");
		case "Task": case "Agent": return firstLine(i.description || i.prompt, 120);
		case "TodoWrite": return Array.isArray(i.todos) ? i.todos.length + " todos" : "";
		case "AskUserQuestion": return Array.isArray(i.questions) && i.questions[0] ? firstLine(i.questions[0].question, 120) : "";
		default: {
			for (const value of Object.values(i)) if (typeof value === "string" && value.trim()) return firstLine(value, 120);
			return "";
		}
	}
}

/** The tool input as the expandable body shows it: a diff for edits, the command for shells. */
function toolBody(name, input) {
	const i = input && typeof input === "object" ? input : {};
	const diff = (oldText, newText) => {
		const minus = String(oldText ?? "").split("\n").map((l) => "- " + l);
		const plus = String(newText ?? "").split("\n").map((l) => "+ " + l);
		return [...minus, ...plus].join("\n");
	};
	let body;
	if (name === "Edit") body = { kind: "diff", text: diff(i.old_string, i.new_string) };
	else if (name === "MultiEdit" && Array.isArray(i.edits)) body = { kind: "diff", text: i.edits.map((e) => diff(e.old_string, e.new_string)).join("\n…\n") };
	else if (name === "Write") body = { kind: "code", text: String(i.content ?? "") };
	else if (name === "Bash" || name === "PowerShell") body = { kind: "code", text: String(i.command ?? "") };
	else if (name === "TodoWrite" && Array.isArray(i.todos)) body = { kind: "todos", todos: i.todos.slice(0, 50).map((t) => ({ s: t.status, t: String(t.content ?? t.activeForm ?? "") })) };
	// The question card the phone renders inline — its options ride the sync itself (never
	// the lazy `tool` fetch), because tapping an answer cannot wait for an opened row.
	// Bounded at construction: the phone echoes these labels back on the `answer` wire.
	else if (name === "AskUserQuestion" && Array.isArray(i.questions)) body = {
		kind: "question",
		questions: i.questions.slice(0, 8).map((q) => ({
			q: clip(q && q.question, 600),
			header: clip(q && q.header, 24),
			multi: !!(q && q.multiSelect),
			opts: (Array.isArray(q && q.options) ? q.options : []).slice(0, 8).map((o) => ({ label: clip(o && o.label, 100), desc: clip(o && o.description, 300) }))
		}))
	};
	else body = { kind: "code", text: JSON.stringify(i, null, 2) };
	if (body.text !== undefined && body.text.length > INPUT_INLINE_CHARS) {
		body.text = body.text.slice(0, INPUT_INLINE_CHARS);
		body.clipped = true;
	}
	return body;
}

/* ---------- file reads ---------- */

function readRange(file, start, end) {
	const length = Math.max(0, end - start);
	const buf = Buffer.alloc(length);
	if (length === 0) return buf;
	const fd = fs.openSync(file, "r");
	try {
		let at = 0;
		while (at < length) {
			const n = fs.readSync(fd, buf, at, length - at, start + at);
			if (!n) break;
			at += n;
		}
		return at === length ? buf : buf.subarray(0, at);
	} finally {
		fs.closeSync(fd);
	}
}

function parseLines(text, from = "start") {
	let lines = text.split("\n");
	if (from === "tail") lines = lines.slice(1); // the window's first line is partial
	const out = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try { out.push(JSON.parse(line)); } catch { /* a torn or partial line */ }
	}
	return out;
}

/* ---------- the session list ---------- */

const summaryCache = new Map(); // file → { size, mtimeMs, value }

function isHumanPrompt(d) {
	if (d.type !== "user" || d.isMeta || d.isCompactSummary) return false;
	if (d.origin && d.origin.kind && d.origin.kind !== "human") return false;
	const content = d.message && d.message.content;
	if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) return false;
	const text = contentText(content);
	if (!text.trim() && !(Array.isArray(content) && content.some((b) => b && b.type === "image"))) return false;
	return !/^\s*<(command-name|local-command|command-message)/.test(text) && !/^\s*\[Request interrupted/.test(text);
}

/** Whether a record sequence ends mid-turn (the model still working). */
function endsMidTurn(records) {
	for (let i = records.length - 1; i >= 0; i--) {
		const d = records[i];
		if (d.isSidechain) continue;
		if (d.type === "system" && (d.subtype === "api_error" || d.level === "error")) return false;
		if (d.type === "assistant") {
			const stop = d.message && d.message.stop_reason;
			return !(stop === "end_turn" || stop === "stop_sequence" || stop === "max_tokens" || stop === "refusal");
		}
		if (d.type === "user") {
			if (d.isMeta) continue;
			const text = contentText(d.message && d.message.content);
			if (/\[Request interrupted/.test(text)) return false;
			if (/^\s*<(command-name|local-command)/.test(text)) return false;
			return true;
		}
	}
	return false;
}

function summarize(file, root) {
	const stat = fs.statSync(file);
	const cached = summaryCache.get(file);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;
	const head = parseLines(readRange(file, 0, Math.min(stat.size, HEAD_BYTES)).toString("utf8"));
	const tailStart = Math.max(0, stat.size - TAIL_BYTES);
	const tail = tailStart === 0 ? head : parseLines(readRange(file, tailStart, stat.size).toString("utf8"), "tail");
	let cwd = null, branch = null, customTitle = null, aiTitle = null, summaryTitle = null, firstPrompt = null;
	let preview = null, previewRole = null, turns = 0, model = null;
	for (const d of head) {
		if (!cwd && typeof d.cwd === "string") cwd = d.cwd;
		if (!branch && typeof d.gitBranch === "string" && d.gitBranch) branch = d.gitBranch;
		if (d.type === "summary" && d.summary && !summaryTitle) summaryTitle = d.summary;
		if (firstPrompt === null && isHumanPrompt(d)) firstPrompt = cleanPrompt(contentText(d.message.content)).text;
	}
	for (const d of tail) {
		if (d.type === "custom-title" && d.customTitle) customTitle = d.customTitle;
		if (d.type === "ai-title" && d.aiTitle) aiTitle = d.aiTitle;
		if (d.type === "summary" && d.summary) summaryTitle = summaryTitle || d.summary;
		if (typeof d.gitBranch === "string" && d.gitBranch) branch = d.gitBranch;
		if (!cwd && typeof d.cwd === "string") cwd = d.cwd;
		if (d.isSidechain) continue;
		if (d.type === "assistant") {
			if (realModel(d)) model = d.message.model;
			const text = contentText(d.message && d.message.content).trim();
			if (text) { preview = text; previewRole = "assistant"; }
		} else if (isHumanPrompt(d)) {
			turns++;
			const text = cleanPrompt(contentText(d.message.content)).text;
			if (text) { preview = text; previewRole = "user"; }
		}
	}
	for (const d of head) if (!customTitle && d.type === "custom-title" && d.customTitle) customTitle = d.customTitle;
	for (const d of head) if (!aiTitle && d.type === "ai-title" && d.aiTitle) aiTitle = d.aiTitle;
	const hasContent = firstPrompt !== null || preview !== null;
	const value = hasContent ? {
		id: path.basename(file, ".jsonl"),
		file,
		root,
		title: firstLine(customTitle || aiTitle || summaryTitle || firstPrompt || "Untitled", 100),
		cwd: cwd || null,
		branch,
		preview: preview ? firstLine(preview.replace(/[#*`>_]/g, ""), 140) : "",
		previewRole,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		midTurn: endsMidTurn(tail),
		approxTurns: turns,
		model
	} : null;
	summaryCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
	return value;
}

function desktopBusy(summary, now = Date.now()) {
	return !!summary && summary.midTurn && now - summary.mtimeMs < BUSY_FRESH_MS;
}

/**
 * The sessions, newest first. `folders` (absolute paths) scopes the list to the open
 * workspace — a session belongs when its cwd is a folder or inside one; `null` lists all.
 */
function listSessions({ roots = claudeRoots(), folders = null, query = "" } = {}) {
	const out = [];
	const munged = folders ? folders.map(mungePath) : null;
	const seen = new Set();
	for (const root of roots) {
		const projects = path.join(root, "projects");
		let dirs = [];
		try { dirs = fs.readdirSync(projects); } catch { continue; }
		for (const dir of dirs) {
			if (munged && !munged.some((m) => dir === m || dir.startsWith(m + "-") || dir.toLowerCase() === m.toLowerCase() || dir.toLowerCase().startsWith(m.toLowerCase() + "-"))) continue;
			const full = path.join(projects, dir);
			let files = [];
			try { files = fs.readdirSync(full); } catch { continue; }
			for (const name of files) {
				if (!name.endsWith(".jsonl")) continue;
				let s;
				try { s = summarize(path.join(full, name), root); } catch { continue; }
				if (!s || seen.has(s.id)) continue;
				if (folders && !(s.cwd ? folders.some((f) => isInside(s.cwd, f)) : true)) continue;
				seen.add(s.id);
				out.push(s);
			}
		}
	}
	const q = String(query || "").trim().toLowerCase();
	const filtered = q ? out.filter((s) => (s.title + "\n" + s.preview + "\n" + (s.cwd || "")).toLowerCase().includes(q)) : out;
	return filtered.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findSession(id, roots = claudeRoots()) {
	const wanted = String(id || "");
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(wanted)) return null;
	for (const root of roots) {
		const projects = path.join(root, "projects");
		let dirs = [];
		try { dirs = fs.readdirSync(projects); } catch { continue; }
		for (const dir of dirs) {
			const file = path.join(projects, dir, wanted + ".jsonl");
			if (fs.existsSync(file)) {
				try { return summarize(file, root) || { id: wanted, file, root, title: "Untitled", cwd: null, mtimeMs: fs.statSync(file).mtimeMs, size: 0, midTurn: false }; } catch { return null; }
			}
		}
	}
	return null;
}

/* ---------- models ---------- */

/** An answer's model as the API reported it; Claude Code's own placeholder answers
 *  (API errors, local commands) carry "<synthetic>". */
function realModel(d) {
	const model = d && d.type === "assistant" && d.message && d.message.model;
	return typeof model === "string" && model && !model.startsWith("<") ? model : null;
}

const TIERS = ["opus", "fable", "sonnet", "haiku"];
const TIER_ALIAS = /^(opus|fable|sonnet|haiku)(\[1m\])?$/i;

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** The tier a bare model alias names (`opus`, `sonnet[1m]`, …), else null. */
function tierOf(id) {
	const m = String(id || "").match(TIER_ALIAS);
	return m ? m[1].toLowerCase() : null;
}

/** The settings layers that pin a model or carry an `env` map for a turn in `cwd`, most
 *  specific first: the project-local, project and user settings. */
function modelLayers({ root, cwd } = {}) {
	return [
		cwd && readJson(path.join(cwd, ".claude", "settings.local.json")),
		cwd && readJson(path.join(cwd, ".claude", "settings.json")),
		root && readJson(path.join(root, "settings.json"))
	].filter(Boolean);
}

/** The environment a turn in `cwd` resolves its model under: the process env plus the
 *  settings layers' `env` maps, the user layer applied last so it wins — the precedence
 *  Claude Code itself applies. */
function modelEnv({ root, cwd } = {}) {
	const env = { ...process.env };
	for (const layer of [...modelLayers({ root, cwd })].reverse()) if (layer.env && typeof layer.env === "object") Object.assign(env, layer.env);
	return env;
}

/**
 * The model the desktop's next turn would use, resolved the way Claude Code does: the
 * `model` pin of the project-local, project and user settings (in that precedence), else
 * `ANTHROPIC_MODEL` (the settings' `env` map — where Git Graph Studio's provider bridge
 * writes it — over the process environment); a tier alias (`opus`, `sonnet[1m]`, …)
 * resolves through `ANTHROPIC_DEFAULT_<TIER>_MODEL`. `fallback` (the latest model the
 * workspace's sessions actually answered with) names the account default when nothing
 * is pinned.
 */
function modelInfo({ root, cwd, fallback = null } = {}) {
	const layers = modelLayers({ root, cwd });
	const env = modelEnv({ root, cwd });
	const pinned = layers.map((l) => l.model).find((m) => typeof m === "string" && m.trim()) || null;
	const resolveTier = (tier) => env["ANTHROPIC_DEFAULT_" + tier.toUpperCase() + "_MODEL"] || null;
	let current = null, source = "default";
	if (pinned) {
		const tier = tierOf(pinned);
		current = tier ? resolveTier(tier) || pinned : pinned;
		source = "settings";
	} else if (env.ANTHROPIC_MODEL) {
		current = env.ANTHROPIC_MODEL;
		source = "env";
	} else if (fallback) {
		current = fallback;
		source = "recent";
	}
	return {
		current,
		pinned,
		source,
		tiers: TIERS.map((tier) => ({ id: tier, resolved: resolveTier(tier) })),
		provider: env.ANTHROPIC_BASE_URL ? String(env.ANTHROPIC_BASE_URL).replace(/^https?:\/\//, "").split("/")[0] : null
	};
}

/**
 * A model name as the phone should show it: a bare tier alias (`opus`, `sonnet[1m]`, …)
 * resolves through the same provider remap the run itself resolves it through
 * (`ANTHROPIC_DEFAULT_<TIER>_MODEL` — where Git Graph Studio's provider bridge writes the
 * third-party's own ids), so a third-party provider is named by its models, not Claude's
 * tiers. Everything else — a full model id, an alias no remap covers (the official
 * service) — passes through verbatim.
 */
function resolveModelName(id, { root = claudeRoot(), cwd = null } = {}) {
	const tier = tierOf(id);
	if (!tier) return id || null;
	const env = modelEnv({ root, cwd });
	return env["ANTHROPIC_DEFAULT_" + tier.toUpperCase() + "_MODEL"] || id;
}

/* ---------- the transcript ---------- */

const transcriptCache = new Map(); // file → state

// One per parsed state: a rebuilt state (cache eviction, a rewritten file) gets a new one,
// so a client holding a cursor from the previous parse is sent the full window again.
let transcriptGen = 0;

function newTranscript(file) {
	return {
		file,
		gen: ++transcriptGen,
		seq: 0, // the version stamp high-water: every push or mutation takes the next number
		lowSeq: 0, // the stamp floor: history prepended on demand counts DOWN from here
		offset: 0,
		size: 0,
		mtimeMs: 0,
		truncatedHead: false,
		cwd: null,
		items: [],
		tools: new Map(), // tool_use_id → item
		fullResults: new Map(), // item id → full result text
		images: new Map(), // ref → { mime, data }
		tailRecords: [], // the last few turn records, for the mid-turn check
		model: null, // the model of the latest answer
		seen: new Set(), // record uuids already ingested: a record written twice shows once
		records: 0 // records ingested, for ids of records without a uuid
	};
}

function pushImage(state, ref, block) {
	const source = block && block.source;
	if (!source || source.type !== "base64" || !source.data) return null;
	state.images.set(ref, { mime: source.media_type || "image/png", data: source.data });
	return ref;
}

function resultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && b.type === "text" ? b.text : b && b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

function ingest(state, d) {
	if (!d || typeof d !== "object" || d.isSidechain) return;
	state.records++;
	// Every item takes the next version stamp, so a client can ask for what changed since
	// the stamp it last saw instead of the whole window. While a chunk of older history is
	// being prepended (extendBackward), items collect into the sink unstamped — the stamps
	// that keep file order increasing are assigned below every existing one afterwards.
	const push = (item) => {
		if (state.prependSink) { state.prependSink.push(item); return; }
		item.q = ++state.seq;
		state.items.push(item);
	};
	if (d.uuid) {
		// item ids derive from the record uuid — a repeated record would repeat ids, and the
		// phone's keyed renderer shows one element per id
		if (state.seen.has(d.uuid)) return;
		state.seen.add(d.uuid);
	}
	if (!state.cwd && typeof d.cwd === "string") state.cwd = d.cwd;
	const ts = d.timestamp ? Date.parse(d.timestamp) || null : null;
	const uuid = String(d.uuid || "r" + state.records);
	if (d.type === "user" || d.type === "assistant" || d.type === "system") {
		// the tail check reads the file's LAST records; prepended history is older than what
		// is already there and must not enter it
		if (!state.prependSink) {
			state.tailRecords.push(d);
			if (state.tailRecords.length > 12) state.tailRecords.shift();
		}
	}
	if (d.type === "system") {
		if (d.subtype === "api_error" || d.level === "error") {
			const message = d.error && (d.error.message || d.error.error && d.error.error.message) || d.content || "API error";
			push({ id: uuid, k: "notice", lvl: "error", t: ts, text: firstLine(String(message), 400) });
		} else if (d.subtype === "compact_boundary") {
			push({ id: uuid, k: "notice", lvl: "info", t: ts, text: "compacted" });
		}
		return;
	}
	if (d.type !== "user" && d.type !== "assistant") return;
	const content = d.message && d.message.content;
	if (d.type === "user") {
		if (d.isCompactSummary) {
			push({ id: uuid, k: "notice", lvl: "info", t: ts, text: "compacted" });
			return;
		}
		if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) {
			for (const block of content) {
				if (!block || block.type !== "tool_result") continue;
				const item = state.tools.get(block.tool_use_id);
				if (!item) continue;
				const full = resultText(block.content);
				const imgs = [];
				if (Array.isArray(block.content)) {
					block.content.forEach((b, i) => {
						if (b && b.type === "image") {
							const ref = pushImage(state, item.id + ":r" + i, b);
							if (ref) imgs.push(ref);
						}
					});
				}
				item.st = block.is_error ? "err" : "ok";
				item.res = { text: clip(full, RESULT_INLINE_CHARS), more: full.length > RESULT_INLINE_CHARS, err: !!block.is_error, imgs };
				if (full.length > RESULT_INLINE_CHARS) state.fullResults.set(item.id, clip(full, RESULT_KEEP_CHARS));
				item.q = ++state.seq; // the row changed: a delta must resend it
			}
			return;
		}
		if (d.isMeta) return;
		const raw = contentText(content);
		const command = localCommandNotice(raw);
		if (command !== null) {
			if (command) push({ id: uuid, k: "notice", lvl: "cmd", t: ts, text: clip(command, 600) });
			return;
		}
		if (/^\s*\[Request interrupted/.test(raw)) {
			push({ id: uuid, k: "notice", lvl: "warn", t: ts, text: "interrupted" });
			return;
		}
		const { text, chips } = cleanPrompt(raw);
		const imgs = [];
		if (Array.isArray(content)) {
			content.forEach((b, i) => {
				if (b && b.type === "image") {
					const ref = pushImage(state, uuid + ":" + i, b);
					if (ref) imgs.push(ref);
				}
			});
		}
		if (!text && !imgs.length) return;
		push({ id: uuid, k: "user", t: ts, text, chips, imgs });
		return;
	}
	// assistant: one record per content block in current Claude Code; older files batch them
	// (prepended history carries older answers — the model shown is the latest one)
	if (!state.prependSink && realModel(d)) state.model = d.message.model;
	const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
	blocks.forEach((block, i) => {
		if (!block) return;
		const id = uuid + ":" + i;
		if (block.type === "text" && block.text && block.text.trim()) {
			if (block.text.trim() === "No response requested.") return;
			push({ id, k: "assistant", t: ts, text: block.text });
		} else if (block.type === "thinking" && block.thinking && block.thinking.trim()) {
			push({ id, k: "thinking", t: ts, text: clip(block.thinking, THINKING_INLINE_CHARS) });
		} else if (block.type === "tool_use") {
			const item = { id, k: "tool", t: ts, name: String(block.name || "tool"), sum: toolSummary(block.name, block.input, state.cwd), body: toolBody(block.name, block.input), st: "run", res: null };
			push(item);
			if (block.id) state.tools.set(block.id, item);
		}
	});
}

/** The transcript state for a session file, brought up to date incrementally. */
function readTranscript(file) {
	const stat = fs.statSync(file);
	let state = transcriptCache.get(file);
	if (state && stat.size < state.offset) state = null; // rewritten: start over
	if (state) transcriptCache.delete(file); // re-inserted below: the Map's order is recency
	if (!state) {
		state = newTranscript(file);
		// A cold open parses only the tail: a multi-megabyte conversation answers its first
		// window in tail time, not whole-file time. Older history parses on demand when a
		// wider window is asked for (ensureWindow).
		if (stat.size > COLD_TAIL_BYTES) {
			state.offset = stat.size - COLD_TAIL_BYTES;
			state.truncatedHead = true;
			// align to the next full line
			const probe = readRange(file, state.offset, Math.min(stat.size, state.offset + 1024 * 1024));
			const nl = probe.indexOf(10);
			state.offset += nl >= 0 ? nl + 1 : probe.length;
		}
	}
	transcriptCache.set(file, state);
	while (transcriptCache.size > MAX_CACHED_TRANSCRIPTS) transcriptCache.delete(transcriptCache.keys().next().value);
	if (stat.size > state.offset) {
		const buf = readRange(file, state.offset, stat.size);
		const lastNl = buf.lastIndexOf(10);
		if (lastNl >= 0) {
			const complete = buf.subarray(0, lastNl + 1).toString("utf8");
			for (const d of parseLines(complete)) ingest(state, d);
			state.offset += lastNl + 1;
		}
	}
	state.size = stat.size;
	state.mtimeMs = stat.mtimeMs;
	return state;
}

/**
 * One backward step of on-demand history: parse the `EXTEND_BACK_BYTES` before the parsed
 * offset (never past the giant-session floor) and prepend its items with version stamps
 * below every existing one. File order keeps increasing stamps, and the append-side
 * high-water (`seq`, what a `since` delta reads) is untouched — prepended items can only
 * reach a client through a `before` window, never as a delta, so the state's gen (the
 * rebuild marker) stays what it is and a client's cursor survives the extension.
 *
 * A tool_use whose result record sits across the old parse boundary keeps its "running"
 * look — its result was consumed by a parse that could not match it. Cosmetic, and rare:
 * only a turn straddling the boundary does it.
 */
function extendBackward(state) {
	const file = state.file;
	const stat = fs.statSync(file);
	let start = Math.max(0, state.offset - EXTEND_BACK_BYTES);
	const floor = Math.max(0, stat.size - MAX_TRANSCRIPT_BYTES);
	if (start < floor) start = floor;
	if (start >= state.offset) return false;
	if (start > 0) {
		// align to the next full line
		const probe = readRange(file, start, Math.min(state.offset, start + 1024 * 1024));
		const nl = probe.indexOf(10);
		start += nl >= 0 ? nl + 1 : probe.length;
		if (start >= state.offset) return false;
	}
	const buf = readRange(file, start, state.offset);
	const lastNl = buf.lastIndexOf(10);
	if (lastNl < 0) return false;
	const sink = [];
	state.prependSink = sink;
	try {
		for (const d of parseLines(buf.subarray(0, lastNl + 1).toString("utf8"))) ingest(state, d);
	} finally {
		state.prependSink = null;
	}
	let stamp = (state.lowSeq || 0) - sink.length;
	for (const item of sink) item.q = ++stamp;
	state.lowSeq = stamp;
	state.items = sink.concat(state.items);
	state.offset = start;
	state.truncatedHead = start > 0;
	return true;
}

/** Parse older history while fewer than `want` items are parsed (older than `before`,
 *  when a page before that stamp is asked for) and head bytes remain. `truncatedHead`, not
 *  `offset > 0`, says history remains: a fully parsed file sits at offset === size, and
 *  re-reading it as a "prepend" would duplicate its anonymous records (no uuid to dedup). */
function ensureWindow(state, want, before) {
	const count = () => (before === null ? state.items.length : state.items.filter((it) => (it.q || 0) < before).length);
	let steps = 0;
	while (count() < want && state.truncatedHead && state.offset > 0 && steps++ < 64) {
		if (!extendBackward(state)) break;
	}
}

/**
 * The items a client sees. Without `since`: the last `limit` items (a full window — parsed
 * back on demand when the window asked for is wider than what is parsed). With `since` (a
 * stamp from a previous answer of the same parsed state): only the items pushed or changed
 * after it — a live conversation costs its new lines, not its history. With `before` (a
 * stamp from a previous answer): the last `limit` items older than it — one page of
 * earlier history, prepended client-side, that never disturbs a `since` cursor. `cur` is
 * the stamp to send back next time; `delta` says the items are a merge, not a window.
 */
function transcriptWindow(state, opts = {}) {
	if (typeof opts === "number") opts = { limit: opts };
	const n = Math.max(20, Math.min(4000, Number(opts.limit) || 160));
	const since = opts.since != null && Number.isFinite(Number(opts.since)) ? Number(opts.since) : null;
	const before = opts.before != null && Number.isFinite(Number(opts.before)) ? Number(opts.before) : null;
	// `before` wins over `since` when both arrive (the phone polls with its cursor and asks
	// for a page of earlier history in the same call): an earlier page is itself a merge, and
	// the appends behind the cursor arrive on the next regular poll.
	if (before !== null) {
		ensureWindow(state, n, before);
		const older = state.items.filter((it) => (it.q || 0) < before);
		const items = older.slice(-n);
		return {
			items,
			total: state.items.length,
			hasMore: older.length > items.length || state.truncatedHead,
			midTurn: endsMidTurn(state.tailRecords),
			model: state.model,
			delta: true,
			cur: { gen: state.gen, since: state.seq }
		};
	}
	if (since !== null) {
		const items = state.items.filter((it) => (it.q || 0) > since);
		return {
			items,
			total: state.items.length,
			hasMore: state.truncatedHead,
			midTurn: endsMidTurn(state.tailRecords),
			model: state.model,
			delta: true,
			cur: { gen: state.gen, since: state.seq }
		};
	}
	ensureWindow(state, n, null);
	const items = state.items.slice(-n);
	return {
		items,
		total: state.items.length,
		hasMore: state.items.length > items.length || state.truncatedHead,
		midTurn: endsMidTurn(state.tailRecords),
		model: state.model,
		delta: false,
		cur: { gen: state.gen, since: state.seq }
	};
}

module.exports = {
	modelInfo,
	resolveModelName,
	setHost,
	claudeRoot,
	claudeRoots,
	listSessions,
	findSession,
	readTranscript,
	transcriptWindow,
	desktopBusy,
	mungePath,
	isInside,
	samePathKey,
	cleanPrompt,
	toolSummary,
	BUSY_FRESH_MS,
	MAX_CACHED_TRANSCRIPTS,
	cachedTranscripts: () => transcriptCache.size
};
