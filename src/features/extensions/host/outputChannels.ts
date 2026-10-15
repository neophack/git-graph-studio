// The Output view channels the extension host owns (append/reveal/clear) and the Extension Host log channel.

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


export const EXT_HOST_LOG_OWNER = 'ggs.extension-host';

/** The core configuration sections VS Code defines and extensions read through
 *  `getConfiguration` (`editor.tabSize`, `files.exclude`, `http.proxy`, …) — mirrored
 *  from the workbench's own settings where one exists. */

/** The outputChannels concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const outputChannelsMethods: ThisType<ExtensionHost> = {
	appendOutput(extId: string, name: string, line: string): void {
		const channels = this.outputChannels.get(extId) ?? [];
		if (!channels.includes(name)) {
			channels.push(name);
			this.outputChannels.set(extId, channels);
			this.emitOutputChannels();
		}
		this.onOutputAppend?.(extId, name, line);
	},

	emitOutputChannels(): void {
		const channels: { extId: string; name: string }[] = [];
		for (const [extId, names] of this.outputChannels) for (const name of names) channels.push({ extId, name });
		this.onOutputChannels?.(channels);
	},

	showLog(): void {
		extLog('info', 'host', `extension host log level: ${extLogLevel()}`);
		this.onOutputReveal?.(EXT_HOST_LOG_OWNER, t('extensions.logChannel'));
	},

	async openLogFile(): Promise<void> {
		await flushExtLog();
		try {
			const path = await extLogPath();
			if (typeof path !== 'string' || path === '') throw new Error('no log path');
			this.onOpenFile?.(path);
		} catch (error) {
			notify('warning', tf('extensions.logFileMissing', String(error)));
		}
	},
};
