// The References panel page (module 5) — the classic lookup-references page: the
// clicked symbol's every whole-word site, grouped by file with per-file counts, each site
// answered not raw but specially processed before it shows — the click opens a folded
// context slice: the innermost enclosing definition's declaration line, a window of lines
// around the site, and the body's middle folded into `… N lines …` rows that click open
// (capped), the way the classic lookup page keeps a reference's context structural instead of a
// wall of code. The workbench feeds it with the same gate and debounce discipline the
// definition page keeps (the panel up, this page active, the pin off); the highlighted
// site line — or the row's double click — jumps into the editor.

import { readFile } from '../../platform/ipc/fs';
import { symbolFileOutline, symbolLookup, symbolReferences, type SymbolRefFile } from '../../platform/ipc/symbols';

import { t, tf } from '../../platform/i18n';
import { KIND_ICONS } from './contextView';
import { highlightLine, extOf } from '../../platform/highlight';
import { actionButton, el, icon } from '../../platform/ui/index';

import './references.css';

/** The subject the page shows: the resolved symbol under the cursor. */
export interface ReferencesSubject {
	kind: string;
	name: string;
	/** Repo-relative path of the definition — the index's own vocabulary. */
	path: string;
	/** 0-based declaration line. */
	line: number;
}

/** One definition span of the file's outline — the folding's structure source. */
export interface RefSpan {
	kind: string;
	name: string;
	container: string | null;
	/** 0-based declaration line. */
	line: number;
	/** 0-based last line of the body; equals `line` when the end is unknown. */
	endLine: number;
}

/** One row of a folded context: a source line, the highlighted site line, or a fold. */
export interface ContextRow {
	kind: 'code' | 'site' | 'fold';
	/** 0-based source line, for the code and site rows. */
	line?: number;
	/** The fold's inclusive span, for the fold rows. */
	from?: number;
	to?: number;
}

/** How many lines flank the site inside its enclosing body. */
const SITE_WINDOW = 2;

/** The raw window when no enclosing definition exists. */
const RAW_WINDOW = 4;

/** A fold row's expansion cap — past it the rest stays folded with its own count. */
const FOLD_MAX = 200;

/** At most this many file groups render; a hotter name answers the cut note. */
const FILE_CAP = 100;

/** At most this many site rows render per file group. */
const SITE_CAP = 500;

/** A site row's text is trimmed to this many characters. */
const TEXT_MAX = 240;

/** The innermost definition span covering `siteLine` — the smallest span wins, the
 *  declaration line included (a definition site's own body is the enclosing structure). */
export function enclosingSpan(spans: RefSpan[], siteLine: number): RefSpan | null {
	let best: RefSpan | null = null;
	for (const span of spans) {
		if (span.line > siteLine || span.endLine < siteLine) continue;
		if (!best || span.endLine - span.line < best.endLine - best.line) best = span;
	}
	return best;
}

/** The folded context slice of one site (module 5's special processing, pure for the
 *  tests): the enclosing definition's declaration line, a fold over the body's run-up,
 *  the lines around the site, a fold over the body's tail — and, with nothing enclosing,
 *  a raw window with no folds. */
export function foldedContext(lines: string[], spans: RefSpan[], siteLine: number): ContextRow[] {
	const rows: ContextRow[] = [];
	const span = enclosingSpan(spans, siteLine);
	if (!span) {
		const from = Math.max(0, siteLine - RAW_WINDOW);
		const to = Math.min(lines.length - 1, siteLine + RAW_WINDOW);
		for (let at = from; at <= to; at++) rows.push({ kind: at === siteLine ? 'site' : 'code', line: at });
		return rows;
	}
	const bodyFrom = span.line + 1;
	const bodyTo = Math.max(span.endLine, span.line);
	// A definition site sits on the declaration line itself: the site row is the head, and
	// the whole body folds behind it.
	if (siteLine <= span.line) {
		rows.push({ kind: 'site', line: span.line });
		if (bodyTo >= bodyFrom) rows.push({ kind: 'fold', from: bodyFrom, to: bodyTo });
		return rows;
	}
	rows.push({ kind: 'code', line: span.line });
	const winFrom = Math.max(bodyFrom, siteLine - SITE_WINDOW);
	const winTo = Math.min(bodyTo, siteLine + SITE_WINDOW);
	if (winFrom > bodyFrom) rows.push({ kind: 'fold', from: bodyFrom, to: winFrom - 1 });
	for (let at = winFrom; at <= winTo; at++) rows.push({ kind: at === siteLine ? 'site' : 'code', line: at });
	if (winTo < bodyTo) rows.push({ kind: 'fold', from: winTo + 1, to: bodyTo });
	return rows;
}

/** A path's basename over either separator. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}

export class ReferencesView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;

	/** A jump into the editor — the line arrives 1-based. */
	onOpen?: (path: string, line: number) => void;

	/** The panel page's shown() asks the workbench to re-resolve the cursor symbol. */
	onNeedRoot?: () => void;

	/** The index's repo-relative paths against the workspace: the hook the host wires so
	 *  a file's read and outline open the absolute spelling the backend needs. Unwired,
	 *  the path passes through as-is. */
	resolvePath?: (path: string) => string;

	private readonly body: HTMLElement;
	private readonly pinButton: HTMLButtonElement;

	private pinned = false;
	private subject: ReferencesSubject | null = null;
	/** Why the subject is empty (the resolution's note), shown instead of the resting hint. */
	private note: string | undefined;
	private loading = false;
	private failed = false;
	/** The fetch's staleness counter: every setSubject drops the answers before it. */
	private generation = 0;
	private files: SymbolRefFile[] = [];
	/** 0-based definition lines per repo-relative path — the def rows' marker. */
	private readonly defLines = new Map<string, Map<number, string>>();
	private filesCapped = false;
	private totalSites = 0;
	private readonly openGroups = new Set<string>();
	private readonly openSites = new Set<string>();
	/** One file's read lines and outline, kept per repo-relative path and dropped when the
	 *  subject changes — a group's rows and every folded context slice draw from it. */
	private readonly fileData = new Map<string, Promise<FileData | null>>();

	constructor() {
		this.body = el('div', 'refs-body');
		this.element = el('div', 'panel-body refs-panel', [this.body]);
		this.element.hidden = true;
		this.pinButton = actionButton('pin', t('references.pin'), () => this.togglePin());
		this.actions = el('div', 'actions', [this.pinButton]);
		this.render();
	}

	private togglePin(): void {
		this.pinned = !this.pinned;
		this.pinButton.title = this.pinned ? t('references.unpin') : t('references.pin');
		this.pinButton.setAttribute('aria-label', this.pinButton.title);
		this.pinButton.innerHTML = '';
		this.pinButton.appendChild(icon(this.pinned ? 'pinned' : 'pin'));
	}

	/** While pinned, the auto-following pauses: the cursor can roam without changing the list. */
	isPinned(): boolean {
		return this.pinned;
	}

	/** Swap the subject (or clear it, `note` explaining why) and refetch the references. */
	setSubject(subject: ReferencesSubject | null, note?: string): void {
		const same =
			this.subject !== null &&
			subject !== null &&
			this.subject.name === subject.name &&
			this.subject.path === subject.path &&
			this.subject.line === subject.line;
		if (same) return;
		this.subject = subject ? { ...subject } : null;
		this.note = note;
		this.openGroups.clear();
		this.openSites.clear();
		this.fileData.clear();
		void this.load();
	}

	private async load(): Promise<void> {
		const generation = ++this.generation;
		const subject = this.subject;
		this.loading = subject !== null;
		this.failed = false;
		this.files = [];
		this.defLines.clear();
		this.filesCapped = false;
		this.totalSites = 0;
		this.render();
		if (!subject) return;
		try {
			const [refs, defs] = await Promise.all([symbolReferences(subject.name), symbolLookup(subject.name)]);
			// A newer setSubject owns the page now; this answer paints nothing.
			if (generation !== this.generation) return;
			for (const def of defs ?? []) {
				let lines = this.defLines.get(def.path);
				if (!lines) this.defLines.set(def.path, (lines = new Map()));
				lines.set(def.line, def.kind);
			}
			this.files = (refs ?? [])
				.map((file) => {
					// Two hits on one line are one site — the folded context and the jump speak
					// lines, as Source Insight's "%s line %d" unit does.
					const seen = new Set<number>();
					const matches = [...file.matches]
						.sort((a, b) => a.line - b.line || a.column - b.column)
						.filter((match) => {
							if (seen.has(match.line)) return false;
							seen.add(match.line);
							return true;
						});
					return { ...file, matches };
				})
				.sort((a, b) => a.path.localeCompare(b.path));
			this.filesCapped = this.files.length > FILE_CAP;
			if (this.filesCapped) this.files = this.files.slice(0, FILE_CAP);
			this.totalSites = this.files.reduce((sum, file) => sum + file.matches.length, 0);
			// The first group answers open, so the page opens showing sites, not a wall of headers.
			if (this.files[0]) this.openGroups.add(this.files[0].path);
		} catch {
			if (generation !== this.generation) return;
			this.failed = true;
		}
		this.loading = false;
		this.render();
	}

	/** The file's lines and outline, fetched once per subject — the folded contexts and the
	 *  site rows both draw from it. A vanished or unreadable file answers null and is not
	 *  kept (the group paints its sites without texts instead). */
	private loadFile(path: string): Promise<FileData | null> {
		const cached = this.fileData.get(path);
		if (cached) return cached;
		const fetch = (async (): Promise<FileData | null> => {
			try {
				const absolute = this.resolvePath?.(path) ?? path;
				const [file, outline] = await Promise.all([readFile(absolute), symbolFileOutline(absolute)]);
				if (file?.contents == null) return null;
				return {
					lines: file.contents.split('\n'),
					spans: (outline?.symbols ?? []).map((symbol) => ({
						kind: symbol.kind,
						name: symbol.name,
						container: symbol.container,
						line: symbol.line,
						endLine: symbol.endLine
					}))
				};
			} catch {
				return null;
			}
		})();
		this.fileData.set(path, fetch);
		void fetch.then((data) => {
			if (data === null) this.fileData.delete(path);
		});
		return fetch;
	}

	/** The panel page's activation: the workbench's hook re-resolves the cursor symbol. */
	shown(): void {
		this.onNeedRoot?.();
	}

	/* ---------- Rendering ---------- */

	private render(): void {
		this.body.textContent = '';
		if (!this.subject) {
			this.body.appendChild(el('div', 'refs-hint', [this.note ?? t('references.hint')]));
			return;
		}
		this.body.appendChild(this.buildHeader(this.subject));
		if (this.loading) {
			this.body.appendChild(el('div', 'refs-hint', [icon('sync', 'codicon-modifier-spin'), t('relations.loading')]));
			return;
		}
		if (this.failed) {
			this.body.appendChild(el('div', 'refs-hint', [t('relations.failed')]));
			return;
		}
		if (this.files.length === 0) {
			this.body.appendChild(el('div', 'refs-hint', [t('references.none')]));
			return;
		}
		for (const file of this.files) this.body.appendChild(this.buildGroup(file));
		if (this.filesCapped) this.body.appendChild(el('div', 'refs-cut', [t('references.filesCut')]));
	}

	/** The header row: the kind's icon and caption, the name, and the site/file summary. */
	private buildHeader(subject: ReferencesSubject): HTMLElement {
		return el('div', 'refs-title', [
			icon(KIND_ICONS[subject.kind] ?? 'symbol-variable'),
			el('span', 'refs-name', [subject.name]),
			el('span', 'refs-kind', [subject.kind]),
			el('span', 'refs-summary', [tf('references.sites', this.totalSites, this.files.length)])
		]);
	}

	/** One file group: the collapsible header with its count, the site rows, and the
	 *  folded context under an expanded site. */
	private buildGroup(file: SymbolRefFile): HTMLElement {
		const open = this.openGroups.has(file.path);
		const header = el('div', 'refs-file');
		header.setAttribute('role', 'button');
		header.tabIndex = 0;
		header.appendChild(icon(open ? 'chevron-down' : 'chevron-right', 'twistie'));
		header.appendChild(el('span', 'refs-file-name', [baseName(file.path)]));
		header.appendChild(el('span', 'refs-file-path', [file.path]));
		header.appendChild(el('span', 'refs-file-count', [String(file.matches.length)]));
		header.title = file.path;
		const toggle = (): void => {
			if (open) this.openGroups.delete(file.path);
			else this.openGroups.add(file.path);
			this.render();
		};
		header.addEventListener('click', toggle);
		header.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				toggle();
			}
		});
		const group = el('div', 'refs-group', [header]);
		if (open) {
			if (file.matches.length > SITE_CAP) {
				this.paintGroup(group, file, file.matches.slice(0, SITE_CAP));
				group.appendChild(el('div', 'refs-cut', [t('references.sitesCut')]));
			} else {
				this.paintGroup(group, file, file.matches);
			}
		}
		return group;
	}

	/** The group's site rows: the def marker, the context arrow, the 1-based line number,
	 *  and the line's code colored. */
	private paintGroup(group: HTMLElement, file: SymbolRefFile, matches: SymbolRefFile['matches']): void {
		const pending = el('div', 'refs-hint', [icon('sync', 'codicon-modifier-spin')]);
		group.appendChild(pending);
		void this.loadFile(file.path).then((data) => {
			if (!this.openGroups.has(file.path) || !pending.isConnected) return;
			pending.remove();
			const lines = data?.lines ?? [];
			const defs = this.defLines.get(file.path);
			for (const match of matches) {
				if (!this.openGroups.has(file.path)) return;
				group.appendChild(this.buildSite(file, match, lines, defs?.get(match.line - 1)));
			}
			// An expanded site of a re-rendered group repaints its folded context from the cache.
			for (const match of matches) {
				if (this.openSites.has(siteKey(file.path, match.line))) {
					const key = siteKey(file.path, match.line);
					group.querySelector(`.refs-site[data-key="${cssEscape(key)}"] .refs-ctx-toggle`)?.classList.add('open');
					void this.expandSite(group, file, match.line, false);
				}
			}
		});
	}

	private buildSite(file: SymbolRefFile, match: { line: number; column: number }, lines: string[], defKind: string | undefined): HTMLElement {
		const key = siteKey(file.path, match.line);
		const row = el('div', 'refs-site');
		row.dataset['key'] = key;
		row.tabIndex = 0;
		if (defKind) {
			const marker = icon(KIND_ICONS[defKind] ?? 'symbol-variable', 'refs-def');
			marker.title = t('references.defTitle');
			row.appendChild(marker);
		} else {
			row.appendChild(el('span', 'refs-def-space'));
		}
		// The context's toggle is its own affordance — the row itself is the jump (Source
		// Insight's search results: one click navigates), the arrow folds and unfolds.
		const context = el('span', 'refs-ctx-toggle', [icon('chevron-right', 'twistie')]);
		context.title = t('references.contextTitle');
		context.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.toggleSite(row, file, match.line, context);
		});
		row.appendChild(context);
		// The index speaks 1-based lines; the file's lines array and the outline spans are
		// 0-based — the site row shows the line as the backend named it.
		const at = match.line - 1;
		row.appendChild(el('span', 'refs-site-num', [String(match.line)]));
		row.appendChild(this.paintLineText((lines[at] ?? '').trimEnd(), extOf(file.path)));
		row.title = t('references.siteTitle');
		row.addEventListener('click', () => this.onOpen?.(file.path, match.line));
		row.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.onOpen?.(file.path, match.line);
			} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				const rows = this.body.querySelectorAll<HTMLElement>('.refs-site');
				const at = Array.from(rows).indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1);
				rows[at]?.focus();
			}
		});
		return row;
	}

	/** One line's code, colored — the shared tokenizer's runs, the searched name riding
	 *  the emphasis class over its word tokens. */
	private paintLineText(text: string, ext: string, cap = TEXT_MAX): HTMLElement {
		const span = el('span', 'refs-site-text');
		const shown = text.slice(0, cap);
		for (const segment of highlightLine(shown, ext, this.subject?.name)) {
			span.appendChild(segment.cls ? el('span', segment.cls, [segment.text]) : document.createTextNode(segment.text));
		}
		if (text.length > cap) span.appendChild(document.createTextNode('…'));
		return span;
	}

	/** Open or close one site's folded context; the row's chevron flips with it. */
	private async toggleSite(row: HTMLElement, file: SymbolRefFile, line: number, toggle?: HTMLElement): Promise<void> {
		const key = siteKey(file.path, line);
		if (!this.openSites.delete(key)) {
			this.openSites.add(key);
			toggle?.classList.add('open');
			await this.expandSite(row.parentElement ?? row, file, line, true);
			return;
		}
		toggle?.classList.remove('open');
		row.parentElement?.querySelector(`.refs-ctx[data-for="${cssEscape(key)}"]`)?.remove();
	}

	/** Build and mount one site's folded context after its row: the pure slice over the
	 *  file's cached lines and outline, the fold rows wired to open in place. `line` is the
	 *  index's 1-based site line. */
	private async expandSite(host: HTMLElement, file: SymbolRefFile, line: number, scroll: boolean): Promise<void> {
		const key = siteKey(file.path, line);
		const data = await this.loadFile(file.path);
		if (!this.openSites.has(key) || !host.isConnected) return;
		host.querySelector(`.refs-ctx[data-for="${cssEscape(key)}"]`)?.remove();
		const row = host.querySelector<HTMLElement>(`.refs-site[data-key="${cssEscape(key)}"]`);
		if (!row) return;
		const ctx = el('div', 'refs-ctx');
		ctx.dataset['for'] = key;
		const lines = data?.lines ?? [];
		const spans = data?.spans ?? [];
		for (const entry of foldedContext(lines, spans, line - 1)) {
			if (entry.kind === 'fold') {
				ctx.appendChild(this.buildFold(entry.from ?? 0, entry.to ?? 0, lines, extOf(file.path)));
			} else {
				const at = entry.line ?? 0;
				const lineElt = this.buildContextLine(lines[at] ?? '', extOf(file.path));
				if (entry.kind === 'site') {
					lineElt.classList.add('ref-ctx-site');
					lineElt.title = t('references.openTitle');
					lineElt.addEventListener('click', () => this.onOpen?.(file.path, line));
				}
				ctx.appendChild(lineElt);
			}
		}
		row.after(ctx);
		if (scroll) ctx.scrollIntoView({ block: 'nearest' });
	}

	/** A fold row: `… N lines …` — the click replaces it with the folded lines, capped,
	 *  the remainder staying a fold row of its own. */
	private buildFold(from: number, to: number, lines: string[], ext: string): HTMLElement {
		const fold = el('div', 'ref-ctx-fold', [tf('references.fold', to - from + 1)]);
		fold.setAttribute('role', 'button');
		fold.tabIndex = 0;
		const open = (): void => {
			const end = Math.min(to, from + FOLD_MAX - 1);
			const frag = document.createDocumentFragment();
			for (let at = from; at <= end; at++) frag.appendChild(this.buildContextLine(lines[at] ?? '', ext));
			if (end < to) frag.appendChild(this.buildFold(end + 1, to, lines, ext));
			fold.replaceWith(frag);
		};
		fold.addEventListener('click', open);
		fold.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				open();
			}
		});
		return fold;
	}

	/** One context code line, colored like the site rows. */
	private buildContextLine(text: string, ext: string): HTMLElement {
		return el('div', 'ref-ctx-line', [this.paintLineText(text.trimEnd(), ext)]);
	}
}

interface FileData {
	lines: string[];
	spans: RefSpan[];
}

/** The site's identity within one subject: two same-line matches are one site. */
function siteKey(path: string, line: number): string {
	return `${path}:${line}`;
}

/** An attribute-selector escape that answers where `CSS.escape` does not (jsdom). */
function cssEscape(value: string): string {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}
