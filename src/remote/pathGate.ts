// The remote trust boundary's path rule (docs/ggs-remote-plan.md §23.4, the 2026-10-13
// audit's F1): a browser session drives the workbench, but its file reads and writes land
// inside the open folders only — `~/.ggs` (settings, provider keys, Claude state) and the
// rest of the disk are not a remote session's to touch through app commands. The desktop
// window is unaffected: the gate answers "is this caller a remote session", which only the
// Relay's stamped traffic is. Shared by the Relay (every path-carrying invoke) and the
// workbench sync receiver (remote-originated opens), so the two can never disagree.

/** Lexically absolute-path form for comparison: forward slashes, `.`/`..` resolved, a
 *  drive letter lower-cased (Windows compares case-insensitively; POSIX roots keep case).
 *  `null` when the path is not absolute — the backend would resolve it against a working
 *  directory the caller does not control the location of. */
export function absoluteForm(path: string): string | null {
	if (typeof path !== 'string' || path === '') return null;
	const fwd = path.replace(/\\/g, '/');
	const windows = /^[a-zA-Z]:\//.test(fwd);
	const posix = fwd.startsWith('/');
	// A UNC path (`//server/share`) never sits under a local root — it normalizes to its
	// own absolute form and fails every prefix check, which is the answer we want.
	if (!windows && !posix) return null;
	const body = windows ? fwd.slice(2) : fwd;
	const parts: string[] = [];
	for (const part of body.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (parts.length === 0 && windows) return null; // above the drive root: malformed
			parts.pop();
		} else parts.push(part);
	}
	const joined = parts.join('/');
	if (windows) return `${fwd[0].toLowerCase()}:/${joined}`;
	return `/${joined}`;
}

/** Whether `path` is `root` itself or inside it, both in absolute form. */
export function withinRoots(path: string, roots: string[]): boolean {
	const form = absoluteForm(path);
	if (form === null) return false;
	return roots.some((root) => {
		const base = absoluteForm(root);
		if (base === null) return false;
		// A root's own form may carry a trailing slash (`C:\` → `c:/`; the POSIX root stays
		// `/`): normalise it away so the prefix check never looks for a doubled slash.
		const stem = base.length > 1 && base.endsWith('/') ? base.slice(0, -1) : base;
		return form === stem || form.startsWith(`${stem}/`);
	});
}

/** The commands whose arguments name filesystem paths, by argument name (the JS/camelCase
 *  spelling the invoke carries). `relative` marks the git-anchored commands whose backend
 *  resolves a relative path against the (gated) `repo` argument — for the rest, a relative
 *  path would resolve against a working directory outside the roots and is refused. */
export const PATH_GATED: Record<
	string,
	{ args: string[]; relativeAllowed?: boolean; sameRootOnly?: boolean }
> = {
	list_dir: { args: ['path'] },
	list_dir_page: { args: ['path'] },
	list_files: { args: ['root'] },
	read_file: { args: ['path'] },
	read_file_raw: { args: ['path'] },
	read_file_base64: { args: ['path'] },
	read_file_chunk: { args: ['path'] },
	file_probe: { args: ['path'] },
	file_fingerprint: { args: ['path'] },
	patch_file: { args: ['path'] },
	write_file: { args: ['path'] },
	create_file: { args: ['path'] },
	create_folder: { args: ['path'] },
	delete_path: { args: ['path'] },
	rename_path: { args: ['from', 'to'] },
	backup_write: { args: ['path'] },
	backup_clear: { args: ['path'] },
	backup_read: { args: ['path'] },
	read_file_at: { args: ['path', 'repo'], relativeAllowed: true },
	materialize_revision_file: { args: ['path', 'repo'], relativeAllowed: true },
	file_log: { args: ['path', 'repo'], relativeAllowed: true },
	scm_blame: { args: ['path', 'repo'], relativeAllowed: true },
	workspace_symbols: { args: ['repo'] },
	find_references: { args: ['path', 'repo'], relativeAllowed: true },
	repo_head: { args: ['repo'] },
	repo_submodules: { args: ['repo'] },
	search_workspace: { args: ['path'] },
	compare_dirs: { args: ['left', 'right'] },
	hex_diff: { args: ['pathA', 'pathB'] },
	viewer_open: { args: ['path'] },
	viewer_backup: { args: ['path'] },
	open_folder: { args: ['path'], sameRootOnly: true },
	open_workspace: { args: ['path'], sameRootOnly: true }
};

/** The commands a remote session may not run at all: they widen the very boundary this
 *  gate enforces (a remote open of an arbitrary folder would make everything under it
 *  "the open workspace"). Opening NEW folders is what the picker's sandboxed SPAWN is
 *  for; the idempotent reopen of a folder already inside the open roots — the boot's own
 *  first call — stays allowed (`sameRootOnly` in PATH_GATED). */
export const REFUSED_COMMANDS = new Set<string>();

/** Whether the command needs the roots fetched at all — the cheap pre-check that keeps
 *  the untimed majority of invokes free of the policy round trip. */
export function isPathGated(command: string): boolean {
	return REFUSED_COMMANDS.has(command) || PATH_GATED[command] !== undefined;
}

/** Check one invoke's arguments against the roots; throws the message the session sees. */
export function gateInvoke(
	command: string,
	args: Record<string, unknown> | undefined,
	roots: string[]
): void {
	if (REFUSED_COMMANDS.has(command)) {
		throw new Error(
			'a remote session cannot open folders on this PC — open one from the PC, or spawn a sandboxed window'
		);
	}
	const rule = PATH_GATED[command];
	if (!rule) return;
	const record = args ?? {};
	for (const name of rule.args) {
		const value = record[name];
		if (value === undefined || value === null) continue;
		if (typeof value !== 'string') continue;
		const absolute = absoluteForm(value) !== null;
		if (!absolute) {
			if (rule.relativeAllowed && name !== 'repo') continue;
			throw new Error(`${command}: ${name} must be an absolute path inside the open folders`);
		}
		if (!withinRoots(value, roots)) {
			if (rule.sameRootOnly) {
				throw new Error(
					'a remote session cannot open new folders on this PC — open one from the PC, or spawn a sandboxed window'
				);
			}
			throw new Error(`${command}: ${value} is outside the folders this window has open`);
		}
	}
}
