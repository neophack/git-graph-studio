// The Definition panel page (module 5) — the bottom panel's answer to a click, the
// whole declaring file as the page (2026-11-23, the owner's direction: the windows read
// as one coherent set): the file stands as a live read-only view — scrolled
// to the declaration, the symbol's own line span marked as the selection — not a slice.
// Enriched with:
// - Back/Forward navigation history for chain-browsing identifiers inside the pane
// - Multi-definition switcher (declaration vs. implementation / overloads)
// - Native 9-volume metadata bar (`.ggs_sym` effective lines, control-flow complexity,
//   goto count, parameter count; `.ggs_xc`/`.ggs_xr` code vs. comment reference counts)
// - Inline `#define` macro expansion preview for macro subjects
// - CSS line-number gutter (preserving verbatim `textContent`), copy actions, and
//   enriched context menu (Sync to Editor, Relation Graph, Find References, Copy)

import { readFile } from '../../platform/ipc/fs';
import {
	symbolLookup,
	symbolMacroExpand,
	symbolRefStats,
	symbolScopeLookup,
	type MacroExpansion,
	type RefStats
} from '../../platform/ipc/symbols';
import type { WsSymbol } from '../../platform/ipc/search';

import { onLocaleChange, t, tf, type LocaleKey } from '../../platform/i18n';
import { highlightLine, extOf, wordAt } from '../../platform/highlight';
import { KIND_ICONS } from './contextView';
import { actionButton, el, icon, showContextMenu, type MenuEntry } from '../../platform/ui/index';

import './definition.css';

/** The definition the page shows: the resolved symbol with its body's reach. */
export interface DefinitionSubject {
	kind: string;
	name: string;
	/** Repo-relative path of the definition — the index's own vocabulary. */
	path: string;
	/** 0-based declaration line. */
	line: number;
	/** 0-based line the definition's body ends on (the index's end_line; absent falls
	 *  back to the declaration's line and the macro rule extends the span). */
	endLine?: number;
}

/** The file-level ceiling (SPEC §2.2: `FUN_004174d0(file) < 0x100001` — one byte over a
 *  mebibite refuses with "file too big"). */
const FILE_MAX = 1024 * 1024 + 1;
const HISTORY_CAP = 50;

/** Split a path into its parent directory and basename over either separator. */
function splitDirAndBase(path: string): { dir: string; file: string } {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	if (cut === -1) return { dir: '', file: path };
	return { dir: path.slice(0, cut), file: path.slice(cut + 1) };
}

const KIND_KEYS: Record<string, LocaleKey> = {
	function: 'symbol.kind.function',
	method: 'symbol.kind.method',
	class: 'symbol.kind.class',
	struct: 'symbol.kind.struct',
	union: 'symbol.kind.union',
	file: 'symbol.kind.file',
	interface: 'symbol.kind.interface',
	enum: 'symbol.kind.enum',
	enumMember: 'symbol.kind.enumMember',
	constant: 'symbol.kind.constant',
	member: 'symbol.kind.member',
	property: 'symbol.kind.property',
	field: 'symbol.kind.field',
	namespace: 'symbol.kind.namespace',
	module: 'symbol.kind.module',
	package: 'symbol.kind.package',
	type: 'symbol.kind.type',
	typedef: 'symbol.kind.typedef',
	typeParameter: 'symbol.kind.typeParameter',
	macro: 'symbol.kind.macro',
	label: 'symbol.kind.label',
	parameter: 'symbol.kind.parameter',
	variable: 'symbol.kind.variable'
};

/** Human-readable localized symbol kind label: e.g. `function` → `Function` / `函数`. */
function formatKind(kind: string): string {
	if (!kind) return t('symbol.kind.symbol');
	const key = KIND_KEYS[kind];
	if (key) return t(key);
	const spaced = kind.replace(/([a-z])([A-Z])/g, '$1 $2');
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Format the panel header's location summary, e.g.
 *  `Function in location buffer.c (PAS\pas odo) at line 99 (6 lines)`. */
export function formatDefinitionLocation(subject: DefinitionSubject, lineCount: number): string {
	const kind = formatKind(subject.kind);
	const { dir, file } = splitDirAndBase(subject.path);
	const location = dir ? `${file} (${dir})` : file;
	const count = Math.max(1, lineCount);
	const linesLabel = count === 1
		? t('definition.location.oneLine')
		: tf('definition.location.lines', count);
	return tf('definition.location', kind, location, subject.line + 1, linesLabel);
}

function copyText(text: string): void {
	try {
		void navigator.clipboard?.writeText(text);
	} catch {
		// Clipboard may be unavailable in headless tests.
	}
}

export class DefinitionView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;
	/** The panel header's location summary — mounted beside the panel tabs so the file,
	 *  directory, line and span stay visible even after the code pane scrolls down. */
	readonly headerInfo: HTMLButtonElement;

	/** A location-button click — the line arrives 1-based. */
	onOpenDefinition?: (path: string, line: number) => void;

	/** Optional hook to jump directly to the Relation Graph rooted on this symbol. */
	onShowRelations?: (subject: DefinitionSubject) => void;

	/** Optional hook to open Find References for this symbol. */
	onFindReferences?: (subject: DefinitionSubject) => void;

	/** The panel page's shown() asks the workbench to re-resolve the cursor symbol. */
	onNeedRoot?: () => void;

	/** The index's repo-relative paths against the workspace: the hook the host wires so
	 *  the body's read opens the absolute spelling the backend's read_file needs. Unwired,
	 *  the path passes through as-is. */
	resolvePath?: (path: string) => string;

	private readonly body: HTMLElement;
	private readonly backButton: HTMLButtonElement;
	private readonly forwardButton: HTMLButtonElement;
	private readonly pinButton: HTMLButtonElement;

	private pinned = false;
	private subject: DefinitionSubject | null = null;
	/** Why the subject is empty (the resolution's note), shown instead of the resting hint. */
	private note: string | undefined;
	private loading = false;
	private failed = false;
	/** The file was past the ceiling — the page's own refusal. */
	private tooBig = false;
	/** The whole file's text once read, and its lines — the view's live document. */
	private fileLines: string[] | null = null;
	/** The fetch's staleness counter: every setDefinition drops the answers before it. */
	private generation = 0;

	/** Chain-browsing navigation history stack. */
	private readonly history: DefinitionSubject[] = [];
	private historyAt = -1;
	private navigatingHistory = false;

	/** Async 9-volume metadata, sibling definitions, and macro expansion for the active subject. */
	private refStats: RefStats | null = null;
	private siblingDefs: WsSymbol[] = [];
	private macroExpansion: MacroExpansion | null = null;
	private metaHost: HTMLElement | null = null;

	constructor() {
		this.body = el('div', 'def-body');
		this.body.addEventListener('click', this.onBodyClick);
		this.body.addEventListener('contextmenu', this.onBodyContextMenu);
		this.element = el('div', 'panel-body def-panel', [this.body]);
		this.element.hidden = true;
		this.backButton = actionButton('arrow-left', t('relations.back'), () => this.goHistory(-1));
		this.forwardButton = actionButton('arrow-right', t('relations.forward'), () => this.goHistory(1));
		this.pinButton = actionButton('pin', t('definition.pin'), () => this.togglePin());
		this.actions = el('div', 'actions', [this.backButton, this.forwardButton, this.pinButton]);
		this.headerInfo = el('button', 'def-header-info') as HTMLButtonElement;
		this.headerInfo.type = 'button';
		this.headerInfo.hidden = true;
		this.headerInfo.addEventListener('click', () => {
			if (this.subject) this.onOpenDefinition?.(this.subject.path, this.subject.line + 1);
		});
		this.paintHistoryButtons();
		onLocaleChange(() => {
			this.pinButton.title = this.pinned ? t('definition.unpin') : t('definition.pin');
			this.pinButton.setAttribute('aria-label', this.pinButton.title);
			this.paintHistoryButtons();
			this.render();
		});
		this.render();
	}

	private paintHistoryButtons(): void {
		this.backButton.disabled = this.historyAt <= 0;
		this.forwardButton.disabled = this.historyAt >= this.history.length - 1;
		this.backButton.title = t('relations.back');
		this.forwardButton.title = t('relations.forward');
	}

	private pushHistory(subject: DefinitionSubject): void {
		const top = this.history[this.historyAt];
		if (top && top.name === subject.name && top.path === subject.path && top.line === subject.line) return;
		this.history.length = this.historyAt + 1;
		this.history.push({ ...subject });
		if (this.history.length > HISTORY_CAP) this.history.shift();
		this.historyAt = this.history.length - 1;
		this.paintHistoryButtons();
	}

	private goHistory(delta: number): void {
		const next = this.historyAt + delta;
		const entry = this.history[next];
		if (!entry) return;
		this.historyAt = next;
		this.paintHistoryButtons();
		this.navigatingHistory = true;
		this.setDefinition(entry);
	}

	private togglePin(): void {
		this.setPinned(!this.pinned);
	}

	/** The pin's state, from the host's side too: a relation click's feed pins the page
	 *  ahead of its own activation, so the cursor-follow's gate refuses and the symbol
	 *  the click named stays standing. */
	setPinned(pinned: boolean): void {
		this.pinned = pinned;
		this.pinButton.title = this.pinned ? t('definition.unpin') : t('definition.pin');
		this.pinButton.setAttribute('aria-label', this.pinButton.title);
		this.pinButton.innerHTML = '';
		this.pinButton.appendChild(icon(this.pinned ? 'pinned' : 'pin'));
	}

	/** While pinned, the auto-following pauses: the cursor can roam without changing the content. */
	isPinned(): boolean {
		return this.pinned;
	}

	/** Swap the subject (or clear it, `note` explaining why) and refetch its content. */
	setDefinition(subject: DefinitionSubject | null, note?: string): void {
		const same =
			this.subject !== null &&
			subject !== null &&
			this.subject.name === subject.name &&
			this.subject.path === subject.path &&
			this.subject.line === subject.line;
		if (same) {
			this.navigatingHistory = false;
			return;
		}
		this.subject = subject ? { ...subject } : null;
		this.note = note;
		if (subject && !this.navigatingHistory) this.pushHistory(subject);
		this.navigatingHistory = false;
		void this.load();
	}

	private async load(): Promise<void> {
		const generation = ++this.generation;
		const subject = this.subject;
		this.loading = subject !== null;
		this.failed = false;
		this.tooBig = false;
		this.fileLines = null;
		this.refStats = null;
		this.siblingDefs = [];
		this.macroExpansion = null;
		this.render();
		if (!subject) return;
		// Opportunistically fetch 9-volume metadata, sibling definitions, and macro expansion
		// in parallel without blocking or failing the primary file render.
		void this.loadMetadata(subject, generation);
		try {
			const file = await readFile(this.resolvePath?.(subject.path) ?? subject.path);
			// A newer setDefinition owns the page now; this answer paints nothing.
			if (generation !== this.generation) return;
			const contents = file?.contents;
			if (contents == null) {
				this.failed = true;
			} else if (contents.length > FILE_MAX) {
				this.tooBig = true;
			} else {
				this.fileLines = contents.split('\n');
			}
		} catch {
			if (generation !== this.generation) return;
			this.failed = true;
		}
		this.loading = false;
		this.render();
	}

	private async loadMetadata(subject: DefinitionSubject, generation: number): Promise<void> {
		if (!subject.name || subject.kind === 'file') return;
		const [stats, defs, macro] = await Promise.all([
			symbolRefStats(subject.name, subject.path, subject.line).catch(() => null),
			symbolLookup(subject.name).catch(() => null),
			subject.kind === 'macro' ? symbolMacroExpand(subject.name).catch(() => null) : Promise.resolve(null)
		]);
		if (generation !== this.generation) return;
		this.refStats = stats ?? null;
		this.siblingDefs = Array.isArray(defs) ? defs : [];
		this.macroExpansion = macro ?? null;
		this.paintMetaBar();
	}

	/** The selection's last line: the index's end span, a macro whose end never reached
	 *  the index extending over its `\` continuations. */
	private selectionEnd(subject: DefinitionSubject, lines: string[]): number {
		let end = Math.max(subject.endLine ?? subject.line, subject.line);
		if (subject.kind === 'macro' && (subject.endLine ?? 0) <= subject.line) {
			end = subject.line;
			for (let at = subject.line; at < Math.min(lines.length, subject.line + 40); at++) {
				end = at;
				if (!lines[at]!.trimEnd().endsWith('\\')) break;
			}
		}
		return Math.min(end, lines.length - 1);
	}

	/** The header row: the kind's icon and caption, the name, copy action, and the file:line button. */
	private buildHeader(subject: DefinitionSubject): HTMLElement {
		const copyBtn = el('button', 'def-copy-btn', [icon('copy')]) as HTMLButtonElement;
		copyBtn.type = 'button';
		copyBtn.title = t('analysis.modules.copyPath');
		copyBtn.addEventListener('click', () => copyText(`${subject.path}:${subject.line + 1}`));

		const location = el('button', 'def-location') as HTMLButtonElement;
		location.type = 'button';
		location.textContent = `${splitDirAndBase(subject.path).file}:${subject.line + 1}`;
		location.title = t('symbols.context.open');
		location.addEventListener('click', () => this.onOpenDefinition?.(subject.path, subject.line + 1));
		return el('div', 'def-title', [
			icon(KIND_ICONS[subject.kind] ?? 'symbol-variable'),
			el('span', 'def-name', [subject.name]),
			el('span', 'def-kind', [subject.kind]),
			location,
			copyBtn
		]);
	}

	/** Patch the rich metadata strip (`.ggs_sym` metrics, `.ggs_xc`/`.ggs_xr` ref counts,
	 *  multi-definition switcher, and macro expansion) in place without disturbing code scroll. */
	private paintMetaBar(): void {
		const host = this.metaHost;
		const subject = this.subject;
		if (!host || !subject) return;
		host.textContent = '';

		const pills: HTMLElement[] = [];

		// Multi-definition switcher (declaration vs. implementation / overloads).
		if (this.siblingDefs.length > 1) {
			const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase();
			const curIdx = Math.max(
				0,
				this.siblingDefs.findIndex((d) => norm(d.path) === norm(subject.path) && d.line === subject.line)
			);
			const btn = el('button', 'def-meta-pill def-meta-action', [
				icon('references'),
				el('span', undefined, [`${curIdx + 1}/${this.siblingDefs.length} defs`]),
				icon('chevron-down')
			]) as HTMLButtonElement;
			btn.type = 'button';
			btn.title = 'Switch between definitions / declarations';
			btn.addEventListener('click', (event) => {
				const entries: MenuEntry[] = this.siblingDefs.map((d) => ({
					label: `${d.kind} · ${splitDirAndBase(d.path).file}:${d.line + 1}`,
					checked: norm(d.path) === norm(subject.path) && d.line === subject.line,
					run: () => this.setDefinition({
						kind: d.kind,
						name: d.name,
						path: d.path,
						line: d.line,
						endLine: d.endLine
					})
				}));
				showContextMenu(event.clientX, event.clientY, entries);
			});
			pills.push(btn);
		}

		// Native 9-volume `.ggs_sym` metrics.
		const m = this.refStats?.metrics;
		if (m) {
			if (m.effectiveLines > 0) pills.push(el('span', 'def-meta-pill', [`${m.effectiveLines}L`]));
			if (m.controlFlow > 0) pills.push(el('span', 'def-meta-pill def-meta-cx', [`${m.controlFlow} br`]));
			if (m.paramCount > 0) pills.push(el('span', 'def-meta-pill', [m.paramCount === 255 ? '… params' : `${m.paramCount}p`]));
			if (m.gotoCount > 0) pills.push(el('span', 'def-meta-pill def-meta-warn', [`${m.gotoCount} goto`]));
		}

		// Reference count (`.ggs_xc` code files + `.ggs_xr` \ `.ggs_xc` comment/doc files).
		if (this.refStats && (this.refStats.files > 0 || (this.refStats.commentFiles ?? 0) > 0)) {
			const commentPart = (this.refStats.commentFiles ?? 0) > 0 ? ` (+${this.refStats.commentFiles} docs)` : '';
			const refEl = el(this.onFindReferences ? 'button' : 'span', `def-meta-pill${this.onFindReferences ? ' def-meta-action' : ''}`, [
				icon('search'),
				el('span', undefined, [`${this.refStats.files} files${commentPart}`])
			]);
			if (this.onFindReferences) {
				(refEl as HTMLButtonElement).type = 'button';
				refEl.addEventListener('click', () => this.onFindReferences?.(subject));
			}
			pills.push(refEl);
		}

		if (this.onShowRelations) {
			const relBtn = el('button', 'def-meta-pill def-meta-action', [
				icon('type-hierarchy'),
				el('span', undefined, [t('symbols.graph.title')])
			]) as HTMLButtonElement;
			relBtn.type = 'button';
			relBtn.addEventListener('click', () => this.onShowRelations?.(subject));
			pills.push(relBtn);
		}

		if (pills.length > 0) {
			host.appendChild(el('div', 'def-meta-bar', pills));
		}

		// Inline macro expansion banner for `#define` macros.
		if (this.macroExpansion && this.macroExpansion.expanded) {
			const box = el('div', 'def-macro-box', [
				el('span', 'def-macro-tag', ['Macro']),
				el('code', 'def-macro-val', [this.macroExpansion.expanded])
			]);
			host.appendChild(box);
		}
		host.hidden = host.childElementCount === 0;
	}

	/** The panel page's activation: the workbench's hook re-resolves the cursor symbol. */
	shown(): void {
		this.onNeedRoot?.();
	}

	private render(): void {
		this.body.textContent = '';
		this.metaHost = null;
		if (!this.subject) {
			this.headerInfo.textContent = '';
			this.headerInfo.title = '';
			this.headerInfo.hidden = true;
			this.body.appendChild(el('div', 'def-hint', [this.note ?? t('definition.hint')]));
			return;
		}
		const selEnd = this.fileLines !== null
			? this.selectionEnd(this.subject, this.fileLines)
			: Math.max(this.subject.endLine ?? this.subject.line, this.subject.line);
		const summary = formatDefinitionLocation(this.subject, selEnd - this.subject.line + 1);
		this.headerInfo.textContent = summary;
		this.headerInfo.title = `${summary} — ${t('symbols.context.open')}`;
		this.headerInfo.hidden = false;
		this.body.appendChild(this.buildHeader(this.subject));
		this.metaHost = el('div', 'def-meta-host');
		this.metaHost.hidden = true;
		this.body.appendChild(this.metaHost);
		this.paintMetaBar();
		if (this.loading) {
			this.body.appendChild(el('div', 'def-hint', [icon('sync', 'codicon-modifier-spin'), t('relations.loading')]));
			return;
		}
		if (this.failed || this.fileLines === null) {
			this.body.appendChild(el('div', 'def-hint', [this.tooBig ? t('definition.tooBig') : t('relations.failed')]));
			return;
		}
		// The whole file as the live view: every line one colored span with the newline
		// as text — the pane's text content stays the code verbatim — the symbol's own
		// span marked as the selection, and the declaration scrolled into view: the
		// page's opening frame.
		const subject = this.subject;
		const code = el('pre', 'def-code');
		const ext = extOf(subject.path);
		const lines = this.fileLines;
		lines.forEach((line, index) => {
			const row = el('span', 'def-line');
			row.dataset['line'] = String(index);
			row.dataset['ln'] = String(index + 1);
			if (index >= subject.line && index <= selEnd) row.classList.add('def-sel');
			for (const segment of highlightLine(line, ext)) {
				row.appendChild(segment.cls ? el('span', segment.cls, [segment.text]) : document.createTextNode(segment.text));
			}
			code.appendChild(row);
			if (index < lines.length - 1) code.appendChild(document.createTextNode('\n'));
		});
		this.body.appendChild(code);
		const declaration = this.body.querySelector<HTMLElement>(`.def-line[data-line="${subject.line}"]`);
		if (declaration && typeof declaration.scrollIntoView === 'function') declaration.scrollIntoView({ block: 'center' });
	}

	/* ---------- The click-to-relocate (chain browsing) ---------- */

	private readonly onBodyClick = (event: MouseEvent): void => {
		if (!this.fileLines) return;
		if ((window.getSelection?.()?.toString().length ?? 0) > 0) return;
		const target = event.target as HTMLElement;
		if (target.closest('.hl-comment, .hl-string, .hl-keyword, .hl-number')) return;
		const row = target.closest<HTMLElement>('.def-line');
		if (!row?.dataset['line']) return;
		const at = this.caretOffsetIn(row, event);
		if (at < 0) return;
		const line0 = Number(row.dataset['line']);
		const word = wordAt(this.fileLines[line0] ?? '', at);
		if (word === null) return;
		void this.revealWord(word, line0);
	};

	/** The caret's character offset across the row's text — the browser's own hit test
	 *  (`caretRangeFromPoint` / `caretPositionFromPoint`), read back through the row's
	 *  text nodes. No layout (a harness), no offset. */
	private caretOffsetIn(row: HTMLElement, event: MouseEvent): number {
		const doc = document as Document & {
			caretRangeFromPoint?: (x: number, y: number) => Range | null;
			caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		};
		let node: Node | null = null;
		let offset = 0;
		if (typeof doc.caretRangeFromPoint === 'function') {
			const range = doc.caretRangeFromPoint(event.clientX, event.clientY);
			node = range?.startContainer ?? null;
			offset = range?.startOffset ?? 0;
		} else if (typeof doc.caretPositionFromPoint === 'function') {
			const position = doc.caretPositionFromPoint(event.clientX, event.clientY);
			node = position?.offsetNode ?? null;
			offset = position?.offset ?? 0;
		}
		if (!node || !row.contains(node)) return -1;
		const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
		let at = 0;
		let current = walker.nextNode();
		while (current) {
			if (current === node) return at + offset;
			at += current.textContent?.length ?? 0;
			current = walker.nextNode();
		}
		return -1;
	}

	/** The clicked word's definition re-roots the page: a scope-local parameter or variable
	 *  at the clicked line wins first, then the shown file's own definition, then one with a
	 *  body, then the first — the same preference the declaration card reads by. A failed
	 *  lookup leaves the page standing. */
	private async revealWord(word: string, line0: number): Promise<void> {
		const generation = this.generation;
		const subjectPath = this.subject?.path ?? null;
		try {
			if (subjectPath && this.fileLines) {
				const ext = extOf(subjectPath);
				if (ext) {
					try {
						const locals = (await symbolScopeLookup(word, line0, this.fileLines.join('\n'), ext)) ?? [];
						if (generation !== this.generation) return;
						const local = locals[0];
						if (local) {
							this.setDefinition({ kind: local.kind, name: local.name, path: subjectPath, line: local.line, endLine: local.line });
							return;
						}
					} catch {
						if (generation !== this.generation) return;
						// Scope lookup is opportunistic; fall back to the workspace index.
					}
				}
			}
			const defs = (await symbolLookup(word)) ?? [];
			if (generation !== this.generation || defs.length === 0) return;
			const norm = (p: string): string => (this.resolvePath?.(p) ?? p).replaceAll('\\', '/').toLowerCase();
			const currentNorm = subjectPath ? norm(subjectPath) : '';
			const sameFile = subjectPath ? defs.filter((entry) => norm(entry.path) === currentNorm) : [];
			const def = (sameFile.length > 0
				? (sameFile.find((entry) => entry.line <= line0 && line0 <= (entry.endLine ?? entry.line))
					?? sameFile.find((entry) => (entry.endLine ?? entry.line) > entry.line)
					?? sameFile.reduce((best, entry) => Math.abs(entry.line - line0) < Math.abs(best.line - line0) ? entry : best, sameFile[0]!))
				: undefined)
				?? defs.find((entry) => (entry.endLine ?? entry.line) > entry.line)
				?? defs[0];
			if (!def) return;
			this.setDefinition({ kind: def.kind, name: def.name, path: def.path, line: def.line, endLine: def.endLine });
		} catch {
			// The click is an affordance, never an error surface.
		}
	}

	/* ---------- The right-click sync (the page's own push into the code page) ---------- */

	/** The page's right-click: sync position to editor, open in relation graph, find references, or copy. */
	private readonly onBodyContextMenu = (event: MouseEvent): void => {
		if (!this.subject) return;
		event.preventDefault();
		const subject = this.subject;
		const entries: MenuEntry[] = [
			{
				label: t('definition.syncToEditor'),
				run: () => this.onOpenDefinition?.(subject.path, subject.line + 1)
			}
		];
		if (this.onShowRelations) {
			entries.push({
				label: t('symbols.graph.title'),
				run: () => this.onShowRelations?.(subject)
			});
		}
		if (this.onFindReferences) {
			entries.push({
				label: t('panel.references'),
				run: () => this.onFindReferences?.(subject)
			});
		}
		if (this.fileLines) {
			const selEnd = this.selectionEnd(subject, this.fileLines);
			const snippet = this.fileLines.slice(subject.line, selEnd + 1).join('\n');
			entries.push('separator', {
				label: t('analysis.modules.copyPath'),
				run: () => copyText(`${subject.path}:${subject.line + 1}`)
			}, {
				label: 'Copy Definition Code',
				run: () => copyText(snippet)
			});
		}
		showContextMenu(event.clientX, event.clientY, entries);
	};
}
