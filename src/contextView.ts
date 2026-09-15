// The Context Window (plan M4 4.7) - Source Insight's signature panel: the definition of the
// symbol under the cursor, pinned over the bottom panel. The workbench feeds it from the
// editor's cursor changes (debounced there); this view only renders what it is handed, keeps
// a pin that stops the auto-following, and opens the definition in the editor on click.

import { t } from './i18n';
import { actionButton, el, escapeHtml, icon } from './ui';

/** What the workbench resolved the symbol under the cursor to. */
export interface ContextDefinition {
	kind: string;
	name: string;
	/** Absolute path of the declaring file. */
	path: string;
	/** 0-based declaration line. */
	line: number;
	/** The source fragment around the declaration, already sliced. */
	fragment: string;
}

/** The codicon for a symbol kind, spelled as the Outline's icons are. The Symbol
 *  Database page renders the same kinds. */
export const KIND_ICONS: Record<string, string> = {
	function: 'symbol-method',
	method: 'symbol-method',
	class: 'symbol-class',
	struct: 'symbol-struct',
	interface: 'symbol-interface',
	enum: 'symbol-enum',
	module: 'symbol-module',
	type: 'symbol-type-parameter'
};

export class ContextView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;
	private readonly body: HTMLElement;
	private readonly pinButton: HTMLButtonElement;
	private pinned = false;
	private current: ContextDefinition | null = null;

	onOpenDefinition: ((definition: ContextDefinition) => void) | null = null;

	constructor() {
		this.body = el('div', 'context-body');
		this.element = el('div', 'panel-body context-panel', [this.body]);
		this.element.hidden = true;
		this.pinButton = actionButton('pin', t('symbols.context.pin'), () => this.togglePin());
		this.actions = el('div', 'actions', [this.pinButton]);
		this.renderEmpty();
	}

	private togglePin(): void {
		this.pinned = !this.pinned;
		this.pinButton.title = this.pinned ? t('symbols.context.unpin') : t('symbols.context.pin');
		this.pinButton.setAttribute('aria-label', this.pinButton.title);
		this.pinButton.innerHTML = '';
		this.pinButton.appendChild(icon(this.pinned ? 'pinned' : 'pin'));
		this.element.classList.toggle('pinned', this.pinned);
	}

	/** While pinned, the auto-following pauses: the cursor can roam without wiping the view. */
	isPinned(): boolean {
		return this.pinned;
	}

	definition(): ContextDefinition | null {
		return this.current;
	}

	private renderEmpty(message = t('symbols.context.empty')): void {
		this.current = null;
		this.body.textContent = '';
		this.body.appendChild(el('div', 'context-empty', [message]));
	}

	/** Show a resolved definition (or, with null, the resting text; `note` explains why). */
	show(definition: ContextDefinition | null, note?: string): void {
		if (!definition) {
			this.renderEmpty(note);
			return;
		}
		this.current = definition;
		this.body.textContent = '';
		const header = el('div', 'context-header', [
			icon(KIND_ICONS[definition.kind] ?? 'symbol-variable'),
			el('span', 'context-name', [definition.name]),
			el('span', 'context-kind', [definition.kind])
		]);
		const location = el('button', 'context-location');
		location.textContent = `${definition.path.split(/[\\/]/).pop()}:${definition.line + 1}`;
		location.title = t('symbols.context.open');
		location.addEventListener('click', () => this.onOpenDefinition?.(definition));
		header.appendChild(location);
		const code = el('pre', 'context-code');
		code.innerHTML = definition.fragment.split('\n').map(escapeHtml).join('\n');
		this.body.append(header, code);
	}

	shown(): void {
		// Nothing to load lazily - the workbench pushes into this view.
	}
}
