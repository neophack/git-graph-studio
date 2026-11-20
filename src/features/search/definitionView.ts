// The Definition panel page (module 5) — the bottom panel's answer to a click: the
// definition content of the symbol under the cursor (the caret a click leaves behind),
// drawn from the persistent index. A function or method shows through its body's end
// line, a macro through its directive and every continuation, a struct/enum/class through
// its whole body, anything else through its declaration — the index's `endLine` sizes the
// slice, capped with a faint cut note. The workbench feeds it with the same gate and
// debounce discipline the relation page ran on (the panel up, this page active, the pin
// off); the pin freezes the content, and the location button jumps to the definition.

import { readFile } from '../../platform/ipc/fs';

import { t } from '../../platform/i18n';
import { KIND_ICONS } from './contextView';
import { actionButton, el, escapeHtml, icon } from '../../platform/ui/index';

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
	 *  back to the declaration's line and the cap slices a window). */
	endLine?: number;
}

/** The body slice's caps: at most this many lines and this many characters, past either
 *  the faint cut note answers. */
const BODY_MAX_LINES = 400;
const BODY_MAX_CHARS = 20000;

/** A path's basename over either separator. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}

export class DefinitionView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;

	/** A location-button click — the line arrives 1-based. */
	onOpenDefinition?: (path: string, line: number) => void;

	/** The panel page's shown() asks the workbench to re-resolve the cursor symbol. */
	onNeedRoot?: () => void;

	private readonly body: HTMLElement;
	private readonly pinButton: HTMLButtonElement;

	private pinned = false;
	private subject: DefinitionSubject | null = null;
	/** Why the subject is empty (the resolution's note), shown instead of the resting hint. */
	private note: string | undefined;
	private loading = false;
	private failed = false;
	/** The settled slice and whether a cap trimmed it — null while loading or failed. */
	private bodyText: string | null = null;
	private bodyCapped = false;
	/** The fetch's staleness counter: every setDefinition drops the answers before it. */
	private generation = 0;

	constructor() {
		this.body = el('div', 'def-body');
		this.element = el('div', 'panel-body def-panel', [this.body]);
		this.element.hidden = true;
		this.pinButton = actionButton('pin', t('definition.pin'), () => this.togglePin());
		this.actions = el('div', 'actions', [this.pinButton]);
		this.render();
	}

	private togglePin(): void {
		this.pinned = !this.pinned;
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
		this.bodyText = null;
		this.bodyCapped = false;
		this.render();
		if (!subject) return;
		try {
			const file = await readFile(subject.path);
			// A newer setDefinition owns the page now; this answer paints nothing.
			if (generation !== this.generation) return;
			const contents = file?.contents;
			if (contents == null) {
				this.failed = true;
			} else {
				const slice = this.sliceBody(subject, contents.split('\n'));
				this.bodyText = slice.text;
				this.bodyCapped = slice.capped;
			}
		} catch {
			if (generation !== this.generation) return;
			this.failed = true;
		}
		this.loading = false;
		this.render();
	}

	/** The body slice: the declaration through the index's end line — a macro whose end
	 *  never reached the index extends over its `\` continuations — capped. */
	private sliceBody(subject: DefinitionSubject, lines: string[]): { text: string; capped: boolean } {
		let end = Math.max(subject.endLine ?? subject.line, subject.line);
		if (subject.kind === 'macro' && (subject.endLine ?? 0) <= subject.line) {
			end = subject.line;
			for (let at = subject.line; at < Math.min(lines.length, subject.line + 40); at++) {
				end = at;
				if (!lines[at]!.trimEnd().endsWith('\\')) break;
			}
		}
		let capped = end - subject.line + 1 > BODY_MAX_LINES;
		if (capped) end = subject.line + BODY_MAX_LINES - 1;
		let text = lines.slice(subject.line, Math.min(end + 1, lines.length)).join('\n');
		if (text.length > BODY_MAX_CHARS) {
			text = text.slice(0, BODY_MAX_CHARS);
			capped = true;
		}
		if (capped) text += '\n…';
		return { text, capped };
	}

	/** The header row: the kind's icon and caption, the name, and the file:line button. */
	private buildHeader(subject: DefinitionSubject): HTMLElement {
		const location = el('button', 'def-location');
		location.textContent = `${baseName(subject.path)}:${subject.line + 1}`;
		location.title = t('symbols.context.open');
		location.addEventListener('click', () => this.onOpenDefinition?.(subject.path, subject.line + 1));
		return el('div', 'def-title', [
			icon(KIND_ICONS[subject.kind] ?? 'symbol-variable'),
			el('span', 'def-name', [subject.name]),
			el('span', 'def-kind', [subject.kind]),
			location
		]);
	}

	/** The panel page's activation: the workbench's hook re-resolves the cursor symbol. */
	shown(): void {
		this.onNeedRoot?.();
	}

	private render(): void {
		this.body.textContent = '';
		if (!this.subject) {
			this.body.appendChild(el('div', 'def-hint', [this.note ?? t('definition.hint')]));
			return;
		}
		this.body.appendChild(this.buildHeader(this.subject));
		if (this.loading) {
			this.body.appendChild(el('div', 'def-hint', [icon('sync', 'codicon-modifier-spin'), t('relations.loading')]));
			return;
		}
		if (this.failed || this.bodyText === null) {
			this.body.appendChild(el('div', 'def-hint', [t('relations.failed')]));
			return;
		}
		const code = el('pre', 'def-code');
		code.innerHTML = escapeHtml(this.bodyText);
		this.body.appendChild(code);
		if (this.bodyCapped) this.body.appendChild(el('div', 'def-cut', [t('definition.cut')]));
	}
}
