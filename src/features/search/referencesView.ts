// The References panel page (module 5) — the lookup-references page: the clicked
// symbol's every whole-word site, grouped by file with per-file counts, each site
// answered not raw but specially processed before it shows — the click opens a folded
// context slice: the innermost enclosing definition's declaration line, a window of lines
// around the site, and the body's middle folded into `… N lines …` rows that click open
// (capped), so a reference's context reads structural instead of a wall of code. The
// workbench feeds it with the same gate and debounce discipline the definition page
// keeps (the panel up, this page active, the pin off); the highlighted site line — or
// the row's double click — jumps into the editor.
// The search-results options land too (2026-11-23, the owner's direction: the windows
// read as one coherent set): each site row carries the four display
// switches — the container function or class's name, the file name, the line number, the
// line text — and repeated lookups follow the output policy, appending to, replacing, or
// asking about the old results, the page accumulating the lookups as sections.

import { readFile } from '../../platform/ipc/fs';
import { symbolFileOutline, symbolLookup, symbolReferences, type SymbolRefFile } from '../../platform/ipc/symbols';

import { t, tf } from '../../platform/i18n';
import { load, save } from '../../platform/state';
import { KIND_ICONS } from './contextView';
import { highlightLine, extOf } from '../../platform/highlight';
import { actionButton, confirmDialog, el, icon, showContextMenu, type MenuEntry } from '../../platform/ui/index';

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

/** The search-results options (SPEC §1.2's four switches and §1.5's output policy),
 *  persisted — what each site row includes and what a repeated lookup does. */
export interface ResultsOptions {
	containers: boolean;
	fileNames: boolean;
	lineNumbers: boolean;
	lineText: boolean;
	output: 'append' | 'replace' | 'ask';
}

const DEFAULT_OPTIONS: ResultsOptions = { containers: false, fileNames: false, lineNumbers: true, lineText: true, output: 'replace' };

const OPTIONS_KEY = 'references.options';

/** One accumulated lookup: its subject and the answer, rendered as its own section of
 *  the page. */
interface ResultSection {
	id: number;
	subject: ReferencesSubject;
	files: SymbolRefFile[];
	filesCapped: boolean;
	totalSites: number;
	/** 0-based definition lines per repo-relative path — the def rows' marker. */
	defLines: Map<string, Map<number, string>>;
}

/** How many lines flank the site inside its enclosing body. */
const SITE_WINDOW = 2;

/** The raw window when no enclosing definition exists. */
const RAW_WINDOW = 4;

/** A fold row's expansion cap — past it the rest stays folded with its own count. */
const FOLD_MAX = 200;

/** At most this many file groups render per section; a hotter name answers the cut note. */
const FILE_CAP = 100;

/** At most this many site rows render per file group. */
const SITE_CAP = 500;

/** A site row's text is trimmed to this many characters. */
const TEXT_MAX = 240;

/** How many lookups the page accumulates before the oldest section retires — the page
 *  keeps a recent window rather than growing without bound. */
const SECTION_CAP = 8;

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

/** A site row's container prefix — the enclosing function's name, its own class's name
 *  joined ahead of it by the colon (SPEC §1.2's two container queries). */
export function containerPrefix(spans: RefSpan[], siteLine: number): string | null {
	const span = enclosingSpan(spans, siteLine);
	if (!span) return null;
	return span.container ? `${span.container}:${span.name}:` : `${span.name}:`;
}

/** A path's basename over either separator. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}

export class ReferencesView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;

	/** A jump into the editor — the line arrives 1-based, the column 1-based when known. */
	onOpen?: (path: string, line: number, column?: number) => void;

	/** The panel page's shown() asks the workbench to re-resolve the cursor symbol. */
	onNeedRoot?: () => void;

	/** The index's repo-relative paths against the workspace: the hook the host wires so
	 *  a file's read and outline open the absolute spelling the backend needs. Unwired,
	 *  the path passes through as-is. */
	resolvePath?: (path: string) => string;

	private readonly body: HTMLElement;
	private readonly pinButton: HTMLButtonElement;
	private readonly optionsButton: HTMLButtonElement;

	private pinned = false;
	private subject: ReferencesSubject | null = null;
	/** Why the subject is empty (the resolution's note), shown instead of the resting hint. */
	private note: string | undefined;
	private loading = false;
	private failed = false;
	/** The fetch's staleness counter: every setSubject drops the answers before it. */
	private generation = 0;
	/** The accumulated lookups, oldest first — one section per lookup. */
	private sections: ResultSection[] = [];
	private nextSectionId = 1;
	private readonly openGroups = new Set<string>();
	private readonly openSites = new Set<string>();
	/** Access-kind filter (Area 2: Read / Write / Call / All). */
	private accessFilter: 'all' | 'write' | 'read' | 'call' = 'all';
	/** The display options, persisted. */
	private options: ResultsOptions = { ...DEFAULT_OPTIONS, ...load<Partial<ResultsOptions>>(OPTIONS_KEY, {}) };
	/** One file's read lines and outline, kept per repo-relative path and dropped when a
	 *  lookup lands — every section's rows and folded contexts draw from it. */
	private readonly fileData = new Map<string, Promise<FileData | null>>();

	constructor() {
		this.body = el('div', 'refs-body');
		this.element = el('div', 'panel-body refs-panel', [this.body]);
		this.element.hidden = true;
		this.pinButton = actionButton('pin', t('references.pin'), () => this.togglePin());
		this.optionsButton = actionButton('settings-gear', t('references.options'), (event) => this.showOptionsMenu(event));
		this.actions = el('div', 'actions', [this.optionsButton, this.pinButton]);
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

	/** Swap the subject (or clear it, `note` explaining why) and refetch the references —
	 *  under the output policy: replace, append, or ask. */
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
		void this.load();
	}

	private async load(): Promise<void> {
		const generation = ++this.generation;
		const subject = this.subject;
		this.loading = subject !== null;
		this.failed = false;
		if (!subject) {
			// A cursor resting on nothing never wipes accumulated results under the
			// append / ask policies — only the replace policy clears the page.
			if (this.options.output === 'replace') {
				this.sections = [];
				this.openGroups.clear();
				this.openSites.clear();
				this.fileData.clear();
			}
			this.loading = false;
			this.render();
			return;
		}
		// The output policy decides what happens to the old results.
		let mode = this.options.output;
		if (mode === 'ask' && this.sections.length > 0) {
			const append = await confirmDialog(t('references.askReplace'), t('references.askAppend'));
			if (generation !== this.generation) return;
			mode = append ? 'append' : 'replace';
		}
		if (mode === 'replace') {
			this.sections = [];
			this.openGroups.clear();
			this.openSites.clear();
			this.fileData.clear();
		}
		this.render();
		try {
			const [refs, defs] = await Promise.all([symbolReferences(subject.name), symbolLookup(subject.name)]);
			// A newer setSubject owns the page now; this answer paints nothing.
			if (generation !== this.generation) return;
			const defLines = new Map<string, Map<number, string>>();
			for (const def of defs ?? []) {
				let lines = defLines.get(def.path);
				if (!lines) defLines.set(def.path, (lines = new Map()));
				lines.set(def.line, def.kind);
			}
			const files = (refs ?? [])
				.map((file) => {
					// Two hits on one line are one site — the folded context and the jump speak
					// lines, and the "%s line %d" counter counts the same grain.
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
			const filesCapped = files.length > FILE_CAP;
			const kept = filesCapped ? files.slice(0, FILE_CAP) : files;
			const section: ResultSection = {
				id: this.nextSectionId++,
				subject,
				files: kept,
				filesCapped,
				totalSites: kept.reduce((sum, file) => sum + file.matches.length, 0),
				defLines
			};
			this.sections.push(section);
			while (this.sections.length > SECTION_CAP) {
				const evicted = this.sections.shift()!;
				const prefix = `${evicted.id}:`;
				for (const key of this.openGroups) if (key.startsWith(prefix)) this.openGroups.delete(key);
				for (const key of this.openSites) if (key.startsWith(prefix)) this.openSites.delete(key);
			}
			// The newest section's first group answers open, so the page opens showing
			// sites, not a wall of headers.
			if (section.files[0]) this.openGroups.add(groupKey(section.id, section.files[0].path));
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

	/* ---------- The search-results options (SPEC §1.2/§1.5) ---------- */

	private showOptionsMenu(event: MouseEvent): void {
		const toggle = (key: keyof Omit<ResultsOptions, 'output'>): void => {
			this.options[key] = !this.options[key];
			save(OPTIONS_KEY, this.options);
			this.render();
		};
		const output = (mode: ResultsOptions['output']): void => {
			this.options.output = mode;
			save(OPTIONS_KEY, this.options);
		};
		const entries: MenuEntry[] = [
			{ label: t('references.optLineText'), checked: this.options.lineText, run: () => toggle('lineText') },
			{ label: t('references.optLineNumbers'), checked: this.options.lineNumbers, run: () => toggle('lineNumbers') },
			{ label: t('references.optFileNames'), checked: this.options.fileNames, run: () => toggle('fileNames') },
			{ label: t('references.optContainers'), checked: this.options.containers, run: () => toggle('containers') },
			'separator',
			{ label: t('references.optAppend'), checked: this.options.output === 'append', run: () => output('append') },
			{ label: t('references.optReplace'), checked: this.options.output === 'replace', run: () => output('replace') },
			{ label: t('references.optAsk'), checked: this.options.output === 'ask', run: () => output('ask') }
		];
		showContextMenu(event.clientX, event.clientY, entries);
	}

	/* ---------- Rendering ---------- */

	private render(): void {
		this.body.textContent = '';
		if (!this.subject && this.sections.length === 0) {
			this.body.appendChild(el('div', 'refs-hint', [this.note ?? t('references.hint')]));
			return;
		}
		if (this.loading) {
			this.body.appendChild(el('div', 'refs-hint', [icon('sync', 'codicon-modifier-spin'), t('relations.loading')]));
			return;
		}
		if (this.failed) {
			this.body.appendChild(el('div', 'refs-hint', [t('relations.failed')]));
			return;
		}
		if (this.sections.length === 0) {
			this.body.appendChild(el('div', 'refs-hint', [t('references.none')]));
			return;
		}
		this.sections.forEach((section, index) => this.body.appendChild(this.buildSection(section, index)));
	}

	/** One accumulated lookup: its header row (with Read/Write/Call filter pills) and file groups. */
	private buildSection(section: ResultSection, index: number): HTMLElement {
		const wrap = el('div', 'refs-section');
		if (index > 0) wrap.classList.add('refs-section-later');
		const hasAccess = section.files.some((f) => f.matches.some((m) => m.access !== undefined));
		const filteredFiles = this.accessFilter === 'all' || !hasAccess
			? section.files
			: section.files
				.map((f) => ({ ...f, matches: f.matches.filter((m) => m.access === this.accessFilter) }))
				.filter((f) => f.matches.length > 0);
		const filteredSites = filteredFiles.reduce((sum, f) => sum + f.matches.length, 0);

		const titleRow = el('div', 'refs-title', [
			icon(KIND_ICONS[section.subject.kind] ?? 'symbol-variable'),
			el('span', 'refs-name', [section.subject.name]),
			el('span', 'refs-kind', [section.subject.kind])
		]);
		if (hasAccess) {
			const bar = el('div', 'refs-access-bar');
			for (const [mode, label] of [['all', 'All'], ['write', 'W'], ['read', 'R'], ['call', 'C']] as const) {
				const btn = el('button', `refs-access-pill${this.accessFilter === mode ? ' active' : ''}`, [label]);
				btn.type = 'button';
				btn.title = mode === 'all' ? 'All references' : mode === 'write' ? 'Writes only' : mode === 'read' ? 'Reads only' : 'Calls only';
				btn.addEventListener('click', () => {
					this.accessFilter = mode;
					this.render();
				});
				bar.appendChild(btn);
			}
			titleRow.appendChild(bar);
		}
		titleRow.appendChild(el('span', 'refs-summary', [tf('references.sites', filteredSites, filteredFiles.length)]));
		wrap.appendChild(titleRow);
		if (filteredFiles.length === 0) {
			wrap.appendChild(el('div', 'refs-hint', [t('references.none')]));
			return wrap;
		}
		for (const file of filteredFiles) wrap.appendChild(this.buildGroup(section, file));
		if (section.filesCapped) wrap.appendChild(el('div', 'refs-cut', [t('references.filesCut')]));
		return wrap;
	}

	/** One file group: the collapsible header with its count, the site rows, and the
	 *  folded context under an expanded site. */
	private buildGroup(section: ResultSection, file: SymbolRefFile): HTMLElement {
		const key = groupKey(section.id, file.path);
		const open = this.openGroups.has(key);
		const header = el('div', 'refs-file');
		header.setAttribute('role', 'button');
		header.tabIndex = 0;
		header.appendChild(icon(open ? 'chevron-down' : 'chevron-right', 'twistie'));
		header.appendChild(el('span', 'refs-file-name', [baseName(file.path)]));
		header.appendChild(el('span', 'refs-file-path', [file.path]));
		header.appendChild(el('span', 'refs-file-count', [String(file.matches.length)]));
		header.title = file.path;
		const toggle = (): void => {
			if (open) this.openGroups.delete(key);
			else this.openGroups.add(key);
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
				this.paintGroup(section, group, file, file.matches.slice(0, SITE_CAP));
				group.appendChild(el('div', 'refs-cut', [t('references.sitesCut')]));
			} else {
				this.paintGroup(section, group, file, file.matches);
			}
		}
		return group;
	}

	/** The group's site rows: the def marker, the context arrow, the row's own segments
	 *  (the container prefix, the file name, the 1-based line number, the line's code
	 *  colored), each present per its switch. */
	private paintGroup(section: ResultSection, group: HTMLElement, file: SymbolRefFile, matches: SymbolRefFile['matches']): void {
		const pending = el('div', 'refs-hint', [icon('sync', 'codicon-modifier-spin')]);
		group.appendChild(pending);
		void this.loadFile(file.path).then((data) => {
			if (!this.openGroups.has(groupKey(section.id, file.path)) || !pending.isConnected) return;
			pending.remove();
			const defs = section.defLines.get(file.path);
			for (const match of matches) {
				if (!this.openGroups.has(groupKey(section.id, file.path))) return;
				group.appendChild(this.buildSite(section, file, match, data, defs?.get(match.line - 1)));
			}
			// An expanded site of a re-rendered group repaints its folded context from the cache.
			for (const match of matches) {
				if (this.openSites.has(siteKey(section.id, file.path, match.line))) {
					const key = siteKey(section.id, file.path, match.line);
					group.querySelector(`.refs-site[data-key="${cssEscape(key)}"] .refs-ctx-toggle`)?.classList.add('open');
					void this.expandSite(section, group, file, match.line, false);
				}
			}
		});
	}

	private buildSite(section: ResultSection, file: SymbolRefFile, match: SymbolRefFile['matches'][number], data: FileData | null, defKind: string | undefined): HTMLElement {
		const key = siteKey(section.id, file.path, match.line);
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
		// The context's toggle is its own affordance — the row itself is the jump (one
		// click navigates), the arrow folds and unfolds.
		const context = el('span', 'refs-ctx-toggle', [icon('chevron-right', 'twistie')]);
		context.title = t('references.contextTitle');
		context.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.toggleSite(section, row, file, match.line, context);
		});
		row.appendChild(context);
		if (match.access) {
			const letter = match.access === 'write' ? 'W' : match.access === 'call' ? 'C' : match.access === 'decl' ? 'D' : 'R';
			const badge = el('span', `refs-access-badge refs-access-${match.access}`, [letter]);
			badge.title = match.access;
			row.appendChild(badge);
		}
		// The row's segments, each per its switch: the enclosing container's name,
		// the file name, the 1-based line number, and the line's text.
		if (this.options.containers) {
			const prefix = containerPrefix(data?.spans ?? [], match.line - 1);
			if (prefix) row.appendChild(el('span', 'refs-site-container', [prefix]));
		}
		if (this.options.fileNames) row.appendChild(el('span', 'refs-site-file', [tf('references.inFile', baseName(file.path))]));
		if (this.options.lineNumbers) {
			// The index speaks 1-based lines; the file's lines array and the outline spans are
			// 0-based — the site row shows the line as the backend named it.
			row.appendChild(el('span', 'refs-site-num', [String(match.line)]));
		}
		if (this.options.lineText) {
			const lines = data?.lines ?? [];
			const at = match.line - 1;
			row.appendChild(this.paintLineText((lines[at] ?? '').trimEnd(), extOf(file.path), section.subject.name));
		}
		row.title = t('references.siteTitle');
		row.addEventListener('click', () => this.onOpen?.(file.path, match.line, match.column));
		row.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.onOpen?.(file.path, match.line, match.column);
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
	private paintLineText(text: string, ext: string, highlightName = this.subject?.name, cap = TEXT_MAX): HTMLElement {
		const span = el('span', 'refs-site-text');
		const shown = text.slice(0, cap);
		for (const segment of highlightLine(shown, ext, highlightName)) {
			span.appendChild(segment.cls ? el('span', segment.cls, [segment.text]) : document.createTextNode(segment.text));
		}
		if (text.length > cap) span.appendChild(document.createTextNode('…'));
		return span;
	}

	/** Open or close one site's folded context; the row's chevron flips with it. */
	private async toggleSite(section: ResultSection, row: HTMLElement, file: SymbolRefFile, line: number, toggle?: HTMLElement): Promise<void> {
		const key = siteKey(section.id, file.path, line);
		if (!this.openSites.delete(key)) {
			this.openSites.add(key);
			toggle?.classList.add('open');
			await this.expandSite(section, row.parentElement ?? row, file, line, true);
			return;
		}
		toggle?.classList.remove('open');
		row.parentElement?.querySelector(`.refs-ctx[data-for="${cssEscape(key)}"]`)?.remove();
	}

	/** Build and mount one site's folded context after its row: the pure slice over the
	 *  file's cached lines and outline, the fold rows wired to open in place. `line` is the
	 *  index's 1-based site line. */
	private async expandSite(section: ResultSection, host: HTMLElement, file: SymbolRefFile, line: number, scroll: boolean): Promise<void> {
		const key = siteKey(section.id, file.path, line);
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
				ctx.appendChild(this.buildFold(entry.from ?? 0, entry.to ?? 0, lines, extOf(file.path), section.subject.name));
			} else {
				const at = entry.line ?? 0;
				const lineElt = this.buildContextLine(lines[at] ?? '', extOf(file.path), section.subject.name);
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
	private buildFold(from: number, to: number, lines: string[], ext: string, highlightName?: string): HTMLElement {
		const fold = el('div', 'ref-ctx-fold', [tf('references.fold', to - from + 1)]);
		fold.setAttribute('role', 'button');
		fold.tabIndex = 0;
		const open = (): void => {
			const end = Math.min(to, from + FOLD_MAX - 1);
			const frag = document.createDocumentFragment();
			for (let at = from; at <= end; at++) frag.appendChild(this.buildContextLine(lines[at] ?? '', ext, highlightName));
			if (end < to) frag.appendChild(this.buildFold(end + 1, to, lines, ext, highlightName));
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
	private buildContextLine(text: string, ext: string, highlightName?: string): HTMLElement {
		return el('div', 'ref-ctx-line', [this.paintLineText(text.trimEnd(), ext, highlightName)]);
	}
}

interface FileData {
	lines: string[];
	spans: RefSpan[];
}

/** A group's identity within the accumulated page: the section's own namespace. The
 *  separator is the plain colon — these keys ride the attribute selectors too. */
function groupKey(index: number, path: string): string {
	return `${index}:${path}`;
}

/** The site's identity within one section: two same-line matches are one site. */
function siteKey(index: number, path: string, line: number): string {
	return `${index}:${path}:${line}`;
}

/** An attribute-selector escape that answers where `CSS.escape` does not (jsdom). */
function cssEscape(value: string): string {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}
