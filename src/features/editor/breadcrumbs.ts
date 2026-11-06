import { listDir } from '../../platform/ipc/fs';
import { viewerClose, viewerOpen, type ViewerOutlineSymbol } from '../../platform/ipc/viewer';
import { t, tf } from '../../platform/i18n';
import { settings } from '../../platform/settings';
import { el, icon, relativeTo, showMenuBelow, toPosix, type MenuEntry } from '../../platform/ui/index';
import { fileIcon, fileIconColor } from '../../platform/fileIcons';
import type { EditorGroup } from './group';
import type { Editor } from './inputs';

/** How many entries a folder crumb's dropdown lists before a "more" row stands in — the
 *  menu is a navigation aid, not the Explorer. */
const CRUMB_MENU_CAP = 100;


/** A symbol the backend's outline extraction found in a document. */
/** The codicon VS Code's outline uses per symbol kind. */
export const SYMBOL_ICONS: Record<string, string> = {
	function: 'symbol-method',
	method: 'symbol-method',
	class: 'symbol-class',
	struct: 'symbol-structure',
	interface: 'symbol-interface',
	enum: 'symbol-enum',
	module: 'symbol-module',
	type: 'symbol-parameter'
};


/** The breadcrumbs concern of EditorGroup — assigned onto the prototype by the module facade. */
export const breadcrumbsMethods: ThisType<EditorGroup> = {
	refreshOutlines(): void {
		for (const editor of this.open) {
			if (editor.input.kind === 'file') this.updateOutline(editor);
		}
	},

	updateOutline(editor: Editor): void {
		editor.outline?.remove();
		editor.outline = undefined;
		editor.pane.classList.remove('has-outline');
		if (!settings.showOutline || editor.input.kind !== 'file') return;
		const path = editor.input.path;
		const pane = el('aside', 'editor-outline');
		pane.appendChild(el('div', 'editor-outline-title', [t('outline.title')]));
		pane.appendChild(el('div', 'editor-outline-empty'));
		editor.outline = pane;
		editor.pane.classList.add('has-outline');
		editor.pane.prepend(pane);
		void (async () => {
			let symbols: ViewerOutlineSymbol[];
			try {
				const info = await viewerOpen(path);
				symbols = info.symbols ?? [];
				await viewerClose(info.docId).catch(() => undefined);
			} catch {
				symbols = [];
			}
			// The editor may have closed, or the setting been toggled again, meanwhile.
			if (editor.outline !== pane) return;
			if (symbols.length === 0) {
				pane.remove();
				editor.outline = undefined;
				editor.pane.classList.remove('has-outline');
				return;
			}
			pane.textContent = '';
			pane.appendChild(el('div', 'editor-outline-title', [t('outline.title')]));
			for (const symbol of symbols) {
				const item = el('div', 'editor-outline-item', [icon(SYMBOL_ICONS[symbol.kind] ?? 'symbol-method'), el('span', '', [symbol.name])]);
				item.title = `${symbol.name} — line ${symbol.line + 1}`;
				item.addEventListener('click', () => this.revealIn(editor, symbol.line + 1, 1));
				pane.appendChild(item);
			}
		})();
	},

	renderBreadcrumbs(): void {
		this.breadcrumbs.innerHTML = '';
		const input = this.active?.input;
		// Only a file-backed tab has a path worth walking — a preview, history or hex tab
		// walks the file's own path, as VS Code's breadcrumbs do for a custom editor over
		// that file. Every other page has no path, and its single crumb would only repeat
		// the tab's own title, so the bar stays hidden.
		const path = input && (input.kind === 'file' || input.kind === 'markdown' || input.kind === 'history' || input.kind === 'hex' || input.kind === 'canlog') ? input.path : null;
		this.breadcrumbs.hidden = path === null;
		if (path === null) return;
		const relative = this.rootPath ? relativeTo(this.rootPath, path) : toPosix(path);
		const parts = relative.split('/').filter((p) => p !== '');
		// The absolute path a crumb stands for: the full path minus the crumbs after it.
		// The crumbs spell the root-relative POSIX form, the path itself carries the
		// platform's separators — drop segments from the path's own end, never rejoin the
		// relative parts onto a guessed root.
		const separator = path.includes('\\') ? '\\' : '/';
		const segments = path.split(/[\\/]/);
		const nodePath = (index: number): string => segments.slice(0, segments.length - (parts.length - 1 - index)).join(separator);
		// A folder crumb lists that folder's entries (folders first, then files); a folder
		// pick drills one level deeper at the same crumb, a file pick opens it in this
		// group — VS Code's breadcrumb reveal. The listing is fetched per click: cheap, and
		// always what the folder holds right now.
		const openFolderMenu = (anchor: HTMLElement, folder: string): void => {
			void listDir(folder).then((entries) => {
				const sorted = [...entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
				const items: MenuEntry[] = sorted.slice(0, CRUMB_MENU_CAP).map((entry) => ({
					label: entry.name,
					run: () => (entry.isDir ? openFolderMenu(anchor, entry.path) : void this.openFile(entry.path))
				}));
				if (items.length === 0) items.push({ label: t('breadcrumbs.emptyFolder'), disabled: true });
				else if (sorted.length > CRUMB_MENU_CAP) items.push({ label: tf('breadcrumbs.moreEntries', String(sorted.length - CRUMB_MENU_CAP)), disabled: true });
				showMenuBelow(anchor, items);
			}).catch(() => undefined); // an unreadable folder leaves the click a no-op
		};
		// The file crumb lists the file's symbol outline — the same symbols the outline
		// pane shows — and a pick reveals the line in the active editor, exactly the
		// outline click's reveal.
		const openFileMenu = (anchor: HTMLElement, filePath: string): void => {
			void viewerOpen(filePath).then(async (info) => {
				const symbols = info.symbols ?? [];
				await viewerClose(info.docId).catch(() => undefined);
				if (symbols.length === 0) {
					showMenuBelow(anchor, [{ label: t('breadcrumbs.noSymbols'), disabled: true }]);
					return;
				}
				const editor = this.active;
				showMenuBelow(anchor, symbols.map((symbol) => ({
					label: symbol.name,
					run: () => {
						if (editor) this.revealIn(editor, symbol.line + 1, 1);
					}
				})));
			}).catch(() => undefined); // no outline for this file (binary, unreadable): no menu
		};
		parts.forEach((part, index) => {
			if (index > 0) this.breadcrumbs.appendChild(icon('chevron-right'));
			const last = index === parts.length - 1;
			const glyph = icon(last ? this.active!.iconClass ?? fileIcon(part) : 'folder');
			const color = last ? fileIconColor(part) : undefined;
			if (color) glyph.style.color = color;
			const crumb = el('span', 'crumb', [glyph, part]);
			// Clicking a crumb opens its dropdown (VS Code's breadcrumb picker): the folder
			// crumbs walk the workspace, the file crumb walks the outline.
			crumb.style.cursor = 'pointer';
			const node = nodePath(index);
			crumb.title = node;
			crumb.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (last) openFileMenu(crumb, path!);
				else openFolderMenu(crumb, node);
			});
			this.breadcrumbs.appendChild(crumb);
		});
	},
};
