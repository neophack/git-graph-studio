// The Extensions view: the installed extensions (bundled offers and user-installed packages)
// with their icons and metadata, the "Install from VSIX..." action
// (Studio's own format, and the VS Code compatibility path), per-extension uninstall, and the
// process backends' status (running pid / why not, restart). A row's click opens the
// extension's detail page — VS Code's extension editor: the header's facts and actions, then
// the README rendered — in an editor tab through `onOpenDetail` (the workbench wires it).
// There is no marketplace search: the view offers exactly the featured packages the backend
// names (ext_gallery.rs's FEATURED — the owner's direction, 2026-09-27), each row merging its
// Open VSX entry (this machine's platform build) with its installed state: Install when
// absent, Update when the registry is ahead, the installed tag when current. A marketplace
// package installs through exactly the path a picked VSIX takes. Anything else installed
// (a picked VSIX, an older install) lists under "Other installed", so it stays removable.
// Nothing is installed by default: the packages the installer ships beside the app (the Git
// Graph engine view) lists from its manifest until one-click installed
// (installBundled), after which each is a standard, uninstallable package — and that
// offline offer is what a featured row falls back to when the marketplace is unreachable.

import { open as openDialog } from '@tauri-apps/plugin-dialog';

import type { ExtInfo, ExtProcessInfo, ExtensionHost, GalleryEntry } from './extHost';
import { extFileDataUrl, extIconRelPath as iconRelPath, extTitle } from './extHost';
import { renderMarkdown } from './markdown';
import { t, tf } from './i18n';
import { actionButton, confirmDialog, el, icon, notify } from './ui';

/** One featured id's marketplace half: in flight, its entry, or why there is none. */
type MarketState = { status: 'loading' } | { status: 'ok'; entry: GalleryEntry } | { status: 'error'; error: string };

export class ExtensionsPanel {
	private readonly body: HTMLElement;
	private readonly list: HTMLElement;
	private extensions: ExtInfo[] = [];
	private processes = new Map<string, ExtProcessInfo>();
	private readonly host: ExtensionHost;
	/** The featured ids in display order, or null until the backend has named them. */
	private featured: string[] | null = null;
	/** Each featured id's marketplace state, keyed by the lower-cased id. */
	private readonly market = new Map<string, MarketState>();
	/** Gallery entry ids with an install in flight (their rows show the busy state). */
	private readonly installing = new Set<string>();
	/** The in-flight marketplace pass, so overlapping refreshes share one. */
	private marketPass: Promise<void> | null = null;

	/** Signals the workbench so it can refresh what the activation state changed. */
	onChanged: (() => void) | null = null;
	/** A row was clicked: the workbench opens the extension's detail page (an editor tab). */
	onOpenDetail: ((ext: ExtInfo) => void) | null = null;

	constructor(container: HTMLElement, host: ExtensionHost) {
		this.host = host;
		container.appendChild(el('div', 'sidebar-title', [el('span', 'label', [t('extensions.title')])]));
		const pane = el('div', 'view-pane');
		const header = el('div', 'pane-header');
		header.appendChild(el('span', 'label', [t('extensions.featured')]));
		header.appendChild(actionButton('refresh', t('extensions.checkForUpdates'), () => void this.checkForUpdates()));
		header.appendChild(actionButton('package', t('extensions.installFromVsix'), () => void this.pickVsix()));
		this.body = el('div', 'pane-body list');
		this.body.tabIndex = 0;
		this.list = el('div', 'ext-list');
		this.body.appendChild(this.list);
		pane.append(header, this.body);
		container.appendChild(pane);
		this.render();
	}

	/** Re-list the installed packages and the backends' state; the first refresh also asks
	 *  the marketplace (later ones reuse its answer — `checkForUpdates` asks again). */
	async refresh(): Promise<void> {
		try {
			this.extensions = await this.host.list();
		} catch (error) {
			this.extensions = [];
			notify('error', tf('extensions.listFailed', String(error)));
		}
		// The backends' state rides the same refresh, so a restart's effect shows at once.
		try {
			this.processes = new Map((await this.host.processStatus()).map((info) => [info.extensionId, info]));
		} catch {
			this.processes = new Map();
		}
		if (this.featured === null) {
			try {
				this.featured = await this.host.featuredGallery();
			} catch {
				this.featured = [];
			}
		}
		this.render();
		// The marketplace answers asynchronously: the rows are already up (installed state,
		// the bundled offer), each fills in as its lookup lands.
		if (this.market.size === 0) void this.loadMarket();
	}

	/** Ask the marketplace for every featured id again (the header's refresh action and the
	 *  palette's Check for Extension Updates), then re-render with the answers. */
	async checkForUpdates(): Promise<void> {
		this.market.clear();
		await this.refresh();
		await this.marketPass;
	}

	/** Look every featured id up, in parallel; each answer re-renders on its own. */
	private loadMarket(): Promise<void> {
		if (this.marketPass) return this.marketPass;
		const ids = this.featured ?? [];
		for (const id of ids) this.market.set(id.toLowerCase(), { status: 'loading' });
		this.render();
		this.marketPass = Promise.all(ids.map(async (id) => {
			let state: MarketState;
			try {
				state = { status: 'ok', entry: await this.host.lookupGallery(id) };
			} catch (error) {
				state = { status: 'error', error: String(error) };
			}
			this.market.set(id.toLowerCase(), state);
			this.render();
		})).then(() => undefined).finally(() => { this.marketPass = null; });
		return this.marketPass;
	}

	/** The installed (or bundled-offer) listing of an id, matched as VS Code does: ignoring case. */
	private installedOf(id: string): ExtInfo | undefined {
		const key = id.toLowerCase();
		return this.extensions.find((ext) => ext.id.toLowerCase() === key);
	}

	private render(): void {
		this.list.replaceChildren();
		const featured = this.featured ?? [];
		const featuredKeys = new Set(featured.map((id) => id.toLowerCase()));
		for (const id of featured) this.list.appendChild(this.featuredRow(id));
		// Whatever else is installed (a picked VSIX, an install from before the featured
		// list): listed so it stays visible and removable. Bundled offers outside the
		// featured list are not offered.
		const others = this.extensions.filter((ext) => !featuredKeys.has(ext.id.toLowerCase()) && ext.format !== 'bundled');
		if (others.length > 0) {
			this.list.appendChild(el('div', 'ext-section-label', [t('extensions.otherInstalled')]));
			for (const ext of others) this.list.appendChild(this.installedRow(ext, null));
		}
		if (featured.length === 0 && others.length === 0) {
			this.list.appendChild(el('p', 'empty', [t('extensions.empty')]));
		}
	}

	/** One featured id's row. Installed: the installed row, with an Update offer when the
	 *  marketplace is ahead. Not installed: the marketplace entry with Install — or, when
	 *  the marketplace cannot answer, the installer's bundled offer, or the lookup's state
	 *  (checking… / the error with a retry). */
	private featuredRow(id: string): HTMLElement {
		const ext = this.installedOf(id);
		const state = this.market.get(id.toLowerCase()) ?? { status: 'loading' };
		const entry = state.status === 'ok' ? state.entry : null;
		if (ext && ext.format !== 'bundled') return this.installedRow(ext, entry);
		if (entry) return this.galleryRow(entry);
		if (ext) return this.installedRow(ext, null);
		const row = el('div', 'ext-row gallery-row', [
			el('div', 'ext-icon-box', [icon('extensions', 'ext-icon')]),
			el('div', 'ext-main', [
				el('div', 'ext-name', [id]),
				state.status === 'error'
					? el('div', 'ext-process', [tf('extensions.marketplaceUnavailable', state.error)])
					: el('div', 'ext-gallery-stats', [t('extensions.checkingMarketplace')])
			]),
			state.status === 'error' ? actionButton('refresh', t('extensions.retry'), () => void this.checkForUpdates()) : null
		]);
		row.title = id;
		return row;
	}

	/** An installed package's row (or a bundled offer's): identity, backend status, and its
	 *  actions — plus Update when `entry` (its marketplace listing) is a newer version. */
	private installedRow(ext: ExtInfo, entry: GalleryEntry | null): HTMLElement {
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
			// The marketplace is ahead of the install: the Update offer (or its busy state).
			entry && compareVersions(ext.version, entry.version) < 0 ? this.galleryAction(entry, true) : null,
			// A bundled entry that is not yet installed (an embedded-manifest offer): the
			// bundled package is one click away. Installed entries: uninstall (a process
			// package's backend dies with it — the Rust side stops it before removing the
			// directory).
			ext.format === 'bundled'
				? actionButton('package', t(ext.builtin ? 'extensions.installBundled' : 'extensions.installSample'), () => void this.installBundled(ext))
				: ext.builtin ? null : actionButton('trash', tf('extensions.uninstall', ext.id), () => void this.uninstall(ext)),
			isProcessPackage ? actionButton('refresh', this.restartLabel(ext), () => void this.restart(ext)) : null
		]);
		row.title = ext.builtin
			? tf('extensions.builtInTooltip', ext.id, ext.version)
			: `${ext.id} v${ext.version}`;
		// actionButton()'s own click handler stops propagation, so this never fires for the
		// row's buttons (install/uninstall/restart): the row itself opens the detail page.
		row.addEventListener('click', () => this.onOpenDetail?.(ext));
		return row;
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

	/* ---------- The marketplace half (Open VSX, over the backend gallery commands) ---------- */

	/** A featured package that is not installed: its marketplace identity and Install. */
	private galleryRow(entry: GalleryEntry): HTMLElement {
		const row = el('div', 'ext-row gallery-row', [
			this.galleryIconBox(entry),
			el('div', 'ext-main', [
				el('div', 'ext-name', [entry.displayName ?? entry.name, ' ', el('span', 'ext-version', [`v${entry.version}`])]),
				el('div', 'ext-publisher', [entry.namespace, entry.verified ? el('span', 'ext-verified', [t('extensions.verified')]) : null]),
				entry.description ? el('div', 'ext-description', [entry.description]) : null,
				el('div', 'ext-gallery-stats', [tf('extensions.downloads', entry.downloadCount.toLocaleString())])
			]),
			this.galleryAction(entry, false)
		]);
		row.title = `${entry.id} v${entry.version}`;
		return row;
	}

	/** A marketplace entry's icon box: the codicon placeholder until the gallery's icon
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

	/** Install (or, over an older install, Update to the marketplace's version) — a busy
	 *  line while that install is in flight. */
	private galleryAction(entry: GalleryEntry, update: boolean): HTMLElement {
		if (this.installing.has(entry.id.toLowerCase())) {
			const busy = el('span', 'ext-installed-tag', [t('extensions.marketplaceInstalling')]);
			busy.classList.add('busy');
			return busy;
		}
		return update
			? actionButton('cloud-download', tf('extensions.updateTo', entry.version), () => void this.installGallery(entry))
			: actionButton('cloud-download', t('extensions.installFromMarketplace'), () => void this.installGallery(entry));
	}

	/** Download and install one marketplace entry: the busy state on its row, the ordinary
	 *  install notification on success, and the list refreshed either way (a finished
	 *  install changes the row's action). A second click while one is in flight is a no-op. */
	private async installGallery(entry: GalleryEntry): Promise<void> {
		if (this.installing.has(entry.id.toLowerCase())) return;
		this.installing.add(entry.id.toLowerCase());
		this.render();
		try {
			const info = await this.host.installFromGallery(entry);
			notify('info', tf('extensions.installedOk', info.id, info.version));
			// What the package declares it needs arrives with it (VS Code installs a
			// package's dependencies and pack members at the same time).
			await this.host.installDependencies(info);
			this.onChanged?.();
		} catch (error) {
			notify('error', tf('extensions.marketplaceInstallFailed', String(error)));
		} finally {
			this.installing.delete(entry.id.toLowerCase());
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

	/** The restart affordance's label follows what the backend process is: a `node` kind
	 *  restarts the extension's own host process (VS Code's "Restart Extension Host"), a
	 *  `process` kind restarts the package's own binary. */
	private restartLabel(ext: ExtInfo): string {
		return ext.capabilities?.backend?.kind === 'node' ? t('extensions.restartHost') : t('extensions.restart');
	}

	/** The page's header: the icon, the identity lines, and the actions a row also carries. */
	private detailHeader(ext: ExtInfo, processInfo: ExtProcessInfo | null): HTMLElement {
		const backend = ext.capabilities?.backend ?? null;
		const uninstall = el('button', 'button secondary', [t('extensions.uninstallAction')]);
		uninstall.addEventListener('click', () => void this.uninstall(ext));
		const restart = el('button', 'button secondary', [this.restartLabel(ext)]);
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
	 *  license — the fields a row's summary line has no room for. */
	private detailFacts(ext: ExtInfo, processInfo: ExtProcessInfo | null): HTMLElement {
		const backend = ext.capabilities?.backend ?? null;
		const backendLine = backend
			? tf('extensions.backendSummary', backend.kind, backend.protocol ?? 'ggs-ext/1', backend.command)
			: t('extensions.backendNone');
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
		await this.pickPackage(t('extensions.installPickTitleVsix'), [{ name: 'VS Code extension', extensions: ['vsix'] }], async (path) => {
			const info = await this.host.installFromVsix(path);
			await this.host.installDependencies(info);
			return info;
		});
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
