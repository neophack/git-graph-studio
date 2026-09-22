// Splits `git diff` output into per-file hunks so a mixed changeset can be committed
// feature by feature. Usage:
//   node ggs-commit-split.mjs list <file>        — hunk indices with their first +/- line
//   node ggs-commit-split.mjs pick <out> <file> <idx...> — patch with selected hunks
//   node ggs-commit-split.mjs raw <out> <file> <idx...>  — raw hunk bodies for hand editing
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [,, cmd, a, b, ...rest] = process.argv;
// The diff is pinned to a file: the index keeps changing as feature commits land, but
// every patch must be built against the original staged changeset.
const diff = process.env.GGS_DIFF_FILE
	? readFileSync(process.env.GGS_DIFF_FILE, 'utf8')
	: execFileSync('git', ['diff', '--cached'], { maxBuffer: 1 << 26 }).toString();

// Parse into per-file segments of (header lines, hunks).
const files = new Map();
let current = null;
for (const line of diff.split('\n')) {
	if (line.startsWith('diff --git ')) {
		const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
		current = { path: m[2], prelude: [], hunks: [] };
		files.set(current.path, current);
		current.prelude.push(line);
	} else if (current) {
		if (line.startsWith('@@ ')) current.hunks.push([line]);
		else if (current.hunks.length) current.hunks[current.hunks.length - 1].push(line);
		else current.prelude.push(line);
	}
}
const die = (msg) => { console.error(msg); process.exit(1); };
const getFile = (p) => files.get(p) ?? die(`no diff for ${p}`);

if (cmd === 'list') {
	const f = getFile(a);
	f.hunks.forEach((h, i) => {
		const first = h.find((l) => /^[+-]/.test(l)) ?? h[1];
		console.log(`#${i}: ${h[0].slice(0, 60)}  |  ${first.slice(0, 100)}`);
	});
} else if (cmd === 'del') {
	// A deletion patch against the final worktree content, so a commit can stage a mixed
	// hunk minus the lines belonging to a later feature. Usage: del <out> <file> <s:e> ...
	const lines = readFileSync(a, 'utf8').replace(/\r\n/g, '\n').split('\n');
	const groups = rest.map((r) => r.split(':').map(Number)).sort((x, y) => x[0] - y[0]);
	const body = [];
	let removed = 0, kept = 0, prev = null;
	for (const [s, e] of groups) {
		const from = prev === null ? Math.max(1, s - 3) : prev + 1;
		for (let n = from; n < s; n++) { body.push(' ' + lines[n - 1]); kept++; }
		for (let n = s; n <= e; n++) body.push('-' + lines[n - 1]);
		removed += e - s + 1;
		prev = e;
	}
	for (let n = prev + 1; n <= Math.min(lines.length, prev + 3); n++) { body.push(' ' + lines[n - 1]); kept++; }
	const oldStart = Math.max(1, groups[0][0] - 3);
	const out = [`--- a/${a}`, `+++ b/${a}`,
		`@@ -${oldStart},${kept + removed} +${oldStart},${kept} @@`, ...body, ''];
	writeFileSync(b, out.join('\n'));
	console.log(`wrote ${b}: deletes ${rest.join(', ')} from ${a}`);
} else if (cmd === 'split') {
	// Splits one mixed hunk into N sequential patches (applied in commit order 1..N) whose
	// union is the original hunk. Assignment maps BODY line ranges (1-based, excluding the
	// @@ header) to feature numbers: "1-2:1,3:2,4-9:1". Context lines are shared; every
	// +/- line must be assigned. Patch f sees earlier features' adds as context, keeps
	// later features' dels as context, and omits lines that do not exist at its stage.
	const [outPrefix, filePath, hunkIdx, spec] = [a, b, rest[0], rest[1]];
	const f = getFile(filePath);
	const hunk = f.hunks[Number(hunkIdx)] ?? die(`no hunk #${hunkIdx} in ${filePath}`);
	const m = hunk[0].match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
	const [os, , ns] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const body = hunk.slice(1).filter((l) => l !== '' || true);
	const assign = new Array(body.length).fill(0);
	for (const part of spec.split(',')) {
		const [range, feat] = part.split(':');
		const [s, e = s] = range.split('-').map(Number);
		for (let i = s; i <= e; i++) assign[i - 1] = Number(feat);
	}
	const nFeat = Math.max(...assign);
	const lines = body.map((l, i) => ({
		kind: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx',
		text: l.slice(1), feat: assign[i]
	}));
	lines.forEach((l, i) => { if (l.kind !== 'ctx' && !l.feat) die(`body line ${i + 1} (${l.kind}) unassigned`); });
	const existsAt = (l, stage) => l.kind === 'ctx' || (l.kind === 'add' ? l.feat <= stage : l.feat > stage);
	for (let feat = 1; feat <= nFeat; feat++) {
		// Retained lines at this stage, in order, with a marker for +/- of this feature.
		const retained = [];
		lines.forEach((l) => {
			if (l.kind === 'ctx') retained.push({ op: ' ', l });
			else if (l.feat === feat) retained.push({ op: l.kind === 'add' ? '+' : '-', l });
			else if (existsAt(l, feat)) retained.push({ op: ' ', l });
		});
		// The retained stream IS the stage-f file's hunk region (omitted lines do not exist
		// there), so one contiguous segment spanning first to last change is always valid.
		const first = retained.findIndex((r) => r.op !== ' ');
		const last = retained.length - 1 - [...retained].reverse().findIndex((r) => r.op !== ' ');
		if (first === -1) die(`feature ${feat} has no lines in this hunk`);
		const seg = retained.slice(Math.max(0, first - 3), Math.min(retained.length, last + 4));
		const sub = [seg];
		// Absolute start lines: walk the ORIGINAL hunk counting old/stage positions.
		const patches = sub.map((seg) => {
			const first = seg[0];
			let oldPos = os, stageBefore = os, stageAfter = os;
			for (const l of lines) {
				if (l === first.l) break;
				if (l.kind !== 'add') oldPos++;
				if (existsAt(l, feat - 1)) stageBefore++;
				if (existsAt(l, feat)) stageAfter++;
			}
			const oldCount = seg.filter((r) => r.op !== '+').length;
			const newCount = seg.filter((r) => r.op !== '-').length;
			return [`@@ -${stageBefore},${oldCount} +${stageAfter},${newCount} @@`,
				...seg.map((r) => r.op + r.l.text)];
		}).flat();
		writeFileSync(`${outPrefix}.${feat}.patch`,
			[`--- a/${filePath}`, `+++ b/${filePath}`, ...patches, ''].join('\n'));
		console.log(`wrote ${outPrefix}.${feat}.patch (${sub.length} sub-hunk(s), feature ${feat})`);
	}
} else if (cmd === 'pick' || cmd === 'raw') {
	const f = getFile(b);
	const out = [];
	if (cmd === 'pick') out.push(...f.prelude);
	for (const idx of rest) {
		const h = f.hunks[Number(idx)] ?? die(`no hunk #${idx} in ${b}`);
		out.push(...h);
	}
	// Trim trailing empty split artifacts.
	while (out.length && out[out.length - 1] === '') out.pop();
	if (cmd === 'pick') out.push('');
	writeFileSync(a, out.join('\n'));
	console.log(`wrote ${a}: ${rest.length} hunk(s) from ${b}`);
} else die('unknown command');
