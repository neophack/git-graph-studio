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

/** The git/scm/analysis/symbol family: every one anchors on `repo` (an absolute path)
 *  and some carry a repo-relative `path`. One rule, spelled once. */
const REPO_ANCHORED = { args: ['repo'] };
const REPO_AND_PATH = { args: ['path', 'repo'], relativeAllowed: true };

/** Whether `partial` is on its way TO a root — a completion's typed prefix (`C:\r`
 *  while the root is `C:\repo`): not inside any root yet, but some root starts with it. */
function towardRoot(partial: string, roots: string[]): boolean {
	const form = absoluteForm(partial);
	if (form === null) return false;
	return roots.some((root) => {
		const base = absoluteForm(root);
		return base !== null && base.startsWith(form);
	});
}

/** The commands whose arguments name filesystem paths, by argument name (the JS/camelCase
 *  spelling the invoke carries — the Rust side spells them snake_case). `relativeAllowed`
 *  marks args the backend resolves against the (gated) `repo` argument — for the rest, a
 *  relative path would resolve against a working directory outside the roots and is
 *  refused. `sameRootOnly` marks the commands that would WIDEN the boundary (opening a
 *  new folder or single file makes it a root); `prefixTowardRoot` marks the completion
 *  command, whose partial input may also be on the way TO a root. The table is the
 *  extraction of every `#[tauri::command]` with String path-like parameters — a command
 *  missing here is a hole, so extend it with the command, not around it. */
export const PATH_GATED: Record<
	string,
	{
		args: string[];
		relativeAllowed?: boolean;
		sameRootOnly?: boolean;
		prefixTowardRoot?: boolean;
	}
> = {
	// The Explorer/editor file surface.
	list_dir: { args: ['path'] },
	list_dir_page: { args: ['path'] },
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
	fs_upload_offset: { args: ['path'] },
	discard_temp_blob: { args: ['path'] },
	// Revisions and history.
	read_file_at: REPO_AND_PATH,
	materialize_revision_file: REPO_AND_PATH,
	file_log: REPO_AND_PATH,
	scm_blame: REPO_AND_PATH,
	repo_head: REPO_ANCHORED,
	repo_submodules: { args: ['repo'] },
	// Search, symbols, analysis — everything that walks a tree.
	search_workspace: { args: ['repo'] },
	list_files: REPO_ANCHORED,
	compare_dirs: { args: ['left', 'right'] },
	hex_diff: { args: ['pathA', 'pathB'] },
	workspace_symbols: { args: ['repo'] },
	symbol_lookup: { args: ['repo'] },
	symbol_references: { args: ['repo'] },
	symbol_tree: REPO_ANCHORED,
	symbols_rebuild: REPO_ANCHORED,
	symbols_status: REPO_ANCHORED,
	analysis_status: REPO_ANCHORED,
	analysis_rebuild: REPO_ANCHORED,
	analysis_metrics: REPO_ANCHORED,
	analysis_dead_code: REPO_ANCHORED,
	analysis_security: REPO_ANCHORED,
	analysis_import_graph: REPO_ANCHORED,
	analysis_module_graph: REPO_ANCHORED,
	analysis_module_diagram: { args: ['repo', 'focus'], relativeAllowed: true },
	// The git/scm write set.
	git_commit: REPO_ANCHORED,
	git_discard: REPO_AND_PATH,
	git_discard_all: REPO_ANCHORED,
	git_stage: REPO_ANCHORED,
	git_stage_all: REPO_ANCHORED,
	git_unstage: REPO_ANCHORED,
	git_unstage_all: REPO_ANCHORED,
	scm_add_remote: REPO_ANCHORED,
	scm_add_tag: REPO_ANCHORED,
	scm_amend_last_commit: REPO_ANCHORED,
	scm_apply_stash: REPO_ANCHORED,
	scm_branches: REPO_ANCHORED,
	scm_checkout: REPO_ANCHORED,
	scm_clone: { args: ['parent'], sameRootOnly: true },
	scm_create_branch: REPO_ANCHORED,
	scm_delete_branch: REPO_ANCHORED,
	scm_delete_remote: REPO_ANCHORED,
	scm_delete_tag: REPO_ANCHORED,
	scm_drop_stash: REPO_ANCHORED,
	scm_fetch: REPO_ANCHORED,
	scm_merge: REPO_ANCHORED,
	scm_pop_stash: REPO_ANCHORED,
	scm_pull: REPO_ANCHORED,
	scm_push: REPO_ANCHORED,
	scm_push_stash: REPO_ANCHORED,
	scm_rebase: REPO_ANCHORED,
	scm_remotes: REPO_ANCHORED,
	scm_rename_branch: REPO_ANCHORED,
	scm_reset_to_remote: REPO_ANCHORED,
	scm_stashes: REPO_ANCHORED,
	scm_status: REPO_ANCHORED,
	scm_sync: REPO_ANCHORED,
	scm_tags: REPO_ANCHORED,
	scm_undo_last_commit: REPO_ANCHORED,
	gerrit_install_hook: REPO_ANCHORED,
	gerrit_push_ref: REPO_ANCHORED,
	// The big-file viewers and the CAN analyzer.
	viewer_open: { args: ['path'] },
	viewer_backup: { args: ['path'] },
	indexed_open: { args: ['path'] },
	can_intervals: { args: ['path'] },
	can_log_open: { args: ['path'] },
	can_log_stats: { args: ['path'] },
	convert_can_log: { args: ['from', 'to'] },
	// The extension platform's own path surfaces (the backend confines these too —
	// this is the second lock on the same door).
	ext_fs: { args: ['path', 'to'] },
	ext_page_file_chunk: { args: ['path', 'repo'], relativeAllowed: true },
	ext_page_revision_bytes: { args: ['path', 'repo'], relativeAllowed: true },
	ext_install_from_vsix: { args: ['path'], sameRootOnly: true },
	// The boundary's own gates: opening anything NEW is not a remote session's to do.
	open_folder: { args: ['path'], sameRootOnly: true },
	open_workspace: { args: ['path'], sameRootOnly: true },
	open_single_file: { args: ['path'], sameRootOnly: true },
	// Path completion: the partial input may sit inside a root or be on its way to one.
	path_completions: { args: ['prefix'], prefixTowardRoot: true }
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
			if (rule.prefixTowardRoot && towardRoot(value, roots)) continue;
			if (rule.sameRootOnly || rule.prefixTowardRoot) {
				throw new Error(
					'a remote session cannot open new folders on this PC — open one from the PC, or spawn a sandboxed window'
				);
			}
			throw new Error(`${command}: ${value} is outside the folders this window has open`);
		}
	}
}
