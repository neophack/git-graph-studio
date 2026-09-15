// A file's history: the commits that touched it, newest first, as VS Code's Timeline lists
// them - hash, subject, author, relative date - each opening the diff of that commit's version
// against its parent's. The commits come from the graph engine's own log (a `loadCommits`
// request filtered to the path, through the graph host's channel), so the list matches what
// the Git Graph view would show for "View File History".

import type { DiffRequest } from './scm';
import { graphRequest } from './graphHost';
import { basename, el, icon, toPosix } from './ui';

export interface HistoryEntry {
	hash: string;
	parents: string[];
	author: string;
	/** Seconds since the epoch. */
	date: number;
	message: string;
}

/** The commits that touched `relativePath` (repo-relative, posix), newest first. */
export async function loadFileHistory(repo: string, relativePath: string, maxCommits = 300): Promise<HistoryEntry[]> {
	const response = await graphRequest({
		command: 'loadCommits',
		repo,
		refreshId: 0,
		branches: null,
		authors: null,
		maxCommits,
		showTags: false,
		showRemoteBranches: true,
		includeCommitsMentionedByReflogs: false,
		onlyFollowFirstParent: false,
		commitOrdering: 'date',
		remotes: [],
		hideRemotes: [],
		showUncommittedChanges: false,
		showUntrackedFiles: false,
		filterPath: relativePath
	});
	if (!response || response['error']) throw new Error(String(response?.['error'] ?? 'The history could not be loaded'));
	const commits = response['commits'];
	return Array.isArray(commits) ? (commits as HistoryEntry[]).filter((c) => c.hash !== '*') : [];
}

/** "3 hours ago", "2 days ago", or the date for anything older than a month. */
export function relativeDate(seconds: number, now = Date.now()): string {
	const delta = Math.max(0, Math.floor(now / 1000) - seconds);
	if (delta < 60) return 'just now';
	if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
	if (delta < 86400) { const h = Math.floor(delta / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; }
	if (delta < 30 * 86400) { const d = Math.floor(delta / 86400); return `${d} day${d === 1 ? '' : 's'} ago`; }
	return new Date(seconds * 1000).toLocaleDateString();
}

/** The history tab's contents: a list of commits for one file. */
export class FileHistoryView {
	private readonly list: HTMLElement;
	/** A row was clicked: the diff of the file at that commit against its parent. */
	onOpenDiff: ((diff: DiffRequest) => void) | null = null;
	/** The file at that commit, read-only. */
	onOpenRevision: ((revision: string, path: string, title: string) => void) | null = null;

	constructor(container: HTMLElement, private readonly repo: string, private readonly path: string) {
		container.classList.add('file-history');
		const relative = toPosix(path);
		container.appendChild(el('div', 'file-history-header', [icon('history'), el('span', 'label', [basename(relative)]), el('span', 'description', [relative])]));
		this.list = el('div', 'file-history-list');
		this.list.appendChild(el('div', 'file-history-empty', ['Loading history…']));
		container.appendChild(this.list);
		void this.load();
	}

	async load(): Promise<void> {
		let entries: HistoryEntry[];
		try {
			entries = await loadFileHistory(this.repo, toPosix(this.path));
		} catch (error) {
			this.list.replaceChildren(el('div', 'file-history-empty', [String(error)]));
			return;
		}
		this.render(entries);
	}

	private render(entries: HistoryEntry[]): void {
		this.list.innerHTML = '';
		if (entries.length === 0) {
			this.list.appendChild(el('div', 'file-history-empty', ['No commits touch this file.']));
			return;
		}
		const relative = toPosix(this.path);
		for (const entry of entries) {
			const row = el('div', 'row file-history-row', [
				el('span', 'file-history-hash', [entry.hash.slice(0, 8)]),
				el('span', 'file-history-message', [entry.message]),
				el('span', 'file-history-meta', [`${entry.author} · ${relativeDate(entry.date)}`])
			]);
			row.title = `${entry.hash}\n${entry.message}\n${entry.author}, ${new Date(entry.date * 1000).toLocaleString()}`;
			row.addEventListener('click', () => {
				const parent = entry.parents[0];
				this.onOpenDiff?.({
					id: `history:${entry.hash}:${relative}`,
					title: `${basename(relative)} (${entry.hash.slice(0, 8)})`,
					left: { revision: parent ?? entry.hash, path: relative, label: parent ? parent.slice(0, 8) : 'empty', exists: parent !== undefined },
					right: { revision: entry.hash, path: relative, label: entry.hash.slice(0, 8), exists: true }
				});
			});
			row.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				this.onOpenRevision?.(entry.hash, relative, `${basename(relative)} @ ${entry.hash.slice(0, 8)}`);
			});
			this.list.appendChild(row);
		}
	}
}

/* ---------- Blame ---------- */

/** One line's last change, as `scm_blame` reports it. */
export interface BlameLine {
	hash: string;
	author: string;
	/** Seconds since the epoch. */
	time: number;
	summary: string;
}

/** The gutter text of a blame line: "author, 3 days ago" - the uncommitted marker for an
 *  all-zero hash. */
export function blameLabel(line: BlameLine, now = Date.now()): string {
	if (/^0+$/.test(line.hash)) return 'You, uncommitted';
	return `${line.author}, ${relativeDate(line.time, now)}`;
}
