// The workbench's file transfers — one vocabulary, every environment (2026-10-13's
// rewrite): the PC app and a browser session both Upload and Download through here. The
// transport is the environment's own — a browser session rides the remote wire
// (src/remote/transfer.ts: chunked `fs_write_chunk` uploads, one-time ticket downloads),
// and the desktop app drives the native pickers and the backend's own copies (`fs_import`
// / `fs_export`, streamed progress, the Cancel action; a remote session never reaches
// those commands — the Relay refuses them, src/remote/pathGate.ts, because their paths
// name anywhere on the machine). A desktop upload lands beside what already exists
// (the ` (copy)` naming the Explorer's own drop copy uses — it never clobbers).
import { invoke, Channel } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';

import { t, tf } from './platform/i18n';
import { remoteEnv } from './remote/session';
import { mirrorViewersNow } from './remote/mirror/hostStub';
import { basename, notify, progressToast, type MenuEntry } from './platform/ui';

/** One progress report of a desktop transfer (`fs_export` / `fs_import`). */
export interface TransferProgress {
	name: string;
	bytes: number;
	total: number;
}

/** What a desktop transfer settled on: the paths that landed, per-entry failures, and
 *  whether the Cancel action stopped it early. */
export interface TransferReport {
	landed: string[];
	failed: { name: string; error: string }[];
	cancelled: boolean;
}

/** The surface a transfer reports through: a progress toast and the outcome notices. The
 *  workbench's own toasts are the default; the mirror page (no workbench DOM, no
 *  `#notifications`) installs its own before the first transfer runs. */
export interface TransferSink {
	progress(title: string, onCancel?: () => void): { update(percent: number | null, message?: string): void; done(): void };
	info(message: string): void;
	error(message: string): void;
}

const workbenchSink: TransferSink = {
	progress: (title, onCancel) => progressToast(title, onCancel),
	info: (message) => notify('info', message),
	error: (message) => notify('error', message)
};

let sink: TransferSink = workbenchSink;

/** Replace the progress/notice surface (the mirror page's own toast; `null` restores the
 *  workbench's). */
export function setTransferSink(next: TransferSink | null): void {
	sink = next ?? workbenchSink;
}

/** One running job's progress, as every transport reports it: the label the toast shows
 *  and the percent (null while the total is still unknown). */
interface ProgressTick {
	label: string;
	percent: number | null;
}

/** The toast a transfer owns: created on the first tick, updated by each, closed once. */
class TransferToast {
	private handle: ReturnType<TransferSink['progress']> | null = null;

	constructor(private readonly title: (label: string) => string, private readonly onCancel?: () => void) {}

	tick({ label, percent }: ProgressTick): void {
		this.handle ??= sink.progress(this.title(label), this.onCancel);
		this.handle.update(percent, this.title(label));
	}

	close(): void {
		this.handle?.done();
		this.handle = null;
	}
}

/** Report a settled transfer: the failures by name, the landed count, a cancel. */
function reportOutcome(landed: string[], failed: { name: string; error: string }[], cancelled: boolean, kind: 'upload' | 'download'): void {
	if (failed.length > 0) sink.error(tf('transfer.failed', failed.map((f) => f.name).join(', ')));
	if (cancelled) sink.info(t('transfer.canceled'));
	else if (landed.length > 0) {
		sink.info(kind === 'upload' ? tf('transfer.uploaded', landed.length) : tf('transfer.downloaded', basename(landed[0] ?? '')));
	}
}

/** A report as the backend answers it, missing fields defaulted (an older backend's answer
 *  degrades to empty, never crashes). */
function normalizeReport(report: TransferReport | null): TransferReport {
	return {
		landed: report?.landed ?? [],
		failed: report?.failed ?? [],
		cancelled: report?.cancelled ?? false
	};
}

/** Pick files (or a folder) and land them in `dir`, with a progress toast and the outcome
 *  notified — the one upload entry every environment runs. Resolves with the paths that
 *  landed. */
export async function uploadInto(dir: string, folder = false): Promise<string[]> {
	if (remoteEnv()) {
		const toast = new TransferToast((label) => tf('transfer.uploading', label));
		const remote = await import('./remote/transfer');
		const outcome = await remote.uploadFiles(dir, folder, (p, index, count) => {
			const label = count > 1 ? `${index + 1}/${count} ${p.name}` : p.name;
			toast.tick({ label, percent: p.total > 0 ? Math.round(((index + p.sent / p.total) / count) * 100) : null });
		});
		toast.close();
		reportOutcome(outcome.uploaded, outcome.failed, false, 'upload');
		return outcome.uploaded;
	}
	// The desktop: the native picker chooses sources anywhere on the machine, and the job
	// carries its own stop button (fs_transfer_cancel).
	const picked = await openDialog({ multiple: true, directory: folder, title: t(folder ? 'transfer.uploadFolder' : 'transfer.upload') });
	const sources = Array.isArray(picked) ? picked : picked ? [picked] : [];
	if (sources.length === 0) return [];
	const toast = new TransferToast((label) => tf('transfer.uploading', label), () => void invoke('fs_transfer_cancel').catch(() => undefined));
	const channel = new Channel<TransferProgress>();
	channel.onmessage = (p) => toast.tick({ label: p.name, percent: p.total > 0 ? Math.round((p.bytes / p.total) * 100) : null });
	const report = normalizeReport(await invoke<TransferReport>('fs_import', {
		sources,
		targetDir: dir,
		onProgress: channel
	}).catch((error: unknown) => {
		sink.error(tf('transfer.failed', String(error)));
		return null;
	}));
	toast.close();
	reportOutcome(report.landed, report.failed, report.cancelled, 'upload');
	return report.landed;
}

/** Download a file or a folder (zipped by the backend) to the user's chosen destination —
 *  the one download entry every environment runs. Resolves whether the download ran. */
export async function downloadTo(path: string, zip = false): Promise<boolean> {
	if (remoteEnv()) {
		const remote = await import('./remote/transfer');
		try {
			await remote.download(path, zip);
			return true;
		} catch (error) {
			sink.error(tf('transfer.failed', String(error)));
			return false;
		}
	}
	// The desktop: the save dialog names the destination anywhere on the machine; a folder
	// (or an explicit zip) packs into an archive.
	const suggested = basename(path) + (zip ? '.zip' : '');
	const dest = await saveDialog({
		defaultPath: suggested,
		...(zip ? { filters: [{ name: 'Zip', extensions: ['zip'] }] } : {})
	});
	if (!dest) return false;
	const toast = new TransferToast((label) => tf('transfer.downloading', label), () => void invoke('fs_transfer_cancel').catch(() => undefined));
	const channel = new Channel<TransferProgress>();
	channel.onmessage = (p) => toast.tick({ label: p.name, percent: p.total > 0 ? Math.round((p.bytes / p.total) * 100) : null });
	const report = normalizeReport(await invoke<TransferReport>('fs_export', {
		path,
		dest,
		zip,
		onProgress: channel
	}).catch((error: unknown) => {
		sink.error(tf('transfer.failed', String(error)));
		return null;
	}));
	toast.close();
	reportOutcome(report.landed, report.failed, report.cancelled, 'download');
	return report.landed.length > 0;
}

/** The Explorer context menu's transfer rows (one vocabulary, every environment): a file
 *  downloads, a folder downloads zipped and receives uploads. */
export function transferMenuEntries(path: string, isDir: boolean): MenuEntry[] {
	return isDir ? [
		{ label: t('transfer.downloadZip'), run: () => void downloadTo(path, true) },
		{ label: t('transfer.uploadHere'), run: () => void uploadInto(path, false) },
		{ label: t('transfer.uploadFolderHere'), run: () => void uploadInto(path, true) }
	] : [
		{ label: t('transfer.download'), run: () => void downloadTo(path) }
	];
}

/** Whether the Explorer shows its transfer rows: always on a remote session's own UI; on
 *  the desktop, never while a mirror viewer watches this window — the viewer's own
 *  device-run rows are the transfer vocabulary then (a PC-run row would open a native
 *  dialog the phone cannot see), and they return the moment the viewer leaves. */
export function transferMenuShown(): boolean {
	if (remoteEnv()) return true;
	return !mirrorViewersNow();
}
