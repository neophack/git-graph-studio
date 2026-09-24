// The Extensions view: the installed extensions (bundled offers and user-installed packages)
// with their icons and metadata, the "Install from VSIX..." action
// (Studio's own format, and the VS Code compatibility path), per-extension uninstall, and the
// process backends' status (running pid / why not, restart). A row's click opens the
// extension's detail page — VS Code's extension editor: the header's facts and actions, then
// the README rendered — in an editor tab through `onOpenDetail` (the workbench wires it).
// The search box at the top queries the marketplace (Open VSX, over the backend's
// gallery commands) and offers one-click Install / Update — a marketplace package installs
// through exactly the path a picked VSIX takes.
// Nothing is installed by default: the packages the installer ships beside the app (the Git
// Graph engine view) lists from its manifest until one-click installed
// (installBundled), after which each is a standard, uninstallable package.

import { open as openDialog } from '@tauri-apps/plugin-dialog';

import type { ExtInfo, ExtProcessInfo, ExtensionHost, GalleryEntry } from './extHost';
import { extFileDataUrl, extIconRelPath as iconRelPath, extTitle } from './extHost';
import { renderMarkdown } from './markdown';
import { t, tf } from './i18n';
import { actionButton, confirmDialog, el, icon, notify } from './ui';

export class ExtensionsPanel {
	private readonly body: HTMLElement;
	private readonly list: HTMLElement;
	private extensions: ExtInfo[] = [];
	private processes = new Map<string, ExtProcessInfo>();
	private readonly host: ExtensionHost;
	private installedIds = new Set<string>();
	/** The marketplace search box; Enter searches, Escape restores the installed list. */
	private readonly searchInput: HTMLInputElement;
	/** The last search's entries, or null while no search is showing (the installed list). */
	private galleryResults: GalleryEntry[] | null = null;
	/** The last search's total match count on the registry (the count line above the rows). */
	private galleryTotal = 0;
	private searching = false;
	/** Gallery entry ids with an install in flight (their rows show the busy state). */
	private readonly installing = new Set<string>();

	/** Signals the workbench so it can refresh what the activation state changed. */
	onChanged: (() => void) | null = null;
	/** A row was clicked: the workbench opens the extension's detail page (an editor tab). */
	onOpenDetail: ((ext: ExtInfo) => void) | null = null;

	constructor(container: HTMLElement, host: ExtensionHost) {
		this.host = host;
		container.appendChild(el('div', 'sidebar-title', [el('span', 'label', [t('extensions.title')])]));
		const pane = el('div', 'view-pane');
		this.searchInput = el('input', 'input ext-search-input') as HTMLInputElement;
		this.searchInput.type = 'search';
		this.searchInput.placeholder = t('extensions.searchPlaceholder');
		this.searchInput.setAttribute('aria-label', t('extensions.searchPlaceholder'));
		this.searchInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') void this.searchMarketplace(this.searchInput.value);
			if (event.key === 'Escape') this.clearSearch();
		});
		pane.appendChild(el('div', 'ext-search', [this.searchInput]));
		const header = el('div', 'pane-header');
		header.appendChild(el('span', 'label', [t('extensions.installed')]));
		header.appendChild(actionButton('package', t('extensions.installFromVsix'), () => void this.pickVsix()));
		this.body = el('div', 'pane-body list');
		this.body.tabIndex = 0;
		this.list = el('div', 'ext-list');
		this.body.appendChild(this.list);
		pane.append(header, this.body);
		container.appendChild(pane);
		this.render();
	}

	/** Focus the marketplace search box (the palette command's entry point). */
	focusSearch(): void {
		this.searchInput.focus();
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
		// A search in flight replaces the list with its busy line; a finished search shows
		// its results until cleared (Escape, or emptying the box and pressing Enter again).
		if (this.searching) {
			this.list.appendChild(el('p', 'empty', [t('extensions.searchingMarketplace')]));
			return;
		}
		if (this.galleryResults !== null) {
			this.renderGallery();
			return;
		}
		if (this.extensions.length === 0) {
			this.list.appendChild(el('p', 'empty', [t('extensions.empty')]));
			return;
		}
		for (const ext of this.extensions) {
			const processInfo = this.processes.get(ext.id) ?? null;
			// Both backend kinds run as a process the Extensions view shows status for: the
			// package's own binary (`process`) and an engine `.node` (`node`).
			const isProcessPackage = ext.capabilities?.backend?.kind === 'process' || ext.capabilities?.backend?.kind === 'node';
			const row = el('div', 'ext-row', [
				this.iconBox(ext),
				el('div', 'ext-main', [
					el('div', 'ext-name', [extTitle(ext), ' ', el('span', 'ext-version', [`v${ext.version}`])]),
					el('div', 'ext-publisher', [
						ext.publisher,
						ext.builtin ? el('span', 'ext-builtin', [t('extensions.builtIn')])
							: ext.format === 'bundled' ? el('span', 'ext-builtin', [t('extensions.sample')]) : null
					]),
					ext.description ? el('div', 'ext-description', [ext.description]) : null,
					this.processLine(ext, isProcessPackage, processInfo)
				]),
				// A bundled entry that is not yet installed (an embedded-manifest offer): the
				// bundled package is one click away. Installed entries: uninstall (a process
				// package's backend dies with it — the Rust side stops it before removing the
				// directory).
				ext.format === 'bundled'
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

	/* ---------- The marketplace search (Open VSX, over the backend gallery commands) ---------- */

	/** Run the search the box names: results replace the installed list until cleared. */
	async searchMarketplace(query: string): Promise<void> {
		const trimmed = query.trim();
		if (trimmed === '') {
			this.clearSearch();
			return;
		}
		this.searching = true;
		this.render();
		try {
			const answer = await this.host.searchGallery(trimmed);
			this.galleryTotal = answer.totalSize;
			this.galleryResults = answer.entries;
		} catch (error) {
			notify('error', tf('extensions.searchFailed', String(error)));
			this.galleryResults = null;
		} finally {
			this.searching = false;
			this.render();
		}
	}

	/** Drop the search and restore the installed list. */
	clearSearch(): void {
		this.galleryResults = null;
		this.searchInput.value = '';
		this.render();
	}

	/** The last search's rows: icon, name, publisher, description, downloads — and the
	 *  action its install state names (Install / Update to vX / the installed tag). */
	private renderGallery(): void {
		const entries = this.galleryResults!;
		if (entries.length === 0) {
			this.list.appendChild(el('p', 'empty', [t('extensions.searchNone')]));
			return;
		}
		this.list.appendChild(el('p', 'ext-gallery-count', [tf('extensions.searchCount', String(entries.length), String(this.galleryTotal))]));
		for (const entry of entries) {
			const row = el('div', 'ext-row gallery-row', [
				this.galleryIconBox(entry),
				el('div', 'ext-main', [
					el('div', 'ext-name', [entry.displayName ?? entry.name, ' ', el('span', 'ext-version', [`v${entry.version}`])]),
					el('div', 'ext-publisher', [entry.namespace, entry.verified ? el('span', 'ext-verified', [t('extensions.verified')]) : null]),
					entry.description ? el('div', 'ext-description', [entry.description]) : null,
					el('div', 'ext-gallery-stats', [tf('extensions.downloads', entry.downloadCount.toLocaleString())])
				]),
				this.galleryAction(entry)
			]);
			row.title = `${entry.id} v${entry.version}`;
			this.list.appendChild(row);
		}
	}

	/** A marketplace result's icon box: the codicon placeholder until the gallery's icon
	 *  lands (base64 over the backend, the same data-URL bridge installed icons use). */
	private galleryIconBox(entry: GalleryEntry): HTMLElement {
		const box = el('div', 'ext-icon-box', [icon('extensions', 'ext-icon')]);
		if (entry.iconUrl) {
			void this.host.galleryIcon(entry.iconUrl).then((url) => {
				if (url) this.replaceIcon(box, url);
			});
		}
		return box;
	}

	/** The action a result's install state names: a busy line while installing, Install or
	 *  Update to the marketplace's version when an older one is installed, and the plain
	 *  installed tag when the install is current (or ahead of the registry). */
	private galleryAction(entry: GalleryEntry): HTMLElement {
		if (this.installing.has(entry.id)) {
			const busy = el('span', 'ext-installed-tag', [t('extensions.marketplaceInstalling')]);
			busy.classList.add('busy');
			return busy;
		}
		const installed = this.extensions.find((ext) => ext.id === entry.id);
		if (!installed) return actionButton('cloud-download', t('extensions.installFromMarketplace'), () => void this.installGallery(entry));
		if (compareVersions(installed.version, entry.version) >= 0) return el('span', 'ext-installed-tag', [t('extensions.marketplaceInstalled')]);
		return actionButton('cloud-download', tf('extensions.updateTo', entry.version), () => void this.installGallery(entry));
	}

	/** Download and install one marketplace entry: the busy state on its row, the ordinary
	 *  install notification on success, and the list refreshed either way (a finished
	 *  install changes the row's action, and the installed list behind the search). */
	private async installGallery(entry: GalleryEntry): Promise<void> {
		this.installing.add(entry.id);
		this.render();
		try {
			const info = await this.host.installFromGallery(entry);
			notify('info', tf('extensions.installedOk', info.id, info.version));
			this.onChanged?.();
		} catch (error) {
			notify('error', tf('extensions.marketplaceInstallFailed', String(error)));
		} finally {
			this.installing.delete(entry.id);
		}
		await this.refresh();
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
		if (!ext.readme || ext.format === 'bundled') {
			article.appendChild(el('p', 'ext-readme-missing', [t(ext.format === 'bundled' ? 'extensions.readmeNoneBuiltin' : 'extensions.readmeMissing')]));
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
		const backend = ext.capabilities?.backend ?? null;
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
					ext.publisher, ` · v${ext.version}`, ext.builtin ? ` · ${t('extensions.builtIn')}` : ''
				]),
				ext.description ? el('p', 'ext-detail-desc', [ext.description]) : null
			]),
			el('div', 'ext-detail-actions', [
				ext.format === 'bundled' ? install : ext.builtin ? null : uninstall,
				backend ? restart : null
			])
		]);
	}

	/** Identifier, install location, declared backend (and its live process), repository,
	 *  license, permissions — the fields a row's summary line has no room for. */
	private detailFacts(ext: ExtInfo, processInfo: ExtProcessInfo | null): HTMLElement {
		const backend = ext.capabilities?.backend ?? null;
		const backendLine = backend
			? tf('extensions.backendSummary', backend.kind, backend.protocol ?? 'ggs-ext/1', backend.command)
			: t('extensions.backendNone');
		const permissions = ext.capabilities?.permissions ?? [];
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

	/** The command palette entry point (Extensions: Install Extension from VSIX...) — the
	 *  VS Code compatibility path. */
	async installFromVsixCommand(): Promise<void> {
		await this.pickVsix();
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

	/** One-click install of an entry's bundled package (the Git Graph engine view or the
	 *  bundled package — shipped by the installer, not installed until the
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

/** Numeric x.y.z comparison (the backend's install rule): anything unparseable sorts below. */
function compareVersions(a: string, b: string): number {
	const tuple = (v: string): [number, number, number] => {
		const parts = v.split(/[-+]/)[0]!.split('.');
		const at = (i: number) => Number(parts[i]) || 0;
		return [at(0), at(1), at(2)];
	};
	const [a1, a2, a3] = tuple(a);
	const [b1, b2, b3] = tuple(b);
	return a1 !== b1 ? a1 - b1 : a2 !== b2 ? a2 - b2 : a3 - b3;
}
