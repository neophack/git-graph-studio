// The phone's bottom sheets (docs/ggs-remote-plan.md §11.2): one sheet surface for every
// touch menu — the workbench's context menus (installed as ui.ts's menu presenter, so no view
// changes), the full menus, the open editors list and the editor's actions. A sheet slides up
// from the bottom edge with a grabber, an optional header (a back step for submenus, a title,
// header actions), 48 px rows and a Cancel row; a drag down on the grabber or the header, a
// tap on the backdrop, Escape or the browser's back all dismiss it. One sheet at a time.
import { setMenuPresenter, type MenuEntry, type MenuItem } from '../ui';
import { t } from '../i18n';
import { pushBack } from './backStack';
import { coarsePointer, formFactor } from './responsive';

let open: { backdrop: HTMLElement; onClose?: () => void; release: () => void } | null = null;

export interface SheetOptions {
	title?: string;
	subtitle?: string;
	/** A back step in the header (a submenu's way back to its parent level). */
	back?: () => void;
	/** Buttons on the header's trailing edge. */
	actions?: HTMLElement[];
	body: HTMLElement;
	className?: string;
	onClose?: () => void;
}

/** Drag distance (px) past which a released sheet dismisses. */
const DISMISS_DRAG = 90;

export function closeActionSheet(): void {
	if (!open) return;
	const { backdrop, onClose, release } = open;
	open = null;
	backdrop.remove();
	release();
	onClose?.();
}

export function sheetOpen(): boolean {
	return open !== null;
}

function iconSpan(name: string, className = ''): HTMLElement {
	const glyph = document.createElement('span');
	glyph.className = `codicon codicon-${name}${className ? ' ' + className : ''}`;
	glyph.setAttribute('aria-hidden', 'true');
	return glyph;
}

/** A round header button (44 px target). */
export function sheetButton(iconName: string, label: string, run: () => void): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = 'ggs-sheet-btn';
	button.title = label;
	button.setAttribute('aria-label', label);
	button.appendChild(iconSpan(iconName));
	button.addEventListener('click', (event) => {
		event.stopPropagation();
		run();
	});
	return button;
}

/** Open a sheet over the page. */
export function openSheet(options: SheetOptions): HTMLElement {
	closeActionSheet();
	const backdrop = document.createElement('div');
	backdrop.className = 'ggs-action-sheet-backdrop';
	const sheet = document.createElement('div');
	sheet.className = `ggs-action-sheet${options.className ? ' ' + options.className : ''}`;
	sheet.setAttribute('role', 'dialog');
	sheet.setAttribute('aria-modal', 'true');
	const grabber = document.createElement('div');
	grabber.className = 'grabber';
	sheet.appendChild(grabber);
	let header: HTMLElement | null = null;
	if (options.title || options.back || options.actions?.length) {
		header = document.createElement('div');
		header.className = 'ggs-sheet-header';
		if (options.back) header.appendChild(sheetButton('chevron-left', t('remote.sheet.back'), options.back));
		const titles = document.createElement('div');
		titles.className = 'titles';
		if (options.title) {
			const title = document.createElement('div');
			title.className = 'title';
			title.textContent = options.title;
			titles.appendChild(title);
		}
		if (options.subtitle) {
			const subtitle = document.createElement('div');
			subtitle.className = 'subtitle';
			subtitle.textContent = options.subtitle;
			titles.appendChild(subtitle);
		}
		header.appendChild(titles);
		for (const action of options.actions ?? []) header.appendChild(action);
		sheet.appendChild(header);
	}
	options.body.classList.add('ggs-sheet-body');
	sheet.appendChild(options.body);
	backdrop.appendChild(sheet);
	backdrop.addEventListener('click', (event) => {
		if (event.target === backdrop) closeActionSheet();
	});
	backdrop.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') closeActionSheet();
	});
	installDragToDismiss(sheet, [grabber, ...(header ? [header] : [])]);
	document.body.appendChild(backdrop);
	open = { backdrop, onClose: options.onClose, release: pushBack(closeActionSheet) };
	// The slide-in starts from the off-screen transform the stylesheet gives an unopened sheet.
	requestAnimationFrame(() => backdrop.classList.add('open'));
	return sheet;
}

/** Drag the sheet down by its grabber or header; past the threshold (or a quick flick) the
 *  release dismisses it, short of it the sheet springs back. */
function installDragToDismiss(sheet: HTMLElement, handles: HTMLElement[]): void {
	let start: { y: number; at: number } | null = null;
	let offset = 0;
	const move = (event: PointerEvent) => {
		if (!start) return;
		offset = Math.max(0, event.clientY - start.y);
		sheet.style.transform = `translateY(${offset}px)`;
	};
	const end = (event: PointerEvent) => {
		if (!start) return;
		const velocity = offset / Math.max(1, performance.now() - start.at);
		start = null;
		sheet.classList.remove('dragging');
		sheet.style.transform = '';
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', end);
		window.removeEventListener('pointercancel', end);
		if (event.type === 'pointerup' && (offset > DISMISS_DRAG || (offset > 24 && velocity > 0.6))) closeActionSheet();
		offset = 0;
	};
	for (const handle of handles) {
		handle.addEventListener('pointerdown', (event) => {
			if ((event.target as HTMLElement).closest('button')) return;
			start = { y: event.clientY, at: performance.now() };
			sheet.classList.add('dragging');
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', end);
			window.addEventListener('pointercancel', end);
		});
	}
}

/** One menu row: the label, a checkmark for a checked entry, a chevron for a submenu. */
function menuRow(item: MenuItem, onPick: () => void): HTMLButtonElement {
	const row = document.createElement('button');
	row.className = 'row' + (item.checked ? ' checked' : '');
	row.setAttribute('role', 'menuitem');
	row.disabled = Boolean(item.disabled);
	const label = document.createElement('span');
	label.className = 'label';
	label.textContent = item.label;
	row.appendChild(label);
	if (item.checked) row.appendChild(iconSpan('check', 'trail'));
	if (item.submenu) row.appendChild(iconSpan('chevron-right', 'trail'));
	row.addEventListener('click', (event) => {
		event.stopPropagation();
		onPick();
	});
	return row;
}

/** A menu as a sheet: the entries as rows, a submenu as the next level with a back step to
 *  this one, and a Cancel row at the foot. */
export function showActionSheet(entries: MenuEntry[], title?: string, parent?: () => void): void {
	const body = document.createElement('div');
	body.setAttribute('role', 'menu');
	let lastWasRow = false;
	for (const entry of entries) {
		if (entry === 'separator') {
			// Leading, trailing and doubled separators carry nothing on a sheet.
			if (lastWasRow) {
				const line = document.createElement('div');
				line.className = 'separator';
				body.appendChild(line);
			}
			lastWasRow = false;
			continue;
		}
		const item = entry as MenuItem;
		const reopen = () => showActionSheet(entries, title, parent);
		body.appendChild(
			menuRow(item, () => {
				if (item.submenu) {
					showActionSheet(item.submenu, item.label, reopen);
					return;
				}
				closeActionSheet();
				item.run?.();
			})
		);
		lastWasRow = true;
	}
	if (body.lastElementChild?.classList.contains('separator')) body.lastElementChild.remove();
	const cancel = document.createElement('button');
	cancel.className = 'row cancel';
	cancel.textContent = t('remote.actionSheet.cancel');
	cancel.addEventListener('click', closeActionSheet);
	body.appendChild(cancel);
	openSheet({ title, back: parent, body });
}

/** Route context menus to the sheet while this is a touch phone. */
export function installActionSheet(): void {
	setMenuPresenter((entries) => {
		if (formFactor() !== 'phone' || !coarsePointer()) return false;
		showActionSheet(entries);
		return true;
	});
}
