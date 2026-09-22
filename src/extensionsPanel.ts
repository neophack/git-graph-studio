// The Extensions view: the installed extensions (built-in and user-installed) with their icons
// and metadata, the "Install from GGX..." / "Install from VSIX..." actions (Studio's own
// format, and the VS Code compatibility path), per-extension uninstall, and the process
// backends' status (running pid / why not, restart). A row's click opens the extension's
// detail page — VS Code's extension editor: the header's facts and actions, then the README
// rendered — in an editor tab through `onOpenDetail` (the workbench wires it). Nothing is
// installed by default: the two bundled packages — the integrated git-graph-rs and the GGX
// Demo sample, both carried by the installer — list from their embedded manifests until
// one-click installed (installBundled), after which each is a standard, uninstallable package.

import { open as openDialog } from '@tauri-apps/plugin-dialog';

import type { ExtInfo, ExtProcessInfo, ExtensionHost } from './extHost';
import { extFileDataUrl, extTitle } from './extHost';
import { renderMarkdown } from './markdown';
import { t, tf } from './i18n';
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
	private processes = new Map<string, ExtProcessInfo>();
	private readonly host: ExtensionHost;
	private installedIds = new Set<string>();

	/** Signals the workbench so it can refresh what the activation state changed. */
	onChanged: (() => void) | null = null;
	/** A row was clicked: the workbench opens the extension's detail page (an editor tab). */
	onOpenDetail: ((ext: ExtInfo) => void) | null = null;

	constructor(container: HTMLElement, host: ExtensionHost) {
		this.host = host;
		container.appendChild(el('div', 'sidebar-title', [el('span', 'label', [t('extensions.title')])]));
		const pane = el('div', 'view-pane');
		const header = el('div', 'pane-header');
		header.appendChild(el('span', 'label', [t('extensions.installed')]));
		header.appendChild(actionButton('package', t('extensions.installFromGgx'), () => void this.pickGgx()));
		header.appendChild(actionButton('package', t('extensions.installFromVsix'), () => void this.pickVsix()));
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
			notify('error', tf('extensions.listFailed', String(error)));
		}
		// The backends' state rides the same refresh, so a restart's effect shows at once.
		this.processes = new Map((await this.host.processStatus()).map((info) => [info.extensionId, info]));
		this.render();
	}

	private render(): void {
		this.list.replaceChildren();
		if (this.extensions.length === 0) {
			this.list.appendChild(el('p', 'empty', [t('extensions.empty')]));
			return;
		}
		for (const ext of this.extensions) {
			const processInfo = this.processes.get(ext.id) ?? null;
			const isProcessPackage = ext.ggx?.backend?.kind === 'process';
			const row = el('div', 'ext-row', [
				this.iconBox(ext),
				el('div', 'ext-main', [
					el('div', 'ext-name', [extTitle(ext), ' ', el('span', 'ext-version', [`v${ext.version}`])]),
					el('div', 'ext-publisher', [
						ext.publisher,
						ext.builtin ? el('span', 'ext-builtin', [t('extensions.builtIn')])
							: ext.format === 'builtin' ? el('span', 'ext-builtin', [t('extensions.sample')]) : null
					]),
					ext.description ? el('div', 'ext-description', [ext.description]) : null,
					this.processLine(ext, isProcessPackage, processInfo)
				]),
				// A bundled entry that is not yet installed (an embedded-manifest offer): the
				// bundled package is one click away. Installed entries: uninstall (a process
				// package's backend dies with it — the Rust side stops it before removing the
				// directory).
				ext.format === 'builtin'
					? actionButton('package', t(ext.builtin ? 'extensions.installBundled' : 'extensions.installSample'), () => void this.installBundled(ext))
					: ext.builtin ? null : actionButton('trash', tf('extensions.uninstall', ext.id), () => void this.uninstall(ext)),
				isProcessPackage ? actionButton('refresh', t('extensions.restart'), () => void this.restart(ext)) : null
			]);
			row.title = ext.builtin
				? tf('extensions.builtInTooltip', ext.id, ext.version)
				: `${ext.id} v${ext.version}`;
			// actionButton()'s own click handler stops propagation, so this never fires for the
			// row's buttons (install/uninstall/restart): the row itself opens the detail page.
			row.addEventListener('click', () => this.onOpenDetail?.(ext));
			this.list.appendChild(row);
		}
	}

	/** The extension's icon box: the codicon placeholder until its real icon image loads
	 *  (README images and icons cross the bridge the same way, as data URLs). */
	private iconBox(ext: ExtInfo, extra = ''): HTMLElement {
		const box = el('div', `ext-icon-box${extra ? ' ' + extra : ''}`, [icon('extensions', 'ext-icon')]);
		if (ext.icon) {
			void extFileDataUrl(ext.id, iconRelPath(ext)).then((url) => {
				if (url) this.replaceIcon(box, url);
			});
		}
		return box;
	}

	/** The extension's detail page (VS Code's extension editor), mounted into the editor tab
	 *  the workbench opens on a row click: the header (icon, name, version, description,
	 *  actions), the facts table, then the README rendered through the same markdown machinery
	 *  the preview uses — relative images resolved from the package's own files. */
	mountDetail(ext: ExtInfo, pane: HTMLElement): void {
		const processInfo = this.processes.get(ext.id) ?? null;
		const page = el('div', 'ext-detail-page');
		page.append(this.detailHeader(ext, processInfo), this.detailFacts(ext, processInfo));
		const readme = el('section', 'ext-detail-readme', [el('h3', '', [t('extensions.readme')])]);
		const article = el('article', 'markdown-preview-body');
		readme.appendChild(article);
		page.appendChild(readme);
		pane.appendChild(page);
		// The built-in listing has no install directory: nothing to read the README from until
		// the bundled package is installed.
		if (!ext.readme || ext.format === 'builtin') {
			article.appendChild(el('p', 'ext-readme-missing', [t(ext.format === 'builtin' ? 'extensions.readmeNoneBuiltin' : 'extensions.readmeMissing')]));
			return;
		}
		const file = ext.readme;
		void this.host.readFile(ext.id, file)
			.then(async (text) => {
				// A stalled markdown-it load falls back to the source, as the preview does.
				if (!(await renderMarkdown(text, article, (relative) => extFileDataUrl(ext.id, relative)))) {
					article.replaceChildren(el('pre', 'ext-readme-source', [text]));
				}
			})
			.catch((error) => {
				article.appendChild(el('p', 'ext-readme-missing', [tf('extensions.readmeFailed', String(error))]));
			});
	}

	/** The page's header: the icon, the identity lines, and the actions a row also carries. */
	private detailHeader(ext: ExtInfo, processInfo: ExtProcessInfo | null): HTMLElement {
		const backend = ext.ggx?.backend ?? null;
		const uninstall = el('button', 'button secondary', [t('extensions.uninstallAction')]);
		uninstall.addEventListener('click', () => void this.uninstall(ext));
		const restart = el('button', 'button secondary', [t('extensions.restart')]);
		restart.addEventListener('click', () => void this.restart(ext));
		const install = el('button', 'button', [t(ext.builtin ? 'extensions.installBundled' : 'extensions.installSample')]);
		install.addEventListener('click', () => void this.installBundled(ext));
		return el('div', 'ext-detail-head', [
			this.iconBox(ext, 'ext-detail-icon'),
			el('div', 'ext-detail-head-main', [
				el('h2', 'ext-detail-title', [extTitle(ext)]),
				el('div', 'ext-detail-sub', [
					ext.publisher, ` · v${ext.version}`, ext.builtin && ext.format !== 'builtin' ? ` · ${t('extensions.builtIn')}` : ''
				]),
				ext.description ? el('p', 'ext-detail-desc', [ext.description]) : null
			]),
			el('div', 'ext-detail-actions', [
				ext.format === 'builtin' ? install : ext.builtin ? null : uninstall,
				backend ? restart : null
			])
		]);
	}

	/** Identifier, install location, declared backend (and its live process), repository,
	 *  license, permissions — the fields a row's summary line has no room for. */
	private detailFacts(ext: ExtInfo, processInfo: ExtProcessInfo | null): HTMLElement {
		const backend = ext.ggx?.backend ?? null;
		const backendLine = backend
			? tf('extensions.backendSummary', backend.kind, backend.protocol ?? 'ggs-ext/1', backend.command)
			: t('extensions.backendNone');
		const permissions = ext.ggx?.permissions ?? [];
		const row = (label: string, value: string) => el('div', 'ext-detail-row', [
			el('span', 'ext-detail-label', [label]),
			el('span', 'ext-detail-value', [value])
		]);
		const rows = [
			row(t('extensions.identifier'), ext.id),
			row(t('extensions.installLocation'), ext.path || t('extensions.installLocationEmbedded')),
			row(t('extensions.backend'), backendLine)
		];
		if (backend && processInfo) rows.push(row('', `${processInfo.protocolVersion}, pid ${processInfo.pid || '–'}`));
		if (ext.repository) rows.push(row(t('extensions.repository'), ext.repository));
		if (ext.license) rows.push(row(t('extensions.license'), ext.license));
		rows.push(row(t('extensions.permissions'), permissions.length > 0 ? permissions.join(', ') : t('extensions.permissionsNone')));
		return el('div', 'ext-detail-facts', rows);
	}

	/** The status line under a process package's description: what runs, or why nothing does. */
	private processLine(ext: ExtInfo, isProcessPackage: boolean, info: ExtProcessInfo | null): HTMLElement | null {
		if (!isProcessPackage) return null;
		if (info !== null && info.pid > 0) {
			return el('div', 'ext-process running', [tf('extensions.processRunning', info.pid, info.startCount)]);
		}
		const suffix = info?.lastError ? ` · ${info.lastError}` : '';
		return el('div', 'ext-process', [tf('extensions.processNotRunning', suffix)]);
	}

	/** Swap the placeholder codicon for the extension's real icon image. */
	private replaceIcon(box: HTMLElement, url: string): void {
		const image = el('img', 'ext-icon-img');
		image.src = url;
		image.alt = '';
		box.replaceChildren(image);
	}

	/** The command palette entry point (Extensions: Install Extension from GGX...). */
	async installFromGgxCommand(): Promise<void> {
		await this.pickGgx();
	}

	/** The command palette entry point (Extensions: Install Extension from VSIX...) — the
	 *  VS Code compatibility path. */
	async installFromVsixCommand(): Promise<void> {
		await this.pickVsix();
	}

	private async pickGgx(): Promise<void> {
		await this.pickPackage(t('extensions.installPickTitle'), [{ name: 'GGX package', extensions: ['ggx'] }], (path) => this.host.installFromGgx(path));
	}

	private async pickVsix(): Promise<void> {
		await this.pickPackage(t('extensions.installPickTitleVsix'), [{ name: 'VS Code extension', extensions: ['vsix'] }], (path) => this.host.installFromVsix(path));
	}

	private async pickPackage(title: string, filters: { name: string; extensions: string[] }[], install: (path: string) => Promise<{ id: string; version: string }>): Promise<void> {
		let selected: string | string[] | null;
		try {
			selected = await openDialog({ multiple: false, directory: false, title, filters });
		} catch (error) {
			notify('error', tf('extensions.installPickFailed', String(error)));
			return;
		}
		if (!selected) return;
		const path = Array.isArray(selected) ? selected[0]! : selected;
		try {
			const info = await install(path);
			notify('info', tf('extensions.installedOk', info.id, info.version));
			this.onChanged?.();
		} catch (error) {
			notify('error', String(error));
		}
		await this.refresh();
	}

	/** One-click install of an entry's bundled package (the integrated git-graph-rs or the
	 *  bundled GGX Demo sample — both shipped by the installer, neither installed until the
	 *  user asks here). */
	private async installBundled(ext: ExtInfo): Promise<void> {
		try {
			const info = await this.host.installBundled(ext.id);
			notify('info', tf('extensions.installedOk', info.id, info.version));
			this.onChanged?.();
		} catch (error) {
			notify('error', String(error));
		}
		await this.refresh();
	}

	private async restart(ext: ExtInfo): Promise<void> {
		try {
			await this.host.restartProcess(ext.id);
		} catch (error) {
			notify('error', tf('extensions.restartFailed', ext.id, String(error)));
		}
		await this.refresh();
	}

	private async uninstall(ext: ExtInfo): Promise<void> {
		if (!(await confirmDialog(tf('extensions.uninstallConfirm', ext.id, ext.version), t('extensions.uninstallAction')))) return;
		try {
			await this.host.uninstall(ext.id);
			this.onChanged?.();
		} catch (error) {
			notify('error', String(error));
		}
		await this.refresh();
	}
}
