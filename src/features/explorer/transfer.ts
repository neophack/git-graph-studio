// The remote session's file transfers — one vocabulary over the remote wire
// (src/remote/transfer.ts: chunked `fs_write_chunk` uploads, one-time ticket downloads).
// Upload and download are the BROWSER's own (K16, docs/remote-client-plan.md §11): the
// desktop app had a same-vocabulary pair over its native pickers (`fs_import` /
// `fs_export`) until 2026-10-15, when the owner retired it — copying between two folders
// of the same machine is the system file manager's job, and the rows left the PC's menu
// with the commands themselves. A desktop without a `transferWire` hook (the app) has no
// transfers at all, and these entry points answer empty rather than reaching for one.
import { t, tf } from '../../platform/i18n';
import { hook } from '../../platform/hooks';
import { basename, notify, progressToast, type MenuEntry } from '../../platform/ui/index';

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

	constructor(private readonly title: (label: string) => string) {}

	tick({ label, percent }: ProgressTick): void {
		this.handle ??= sink.progress(this.title(label));
		this.handle.update(percent, this.title(label));
	}

	close(): void {
		this.handle?.done();
		this.handle = null;
	}
}

/** Report a settled transfer: the failures by name and the landed count — a mixed
 *  outcome tells both (the wire never cancels; its failures are per-entry). */
function reportOutcome(landed: string[], failed: { name: string; error: string }[], kind: 'upload' | 'download'): void {
	if (failed.length > 0) sink.error(tf('transfer.failed', failed.map((f) => f.name).join(', ')));
	if (landed.length > 0) {
		sink.info(kind === 'upload' ? tf('transfer.uploaded', landed.length) : tf('transfer.downloaded', basename(landed[0] ?? '')));
	}
}

/** Pick files (or a folder) and land them in `dir`, with a progress toast and the outcome
 *  notified — the one upload entry, over the remote wire. Resolves with the paths that
 *  landed. */
export async function uploadInto(dir: string, folder = false): Promise<string[]> {
	const load = hook('transferWire');
	if (!load) return [];
	const toast = new TransferToast((label) => tf('transfer.uploading', label));
	const wire = await load();
	const outcome = await wire.uploadFiles(dir, folder, (p, index, count) => {
		const label = count > 1 ? `${index + 1}/${count} ${p.name}` : p.name;
		toast.tick({ label, percent: p.total > 0 ? Math.round(((index + p.sent / p.total) / count) * 100) : null });
	});
	toast.close();
	reportOutcome(outcome.uploaded, outcome.failed, 'upload');
	return outcome.uploaded;
}

/** Download a file or a folder (zipped by the daemon) — the one download entry, over the
 * remote wire's one-time ticket. Resolves whether the download ran. */
export async function downloadTo(path: string, zip = false): Promise<boolean> {
	const load = hook('transferWire');
	if (!load) return false;
	try {
		await (await load()).download(path, zip);
		return true;
	} catch (error) {
		sink.error(tf('transfer.failed', String(error)));
		return false;
	}
}

/** Download several files and folders as ONE zip (§6.7's multi-select pack). A wire
 *  without the multi form falls back to one download per selection. Resolves whether
 *  anything ran. */
export async function downloadManyTo(paths: string[]): Promise<boolean> {
	const load = hook('transferWire');
	if (!load || paths.length === 0) return false;
	const wire = await load();
	try {
		if (wire.downloadMany) await wire.downloadMany(paths);
		else for (const path of paths) await wire.download(path, false);
		return true;
	} catch (error) {
		sink.error(tf('transfer.failed', String(error)));
		return false;
	}
}

/** The Explorer context menu's transfer rows — a remote session's own (a file downloads, a
 *  folder downloads zipped and receives uploads). */
export function transferMenuEntries(path: string, isDir: boolean): MenuEntry[] {
	return isDir ? [
		{ label: t('transfer.downloadZip'), run: () => void downloadTo(path, true) },
		{ label: t('transfer.uploadHere'), run: () => void uploadInto(path, false) },
		{ label: t('transfer.uploadFolderHere'), run: () => void uploadInto(path, true) }
	] : [
		{ label: t('transfer.download'), run: () => void downloadTo(path) }
	];
}
