// The typed IPC seam of the app's own update channel (2026-11-10, the owner's direction:
// 软件本身可以 github 下载): the repository's newest release and this platform's
// installer, downloaded through the same streaming progress and mirror setting the
// marketplace's GitHub channel rides. The backend module is `src-tauri/src/app_update.rs`.
import { invoke, type Channel } from './core';
import type { GalleryProgress } from './gallery';

/** One available update (`app_update_check`): the running version against the release's,
 *  plus this platform's installer asset. `null` answers "this is the newest". */
export interface AppUpdate {
	current: string;
	version: string;
	releaseName: string | null;
	publishedAt: string;
	downloadUrl: string;
	fileName: string;
}

/** What the platform tail did with the downloaded installer (`app_update_install`). */
export interface UpdateInstallOutcome {
	/** Windows (packaged): the installer launched and the app is exiting. Elsewhere the
	 *  package was mounted or its folder revealed — the manual step remains. */
	launched: boolean;
	path: string;
}

export const appUpdateCheck = () => invoke<AppUpdate | null>('app_update_check');
export const appUpdateInstall = (downloadUrl: string, mirror: string | null, onProgress: Channel<GalleryProgress>) =>
	invoke<UpdateInstallOutcome>('app_update_install', { downloadUrl, mirror, onProgress });
/** The install toast's Cancel: stops the in-flight app download. */
export const appUpdateInstallCancel = () => invoke<void>('app_update_install_cancel');
