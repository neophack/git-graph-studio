// The app's own update flow (2026-11-10, the owner's direction: 软件本身可以 github 下载):
// Help → Check for App Updates reads the repository's newest release, offers a strictly
// newer one, and downloads this platform's installer through the marketplace downloads'
// progress toast — bytes, the recent speed, the remaining time, cancellable mid-body —
// over the same `githubMirror` setting. The platform tails live in the backend
// (`app_update.rs`): Windows launches the installer and exits, macOS and Linux mount or
// reveal the package for their own manual step.

import { Channel } from '../platform/ipc/core';
import type { GalleryProgress } from '../platform/ipc/gallery';
import { appUpdateCheck, appUpdateInstall, appUpdateInstallCancel, type AppUpdate } from '../platform/ipc/update';
import { settings } from '../platform/settings';
import { t, tf } from '../platform/i18n';
import { confirmDialog, formatBytes, notify, progressToast } from '../platform/ui/index';

/** Help → Check for App Updates. Every failure is a notification, never a throw — the
 *  command sweep runs this against the scripted backend, and a check that cannot answer
 *  (offline, the repository's release carries no package for this platform) says so. */
export async function checkForAppUpdate(): Promise<void> {
	let update: AppUpdate | null;
	try {
		update = await appUpdateCheck();
	} catch (error) {
		notify('error', tf('appUpdate.failed', String(error)));
		return;
	}
	if (!update) {
		notify('info', tf('appUpdate.upToDate', __APP_VERSION__));
		return;
	}
	const release = update.releaseName ?? `Git Graph Studio ${update.version}`;
	if (!(await confirmDialog(tf('appUpdate.available', update.version, update.current, release), t('appUpdate.downloadAction')))) return;

	let cancelled = false;
	const toast = progressToast(tf('appUpdate.downloading', update.version, update.fileName), () => {
		cancelled = true;
		void appUpdateInstallCancel();
	});
	const channel = new Channel<GalleryProgress>();
	channel.onmessage = (tick) => toast.update(percent(tick), message(update, tick));
	try {
		const outcome = await appUpdateInstall(update.downloadUrl, settings.githubMirror.trim() || null, channel);
		notify('info', outcome.launched ? t('appUpdate.launched') : tf('appUpdate.downloaded', outcome.path));
	} catch (error) {
		// The user's own Cancel is not a failure — the toast said so.
		if (cancelled) notify('info', t('appUpdate.installCancelled'));
		else notify('error', tf('appUpdate.failed', String(error)));
	} finally {
		toast.done();
	}
}

/** One tick's percent of the total, when the server sent a Content-Length. */
function percent(tick: GalleryProgress): number | null {
	return tick.total !== null && tick.total > 0 ? Math.floor((tick.received / tick.total) * 100) : null;
}

/** One tick's toast message: the bytes so far against the total, the recent speed and
 *  the remaining time (the marketplace downloads' stats line — the same shape). */
function message(update: AppUpdate, tick: GalleryProgress): string {
	const speed = `${formatBytes(tick.bps)}/s`;
	const stats = tick.total !== null
		? tf('extensions.downloadStats', formatBytes(tick.received), formatBytes(tick.total), speed, tick.etaSecs === null ? '–' : formatEta(tick.etaSecs))
		: tf('extensions.downloadStatsNoLength', formatBytes(tick.received), speed);
	return `${tf('appUpdate.downloading', update.version, update.fileName)} · ${stats}`;
}

/** A download's remaining time (the download toasts' shape): seconds under a minute,
 *  minutes with the leftover seconds beyond, hours with the leftover minutes. */
function formatEta(secs: number): string {
	if (secs < 60) return `${secs}s`;
	const minutes = Math.floor(secs / 60);
	if (minutes < 60) {
		const rest = secs % 60;
		return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
