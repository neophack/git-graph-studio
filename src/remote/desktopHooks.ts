// The remote behaviours' installers, plugged into platform/hooks (plan §5.5). Two entry
// points: the desktop's own remote-shaped halves (the mirror host, the asset protocol, the
// workbench sync — installed from main.ts, the composition root outside remote/ allowed to
// name it), and the remote session's full set (installed from boot.ts before the workbench
// module loads). Nothing here changes behaviour on its own — the modules are the same ones
// the core files once imported directly; the seam is now the hook lookup.

import { provideHook, type WebviewStreamBridge } from '../platform/hooks';
import { extLog } from '../features/extensions';
import { notify } from '../platform/ui';
import { t } from '../platform/i18n';
import { assetUrl } from './assetUrl';
import { installMirrorHost, mirrorViewersActive, mirrorViewersNow } from './mirror/hostStub';
import { installWorkbenchSync } from './workbenchSync';
import { startSummaryReporter } from './summary';
import { panelStream, viewStream } from './mirror/protocol';
import { noteCopyInteraction, recentCopyInteraction } from './mirror/copyInteraction';
import { parseStream, setWebviewFrameSource } from './mirror/webviewFrames';
import { editLockDefault, registerEditLock } from './editLock';
import { dismissFullScreenSideView, fullScreenSideViewOpen, holdPhonePage, noteBackgroundOpen, phoneShell, revealEditorPage, revealEditorPageNow } from './nav';
import { windowedEditThreshold } from './openThreshold';
import { addressedHere, frontendClass, frontendId, remoteEnv } from './session';
import { recentFolders } from '../platform/state';

/** The webview stream vocabulary both mirror sides speak (the desktop registers its frames
 *  and shares them; a remote viewer mounts the copies). */
function webviewStreamBridge(): WebviewStreamBridge {
	return {
		panelStream,
		viewStream,
		parseStream,
		setWebviewFrameSource,
		mountCopy(container, stream, extId) {
			let dispose: (() => void) | null = null;
			let gone = false;
			void import('./mirror/webviewCopy')
				.then(({ mountWebviewCopy }) => {
					if (!gone) dispose = mountWebviewCopy(container, stream, extId);
				})
				.catch((error) => extLog('warn', 'host', `webview copy ${stream}: ${String(error)}`));
			return () => {
				gone = true;
				dispose?.();
			};
		},
		// The desktop answers false forever — it hosts the real pages, nothing is a copy
		// here; only a remote session's own inputs ever note an interaction.
		noteCopyInteraction,
		recentCopyInteraction
	};
}

/** The desktop's own remote halves: the mirror host (this window is the watched side), the
 *  asset-URL protocol (Tauri's own convertFileSrc), the cross-frontend workbench sync, the
 *  summary reporter, and the webview streams. Idempotent. */
export function installDesktopRemoteHooks(): void {
	provideHook('assetUrl', assetUrl);
	provideHook('mirror', {
		install: installMirrorHost,
		viewersActive: mirrorViewersActive,
		viewersNow: mirrorViewersNow
	});
	provideHook('webviewStreams', webviewStreamBridge());
	provideHook('workbenchSync', installWorkbenchSync as unknown as () => ReturnType<typeof installWorkbenchSync>);
	provideHook('summaryReporter', startSummaryReporter);
	// Open Folder while a viewer drives this window: the in-window browser the copy shows,
	// never the native dialog only the PC's screen would (remote-ui-redesign-plan §P0).
	provideHook('folderOpen', async (open, roots) => {
		if (!mirrorViewersNow()) return false;
		const { browseFolders, localFolderSource } = await import('./folderBrowser');
		const fallback = roots[0] ?? (navigator.userAgent.includes('Windows') ? 'C:\\' : '/');
		const folder = await browseFolders(localFolderSource(fallback), { recent: recentFolders() });
		if (folder) await open(folder);
		return true;
	});
}

/** The remote session's set: everything the own-UI workbench runs with, installed by
 *  boot.ts after ATTACH and before `import('../main')`. The mirror host stays out — a
 *  session is a viewer, never the watched side. */
export function installRemoteSessionHooks(): void {
	provideHook('assetUrl', assetUrl);
	provideHook('session', { remote: () => remoteEnv() !== undefined, frontendId, frontendClass, addressedHere });
	provideHook('editLock', { defaultLocked: editLockDefault, register: registerEditLock });
	provideHook('navigation', { phoneShell, fullScreenSideViewOpen, dismissFullScreenSideView, revealEditorPage, revealEditorPageUngated: revealEditorPageNow, holdPage: holdPhonePage, noteBackgroundOpen });
	provideHook('openThreshold', windowedEditThreshold);
	provideHook('webviewStreams', webviewStreamBridge());
	provideHook('workbenchSync', installWorkbenchSync as unknown as () => ReturnType<typeof installWorkbenchSync>);
	provideHook('summaryReporter', startSummaryReporter);
	provideHook('transferWire', () => import('./transfer'));
	// Open Folder is the desktop's own on a remote page (K4, docs/remote-client-plan.md
	// §3.3): its menu row and keybinding never show (the command is desktop-profile), and
	// anything that reaches the picker anyway is told so, plainly, instead of falling
	// through to a native dialog this browser cannot see.
	provideHook('folderOpen', async () => {
		notify('info', t('remote.folders.desktopOnly'));
		return true;
	});
}
