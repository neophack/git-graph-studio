// Uploads and downloads for the remote workbench (docs/ggs-remote-plan.md §11.3 File
// Explorer): an upload crosses as 256 KB raw INVOKE chunks to `fs_write_chunk` (resumable —
// the backend answers the size it has); a download is a one-time ticket URL the browser
// navigates to, so the bytes stream straight from the instance to the device's disk. The
// `uploadInto` / `downloadTo` wrappers carry the UI (a progress toast, the failure notice);
// the commands (remote/shell.ts) and the Explorer's context menu both ride them.
import { notify, progressToast } from '../ui';
import { tf } from '../i18n';
import { invoke } from './tauriShim/core';
import { remoteEnv } from './session';

export const UPLOAD_CHUNK = 256 * 1024;

export interface UploadProgress {
	name: string;
	sent: number;
	total: number;
}

/** What a batch upload settled on: the PC paths that landed, and per-file failures (one
 *  bad file never strands the rest, and a failure is always reported, never silent). */
export interface UploadOutcome {
	uploaded: string[];
	failed: { name: string; error: string }[];
}

function joinPath(dir: string, name: string): string {
	const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
	return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Upload one file into a folder of the PC; resolves with the path it landed at. */
export async function uploadFile(file: File, dir: string, onProgress?: (p: UploadProgress) => void): Promise<string> {
	const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
	const target = joinPath(dir, relative.replace(/\\/g, '/'));
	let offset = 0;
	// Resume: the backend reports how much of a partial upload it already has.
	try {
		offset = await invoke<number>('fs_upload_offset', { path: target, size: file.size });
	} catch {
		offset = 0;
	}
	do {
		const end = Math.min(offset + UPLOAD_CHUNK, file.size);
		const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
		await invoke('fs_write_chunk', bytes, {
			headers: {
				'x-ggs-path': encodeURIComponent(target),
				'x-ggs-offset': String(offset),
				'x-ggs-total': String(file.size)
			}
		});
		offset = end;
		onProgress?.({ name: relative, sent: offset, total: file.size });
	} while (offset < file.size);
	return target;
}

/** Ask the device for files (or a folder) and upload them. Every file's outcome is
 *  collected — a failed file is reported in `failed` and never rejects the batch. */
export function uploadFiles(dir: string, folder = false, onProgress?: (p: UploadProgress, index: number, count: number) => void): Promise<UploadOutcome> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		if (folder) input.setAttribute('webkitdirectory', '');
		input.style.display = 'none';
		input.addEventListener('change', async () => {
			const files = [...(input.files ?? [])];
			input.remove();
			const outcome: UploadOutcome = { uploaded: [], failed: [] };
			for (const [index, file] of files.entries()) {
				const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
				try {
					outcome.uploaded.push(await uploadFile(file, dir, (p) => onProgress?.(p, index, files.length)));
				} catch (error) {
					outcome.failed.push({ name, error: String(error) });
				}
			}
			resolve(outcome);
		});
		input.addEventListener('cancel', () => {
			input.remove();
			resolve({ uploaded: [], failed: [] });
		});
		document.body.appendChild(input);
		input.click();
	});
}

/** The surface a transfer reports through: a progress toast and the outcome notices. The
 *  workbench's own toasts are the default; the mirror page (no workbench DOM, no
 *  `#notifications`) installs its own before the first transfer runs. */
export interface TransferSink {
	progress(title: string): { update(percent: number | null, message?: string): void; done(): void };
	info(message: string): void;
	error(message: string): void;
}

const workbenchSink: TransferSink = {
	progress: (title) => progressToast(title),
	info: (message) => notify('info', message),
	error: (message) => notify('error', message)
};

let sink: TransferSink = workbenchSink;

/** Replace the progress/notice surface (the mirror page's own toast; `null` restores the
 *  workbench's). */
export function setTransferSink(next: TransferSink | null): void {
	sink = next ?? workbenchSink;
}

/** Pick files (or a folder) on the device and upload them into `dir`, with a progress
 *  toast and the outcome notified. Resolves with the PC paths that landed. */
export async function uploadInto(dir: string, folder = false): Promise<string[]> {
	// An object property: the closure assignment must survive control-flow narrowing.
	const progress: { toast: ReturnType<TransferSink['progress']> | null } = { toast: null };
	const outcome = await uploadFiles(dir, folder, (p, index, count) => {
		const label = count > 1 ? `${index + 1}/${count} ${p.name}` : p.name;
		progress.toast ??= sink.progress(tf('remote.transfer.uploading', label));
		progress.toast.update(p.total > 0 ? Math.round(((index + p.sent / p.total) / count) * 100) : null, tf('remote.transfer.uploading', label));
	});
	progress.toast?.done();
	if (outcome.failed.length > 0) {
		sink.error(tf('remote.transfer.failed', outcome.failed.map((f) => f.name).join(', ')));
	}
	if (outcome.uploaded.length > 0) sink.info(tf('remote.transfer.uploaded', outcome.uploaded.length));
	return outcome.uploaded;
}

/** Download a file or a folder (zipped by the instance) to this device. */
export async function download(path: string, zip = false): Promise<void> {
	const env = remoteEnv();
	if (!env) throw new Error('downloads need a remote session');
	const base = new URL(env.basePath, location.href);
	const response = await fetch(new URL('api/download-ticket', base), {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ instance: env.attached.instance, path, zip })
	});
	if (!response.ok) throw new Error(`download refused (${response.status})`);
	const { url } = (await response.json()) as { url: string };
	const link = document.createElement('a');
	link.href = new URL(url, location.href).href;
	link.download = '';
	link.rel = 'noopener';
	document.body.appendChild(link);
	link.click();
	link.remove();
}

/** `download` with its failure notified (the ticket refusal, a dead session). Resolves
 *  whether the download started. */
export async function downloadTo(path: string, zip = false): Promise<boolean> {
	try {
		await download(path, zip);
		return true;
	} catch (error) {
		sink.error(tf('remote.transfer.failed', String(error)));
		return false;
	}
}
