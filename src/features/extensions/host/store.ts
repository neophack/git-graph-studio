// The install surface: list, VSIX/gallery/bundled installs, dependency walks, uninstall, process status and restart.

import { unregisterCommand } from './dispatch';
/** The marketplace the Extensions view installs its featured packages from. */
export const MARKETPLACE_URL = 'https://open-vsx.org';

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


export function extIconRelPath(ext: ExtInfo): string {
	const iconPath = ext.icon!;
	const root = ext.path.replace(/[\\/]+$/, '');
	if (root !== '' && (iconPath.startsWith(root + '/') || iconPath.startsWith(root + '\\'))) return iconPath.slice(root.length + 1);
	return iconPath.split(/[\\/]/).pop()!; // unexpected shape: at least the file name is right
}

/** The extension's display title, like VS Code's extension list (displayName falls back to name). */

export function extTitle(ext: ExtInfo): string {
	return ext.displayName ?? ext.name;
}


/** Cached marketplace icon reads, as data URLs (the same bridge `dataUrlCache` uses). */

const galleryIconCache = new Map<string, Promise<string | null>>();

/** How long a relayed `open_in_editor`'s session stays the pending signal a following
 *  `webview.create` matches against — the create normally follows within the round trip
 *  to the extension; the TTL only bounds a signal left unused (the extension's map was

/** The store concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const storeMethods: ThisType<ExtensionHost> = {
	async list(): Promise<ExtInfo[]> {
		const installed = await extList();
		this.installedExts = installed;
		return installed;
	},

	async installFromVsix(path: string): Promise<ExtInfo> {
		const info = await extInstallFromVsix(path);
		await this.reload(info.id);
		return info;
	},

	async featuredGallery(): Promise<string[]> {
		return await extGalleryFeatured();
	},

	async lookupGallery(id: string): Promise<GalleryEntry> {
		return await extGalleryLookup(MARKETPLACE_URL, id);
	},

	async galleryIcon(url: string): Promise<string | null> {
		let pending = galleryIconCache.get(url);
		if (!pending) {
			pending = extGalleryAsset(MARKETPLACE_URL, url)
				.then((base64) => `data:${imageMime(url)};base64,${base64}`)
				.catch(() => null);
			galleryIconCache.set(url, pending);
		}
		return pending;
	},

	async installFromGallery(entry: GalleryEntry): Promise<ExtInfo> {
		const info = await extGalleryInstall(MARKETPLACE_URL, entry.downloadUrl);
		await this.reload(info.id);
		return info;
	},

	async installDependencies(info: ExtInfo, seen = new Set<string>()): Promise<ExtInfo[]> {
		seen.add(info.id.toLowerCase());
		const installed: ExtInfo[] = [];
		const wanted = [...(info.extensionDependencies ?? []), ...(info.extensionPack ?? [])];
		for (const dependency of wanted) {
			const key = dependency.toLowerCase();
			if (seen.has(key) || key.startsWith('vscode.')) continue;
			seen.add(key);
			if (this.installedExts.some((ext) => ext.id.toLowerCase() === key && ext.format !== 'bundled')) continue;
			try {
				const added = await this.installFromGallery(await this.lookupGallery(dependency));
				extLog('info', info.id, `installed dependency ${added.id} ${added.version}`);
				notify('info', tf('extensions.dependencyInstalled', added.id, info.id));
				installed.push(added, ...(await this.installDependencies(added, seen)));
			} catch (error) {
				extLog('warn', info.id, `dependency ${dependency} could not be installed: ${String(error)}`);
				notify('warning', tf('extensions.dependencyInstallFailed', dependency, info.id, String(error)));
			}
		}
		return installed;
	},

	async installBundled(extId: string): Promise<ExtInfo> {
		const info = await extInstallBundled(extId);
		await this.reload(info.id);
		return info;
	},

	async processStatus(): Promise<ExtProcessInfo[]> {
		return (await extProcessStatus().catch(() => null)) ?? [];
	},

	async restartProcess(extId: string): Promise<void> {
		await extProcessStop(extId).catch(() => undefined);
		await extChildStopFor(extId).catch(() => undefined);
		// A backend-hosted package re-activates in the new process: its remote handle must be
		// registered first, or the activation's first `host.env` request finds no owner (a
		// restart after a failed start - whose handle was dropped - failed exactly that way).
		if (this.backendHosted(extId)) {
			await this.ensureNodeHost(extId);
		} else {
			await extProcessStart(extId);
		}
		// The fresh process re-activated, but this restart path emits no
		// BACKEND_RESTARTED_EVENT (that is the provider switch's, cmd_providers): reset the
		// settled webview views here, or the sidebar keeps the page the old process rendered.
		this.resetViewsAfterBackendRestart(extId);
	},

	async uninstall(extId: string): Promise<void> {
		await extUninstall(extId);
		// A ggs/2 process backend dies with its extension (nothing of it is running after).
		await extProcessStop(extId).catch(() => undefined);
		this.processBacked.delete(extId);
		for (const id of this.declaredCommandIds.get(extId) ?? []) this.processCommandIds.delete(id);
		this.installedExts = this.installedExts.filter((ext) => ext.id !== extId);
		this.deactivate(extId);
		// The manifest-declared commands live in the workbench registry too: removeContributions
		// only drops the declaration records, and a surviving (disabled) entry with a keybinding
		// would still swallow its keystroke (commandForBinding/forKeyEvent ignore enablement).
		for (const id of this.declaredCommandIds.get(extId) ?? []) unregisterCommand(id);
		this.declaredCommandIds.delete(extId);
		removeContributions(extId);
		this.activationPolicies.delete(extId);
		for (const [viewId, owner] of [...this.treeProviders]) {
			if (owner === extId) this.treeProviders.delete(viewId);
		}
		this.onViewsChanged?.();
	},
};
