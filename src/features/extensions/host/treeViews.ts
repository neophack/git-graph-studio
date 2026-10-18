// The tree view surface: children walks, interaction pushes, visibility notes.

import type { ExtensionHost } from './extensionHost';

import { extensionViewContributions } from '../contributions';
import { extLog } from '../extLog';
import { extFileDataUrl } from '../../../platform/extAssets';
import { hook } from '../../../platform/hooks';
import type { SerializedTreeItem } from '../treeView';




/** The treeViews concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const treeViewsMethods: ThisType<ExtensionHost> = {
	async treeChildren(viewId: string, handle: string | null): Promise<SerializedTreeItem[]> {
		const extId = this.treeProviders.get(viewId);
		const frame = extId ? this.frames.get(extId) : undefined;
		if (!frame) return [];
		const items = (await this.callFrame(frame, 'tree.getChildren', [viewId, handle]).catch((error) => {
			extLog('error', extId ?? 'host', `tree view ${viewId}: children could not be read: ${String(error)}`);
			return [];
		})) as SerializedTreeItem[];
		if (extId) {
			await Promise.all((items ?? []).map(async (item) => {
				if (item.iconUrl) item.iconUrl = (await extFileDataUrl(extId, item.iconUrl!)) ?? '';
			}));
		}
		return items ?? [];
	},

	treeInteraction(viewId: string, method: 'treeView.select' | 'treeView.expand' | 'treeView.checkbox', args: unknown[]): void {
		const extId = this.treeProviders.get(viewId);
		const frame = extId ? this.frames.get(extId) : undefined;
		if (frame) void this.callFrame(frame, method, [viewId, ...args]).catch((error) => extLog('warn', extId ?? 'host', `tree view ${viewId}: ${method} failed: ${String(error)}`));
	},

	noteViewVisible(viewId: string, visible: boolean): void {
		const contribution = extensionViewContributions().find((entry) => entry.views.some((view) => view.viewId === viewId));
		const declaredBy = contribution?.extId;
		const owner = this.treeProviders.get(viewId) ?? this.webviewViews.get(viewId)?.extId ?? declaredBy;
		// A webview view this page shows as a copy: the desktop window's page is the one the
		// provider resolved and the one whose visibility the extension tracks (§22.6) — a
		// resolve from here would reload the desktop's chat under its user.
		if (owner && this.sharesWebviews(owner) && contribution?.views.some((view) => view.viewId === viewId && view.type === 'webview')) {
			if (visible) void this.ensureActive(owner);
			return;
		}
		if (visible && owner) void this.ensureActive(owner).then(() => {
			if (owner === undefined) return;
			// A webview view resolves its provider once, at the first visibility after its
			// extension is active — the frame parks the provider until then.
			if (contribution?.views.some((view) => view.viewId === viewId && view.type === 'webview') && visible && !this.resolvedWebviewViews.has(viewId)) {
				const frame = this.frames.get(owner);
				// A remote own-instance page (a per-frontend webview — the phone's Git Graph,
				// 2026-10-18) with the mirrored html already in hand does not resolve again:
				// the html IS the page (the journal or a live mirror carried it), and a second
				// resolve would setHtml once more — reloading every frontend's live page of
				// the view, the desktop's own included. The page asks its state over messages
				// once it boots, and a later setHtml still reaches it like any other.
				if (frame && hook('session').frontendClass() === 'remote' && (this.webviewViews.get(viewId)?.html ?? '') !== '') {
					this.resolvedWebviewViews.add(viewId);
				} else {
					extLog('info', owner, `webview view ${viewId}: resolve via ${frame ? (frame.remote ? 'process backend' : 'frame') : 'NO HANDLE'}`);
					if (frame) {
						this.resolvedWebviewViews.add(viewId);
						void this.callFrame(frame, 'webviewView.resolve', [viewId]).catch((error) => {
							this.resolvedWebviewViews.delete(viewId);
							extLog('warn', owner, `webview view ${viewId}: resolve failed: ${String(error)}`);
						});
					}
				}
			}
		});
		const frame = owner ? this.frames.get(owner) : undefined;
		if (frame && this.treeProviders.has(viewId)) void this.callFrame(frame, 'treeView.setVisible', [viewId, visible]).catch(() => undefined);
		if (frame && this.webviewViews.has(viewId)) {
			// One webviewView object, several own pages (a per-frontend webview): a remote
			// page never reports visibility — the backend's one visible flag stays the
			// desktop's own truth, and a phone leaving its page must not stop the desktop
			// page's pushes. The phone's page asks its state when it boots; a hidden section
			// drops the mirrored pushes at no cost.
			if (hook('session').frontendClass() !== 'remote') {
				void this.callFrame(frame, 'webviewView.setVisible', [viewId, visible]).catch(() => undefined);
				frame.send?.({ type: '__studioExtEvent', event: 'webviewViewVisible', viewId, visible });
			}
		}
	},
};
