// The terminal's link layer (module 11, the VS Code terminal parity pass): every path or
// URL a shell prints becomes a link, ctrl+clicked into the editor or the opener. The
// detection is a pure per-line scan (`detectLinks` — the tests drive it directly); the
// xterm-facing half rides the public `registerLinkProvider` (no addon: @xterm/xterm 5.5
// carries it), whose hover/underline machinery also keeps plain clicks free for selection.
// The xterm instance arrives as an argument — this file never imports @xterm/xterm at
// runtime (src/platform/lazy.ts is the only static import point the lazy-chunk seam allows;
// the terminal module already lives in the async chunk, so its type-only imports are free).

import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import type { IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { notify } from '../../platform/ui/index';
import { t } from '../../platform/i18n';

/** One detected link target within a buffer line. `target` is raw as printed — the MSYS
 *  `/c/...` spelling, a workspace-relative `src/foo.ts` — because the resolution is the
 *  wiring site's decision (the window that owns the workspace root), never this file's. */
export interface DetectedLink {
	/** URL, or a file path (absolute, MSYS-mapped, or workspace-relative). */
	kind: 'url' | 'path';
	/** The link text as the buffer holds it (trailing punctuation stripped). */
	text: string;
	/** What the link names: the URL, or the path without the line/column suffix. */
	target: string;
	/** The `:line[:column]` (or `path(line,column)`) suffix, when present (1-based). */
	line?: number;
	column?: number;
	/** Char offsets within the line: inclusive start, exclusive end. */
	start: number;
	end: number;
}

/* The per-line scan. One alternation, alternatives ordered so the more specific shapes win
   at every position (URL before POSIX-absolute: a URL's `//host/path` must not re-match as
   a path). `LINE_COLUMN` rides the whole group, so any path form takes a `:12:34` (VS Code's
   convention) or a `path(12,5)` (MSVC/GCC diagnostic) suffix. The path bodies exclude `:`
   (it is the suffix's separator), parens (they are the compiler form's), whitespace and
   quotes; trailing punctuation is trimmed after the match (a path that ends a sentence
   must not carry the period). Spaces inside paths are not detected — VS Code's own
   detector treats them the same way, and every tool-printed path of interest is quoted or
   space-free. */
const LINE_COLUMN = String.raw`(?::(\d{1,5})(?::(\d{1,5}))?|\((\d{1,5})(?:,(\d{1,5}))?\))?`;
const LINK_PATTERN = new RegExp(
	'(?:' +
	[
		// 1. http:// and https:// URLs.
		String.raw`https?:\/\/[^\s<>"'` + '`' + String.raw`]+`,
		// 2. Windows absolute paths: `C:\dir\file.ext` and `C:/dir/file.ext` alike. The
		//    lookbehind keeps a drive letter glued to a preceding word (`abC:\x`) out.
		String.raw`(?<![\w.])[A-Za-z]:[\\/][^\s:()"']+`,
		// 3. POSIX/MSYS absolute paths: `/c/Users/...` (git-bash's drive mapping), `/dev/null`.
		//    A word character or another slash must not precede the slash (`refs/heads/main`
		//    has no link inside it).
		String.raw`(?<![\w\\/])[\\/][A-Za-z0-9_.\-][^\s:()"']*`,
		// 4. Workspace-relative paths: `./bar/baz.ts`, `../x/y.z`, and two-or-more-segment
		//    forms whose final segment carries an extension (`src/foo.ts`, `a\b.rs`) — the
		//    extension requirement keeps `a/b`-shaped prose out. A word/colon/slash before
		//    the start keeps fragments inside longer tokens (an scp-style
		//    `git@host:repo/path.git`) from matching.
		String.raw`(?<![\w@+.\-/\\:])(?:\.{1,2}\/[\w@+.\-]+(?:\/[\w@+.\-]+)*|(?:[\w@+][\w@+.\-]*[\\/])+[\w@+.\-]*\.[\w@+.\-]+)`
	].join('|') +
	')' +
	LINE_COLUMN,
	'g'
);

/** How many matches one line may yield: a pathological line (base64 dumps) is bounded
 *  work, never a hang. */
const MAX_LINKS_PER_LINE = 200;

/** Strip the sentence punctuation a match swallowed: `)`, `.`, `,`, `;`, `:` from the end.
 *  The `)` of the `(line,column)` compiler form belongs to the link; a balanced `)` does
 *  too (`https://…/Name_(disambiguation)`), an unbalanced one (the URL inside `(see …)`)
 *  goes. */
function trimTrailing(raw: string): string {
	if (/\(\d{1,5}(?:,\d{1,5})?\)$/.test(raw)) return raw;
	const count = (needle: string, within: string): number => (within.match(new RegExp(needle.replace(/[()]/g, '\\$&'), 'g')) ?? []).length;
	let end = raw.length;
	while (end > 0) {
		const last = raw[end - 1]!;
		if (last === ')') {
			// The balance reads the kept prefix only: each stripped `)` must stop counting.
			const kept = raw.slice(0, end);
			if (count(')', kept) > count('(', kept)) { end--; continue; }
			break;
		}
		if ('.,;:'.includes(last)) { end--; continue; }
		break;
	}
	return raw.slice(0, end);
}

/** Split the parsed line/column suffix off a detected path text (`file.ts:12:34`,
 *  `main.rs(42,7)`). The line is 1-based exactly as tools print it. */
function splitSuffix(text: string): { target: string; line?: number; column?: number } {
	const match = /^(.+?)(?::(\d{1,5})(?::(\d{1,5}))?|\((\d{1,5})(?:,(\d{1,5}))?\))$/.exec(text);
	if (!match) return { target: text };
	const line = Number(match[2] ?? match[4]);
	const column = Number(match[3] ?? match[5]);
	return { target: match[1]!, line, column: Number.isFinite(column) && column > 0 ? column : undefined };
}

/** The pure half: every link in one line of terminal text, left to right, non-overlapping. */
export function detectLinks(lineText: string): DetectedLink[] {
	const found: DetectedLink[] = [];
	for (const match of lineText.matchAll(LINK_PATTERN)) {
		if (found.length >= MAX_LINKS_PER_LINE) break;
		const text = trimTrailing(match[0]);
		if (!text) continue;
		const start = match.index;
		const end = start + text.length;
		// Trimming can pull a match back over its neighbour's end (`(file.ts).`) — the
		// left-to-right scan stays non-overlapping.
		const previous = found[found.length - 1];
		if (previous && start < previous.end) continue;
		if (/^https?:\/\//i.test(text)) {
			found.push({ kind: 'url', text, target: text, start, end });
		} else {
			const suffix = splitSuffix(text);
			found.push({ kind: 'path', text, target: suffix.target, line: suffix.line, column: suffix.column, start, end });
		}
	}
	return found;
}

/** Resolve a detected path the way the wiring site's machine spells it: git-bash's MSYS
 *  `/c/...` mapping becomes the drive path (`C:\Users\...` — the single-letter first
 *  segment is the MSYS drive form; `/dev/null`'s `dev` segment is not one), an absolute
 *  path passes as written, and a relative path joins the workspace root with the root's
 *  own separator. Pure — tests drive it directly. */
export function resolveTerminalPath(raw: string, root: string | null | undefined): string {
	const msys = /^\/([A-Za-z])(?:\/(.*))?$/.exec(raw);
	if (msys) return `${msys[1]!.toUpperCase()}:\\${(msys[2] ?? '').replaceAll('/', '\\')}`;
	if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || !root) return raw;
	const separator = root.includes('\\') ? '\\' : '/';
	return root.replace(/[\\/]+$/, '') + separator + raw.replaceAll('/', separator);
}

/** What the wiring site must answer for the layer to open things. */
export interface TerminalLinkActions {
	/** A URL the user activated: the panel opens it through the opener plugin. */
	openUrl(url: string): void;
	/** A file path the user activated, raw as printed (`path`, `line`, `column` 1-based).
	 *  The window resolves MSYS/relative spellings against its own workspace. */
	openFile(path: string, line?: number, column?: number): void;
}

export interface TerminalLinkController {
	/** The link the pointer last hovered — the context menu's "under the cursor". */
	hoveredLink(): DetectedLink | null;
	/** Activate a link the way ctrl+click would (the context menu's Open Link). */
	open(link: DetectedLink): void;
	/** Copy a link's text (the context menu's Copy Link). */
	copy(link: DetectedLink): void;
	dispose(): void;
}

/* ---------- The hover hint ---------- */

let hint: HTMLElement | null = null;

function showHint(event: MouseEvent, link: DetectedLink): void {
	if (!hint) {
		hint = document.createElement('div');
		hint.className = 'terminal-link-hint';
		// Never a click target: the xterm hover machinery must keep seeing the cells below.
		hint.style.pointerEvents = 'none';
		document.body.appendChild(hint);
	}
	const where = link.line === undefined ? link.target : `${link.target}:${link.line}${link.column !== undefined ? `:${link.column}` : ''}`;
	hint.textContent = '';
	const target = document.createElement('span');
	target.className = 'target';
	target.textContent = where;
	const modifier = document.createElement('span');
	modifier.className = 'modifier';
	modifier.textContent = t('terminal.link.hint');
	hint.append(target, modifier);
	hint.hidden = false;
	const x = Math.min(event.clientX + 14, window.innerWidth - (hint.offsetWidth || 320) - 8);
	hint.style.left = `${Math.max(4, x)}px`;
	hint.style.top = `${event.clientY + 18}px`;
}

function hideHint(): void {
	if (hint) hint.hidden = true;
}

/* ---------- The provider ---------- */

/** Attach the link layer to one xterm instance. The controller is per session; `dispose`
 *  unregisters the provider and takes the hint down. */
export function attachTerminalLinks(term: Terminal, actions: TerminalLinkActions): TerminalLinkController {
	let hovered: DetectedLink | null = null;

	const open = (link: DetectedLink): void => {
		if (link.kind === 'url') actions.openUrl(link.target);
		else actions.openFile(link.target, link.line, link.column);
	};

	const provider: ILinkProvider = {
		provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
			const row = term.buffer.active.getLine(bufferLineNumber - 1);
			if (!row) {
				callback(undefined);
				return;
			}
			const text = row.translateToString(true);
			const links: ILink[] = [];
			for (const detected of detectLinks(text)) {
				// Cell positions are 1-based for x and the absolute buffer row for y: chars
				// [start, end) cover cells start+1 .. end (the range bounds are inclusive).
				const range: IBufferRange = {
					start: { x: detected.start + 1, y: bufferLineNumber },
					end: { x: detected.end, y: bufferLineNumber }
				};
				links.push({
					text: detected.text,
					range,
					decorations: { pointerCursor: true, underline: true },
					activate: (event: MouseEvent) => {
						// Plain clicks stay the shell's (and the selection's): only the
						// ctrl/cmd-modified activation opens — VS Code's Windows default.
						if (!(event.ctrlKey || event.metaKey)) return;
						open(detected);
					},
					hover: (event: MouseEvent) => {
						hovered = detected;
						showHint(event, detected);
					},
					leave: () => {
						if (hovered === detected) hovered = null;
						hideHint();
					}
				});
			}
			callback(links.length > 0 ? links : undefined);
		}
	};
	const disposable = term.registerLinkProvider(provider);

	return {
		hoveredLink: () => hovered,
		open,
		copy: (link: DetectedLink) => {
			void writeText(link.text).catch(() => undefined);
		},
		dispose: () => {
			disposable.dispose();
			hovered = null;
			hideHint();
		}
	};
}

/** Copy a link's target as the no-wiring fallback does (an unwired `openFile` — the remote
 *  shell has no editor group): the path lands on the clipboard, a toast says so. */
export async function copyLinkFallback(path: string): Promise<void> {
	await writeText(path);
	notify('info', t('terminal.link.copied'));
}
