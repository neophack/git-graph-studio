// The device tree a `.dts` / `.dtsi` / `.dtb` opens in: the backend parsed the file
// once (`devtree_open` — the magic picked blob or source, both answering the same node
// tree), this view browses it — collapsible nodes, each property with its strings,
// cells, bytes or phandle references spelled out, the memory reservations on top, and
// a search box that keeps only the matching nodes (their ancestors included). "Text"
// swaps the tab to the file's plain text form, editable (the caller owns the editor
// swap — the same one-button journey a CAN trace takes; a `.dtb` has no text form and
// shows no button).

import { type DevTreeOpenResult, type DevTreeNode, devtreeOpen } from '../../platform/ipc/devtree';
import { basename, el, icon } from '../../platform/ui/index';
import { t, tf } from '../../platform/i18n';

/** Nodes a subtree renders before the expansion stops and a cap names itself. */
const MAX_RENDERED = 20000;

export interface DevTreeViewOptions {
	/** "Text" swaps this tab to the file's plain text form, editable (the caller owns
	 *  the editor swap). */
	onEditText?: () => void;
}

export class DevTreeView {
	readonly root: HTMLElement;
	private readonly liveText: HTMLElement;
	private readonly search: HTMLInputElement;
	private readonly treeHost: HTMLElement;
	private readonly reserveLine: HTMLElement;
	private doc: DevTreeOpenResult | null = null;
	private failed = false;
	private timer: number | null = null;
	private disposed = false;

	constructor(private path: string, options: DevTreeViewOptions = {}) {
		const pathChip = el('span', 'can-path', [this.path]);
		pathChip.title = this.path;
		this.liveText = el('span', 'can-live-text', [t('dt.live.opening')]);
		const live = el('span', 'can-live can-live-parsing', [el('span', 'can-live-dot'), this.liveText]);
		this.search = el('input', 'dbc-search') as HTMLInputElement;
		this.search.type = 'text';
		this.search.placeholder = t('dt.search');
		this.search.setAttribute('aria-label', t('dt.search'));
		this.search.addEventListener('input', () => this.renderTree());
		const toolbar = el('div', 'hex-toolbar can-toolbar', [pathChip, live, this.search]);
		if (options.onEditText) {
			const textButton = el('button', 'button secondary can-text', [icon('edit'), ` ${t('dt.text')}`]) as HTMLButtonElement;
			textButton.title = t('dt.text.title');
			textButton.addEventListener('click', () => options.onEditText?.());
			toolbar.appendChild(textButton);
		}
		this.reserveLine = el('div', 'dt-reserve');
		this.reserveLine.hidden = true;
		this.treeHost = el('div', 'dt-tree');
		const scroller = el('div', 'dt-scroll', [this.reserveLine, this.treeHost]);
		this.root = el('div', 'can-view dt-view', [toolbar, scroller]);
		void this.load();
	}

	private async load(): Promise<void> {
		let doc: DevTreeOpenResult;
		try {
			doc = await devtreeOpen(this.path);
		} catch (error) {
			this.fail(tf('dt.openFailed', basename(this.path), String(error)));
			return;
		}
		if (this.disposed) return; // no backend handle to release; the command keeps no state
		this.doc = doc;
		this.liveText.parentElement?.classList.remove('can-live-parsing');
		this.setLive(tf('dt.live.done', doc.format.toUpperCase(), doc.nodes.toLocaleString(), doc.properties.toLocaleString()));
		if (doc.memReserve.length > 0) {
			this.reserveLine.hidden = false;
			this.reserveLine.replaceChildren(
				el('span', 'dt-reserve-label', [t('dt.memreserve')]),
				...doc.memReserve.map((r) =>
					el('span', 'dt-reserve-pair', [`0x${r.address.toString(16)} +0x${r.size.toString(16)}`])
				)
			);
		}
		this.renderTree();
	}

	private setLive(text: string): void {
		this.liveText.textContent = text;
	}

	private fail(text: string): void {
		this.failed = true;
		this.liveText.parentElement?.classList.remove('can-live-parsing');
		this.setLive(t('dt.live.failed'));
		this.treeHost.replaceChildren(el('div', 'can-error dbc-banner', [text]));
	}

	/** The whole tree, re-rendered on open and on every search keystroke — a device
	 *  tree is small, and the filter prunes it before the DOM is built. */
	private renderTree(): void {
		const doc = this.doc;
		if (!doc || this.failed) return;
		const query = this.search.value.trim().toLowerCase();
		const rootEl = this.renderNode(doc.root, query, true, { rendered: 0 });
		this.treeHost.replaceChildren(rootEl ?? el('div', 'dbc-capped', [t('dt.noMatch')]));
	}

	/** One node's row and its children — matching nodes stay, non-matching subtrees
	 *  drop (a node with no properties and no matching descendants goes). */
	private renderNode(node: DevTreeNode, query: string, isRoot: boolean, budget: { rendered: number }): HTMLElement | null {
		const childMatches: HTMLElement[] = [];
		for (const child of node.children) {
			if (budget.rendered > MAX_RENDERED) break;
			const childEl = this.renderNode(child, query, false, budget);
			if (childEl) childMatches.push(childEl);
		}
		const keptProps = query === '' ? node.properties : node.properties.filter((p) => this.propMatches(p, query));
		const selfMatch =
			query === '' ||
			node.name.toLowerCase().includes(query) ||
			(node.label ?? '').toLowerCase().includes(query) ||
			(node.unitAddress ?? '').toLowerCase().includes(query) ||
			keptProps.length > 0 ||
			childMatches.length > 0;
		if (!selfMatch) {
			// The caller drops this subtree whole.
			return null;
		}
		const wrap = el('div', 'dt-node');
		const titleBits: (string | HTMLElement)[] = [];
		if (node.label) titleBits.push(el('span', 'dt-label', [`${node.label}: `]));
		titleBits.push(el('span', 'dt-name', [isRoot ? `/${node.name === '/' ? '' : node.name}` : node.name]));
		const row = el('div', 'dt-node-row', titleBits);
		if (node.children.length > 0) {
			const toggle = el('button', 'button secondary dt-toggle', [icon('chevron-right')]) as HTMLButtonElement;
			toggle.type = 'button';
			toggle.title = t('dt.toggle');
			toggle.setAttribute('aria-expanded', 'false');
			const childrenEl = el('div', 'dt-children', childMatches);
			childrenEl.hidden = true;
			toggle.addEventListener('click', () => {
				const open = childrenEl.hidden;
				childrenEl.hidden = !open;
				toggle.setAttribute('aria-expanded', String(open));
				toggle.replaceChildren(icon(open ? 'chevron-down' : 'chevron-right'));
			});
			row.prepend(toggle);
			wrap.append(row, childrenEl);
		} else {
			row.prepend(el('span', 'dt-toggle-spacer'));
			wrap.appendChild(row);
		}
		if (keptProps.length > 0 || (query !== '' && node.properties.length > 0)) {
			const props = el('div', 'dt-props');
			for (const p of keptProps) {
				const valueText = p.values.map((v) => (v.kind === 'str' ? `"${v.text}"` : v.text)).join(' ');
				const prop = el('div', 'dt-prop', [
					el('span', 'dt-prop-name', [p.name]),
					el('span', 'dt-prop-value', [valueText === '' ? ';' : `= ${valueText};`])
				]);
				if (valueText.length > 80) prop.title = valueText;
				props.appendChild(prop);
			}
			wrap.appendChild(props);
		}
		budget.rendered += 1 + childMatches.length;
		return wrap;
	}

	private propMatches(p: { name: string; values: { text: string }[] }, query: string): boolean {
		return p.name.toLowerCase().includes(query) || p.values.some((v) => v.text.toLowerCase().includes(query));
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.root.remove();
	}
}
