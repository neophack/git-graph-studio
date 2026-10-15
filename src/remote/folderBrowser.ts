// The PC folder browser (docs/remote-ui-redesign-plan.md §P0): Open Folder for anyone not
// sitting at the PC — a browser session's own workbench, or a mirror viewer driving the PC
// window. It always browses the PC's disk (the one the windows run on), never the browser
// device's: folders only, `..` to climb, the PC's recent folders and starting places first,
// a typed absolute path taken as is. One quick-input loop over a pluggable listing source —
// the daemon's `api/browse` for a session, the window's own `list_dir` on the desktop.
import { quickInput, notify, type QuickPickItem } from '../platform/ui';
import { t, tf } from '../platform/i18n';
import { listDir } from '../platform/ipc/fs';

export interface FolderListing {
	path: string;
	parent: string | null;
	dirs: { name: string; path: string }[];
	truncated?: boolean;
	places?: { kind: 'home' | 'drive' | 'root' | 'sandbox'; path: string }[];
}

/** One directory's sub-folders; rejects with a user-readable message. */
export type FolderSource = (path: string) => Promise<FolderListing>;

export interface BrowseOptions {
	/** Where to start; empty asks the source for its default (home, or the sandbox root). */
	start?: string;
	/** Folders offered before the listing (the PC's recent ones). */
	recent?: string[];
	title?: string;
}

const OPEN = '\u0000open';
const UP = '\u0000up';

const PLACE_ICON: Record<string, string> = { home: 'home', drive: 'server', root: 'root-folder', sandbox: 'shield' };
const PLACE_LABEL: Record<string, () => string> = {
	home: () => t('remote.folders.home'),
	drive: () => t('remote.folders.drive'),
	root: () => '/',
	sandbox: () => t('remote.folders.sandbox')
};

function isAbsolute(path: string): boolean {
	return /^[a-zA-Z]:[\\/]?/.test(path) || path.startsWith('/') || path.startsWith('\\\\');
}

/** Browse until a folder is chosen; resolves with its path, or null when dismissed. */
export async function browseFolders(source: FolderSource, options: BrowseOptions = {}): Promise<string | null> {
	let listing: FolderListing | null = null;
	let next: string | null = options.start ?? '';
	for (;;) {
		if (next !== null) {
			try {
				listing = await source(next);
			} catch (error) {
				notify('error', error instanceof Error ? error.message : String(error));
				// A refused start ends the browse; a refused step stays where it was.
				if (!listing) return null;
			}
			next = null;
		}
		const shown: FolderListing = listing!;
		const items: QuickPickItem[] = [{ label: t('remote.folders.openHere'), description: shown.path, icon: 'check', value: OPEN }];
		if (shown.parent) items.push({ label: '..', description: shown.parent, icon: 'arrow-up', value: UP });
		for (const entry of shown.dirs) items.push({ label: entry.name, icon: 'folder', value: `d:${entry.path}` });
		if (shown.truncated) items.push({ label: t('remote.folders.truncated'), icon: 'info', value: `d:${shown.path}` });
		for (const folder of options.recent ?? []) {
			items.push({ label: folder.split(/[\\/]/).filter(Boolean).pop() ?? folder, description: `${t('remote.folders.recent')} · ${folder}`, icon: 'history', value: `r:${folder}` });
		}
		for (const place of shown.places ?? []) {
			const drive = place.kind === 'drive';
			items.push({ label: drive ? place.path : (PLACE_LABEL[place.kind]?.() ?? place.path), description: drive ? t('remote.folders.drive') : place.path, icon: PLACE_ICON[place.kind] ?? 'folder', value: `d:${place.path}` });
		}
		const picked = await quickInput({
			title: options.title ?? t('remote.folders.title'),
			placeholder: t('remote.folders.placeholder'),
			items,
			allowFreeText: true
		});
		if (picked === null) return null;
		if (picked === OPEN) return shown.path;
		if (picked === UP && shown.parent) next = shown.parent;
		// A recent folder opens directly: it was a window's folder, the pick is the open.
		else if (picked.startsWith('r:')) return picked.slice(2);
		else if (picked.startsWith('d:')) next = picked.slice(2);
		else if (isAbsolute(picked.trim())) next = picked.trim();
	}
}

/** The daemon's listing (a browser session): `api/browse` under the session's base path. */
export function daemonFolderSource(basePath: string): FolderSource {
	return async (path) => {
		const url = new URL(`api/browse?path=${encodeURIComponent(path)}`, new URL(basePath, location.href));
		const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
		const body = (await response.json().catch(() => ({}))) as FolderListing & { error?: string };
		if (response.ok) return body;
		if (body.error === 'folder-input-off') throw new Error(t('remote.folders.disabled'));
		if (body.error === 'outside-sandbox') throw new Error(t('remote.folders.outsideSandbox'));
		throw new Error(tf('remote.folders.failed', body.error ?? String(response.status)));
	};
}

function parentOf(path: string): string | null {
	const trimmed = path.replace(/[\\/]+$/, '');
	if (/^[a-zA-Z]:$/.test(trimmed) || trimmed === '') return null;
	const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	if (at < 0) return null;
	if (at === 0) return '/';
	const parent = trimmed.slice(0, at);
	return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** The window's own listing (the desktop, while a mirror viewer drives it): `list_dir`
 *  over the PC's disk — the window is the PC. The empty path starts at `fallback`. */
export function localFolderSource(fallback: string): FolderSource {
	return async (path) => {
		const dir = path || fallback;
		let entries;
		try {
			entries = await listDir(dir);
		} catch (error) {
			throw new Error(tf('remote.folders.failed', String(error)));
		}
		return {
			path: dir,
			parent: parentOf(dir),
			dirs: entries.filter((entry) => entry.isDir).map((entry) => ({ name: entry.name, path: entry.path }))
		};
	};
}
