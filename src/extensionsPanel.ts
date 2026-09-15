// The Extensions view: the installed extensions (built-in and VSIX-installed) with their icons
// and metadata, the "Install from VSIX..." action and per-extension uninstall. Upgrades happen
// by installing a VSIX with a higher version - the Rust side replaces the old one;
// built-ins (git-graph-rs) refuse to uninstall but accept upgrades.

import { open as openDialog } from '@tauri-apps/plugin-dialog';

import type { ExtInfo, ExtensionHost } from './extHost';
import { extFileDataUrl, extTitle } from './extHost';
import { actionButton, confirmDialog, el, icon, notify } from './ui';

/** The icon path as `ext_read_file_base64` expects it: relative to the extension's install
 *  root. `ExtInfo.icon` is absolute (`<root>/<manifest path>`), so strip the root — reducing
 *  it to a bare file name loses icons kept in a subfolder (`resources/icon.png`). */
function iconRelPath(ext: ExtInfo): string {
	const iconPath = ext.icon!;
	const root = ext.path.replace(/[\\/]+$/, '');
	if (root !== '' && (iconPath.startsWith(root + '/') || iconPath.startsWith(root + '\\'))) return iconPath.slice(root.length + 1);
	return iconPath.split(/[\\/]/).pop()!; // unexpected shape: at least the file name is right
}

export class ExtensionsPanel {
	private readonly body: HTMLElement;
	private readonly list: HTMLElement;
	private extensions: ExtInfo[] = [];
	private readonly host: ExtensionHost;
	private installedIds = new Set<string>();

	/** Signals the workbench so it can refresh what the activation state changed. */
	onChanged: (() => void) | null = null;

	constructor(container: HTMLElement, host: ExtensionHost) {
		this.host = host;
		container.appendChild(el('div', 'sidebar-title', [el('span', 'label', ['Extensions'])]));
		const pane = el('div', 'view-pane');
		const header = el('div', 'pane-header');
		header.appendChild(el('span', 'label', ['Installed']));
		header.appendChild(actionButton('install', 'Install from VSIX...', () => void this.pickVsix()));
		this.body = el('div', 'pane-body list');
		this.body.tabIndex = 0;
		this.list = el('div', 'ext-list');
		this.body.appendChild(this.list);
		pane.append(header, this.body);
		container.appendChild(pane);
		this.render();
	}

	async refresh(): Promise<void> {
		try {
			this.extensions = await this.host.list();
			this.installedIds = new Set(this.extensions.map((e) => e.id));
		} catch (error) {
			this.extensions = [];
			notify('error', `Could not list extensions: ${String(error)}`);
		}
		this.render();
	}

	private render(): void {
		this.list.replaceChildren();
		if (this.extensions.length === 0) {
			this.list.appendChild(el('p', 'empty', ['No extensions installed']));
			return;
		}
		for (const ext of this.extensions) {
			const row = el('div', 'ext-row', [
				el('div', 'ext-icon-box', [icon('extensions', 'ext-icon')]),
				el('div', 'ext-main', [
					el('div', 'ext-name', [extTitle(ext), ' ', el('span', 'ext-version', [`v${ext.version}`])]),
					el('div', 'ext-publisher', [ext.publisher, ext.builtin ? el('span', 'ext-builtin', ['built-in']) : null]),
					ext.description ? el('div', 'ext-description', [ext.description]) : null
				]),
				ext.builtin ? null : actionButton('trash', `Uninstall ${ext.id}`, () => void this.uninstall(ext))
			]);
			row.title = `${ext.id} v${ext.version}${ext.builtin ? ' (built into Git Graph Studio; upgrade by installing a newer VSIX)' : ''}`;
			this.list.appendChild(row);
			if (ext.icon) {
				const box = row.querySelector<HTMLElement>('.ext-icon-box')!;
				void extFileDataUrl(ext.id, iconRelPath(ext)).then((url) => {
					if (url) this.replaceIcon(box, url);
				});
			}
		}
	}

	/** Swap the placeholder codicon for the extension's real icon image. */
	private replaceIcon(box: HTMLElement, url: string): void {
		const image = el('img', 'ext-icon-img');
		image.src = url;
		image.alt = '';
		box.replaceChildren(image);
	}

	/** The command palette entry point (Extensions: Install Extension from VSIX...). */
	async installFromVsixCommand(): Promise<void> {
		await this.pickVsix();
	}

	private async pickVsix(): Promise<void> {
		let selected: string | string[] | null;
		try {
			selected = await openDialog({ multiple: false, directory: false, title: 'Install from VSIX or GGX...', filters: [{ name: 'Extension package', extensions: ['vsix', 'ggx'] }] });
		} catch (error) {
			notify('error', `Could not open the file picker: ${String(error)}`);
			return;
		}
		if (!selected) return;
		await this.install(Array.isArray(selected) ? selected[0]! : selected);
	}

	async install(path: string): Promise<void> {
		try {
			const info = await this.host.installPackage(path);
			notify('info', `Installed ${info.id} v${info.version}.`);
			this.onChanged?.();
		} catch (error) {
			notify('error', String(error));
		}
		await this.refresh();
	}

	private async uninstall(ext: ExtInfo): Promise<void> {
		if (!(await confirmDialog(`Uninstall ${ext.id} v${ext.version}?`, 'Uninstall'))) return;
		try {
			await this.host.uninstall(ext.id);
			this.onChanged?.();
		} catch (error) {
			notify('error', String(error));
		}
		await this.refresh();
	}
}
