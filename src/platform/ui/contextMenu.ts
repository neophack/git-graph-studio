// Menus: context menus, the title bar's menus, the "..." menus — one renderer, VS Code's
// menu keyboard included.

import { el } from './dom';
import { icon } from './codicon';
import { trText } from '../i18n';

export interface MenuItem {
	label: string;
	keybinding?: string;
	disabled?: boolean;
	checked?: boolean;
	submenu?: MenuEntry[];
	run?: () => void;
}
export type MenuEntry = MenuItem | 'separator';

const openMenus: HTMLElement[] = [];

export function closeContextMenu(): void {
	for (const menu of openMenus.splice(0)) menu.remove();
	document.querySelector('.menubar-item.open')?.classList.remove('open');
}

export function isMenuOpen(): boolean {
	return openMenus.length > 0;
}

/** Render one menu level at a position; submenus open to the right of their item on hover. */
function renderMenu(x: number, y: number, entries: MenuEntry[], level: number, minWidth: number): HTMLElement {
	const menu = el('div', 'context-menu');
	menu.setAttribute('role', 'menu');
	menu.style.minWidth = `${minWidth}px`;
	let openSubmenu: HTMLElement | null = null;
	const closeSubmenu = () => {
		if (openSubmenu) {
			const index = openMenus.indexOf(openSubmenu);
			if (index !== -1) openMenus.splice(index).forEach((m) => m.remove());
			openSubmenu = null;
		}
	};
	for (const entry of entries) {
		if (entry === 'separator') {
			menu.appendChild(el('div', 'separator'));
			continue;
		}
		const item = el('div', 'item' + (entry.disabled ? ' disabled' : ''), [
			el('span', 'check', [entry.checked ? icon('check') : null]),
			// Labels arrive as the registry's English text whatever built them - the title bar's
			// commands, a view's "..." entries, an extension's contribution - and localize here,
			// the one place every menu (and submenu) level renders through.
			el('span', 'label', [trText(entry.label)])
		]);
		item.setAttribute('role', 'menuitem');
		// The pointer and the arrow keys share one focus ring per menu level.
		item.addEventListener('mouseenter', () => {
			for (const other of menu.querySelectorAll('.item.focused')) other.classList.remove('focused');
			if (!entry.disabled) item.classList.add('focused');
		});
		if (entry.submenu) {
			item.appendChild(icon('chevron-right', 'submenu-indicator'));
			item.addEventListener('mouseenter', () => {
				closeSubmenu();
				const rect = item.getBoundingClientRect();
				openSubmenu = renderMenu(rect.right - 4, rect.top - 5, entry.submenu!, level + 1, 180);
			});
			item.addEventListener('click', (event) => event.stopPropagation());
		} else {
			if (entry.keybinding) item.appendChild(el('span', 'keybinding', [entry.keybinding]));
			item.addEventListener('mouseenter', closeSubmenu);
			item.addEventListener('click', (event) => {
				event.stopPropagation();
				closeContextMenu();
				entry.run?.();
			});
		}
		menu.appendChild(item);
	}
	document.getElementById('overlays')!.appendChild(menu);
	openMenus.push(menu);
	// Keep the menu on screen; a submenu that does not fit to the right opens to the left.
	const rect = menu.getBoundingClientRect();
	let left = x;
	if (left + rect.width > window.innerWidth - 4) left = level > 0 ? Math.max(4, x - rect.width - 180 + 8) : Math.max(4, window.innerWidth - rect.width - 4);
	menu.style.left = `${left}px`;
	menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
	return menu;
}

/** A replacement presenter for context menus — the remote workbench's phone action sheet
 *  (src/remote/actionSheet.ts). Answering true means it showed the entries itself; callers
 *  of showContextMenu never know the difference. */
let menuPresenter: ((entries: MenuEntry[]) => boolean) | null = null;

export function setMenuPresenter(presenter: ((entries: MenuEntry[]) => boolean) | null): void {
	menuPresenter = presenter;
}

export function showContextMenu(x: number, y: number, entries: MenuEntry[]): void {
	closeContextMenu();
	if (menuPresenter?.(entries)) return;
	renderMenu(x, y, entries, 0, 180);
}

/** A menu dropped below an element (a title-bar menu, a "..." button). The presenter answers
 *  first here too: a touch phone shows every menu as the action sheet, never a floating panel
 *  whose submenus cascade left and right of it. */
export function showMenuBelow(anchor: HTMLElement, entries: MenuEntry[], minWidth = 200): void {
	closeContextMenu();
	if (menuPresenter?.(entries)) return;
	const rect = anchor.getBoundingClientRect();
	renderMenu(rect.left, rect.bottom, entries, 0, minWidth);
}

document.addEventListener('mousedown', (event) => {
	if (openMenus.length > 0 && !openMenus.some((menu) => menu.contains(event.target as Node)) && !(event.target as HTMLElement).closest('.menubar-item')) closeContextMenu();
});
/** VS Code's menu keyboard: Up/Down walk the enabled items of the innermost open menu (with
 *  wrap-around), Enter runs the focused one (or opens its submenu), Right opens a submenu,
 *  Left closes it, Escape closes everything. */
document.addEventListener('keydown', (event) => {
	if (openMenus.length === 0) return;
	if (event.key === 'Escape') {
		closeContextMenu();
		return;
	}
	const menu = openMenus[openMenus.length - 1]!;
	const items = Array.from(menu.querySelectorAll<HTMLElement>('.item:not(.disabled)'));
	if (items.length === 0) return;
	const current = items.findIndex((item) => item.classList.contains('focused'));
	const focus = (index: number) => {
		items.forEach((item, i) => item.classList.toggle('focused', i === index));
		items[index]?.scrollIntoView({ block: 'nearest' });
	};
	switch (event.key) {
		case 'ArrowDown':
			event.preventDefault();
			focus((current + 1) % items.length);
			break;
		case 'ArrowUp':
			event.preventDefault();
			focus((current - 1 + items.length) % items.length);
			break;
		case 'ArrowRight':
			if (current !== -1 && items[current]!.querySelector('.submenu-indicator')) {
				event.preventDefault();
				items[current]!.dispatchEvent(new MouseEvent('mouseenter'));
				const opened = openMenus[openMenus.length - 1];
				if (opened && opened !== menu) opened.querySelector<HTMLElement>('.item:not(.disabled)')?.classList.add('focused');
			}
			break;
		case 'ArrowLeft':
			if (openMenus.length > 1) {
				event.preventDefault();
				openMenus.pop()!.remove();
			}
			break;
		case 'Enter':
		case ' ':
			if (current !== -1) {
				event.preventDefault();
				const item = items[current]!;
				if (item.querySelector('.submenu-indicator')) item.dispatchEvent(new MouseEvent('mouseenter'));
				else item.click();
			}
			break;
	}
}, true);
window.addEventListener('blur', closeContextMenu);
