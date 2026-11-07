// The workbench's chrome: the activity bar, the sidebar and its sash, the panel and the extension views' placement — the DOM and sizing half of the shell.

import type { Workbench } from './workbench';

import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { mountProviderSwitcher } from '../features/providers';
import { mountProviderPaneGate } from '../features/providers';
import { commands } from '../platform/commands';
import { tf } from '../platform/i18n';
import * as state from '../platform/state';
import { el, icon, tooltip } from '../platform/ui/index';
import { ExtensionTreeView } from '../features/extensions';
import { evaluateWhen, extensionViewContributions } from '../features/extensions';
import { extFileDataUrl } from '../platform/extAssets';
import { ViewId } from './workbench';

/* ---------- Zen mode ---------- */

/** The pre-zen visibility the exit restores exactly; null while zen is off. Remembered from
 *  the DOM state the toggles maintain (the side bar's `hidden`, the panel's element): zen is
 *  a viewing state — the persisted layout is untouched, so the exit puts every piece of
 *  chrome back as it stood and a close while zen never loses the user's bars. */
let zenRestore: { sidebar: boolean; panel: boolean } | null = null;

/** The last unclaimed Escape's timestamp — two within ~600 ms exit zen. */
let zenEscapeAt = 0;

let zenEscapeListener: ((event: KeyboardEvent) => void) | null = null;

/** The zoom level the webview's setZoom drives (the real Tauri API; the browser shim and the
 *  tests' mock carry no setZoom and the commands answer nothing there). Not persisted: zoom
 *  is a viewing state like VS Code's window zoom, which also forgets on close. */
let zoomLevel = 1;

/** The layout concern of Workbench — assigned onto the prototype by the module facade (index.ts). */
export const layoutMethods: ThisType<Workbench> = {
	buildActivityBar(): void {
		const add = (id: string, content: HTMLElement, title: string, onClick: () => void) => {
			const item = el('div', 'activity-item', [content]);
			// The view id, for shells that mirror the bar (the remote phone's bottom tabs).
			item.dataset.view = id;
			item.title = title;
			item.setAttribute('role', 'button');
			// Focusable for F6's cycle, with the workbench's delayed tooltip (M7).
			item.tabIndex = 0;
			tooltip(item, () => title);
			item.addEventListener('click', onClick);
			this.activityItems[id] = item;
			this.activityBar.appendChild(item);
			return item;
		};
		add('explorer', icon('files'), 'Explorer (Ctrl+Shift+E)', () => this.toggleView('explorer'));
		add('search', icon('search'), 'Search (Ctrl+Shift+F)', () => this.toggleView('search'));
		add('scm', icon('source-control'), 'Source Control (Ctrl+Shift+G)', () => this.toggleView('scm'));
		add('analysis', icon('graph'), 'Analysis (Ctrl+Shift+A)', () => this.toggleView('analysis'));
		add('extensions', icon('extensions'), 'Extensions (Ctrl+Shift+X)', () => this.toggleView('extensions'));
		this.activitySpacer = el('div', 'activity-spacer');
		this.activityBar.appendChild(this.activitySpacer);
		add('terminal', icon('terminal'), 'Terminal (Ctrl+`)', () => this.panel.toggle('terminal'));
		// The remote shell has no machine-level opens (K4, docs/remote-client-plan.md §3.2):
		// the wire refuses `open_folder` anyway, so the bar's bottom button would only ever
		// answer with an error. The desktop app keeps it.
		if (commands.activeProfile() !== 'remote') {
			add('open', icon('folder-opened'), 'Open Folder... (Ctrl+K Ctrl+O)', () => void this.pickFolder());
		}
	},

	applyLayout(): void {
		this.sidebar.style.width = `${state.layout.sidebarWidth}px`;
		this.panelElement.style.height = `${state.layout.panelHeight}px`;
		// showView reveals the side bar - right for a user gesture, but the boot applies the
		// saved layout: a bar hidden with Ctrl+B stays hidden across the restart.
		const sidebarVisible = state.layout.sidebarVisible;
		this.showView(this.activeView, false);
		if (!sidebarVisible) {
			state.layout.sidebarVisible = false;
			this.sidebar.hidden = true;
			this.sidebarSash.hidden = true;
			state.saveLayout();
		}
		if (!state.layout.sidebarVisible) this.activityItems[this.activeView]?.classList.remove('active');
		for (const [id, item] of Object.entries(this.activityItems)) {
			if (id === 'explorer' || id === 'search' || id === 'scm' || id === 'analysis' || id === 'extensions' || this.isExtensionView(id)) item.classList.toggle('active', state.layout.sidebarVisible && id === this.activeView);
		}
		this.installSash(this.sidebarSash, 'horizontal', (delta, start) => {
			state.layout.sidebarWidth = Math.max(170, Math.min(window.innerWidth - 400, start + delta));
			this.sidebar.style.width = `${state.layout.sidebarWidth}px`;
		}, () => state.layout.sidebarWidth);
		this.installSash(this.panelSash, 'vertical', (delta, start) => {
			state.layout.panelHeight = Math.max(100, Math.min(window.innerHeight - 200, start - delta));
			this.panelElement.style.height = `${state.layout.panelHeight}px`;
		}, () => state.layout.panelHeight);
	},

	installSash(sash: HTMLElement, axis: 'horizontal' | 'vertical', onMove: (delta: number, start: number) => void, startValue: () => number): void {
		sash.addEventListener('mousedown', (event) => {
			event.preventDefault();
			const origin = axis === 'horizontal' ? event.clientX : event.clientY;
			const start = startValue();
			sash.classList.add('active');
			document.body.classList.add('resizing');
			document.body.style.cursor = axis === 'horizontal' ? 'ew-resize' : 'ns-resize';
			// Each applied delta forces a layout of the whole workbench (the graph iframe and
			// the editors re-measure), so the moves are coalesced to one per animation frame -
			// a high-resolution mouse otherwise fires far more `mousemove`s than frames.
			let latest = origin;
			let pending = 0;
			const raf = window.requestAnimationFrame?.bind(window) ?? ((callback: () => void) => window.setTimeout(callback, 16));
			const move = (e: MouseEvent) => {
				latest = axis === 'horizontal' ? e.clientX : e.clientY;
				if (pending) return;
				pending = raf(() => {
					pending = 0;
					onMove(latest - origin, start);
				});
			};
			const up = () => {
				if (pending) { window.cancelAnimationFrame?.(pending); pending = 0; }
				onMove(latest - origin, start);
				document.removeEventListener('mousemove', move);
				document.removeEventListener('mouseup', up);
				sash.classList.remove('active');
				document.body.classList.remove('resizing');
				document.body.style.cursor = '';
				state.saveLayout();
			};
			document.addEventListener('mousemove', move);
			document.addEventListener('mouseup', up);
		});
	},

	isExtensionView(view: string): boolean {
		return view.startsWith('ext-container:');
	},

	showView(view: ViewId | string, focus = true): void {
		// An extension container that no longer exists (uninstalled) falls back to Explorer.
		if (this.isExtensionView(view) && !this.extContainers.has(view)) view = 'explorer';
		this.activeView = view;
		state.layout.activeView = view;
		state.layout.sidebarVisible = true;
		this.sidebar.hidden = false;
		this.sidebarSash.hidden = false;
		for (const [id, element] of Object.entries(this.views)) element.style.display = id === view ? 'flex' : 'none';
		let visibleExtViews: string[] = [];
		for (const [id, container] of this.extContainers) {
			container.element.style.display = id === view ? 'flex' : 'none';
			if (id === view) visibleExtViews = container.viewIds;
		}
		for (const [id, item] of Object.entries(this.activityItems)) if (id === 'explorer' || id === 'search' || id === 'scm' || id === 'analysis' || id === 'extensions' || this.isExtensionView(id)) item.classList.toggle('active', id === view);
		// The views of the container just left stop being visible; the selected one's start.
		for (const viewId of this.lastVisibleExtViews) this.extensionHost.noteViewVisible(viewId, false);
		for (const viewId of visibleExtViews) this.extensionHost.noteViewVisible(viewId, true);
		this.lastVisibleExtViews = visibleExtViews;
		state.saveLayout();
		if (view === 'scm') void this.scm.refresh();
		if (view === 'extensions') void this.extensions.refresh();
		if (view === 'analysis') void this.analysis.refresh();
		// explorer.autoReveal: a file that became the active editor while the Explorer was
		// elsewhere (boot.ts parked it) reveals the moment the view returns.
		if (view === 'explorer' && this.pendingReveal) {
			const path = this.pendingReveal;
			this.pendingReveal = null;
			void this.explorer.reveal(path);
		}
		if (focus) {
			const element = this.isExtensionView(view) ? this.extContainers.get(view)?.element : this.views[view as ViewId];
			element?.querySelector<HTMLElement>('[tabindex]')?.focus();
		}
	},

	toggleView(view: ViewId | string): void {
		if (this.activeView === view && state.layout.sidebarVisible) this.toggleSidebar();
		else this.showView(view);
	},

	toggleSidebar(): void {
		state.layout.sidebarVisible = !state.layout.sidebarVisible;
		this.sidebar.hidden = !state.layout.sidebarVisible;
		this.sidebarSash.hidden = !state.layout.sidebarVisible;
		for (const [id, item] of Object.entries(this.activityItems)) {
			if (id === 'explorer' || id === 'search' || id === 'scm' || id === 'analysis' || id === 'extensions' || this.isExtensionView(id)) item.classList.toggle('active', state.layout.sidebarVisible && id === this.activeView);
		}
		state.saveLayout();
		// The bar's return shows the Explorer again: the reveal a file opened elsewhere was
		// owed (explorer.autoReveal) runs now, the same moment showView's branch would.
		if (state.layout.sidebarVisible && this.activeView === 'explorer' && this.pendingReveal) {
			const path = this.pendingReveal;
			this.pendingReveal = null;
			void this.explorer.reveal(path);
		}
	},

	/* ---------- The window/view modes (the Appearance menu) ---------- */

	toggleFullScreen(): void {
		const win = getCurrentWindow();
		// The browser workbench's window shim (and the tests' mock) carries no setFullscreen:
		// a browser tab keeps its own F11, so the command answers nothing there.
		if (typeof win.setFullscreen !== 'function' || typeof win.isFullscreen !== 'function') return;
		void win.isFullscreen()
			.then((full) => win.setFullscreen(!full))
			.catch(() => undefined);
	},

	zoomWorkbench(direction: 'in' | 'out' | 'reset'): void {
		const webview = getCurrentWebview();
		// Same absence guard as the fullscreen path — the browser shim has no setZoom.
		if (typeof webview.setZoom !== 'function') return;
		zoomLevel = direction === 'reset' ? 1 : Math.min(3, Math.max(0.5, zoomLevel + (direction === 'in' ? 0.1 : -0.1)));
		void webview.setZoom(zoomLevel).catch(() => undefined);
	},

	toggleZenMode(): void {
		if (document.body.classList.contains('zen')) this.exitZenMode();
		else this.enterZenMode();
	},

	enterZenMode(): void {
		if (document.body.classList.contains('zen')) return;
		// The DOM visibility is the thing remembered — it is exactly what the exit restores.
		zenRestore = { sidebar: !this.sidebar.hidden, panel: this.panel.isVisible() };
		// The chrome folds through the DOM (`hidden`, the way applyLayout hides the bar at
		// boot) and the body class styles the rest away — the persisted layout stays as it
		// was, and exitZenMode restores the two remembered visibilities exactly.
		document.body.classList.add('zen');
		this.sidebar.hidden = true;
		this.sidebarSash.hidden = true;
		this.panel.hide();
		// Escape-Escape is the keyboard's way out, beside the command. The listener rides the
		// bubble phase, so an Escape a surface already claimed (the quick input closing
		// itself) arrives defaultPrevented and never counts toward the double.
		zenEscapeListener = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') {
				zenEscapeAt = 0;
				return;
			}
			if (event.defaultPrevented) return;
			const now = Date.now();
			if (zenEscapeAt > 0 && now - zenEscapeAt <= 600) this.exitZenMode();
			else zenEscapeAt = now;
		};
		document.addEventListener('keydown', zenEscapeListener);
	},

	exitZenMode(): void {
		if (!document.body.classList.contains('zen')) return;
		document.body.classList.remove('zen');
		const restore = zenRestore;
		zenRestore = null;
		if (zenEscapeListener) {
			document.removeEventListener('keydown', zenEscapeListener);
			zenEscapeListener = null;
		}
		zenEscapeAt = 0;
		if (restore?.sidebar) {
			this.sidebar.hidden = false;
			this.sidebarSash.hidden = false;
		}
		if (restore?.panel) this.panel.show();
	},

	/** The dispose-time zen teardown: an Escape listener an active zen mode armed on
	 *  document must not survive its workbench (the chrome it left hidden comes back with
	 *  the next boot's applyLayout, which re-applies the persisted layout). */
	disposeZenMode(): void {
		if (zenEscapeListener) {
			document.removeEventListener('keydown', zenEscapeListener);
			zenEscapeListener = null;
		}
		zenEscapeAt = 0;
		zenRestore = null;
		document.body.classList.remove('zen');
	},



	visibleExtensionViews(): string {
		return extensionViewContributions()
			.flatMap((contribution) => contribution.views.filter((view) => evaluateWhen(contribution.extId, view.when)).map((view) => `${contribution.extId}/${view.viewId}`))
			.join('\n');
	},

	applyExtensionViews(): void {
		this.extViewsShown = this.visibleExtensionViews();
		for (const id of Object.keys(this.activityItems)) {
			if (!this.isExtensionView(id) && !id.startsWith('ext-launcher:')) continue;
			this.activityItems[id]!.remove();
			delete this.activityItems[id];
		}
		for (const container of this.extContainers.values()) container.element.remove();
		for (const section of this.extBuiltinSections) section.remove();
		for (const dispose of this.extWebviewViewDisposers) dispose();
		this.extContainers.clear();
		this.extTreeViews.clear();
		this.extBuiltinSections.length = 0;
		this.extWebviewViewDisposers.length = 0;
		// The stale-active-view guard runs AFTER the rebuild, and only when the key is
		// really gone: resetting first — then rebuilding the same container key — left
		// every sidebar section hidden with nothing re-shown (any install/uninstall/
		// activation while the user was viewing an extension's sidebar blanked the bar).
		if (this.isExtensionView(this.activeView) && !this.extContainers.has(this.activeView)) {
			this.activeView = 'explorer';
			this.showView('explorer');
		} else if (this.isExtensionView(this.activeView)) {
			// The container survived the rebuild: its section element is brand new, so
			// re-apply the visibility the old one had.
			this.showView(this.activeView);
		}

		// One sidebar section per declared view: a tree view renders through the generic
		// tree host (its provider feeds it); a `type: "webview"` view mounts the extension
		// host's iframe (its provider's resolveWebviewView fills it at first visibility).
		const makeSection = (viewId: string, name: string, extId: string, type: 'tree' | 'webview', into: HTMLElement): void => {
			const section = el('div', type === 'webview' ? 'ext-view-section ext-webview-view-section' : 'ext-view-section');
			if (type === 'webview') {
				// The AI provider switcher rides a bridged extension's section header
				// (`cmd_providers` says whose — `bridgedExtIds` — so the app names no
				// extension id here); every other extension's slot stays empty.
				const chipSlot = el('span', 'provider-chip-slot');
				section.appendChild(el('div', 'sidebar-title', [el('span', 'label', [name]), chipSlot]));
				const pane = el('div', 'view-pane ext-webview-view-pane');
				section.appendChild(pane);
				this.extWebviewViewDisposers.push(this.extensionHost.mountWebviewView(viewId, extId, pane));
				this.extWebviewViewDisposers.push(mountProviderSwitcher(extId, chipSlot));
				// The AI provider bridge's pane gate: the set-key page over a keyless
				// third-party provider's chat, the usage strip above a keyed one —
				// mounted for every webview section, rendered only for the bridged
				// extension's (the backend's `bridgedExtIds` decides).
				this.extWebviewViewDisposers.push(mountProviderPaneGate(extId, pane));
			} else {
				const tree = new ExtensionTreeView(section, name, {
					viewId,
					fetchChildren: (handle) => this.extensionHost.treeChildren(viewId, handle),
					onCommand: (command, args) => void this.extensionHost.executeCommand(command, args),
					onSelect: (handles) => this.extensionHost.treeInteraction(viewId, 'treeView.select', [handles]),
					onExpand: (handle, expanded) => this.extensionHost.treeInteraction(viewId, 'treeView.expand', [handle, expanded]),
					onCheckbox: (handle, state) => this.extensionHost.treeInteraction(viewId, 'treeView.checkbox', [handle, state])
				});
				this.extTreeViews.set(viewId, tree);
			}
			into.appendChild(section);
			if (into !== this.sidebar) this.extBuiltinSections.push(section);
		};

		for (const contribution of extensionViewContributions()) {
			// A view's `when` hides it exactly as a menu entry's hides the item (VS Code's own
			// rule — Code Spell Checker's "Regular Expressions" view is off unless its
			// experimental setting is), and a container left with no visible view goes away
			// entirely. Evaluated here, at build time: a clause keyed to settings or context
			// keys re-evaluates on the next install/uninstall pass, not on every keystroke.
			const visibleViews = contribution.views.filter((view) => evaluateWhen(contribution.extId, view.when));
			for (const container of contribution.containers) {
				const key = `ext-container:${contribution.extId}.${container.id}`;
				const element = el('div', 'view ext-container-view');
				element.style.display = 'none';
				const viewIds: string[] = [];
				const viewNames = new Map<string, string>();
				for (const declared of visibleViews.filter((view) => view.container === container.id)) {
					makeSection(declared.viewId, declared.name, contribution.extId, declared.type ?? 'tree', element);
					viewIds.push(declared.viewId);
					viewNames.set(declared.viewId, declared.name);
				}
				if (viewIds.length === 0) continue;
				this.sidebar.appendChild(element);
				this.extContainers.set(key, { element, viewIds });
				// VS Code generates a focus command per views container (`<container-id>.focus`)
				// — claude-code's chat calls its own to reveal its sidebar container from inside
				// a panel. Re-registering on every rebuild keeps it pointing at the live one.
				commands.register({ id: `${container.id}.focus`, title: tf('workbench.focusViewContainer', container.title), category: 'View', enabled: () => this.extContainers.has(key), run: () => this.showView(key) });
				// VS Code also generates one per view (`<view-id>.focus`) — kimi-code's own
				// menu commands call `kimi.webview.focus`, the view's, not the container's.
				// Each is titled by its own view — one palette row per view, not N copies of the
				// container's name; a view sharing the container's id keeps the container's.
				for (const viewId of viewIds) {
					if (viewId === container.id) continue;
					commands.register({ id: `${viewId}.focus`, title: tf('workbench.focusViewContainer', viewNames.get(viewId) || container.title), category: 'View', enabled: () => this.extContainers.has(key), run: () => this.showView(key) });
				}
				const item = el('div', 'activity-item', [icon('list-tree')]);
				// The view key, for shells that mirror the bar (the remote phone's bottom tabs).
				item.dataset.view = key;
				item.title = container.title;
				item.setAttribute('role', 'button');
				item.tabIndex = 0;
				tooltip(item, () => container.title);
				item.addEventListener('click', () => this.toggleView(key));
				this.activityItems[key] = item;
				this.activityBar.insertBefore(item, this.activitySpacer);
				if (container.icon) {
					void extFileDataUrl(contribution.extId, container.icon).then((url) => {
						if (!url) return;
						const image = el('img');
						image.src = url;
						image.alt = '';
						item.replaceChildren(image);
					});
				}
			}
			// Views a manifest placed in a built-in container ride that sidebar view's tail —
			// the Explorer / Source Control trees manage their own DOM, never the tail.
			for (const declared of visibleViews) {
				const host = declared.container === 'scm' ? this.views.scm : declared.container === 'explorer' ? this.views.explorer : null;
				if (host) makeSection(declared.viewId, declared.name, contribution.extId, declared.type ?? 'tree', host);
			}
		}
	},
};
