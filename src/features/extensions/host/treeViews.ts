// The tree view surface: children walks, interaction pushes, visibility notes.

import type { ExtensionHost } from './extensionHost';

import { Channel } from '../../../platform/ipc/core';
import { writeFile } from '../../../platform/ipc/fs';
import { extChildEndStdin, extChildKill, type ExtChildEvent, extChildSpawn, extChildStopFor, extChildWrite, extNodeRuntimePath } from '../../../platform/ipc/extChild';
import { type ExtInfo, extInstallBundled, extInstallFromVsix, extList, extLoadCode, extLogPath, type NodeEnv, extNodeEnv, extPageFileChunk, extPageRevisionBytes, extReadFile, extStoragePaths, extUninstall, type StudioManifest } from '../../../platform/ipc/ext';
import { type ExtProcessInfo, extNodeRuntime, extProcessHostRespond, extProcessInvoke, extProcessPushEvent, extProcessRegistrations, extProcessRun, extProcessStart, extProcessStatus, extProcessStop } from '../../../platform/ipc/extProcess';
import { type GalleryEntry, extGalleryAsset, extGalleryFeatured, extGalleryInstall, extGalleryLookup } from '../../../platform/ipc/gallery';
import { extFs } from '../../../platform/ipc/ext';
import { listen } from '../../../platform/ipc/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { commands } from '../../../platform/commands';
import { applyContributions, applyExtensionSettings, declaredCommand, extensionSettingDefs, extensionThemeList, extensionViewContributions, languageIdFor, localize, registerContextProvider, registerExtensionSnippets, registerExtensionThemes, removeContributions, type ExtensionThemeDef, type ManifestContributes } from '../contributions';
import { describeDetail, extLog, extLogEnabled, extLogLevel, extLogOnce, flushExtLog, levelForConsole, setExtLogOutput, type ExtLogLevel } from '../extLog';
import { defaultNodeEnv } from '../../../hosts/extModuleLoader';
import type { EditorPlacement } from '../../editor/types';
import { setFileDiagnostics, type SerializableDiagnostic } from '../editorDiagnostics';
import { settings as appSettings, syncExtensionThemes, themeById } from '../../../platform/settings';
import { locale, registerZhCnText, t, tf } from '../../../platform/i18n';
import * as state from '../../../platform/state';
import { notify, progressToast, quickInput, type ProgressToast } from '../../../platform/ui/index';
import { extFileDataUrl, forgetExtDataUrls, imageMime } from '../../../platform/extAssets';
import { hook } from '../../../platform/hooks';
import type { SerializedTreeItem } from '../treeView';
import { answerChatPermission, answerChatQuestion, chatBusy, chatControls, interruptChat, pickChatModel, pressSend, setChatInput, setChatPermissionMode, type ChatAnswer } from '../claudeChatInject';




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
				extLog('info', owner, `webview view ${viewId}: resolve via ${frame ? (frame.remote ? 'process backend' : 'frame') : 'NO HANDLE'}`);
				if (frame) {
					this.resolvedWebviewViews.add(viewId);
					void this.callFrame(frame, 'webviewView.resolve', [viewId]).catch((error) => {
						this.resolvedWebviewViews.delete(viewId);
						extLog('warn', owner, `webview view ${viewId}: resolve failed: ${String(error)}`);
					});
				}
			}
		});
		const frame = owner ? this.frames.get(owner) : undefined;
		if (frame && this.treeProviders.has(viewId)) void this.callFrame(frame, 'treeView.setVisible', [viewId, visible]).catch(() => undefined);
		if (frame && this.webviewViews.has(viewId)) {
			void this.callFrame(frame, 'webviewView.setVisible', [viewId, visible]).catch(() => undefined);
			frame.send?.({ type: '__studioExtEvent', event: 'webviewViewVisible', viewId, visible });
		}
	},
};
