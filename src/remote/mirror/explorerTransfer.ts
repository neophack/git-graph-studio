// The replica's transfer entries (docs/ggs-remote-plan.md §11.3): in mirror mode the
// Explorer's context menu is the PC's own, rendered there and mirrored here — and the PC's
// rows run on the PC (the desktop transport's native dialogs), where this browser's own
// pickers and downloads cannot reach. The PC hides its rows while a viewer watches
// (transfer.ts's `transferMenuShown`), so the device's transfers are this page's to serve:
// the viewer reads the Explorer row under the click (or the list's blank area, which menus
// the workspace root), and once the PC's menu surface lands in the copy — the desktop
// `.context-menu` in #overlays, the phone shell's action sheet — appends viewer-run entries
// to it. The appended rows carry `data-ggs-local`, which the input layer (viewerInput.ts)
// never forwards: their clicks close the mirrored surface (an Escape for menus, a press on
// the backdrop for sheets) and ride the shared transfer layer (src/transfer.ts) over this
// page's own transport. Entries ride the first surface only — a sheet's submenu step
// rebuilds its rows from the PC's entries; the long press opens it again.
import { t } from '../../i18n';
import { downloadTo, uploadInto } from '../../transfer';

/** What the PC's Explorer menus for one click: the row under it, or the tree's root. */
export interface ExplorerSpot {
	path: string;
	isDir: boolean;
}

/** The parent of a path in either separator dialect (the picker's own `parentOf`). */
function parentOf(path: string): string | null {
	const trimmed = path.replace(/[\\/]+$/, '');
	const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	if (at < 0) return null;
	if (at === 0) return '/';
	const parent = trimmed.slice(0, at);
	return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** What the PC's Explorer would menu for a click that landed on `target` of the copy: the
 *  row under it (its path and dir-ness), or — inside the Explorer's list but off every row —
 *  the workspace root, exactly what the PC's blank-area menu shows. The root is read off the
 *  top-level rows: one parent shared by all of them is the single root (the rows are its
 *  children), unrelated parents mean the multi-root virtual level, whose first row is a root
 *  itself. Other views share the pane classes but carry no path-carrying rows. */
export function explorerSpotAt(target: Element | null): ExplorerSpot | null {
	const row = target?.closest?.('.row[data-path]') as HTMLElement | null;
	if (row?.dataset['path']) return { path: row.dataset['path'], isDir: row.dataset['dir'] === '1' };
	const body = target?.closest?.('.pane-body.list') as HTMLElement | null;
	if (!body || !body.querySelector('.row[data-path]')) return null;
	const tree = body.querySelector('.tree') ?? body;
	const tops = Array.from(tree.children).filter((child) => {
		const el = child as HTMLElement;
		return el.classList.contains('row') && !!el.dataset['path'];
	}) as HTMLElement[];
	if (tops.length === 0) return null;
	const paths = tops.map((top) => top.dataset['path']!);
	const parent = parentOf(paths[0]!);
	const root = tops.length === 1 || paths.every((p) => parentOf(p) === parent)
		? parent ?? paths[0]!
		: paths[0]!;
	return { path: root, isDir: true };
}

/** How the entries reach the PC: closing the mirrored surface the click leaves behind. */
export interface MirrorTransferDeps {
	/** A key replayed on the PC (Escape closes its open context menu). */
	key(name: string): void;
	/** A press replayed at a fraction of a mirrored element (a sheet's backdrop closes it). */
	press(el: Element, fx: number, fy: number): void;
}

/** How long to wait for the PC's menu after the click that opened it. */
const ARM_MS = 4000;

let armed: { observer: MutationObserver; timer: ReturnType<typeof setTimeout> } | null = null;

function disarmExplorerTransfer(): void {
	if (!armed) return;
	armed.observer.disconnect();
	clearTimeout(armed.timer);
	armed = null;
}

/** Watch for the menu the just-sent ctx opens on the PC, and add the transfer entries to it
 *  when its copy lands. Disarmed by the first surface, or `ARM_MS`. */
export function armExplorerTransfer(doc: Document, spot: ExplorerSpot, deps: MirrorTransferDeps): void {
	disarmExplorerTransfer();
	const observer = new MutationObserver((records) => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (node.nodeType !== 1) continue;
				const root = node as Element;
				const menu = root.matches('.context-menu') ? root : root.querySelector('.context-menu');
				if (menu) {
					extendContextMenu(doc, menu, spot, deps);
					disarmExplorerTransfer();
					return;
				}
				const sheet = root.matches('.ggs-action-sheet-backdrop') ? root : root.querySelector('.ggs-action-sheet-backdrop');
				if (sheet) {
					if (extendActionSheet(doc, sheet, spot, deps)) disarmExplorerTransfer();
					return;
				}
			}
		}
	});
	observer.observe(doc.documentElement, { childList: true, subtree: true });
	armed = { observer, timer: setTimeout(disarmExplorerTransfer, ARM_MS) };
}

/** The entries the own-UI Explorer's menu shows (transfer.ts), run on this device instead. */
function transferEntries(spot: ExplorerSpot): { label: string; run: () => Promise<unknown> }[] {
	if (!spot.isDir) return [{ label: t('transfer.download'), run: () => downloadTo(spot.path) }];
	return [
		{ label: t('transfer.downloadZip'), run: () => downloadTo(spot.path, true) },
		{ label: t('transfer.uploadHere'), run: () => uploadInto(spot.path, false) },
		{ label: t('transfer.uploadFolderHere'), run: () => uploadInto(spot.path, true) }
	];
}

/** Take the mirrored surface off this screen at once, and close it on the PC: a menu by the
 *  Escape its document handler reads, a sheet by a press on its backdrop (the sheet's Escape
 *  listener sits on the backdrop itself, where a replayed key — fired at the focused
 *  element — never lands). */
function closeMirrored(surface: HTMLElement, kind: 'menu' | 'sheet', deps: MirrorTransferDeps): void {
	surface.style.display = 'none';
	if (kind === 'menu') deps.key('Escape');
	else deps.press(surface, 0.5, 0.04);
}

/** The desktop menu: entries appended after the PC's own (their rows shift nothing above
 *  them, so every mirrored item's replay rect is exact). */
function extendContextMenu(doc: Document, menu: Element, spot: ExplorerSpot, deps: MirrorTransferDeps): void {
	const separator = doc.createElement('div');
	separator.className = 'separator';
	menu.appendChild(separator);
	for (const entry of transferEntries(spot)) {
		const item = doc.createElement('div');
		item.className = 'item';
		item.setAttribute('role', 'menuitem');
		item.setAttribute('data-ggs-local', '');
		const check = doc.createElement('span');
		check.className = 'check';
		const label = doc.createElement('span');
		label.className = 'label';
		label.textContent = entry.label;
		item.append(check, label);
		// The pointer's focus ring, drawn the way the mirrored menu draws its own.
		item.addEventListener('mouseenter', () => {
			for (const other of menu.querySelectorAll('.item.focused')) other.classList.remove('focused');
			item.classList.add('focused');
		});
		item.addEventListener('mouseleave', () => item.classList.remove('focused'));
		item.addEventListener('click', (event) => {
			event.stopPropagation();
			closeMirrored(menu as HTMLElement, 'menu', deps);
			void entry.run();
		});
		menu.appendChild(item);
	}
}

/** The phone shell's sheet: rows before its Cancel row, the one place every sheet keeps its
 *  actions. Answers whether the sheet's menu body was found (an unrelated addition keeps
 *  watching). */
function extendActionSheet(doc: Document, backdrop: Element, spot: ExplorerSpot, deps: MirrorTransferDeps): boolean {
	const body = backdrop.querySelector('.ggs-sheet-body[role="menu"]');
	if (!body) return false;
	const anchor = body.querySelector('.row.cancel') ?? body.lastElementChild;
	if (body.querySelector('.row:not(.cancel):not([data-ggs-local])')) {
		const separator = doc.createElement('div');
		separator.className = 'separator';
		body.insertBefore(separator, anchor);
	}
	for (const entry of transferEntries(spot)) {
		const row = doc.createElement('button');
		row.className = 'row';
		row.setAttribute('role', 'menuitem');
		row.setAttribute('data-ggs-local', '');
		const label = doc.createElement('span');
		label.className = 'label';
		label.textContent = entry.label;
		row.appendChild(label);
		row.addEventListener('click', (event) => {
			event.stopPropagation();
			closeMirrored(backdrop as HTMLElement, 'sheet', deps);
			void entry.run();
		});
		body.insertBefore(row, anchor);
	}
	return true;
}
