// The remote file picker (docs/ggs-remote-plan.md §9.3, §11.3): the dialog plugin's
// `open` / `save` for a browser, browsing the PC's file system over `list_dir` in the
// workbench's own quick input — folders to step into, `..` to step out, a typed absolute
// path accepted as is, and "Upload from this device…" to put files into the folder shown.
import { invoke } from './tauriShim/core';
import { quickInput, type QuickPickItem } from '../ui';
import { t } from '../i18n';
import { uploadFiles } from './transfer';

interface DirEntryInfo {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
}

export interface PickOptions {
	title?: string;
	defaultPath?: string;
	directory?: boolean;
	multiple?: boolean;
	/** `save`: the file name to propose; the result is a path that may not exist yet. */
	saveName?: string;
	filters?: { name: string; extensions: string[] }[];
}

const SELECT = '\u0000select';
const UP = '\u0000up';
const UPLOAD = '\u0000upload';

function parentOf(path: string): string | null {
	const trimmed = path.replace(/[\\/]+$/, '');
	const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	if (at < 0) return null;
	if (at === 0) return '/';
	const parent = trimmed.slice(0, at);
	return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

function joinPath(dir: string, name: string): string {
	const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
	return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function matchesFilters(name: string, filters?: PickOptions['filters']): boolean {
	if (!filters || filters.length === 0) return true;
	const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
	return filters.some((f) => f.extensions.some((e) => e === '*' || e.toLowerCase() === ext));
}

async function startDir(options: PickOptions): Promise<string> {
	if (options.defaultPath) {
		try {
			await invoke('list_dir', { path: options.defaultPath });
			return options.defaultPath;
		} catch {
			const parent = parentOf(options.defaultPath);
			if (parent) return parent;
		}
	}
	try {
		const status = await invoke<{ folders?: string[] }>('remote_host_status');
		const first = status.folders?.[0];
		if (first) return first;
	} catch {
		/* an older instance */
	}
	return '/';
}

/** Browse until a pick; resolves with the chosen path(s), or null when dismissed. */
export async function pickRemotePath(options: PickOptions): Promise<string | string[] | null> {
	let dir = await startDir(options);
	for (;;) {
		let entries: DirEntryInfo[] = [];
		try {
			entries = await invoke<DirEntryInfo[]>('list_dir', { path: dir });
		} catch {
			entries = [];
		}
		const items: QuickPickItem[] = [];
		if (options.directory || options.saveName !== undefined) {
			items.push({ label: options.saveName !== undefined ? t('remote.picker.saveHere') : t('remote.picker.selectFolder'), description: dir, icon: 'check', value: SELECT });
		}
		const parent = parentOf(dir);
		if (parent) items.push({ label: '..', description: parent, icon: 'arrow-up', value: UP });
		if (!options.directory && options.saveName === undefined) items.push({ label: t('remote.picker.upload'), icon: 'cloud-upload', value: UPLOAD });
		for (const entry of entries) {
			if (entry.isDir) items.push({ label: entry.name, icon: 'folder', value: `d:${entry.path}` });
			else if (!options.directory && matchesFilters(entry.name, options.filters)) items.push({ label: entry.name, icon: 'file', value: `f:${entry.path}` });
		}
		const picked = await quickInput({
			title: options.title ?? (options.directory ? t('remote.picker.chooseFolder') : t('remote.picker.chooseFile')),
			placeholder: dir,
			value: options.saveName,
			items,
			allowFreeText: true
		});
		if (picked === null) return null;
		if (picked === SELECT) return options.saveName !== undefined ? joinPath(dir, options.saveName) : dir;
		if (picked === UP && parent) {
			dir = parent;
			continue;
		}
		if (picked === UPLOAD) {
			const uploaded = await uploadFiles(dir);
			if (uploaded.length) return options.multiple ? uploaded : uploaded[0];
			continue;
		}
		if (picked.startsWith('d:')) {
			dir = picked.slice(2);
			continue;
		}
		if (picked.startsWith('f:')) {
			const path = picked.slice(2);
			return options.multiple ? [path] : path;
		}
		// Free text: an absolute path is taken as typed (a folder is entered); in save mode a
		// bare name lands in the folder shown.
		const typed = picked.trim();
		if (!typed) continue;
		const absolute = /^([A-Za-z]:[\\/]|\/)/.test(typed);
		if (options.saveName !== undefined) return absolute ? typed : joinPath(dir, typed);
		if (absolute) {
			try {
				await invoke('list_dir', { path: typed });
				dir = typed;
				continue;
			} catch {
				if (!options.directory) return options.multiple ? [typed] : typed;
			}
		}
	}
}
