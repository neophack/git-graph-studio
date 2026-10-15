// The remote behaviours' installers, plugged into platform/hooks (plan §5.5). Two entry
// points: the desktop's own remote-shaped halves (the mirror host, the asset protocol, the
// workbench sync — installed from main.ts, the composition root outside remote/ allowed to
// name it), and the remote session's full set (installed from boot.ts before the workbench
// module loads). Nothing here changes behaviour on its own — the modules are the same ones
// the core files once imported directly; the seam is now the hook lookup.

import { provideHook, type WebviewStreamBridge } from '../platform/hooks';
import { extLog } from '../features/extensions';
import { assetUrl } from './assetUrl';
import { installMirrorHost, mirrorViewersActive, mirrorViewersNow } from './mirror/hostStub';
import { installWorkbenchSync } from './workbenchSync';
import { startSummaryReporter } from './summary';
import { panelStream, viewStream } from './mirror/protocol';
import { parseStream, setWebviewFrameSource } from './mirror/webviewFrames';
import { editLockDefault, registerEditLock } from './editLock';
import { dismissFullScreenSideView, fullScreenSideViewOpen, phoneShell, revealEditorPage } from './nav';
import { windowedEditThreshold } from './openThreshold';
import { addressedHere, frontendClass, frontendId, remoteEnv } from './session';

/** The webview stream vocabulary both mirror sides speak (the desktop registers its frames
 *  and shares them; a remote viewer mounts the copies). */
function webviewStreamBridge(): WebviewStreamBridge {
	return {
		panelStream,
		viewStream,
		parseStream,
		setWebviewFrameSource,
		mountCopy(container, stream) {
			let dispose: (() => void) | null = null;
			let gone = false;
			void import('./mirror/webviewCopy')
				.then(({ mountWebviewCopy }) => {
					if (!gone) dispose = mountWebviewCopy(container, stream);
				})
				.catch((error) => extLog('warn', 'host', `webview copy ${stream}: ${String(error)}`));
			return () => {
				gone = true;
				dispose?.();
			};
		}
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
}

/** The remote session's set: everything the own-UI workbench runs with, installed by
 *  boot.ts after ATTACH and before `import('../main')`. The mirror host stays out — a
 *  session is a viewer, never the watched side. */
export function installRemoteSessionHooks(): void {
	provideHook('assetUrl', assetUrl);
	provideHook('session', { remote: () => remoteEnv() !== undefined, frontendId, frontendClass, addressedHere });
	provideHook('editLock', { defaultLocked: editLockDefault, register: registerEditLock });
	provideHook('navigation', { phoneShell, fullScreenSideViewOpen, dismissFullScreenSideView, revealEditorPage });
	provideHook('openThreshold', windowedEditThreshold);
	provideHook('webviewStreams', webviewStreamBridge());
	provideHook('workbenchSync', installWorkbenchSync as unknown as () => ReturnType<typeof installWorkbenchSync>);
	provideHook('summaryReporter', startSummaryReporter);
	provideHook('transferWire', () => import('./transfer'));
}
