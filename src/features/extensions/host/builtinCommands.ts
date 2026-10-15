// The built-in command surface the host itself serves: vscode.diff / vscode.open over provider schemes, VS Code's placement shapes.

import { ExtensionHost } from './extensionHost';

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




/** The builtinCommands concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const builtinCommandsMethods: ThisType<ExtensionHost> = {
	async resolveVscodeUri(uri: unknown): Promise<{ scheme: string; name: string; fsPath: string; label: string; content?: string; local?: boolean }> {
		const value = (uri ?? {}) as { scheme?: unknown; path?: unknown; fsPath?: unknown; query?: unknown };
		const scheme = typeof value.scheme === 'string' && value.scheme !== '' ? value.scheme : 'file';
		const path = typeof value.path === 'string' ? value.path : '';
		if (scheme === 'file') {
			const fsPath = typeof value.fsPath === 'string' && value.fsPath !== '' ? value.fsPath : path;
			return { scheme, name: fsPath.split(/[\\/]/).pop() || fsPath, fsPath, label: fsPath, local: true };
		}
		const handle = this.docProviders.get(scheme);
		if (handle) {
			const text = await this.callFrame(handle, 'docProvider.provide', [value]) as string | null | undefined;
			return { scheme, name: path.split('/').pop() || scheme, fsPath: path, label: path, content: text ?? '' };
		}
		// A file-system provider's scheme (claude-code's diff sides): the same ask-back,
		// the frame's provider answering `readFile` and the frame decoding to text.
		const fsHandle = this.fsProviders.get(scheme);
		if (!fsHandle) throw new Error(`no text-document content provider is registered for the ${scheme} scheme`);
		const fsText = await this.callFrame(fsHandle, 'fsProvider.read', [value]) as string | null | undefined;
		return { scheme, name: path.split('/').pop() || scheme, fsPath: path, label: path, content: fsText ?? '' };
	},

	async openVscodeDiff(left: unknown, right: unknown, title: unknown, column: unknown): Promise<void> {
		if (!left || !right) return;
		const [l, r] = await Promise.all([this.resolveVscodeUri(left), this.resolveVscodeUri(right)]);
		const serial = this.nextExtDocSerial++;
		this.onOpenDiff?.({
			id: `ext-diff-${serial}`,
			title: typeof title === 'string' && title !== '' ? title : `${r.name} (${l.scheme === 'file' ? l.name : l.label} → ${r.scheme === 'file' ? r.name : r.label})`,
			left: l.local === true
				? { revision: '', path: l.fsPath, label: l.name, exists: true, local: true }
				: { revision: '', path: l.label, label: l.name, exists: true, content: l.content ?? '' },
			right: r.local === true
				? { revision: '', path: r.fsPath, label: r.name, exists: true, local: true }
				: { revision: '', path: r.label, label: r.name, exists: true, content: r.content ?? '' }
		}, ExtensionHost.placementOf(column));
	},

	async openVscodeDocument(uri: unknown, column: unknown): Promise<void> {
		if (!uri) return;
		const placement = ExtensionHost.placementOf(column);
		const resolved = await this.resolveVscodeUri(uri);
		if (resolved.local === true) {
			this.onOpenFile?.(resolved.fsPath, undefined, undefined, placement);
			return;
		}
		const serial = this.nextExtDocSerial++;
		this.onOpenContent?.(resolved.name || `document-${serial}`, resolved.label, resolved.content ?? '', placement);
	},
};
