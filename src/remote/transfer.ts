// Uploads and downloads for the remote workbench (docs/ggs-remote-plan.md §11.3 File
// Explorer): an upload crosses as 256 KB raw INVOKE chunks to `fs_write_chunk` (resumable —
// the backend answers the size it has); a download is a one-time ticket URL the browser
// navigates to, so the bytes stream straight from the instance to the device's disk.
import { invoke } from './tauriShim/core';
import { remoteEnv } from './session';

export const UPLOAD_CHUNK = 256 * 1024;

export interface UploadProgress {
	name: string;
	sent: number;
	total: number;
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

/** Ask the device for files (or a folder) and upload them; resolves with the PC paths. */
export function uploadFiles(dir: string, folder = false, onProgress?: (p: UploadProgress) => void): Promise<string[]> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		if (folder) input.setAttribute('webkitdirectory', '');
		input.style.display = 'none';
		input.addEventListener('change', async () => {
			const files = [...(input.files ?? [])];
			input.remove();
			const done: string[] = [];
			for (const file of files) done.push(await uploadFile(file, dir, onProgress));
			resolve(done);
		});
		input.addEventListener('cancel', () => {
			input.remove();
			resolve([]);
		});
		document.body.appendChild(input);
		input.click();
	});
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
