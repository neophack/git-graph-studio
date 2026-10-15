// The Output view channels the extension host owns (append/reveal/clear) and the Extension Host log channel.

import type { ExtensionHost } from './extensionHost';

import { extLogPath } from '../../../platform/ipc/ext';
import { extLog, extLogLevel, flushExtLog } from '../extLog';
import { t, tf } from '../../../platform/i18n';
import { notify } from '../../../platform/ui/index';


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
