// The files page's path bar (docs/remote-client-plan.md §6.1): the workspace root's icon
// and one chip per directory below it, horizontally scrollable and auto-scrolled to the
// end when a directory is entered. A chip's tap jumps straight to that level; a long-press
// copies the path; the trailing ▸ lists the sibling directories of the current one (the
// quick hop to the folder beside, MT-manager's own move). Every level renders as a
// visible capsule (the owner's 2026-10-16 direction, 可以看出每个文件夹胶囊) — the pill
// styling lives with the .ggs-path-chip rules in layouts.css.
import { el, icon, notify } from '../../../platform/ui';
import { listDirPage } from '../../../platform/ipc/fs';
import { t } from '../../../platform/i18n';
import { showActionSheet } from '../../actionSheet';
import type { MenuEntry } from '../../../platform/ui';

function segments(dir: string, root: string): { name: string; path: string }[] {
	const out: { name: string; path: string }[] = [];
	if (dir === root || !dir.startsWith(root)) return out;
	const rest = dir.slice(root.length).replace(/^[/\\]+/, '');
	let path = root.replace(/[\\/]+$/, '');
	for (const name of rest.split(/[/\\]+/).filter(Boolean)) {
		path = `${path}/${name}`;
		out.push({ name, path });
	}
	return out;
}

/** Copy with the §10.2 item 9 fallback (Firefox pages cannot always read, but writing
 *  falls back to the deprecated execCommand). */
async function copyPath(path: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(path);
		notify('info', t('remote.files.pathCopied'));
	} catch {
		const field = document.createElement('textarea');
		field.value = path;
		field.style.position = 'fixed';
		field.style.opacity = '0';
		document.body.appendChild(field);
		field.select();
		const done = document.execCommand('copy');
		field.remove();
		notify(done ? 'info' : 'error', done ? t('remote.files.pathCopied') : t('remote.files.copyFailed'));
	}
}

function chip(name: string, path: string, onTap: (path: string) => void, onLongPress: (path: string) => void): HTMLElement {
	const node = el('button', 'ggs-path-chip', [name]);
	node.type = 'button';
	let timer: number | null = null;
	let start: { x: number; y: number } | null = null;
	let longFired = false;
	node.addEventListener('pointerdown', (event) => {
		start = { x: event.clientX, y: event.clientY };
		longFired = false;
		timer = window.setTimeout(() => {
			timer = null;
			longFired = true;
			navigator.vibrate?.(10);
			onLongPress(path);
		}, 450);
	});
	node.addEventListener('pointermove', (event) => {
		if (!start) return;
		if (Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10) {
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
		}
	});
	const clear = () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
	};
	node.addEventListener('pointerup', clear);
	node.addEventListener('pointercancel', clear);
	node.addEventListener('click', () => {
		if (!longFired) onTap(path);
	});
	return node;
}

export function createPathBar(go: (dir: string) => void) {
	const root = el('div', 'ggs-path-bar');
	const track = el('div', 'ggs-path-track');
	const siblings = el('button', 'ggs-path-siblings');
	siblings.type = 'button';
	siblings.setAttribute('aria-label', t('remote.files.siblingDirs'));
	siblings.appendChild(icon('chevron-right'));
	let current = '';
	let rootDir = '';

	siblings.addEventListener('click', () => {
		void siblingSheet();
	});

	async function siblingSheet(): Promise<void> {
		const parent = parentOf(current, rootDir);
		if (!parent) return;
		try {
			const page = await listDirPage(parent, 0, 200);
			const entries: MenuEntry[] = page.entries
				.filter((entry) => entry.isDir)
				.map((entry) => ({
					label: entry.name,
					checked: entry.path === current,
					run: () => go(entry.path)
				}));
			showActionSheet(entries.length > 0 ? entries : [{ label: t('remote.files.empty'), run: () => undefined }]);
		} catch {
			/* the ▸ simply does nothing without its list */
		}
	}

	function parentOf(dir: string, root: string): string | null {
		if (dir === root) return null;
		const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
		const parent = cut > 0 ? dir.slice(0, cut) : '';
		return parent && (parent.length >= root.length || root.startsWith(parent)) ? parent || root : null;
	}

	return {
		root,
		set(dir: string, workspaceRoot: string): void {
			current = dir;
			rootDir = workspaceRoot;
			const home = el('button', 'ggs-path-chip home');
			home.type = 'button';
			home.title = workspaceRoot;
			home.appendChild(icon('root-folder'));
			home.addEventListener('click', () => go(workspaceRoot));
			track.replaceChildren(home);
			for (const segment of segments(dir, workspaceRoot)) {
				track.appendChild(chip(segment.name, segment.path, go, (path) => void copyPath(path)));
			}
			root.replaceChildren(track, siblings);
			// New directory: the bar scrolls so the LAST chip is in view (§6.1). The
			// scrollLeft write is the whole effect — scrollTo's options form buys nothing
			// here and jsdom does not implement it.
			requestAnimationFrame(() => {
				track.scrollLeft = track.scrollWidth;
			});
		}
	};
}
