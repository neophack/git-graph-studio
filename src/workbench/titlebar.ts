// The custom title bar, laid out as VS Code's on Windows: the app icon and the menu bar on the
// left, the command center (search box) in the middle, and the minimize / maximize / close
// window controls on the right. The bar is the window's drag region (Tauri handles the drag
// and the double-click-to-maximize); the menus are the shell's own dropdowns.

import { getCurrentWindow } from '@tauri-apps/api/window';

import { closeContextMenu, el, icon, isMenuOpen, showMenuBelow, type MenuEntry } from '../platform/ui/index';
import { onLocaleChange, t, tf } from '../platform/i18n';

export interface MenuDefinition {
	label: string;
	/** Computed when opened, so enablement and checkmarks reflect the current state. */
	entries: () => MenuEntry[];
}

/** The subset of the window API the bar drives (mocked in the tests). */
export interface WindowControls {
	minimize(): Promise<void>;
	toggleMaximize(): Promise<void>;
	close(): Promise<void>;
	isMaximized(): Promise<boolean>;
	onResized(handler: () => void): Promise<() => void>;
}

function tauriWindowControls(): WindowControls {
	const window = getCurrentWindow();
	return {
		minimize: () => window.minimize(),
		toggleMaximize: () => window.toggleMaximize(),
		close: () => window.close(),
		isMaximized: () => window.isMaximized(),
		onResized: (handler) => window.onResized(handler)
	};
}

export class TitleBar {
	private readonly container: HTMLElement;
	private readonly menubar: HTMLElement;
	private readonly commandCenter: HTMLElement;
	private readonly commandCenterLabel: HTMLElement;
	private readonly maximizeButton: HTMLElement;
	private readonly minimizeButton: HTMLElement;
	private readonly closeButton: HTMLElement;
	private readonly backButton: HTMLElement;
	private readonly forwardButton: HTMLElement;
	private menus: MenuDefinition[] = [];
	/** The open folder's name, kept so a language switch can re-render the command center. */
	private folderName: string | null = null;
	/** The window's maximized state, kept so a language switch re-derives the tooltip. */
	private maximized = false;

	onCommandCenter: (() => void) | null = null;
	onBack: (() => void) | null = null;
	onForward: (() => void) | null = null;

	constructor(container: HTMLElement, private readonly controls: WindowControls = tauriWindowControls()) {
		this.container = container;
		container.setAttribute('data-tauri-drag-region', '');
		container.setAttribute('role', 'banner');

		const logo = el('img', 'titlebar-logo');
		logo.src = import.meta.env.BASE_URL + 'icons/icon.png';
		logo.alt = '';
		logo.setAttribute('data-tauri-drag-region', '');
		this.menubar = el('div', 'menubar');
		this.menubar.setAttribute('role', 'menubar');
		const left = el('div', 'titlebar-left', [logo, this.menubar]);
		left.setAttribute('data-tauri-drag-region', '');

		this.commandCenterLabel = el('span', 'label', ['Git Graph Studio']);
		this.commandCenter = el('div', 'command-center', [icon('search'), this.commandCenterLabel]);
		this.commandCenter.setAttribute('role', 'button');
		this.commandCenter.title = t('titlebar.commandCenter');
		this.commandCenter.addEventListener('click', () => this.onCommandCenter?.());
		const navButton = (name: 'left' | 'right', title: string, run: () => void) => {
			const button = el('div', 'titlebar-nav', [icon(`arrow-${name}`)]);
			button.title = title;
			button.setAttribute('role', 'button');
			button.addEventListener('click', run);
			return button;
		};
		this.backButton = navButton('left', t('titlebar.goBack'), () => this.onBack?.());
		this.forwardButton = navButton('right', t('titlebar.goForward'), () => this.onForward?.());
		this.backButton.classList.add('disabled');
		this.forwardButton.classList.add('disabled');
		const center = el('div', 'titlebar-center', [this.backButton, this.forwardButton, this.commandCenter]);
		center.setAttribute('data-tauri-drag-region', '');

		const control = (name: string, title: string, run: () => void) => {
			const button = el('div', `window-control ${name}`, [icon(`chrome-${name}`)]);
			button.title = title;
			button.setAttribute('role', 'button');
			button.addEventListener('click', run);
			return button;
		};
		this.minimizeButton = control('minimize', t('titlebar.minimize'), () => void this.controls.minimize());
		this.maximizeButton = control('maximize', t('titlebar.maximize'), () => void this.controls.toggleMaximize().then(() => this.updateMaximized()));
		this.closeButton = control('close', t('titlebar.close'), () => void this.controls.close());
		const right = el('div', 'window-controls', [this.minimizeButton, this.maximizeButton, this.closeButton]);

		container.append(left, center, right);
		void this.updateMaximized();
		void this.controls.onResized(() => void this.updateMaximized());
		// The bar is built once: a language switch relabels its static tooltips and the
		// command center in place (the menus relabel through their own SETTINGS_EVENT pass).
		onLocaleChange(() => {
			this.commandCenter.title = t('titlebar.commandCenter');
			this.minimizeButton.title = t('titlebar.minimize');
			this.maximizeButton.title = t(this.maximized ? 'titlebar.restoreDown' : 'titlebar.maximize');
			this.closeButton.title = t('titlebar.close');
			this.setNavigation(!this.backButton.classList.contains('disabled'), !this.forwardButton.classList.contains('disabled'));
			this.setFolderName(this.folderName);
		});
	}

	setMenus(menus: MenuDefinition[]): void {
		this.menus = menus;
		this.menubar.innerHTML = '';
		for (const menu of menus) {
			const item = el('div', 'menubar-item', [menu.label]);
			item.setAttribute('role', 'menuitem');
			item.addEventListener('mousedown', (event) => {
				event.preventDefault();
				if (item.classList.contains('open')) closeContextMenu();
				else this.open(item, menu);
			});
			// Sliding across the bar while a menu is open switches menus, like VS Code.
			item.addEventListener('mouseenter', () => {
				if (isMenuOpen() && !item.classList.contains('open') && this.menubar.querySelector('.menubar-item.open')) this.open(item, menu);
			});
			this.menubar.appendChild(item);
		}
	}

	/** Open a menu by label (the tests, and Alt+F style access). */
	openMenu(label: string): boolean {
		const index = this.menus.findIndex((m) => m.label === label);
		const item = this.menubar.children[index] as HTMLElement | undefined;
		if (index === -1 || !item) return false;
		this.open(item, this.menus[index]!);
		return true;
	}

	/** The bar's current menu definitions — the phone shell's ☰ serves them whole (its
	 *  action sheet turns each menu into a second level, enablement computed on open). */
	menuDefinitions(): MenuDefinition[] {
		return this.menus;
	}

	private open(item: HTMLElement, menu: MenuDefinition): void {
		showMenuBelow(item, menu.entries(), 240);
		item.classList.add('open');
	}

	/** Enablement of the back/forward arrows, as the navigation history allows. */
	setNavigation(canBack: boolean, canForward: boolean): void {
		this.backButton.classList.toggle('disabled', !canBack);
		this.backButton.title = t(canBack ? 'titlebar.goBack' : 'titlebar.goBackPlain');
		this.forwardButton.classList.toggle('disabled', !canForward);
		this.forwardButton.title = t(canForward ? 'titlebar.goForward' : 'titlebar.goForwardPlain');
	}

	/** The command center shows the open folder, as VS Code's shows the workspace. */
	setFolderName(name: string | null): void {
		this.folderName = name;
		this.commandCenterLabel.textContent = name ? tf('titlebar.searchFolder', name) : 'Git Graph Studio';
	}

	private async updateMaximized(): Promise<void> {
		let maximized = false;
		try {
			maximized = await this.controls.isMaximized();
		} catch {
			// Not running under Tauri (tests): stay in the restored look.
		}
		this.container.classList.toggle('maximized', maximized);
		this.maximized = maximized;
		this.maximizeButton.innerHTML = '';
		this.maximizeButton.appendChild(icon(maximized ? 'chrome-restore' : 'chrome-maximize'));
		this.maximizeButton.title = t(maximized ? 'titlebar.restoreDown' : 'titlebar.maximize');
	}
}
