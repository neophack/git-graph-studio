// The remote trust boundary's path rule (docs/ggs-remote-plan.md §23.4, the 2026-10-13
// audit's F1): a browser session drives the workbench, but its file reads and writes land
// inside the open folders only — `~/.ggs` (settings, provider keys, Claude state) and the
// rest of the disk are not a remote session's to touch through app commands. The one
// exception is the extension platform's own surface: `ext_fs` may also reach the installed
// packages' files, the extensions' storage and their logs (the same roots the backend's
// `ext_fs` contract allows — an extension reading its own bundled files, as Python's
// `pythonrc.py` copy does at activation, is ordinary traffic, not a boundary crossing);
// `remote_ext_roots` names those areas. The desktop
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
		// The POSIX root holds every absolute path — the generic check below would compare
		// against a doubled slash and match nothing (or a '//…' form and match wrong).
		if (stem === '/') return form.startsWith('/');
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

/** The absolute form a relativeAllowed value resolves to: the backend joins it against
 *  the (gated) `repo` argument — or the first open root when none rides along — and reads
 *  or writes the joined path raw, so a `..` segment climbs OUT of that base. `null` when
 *  the pair does not resolve to an absolute form at all. */
function resolveRelative(value: string, record: Record<string, unknown>, roots: string[]): string | null {
	const repo = record.repo;
	const base = typeof repo === 'string' && repo !== '' ? repo : roots[0];
	if (!base) return null;
	return absoluteForm(`${base.replace(/\\/g, '/')}/${value.replace(/\\/g, '/')}`);
}

/** The commands whose arguments name filesystem paths, by argument name (the JS/camelCase
 *  spelling the invoke carries — the Rust side spells them snake_case). `relativeAllowed`
 *  marks args the backend resolves against the (gated) `repo` argument — for the rest, a
 *  relative path would resolve against a working directory outside the roots and is
 *  refused. `sameRootOnly` marks the commands that would WIDEN the boundary (opening a
 *  new folder or single file makes it a root); `prefixTowardRoot` marks the completion
 *  command, whose partial input may also be on its way TO a root. `extensionRoots` marks
 *  the one surface whose paths may also land inside the extension platform's own areas
 *  (installed packages, their storage, their logs) — the same roots the backend's `ext_fs`
 *  contract allows. The table is the
 *  extraction of every `#[tauri::command]` with String path-like parameters — a command
 *  missing here is a hole, so extend it with the command, not around it. */
export const PATH_GATED: Record<
	string,
	{
		args: string[];
		relativeAllowed?: boolean;
		sameRootOnly?: boolean;
		prefixTowardRoot?: boolean;
		extensionRoots?: boolean;
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
	// The workspace-wide replace (2026-10-16 audit of the command surface): it rewrites
	// every matching file under `repo` — without this entry the gate let a session name
	// any absolute path as the tree to rewrite.
	replace_in_files: REPO_ANCHORED,
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
	// The Explorer drop's copy-in (2026-10-16 audit of the command surface): the desktop
	// drag-drop's `sources` may come from anywhere on the machine, but a REMOTE session
	// reaching anywhere on the machine is the exfiltration chain the boundary exists to
	// stop (copy `~/.ggs/keys/ai-providers.key` into the workspace, then read it). Both
	// ends stay inside the open folders — copying between two folders of one machine is
	// the system file manager's job (the same reasoning that retired fs_import/fs_export).
	copy_into: { args: ['sources', 'dest_dir'] },
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
	ext_fs: { args: ['path', 'to'], extensionRoots: true },
	ext_page_file_chunk: { args: ['path', 'repo'], relativeAllowed: true },
	ext_page_revision_bytes: { args: ['path', 'repo'], relativeAllowed: true },
	ext_install_from_vsix: { args: ['path'], sameRootOnly: true },
	// The boundary's own gates: opening anything NEW is not a remote session's to do. The
	// idempotent reopen of a workspace or single file already inside the open roots stays
	// allowed (`sameRootOnly`); a plain folder's reopen rides `boot_context`'s roots answer
	// instead (a session never invokes `open_folder` — REFUSED below).
	open_workspace: { args: ['path'], sameRootOnly: true },
	open_single_file: { args: ['path'], sameRootOnly: true },
	// Path completion: the partial input may sit inside a root or be on its way to one.
	path_completions: { args: ['prefix'], prefixTowardRoot: true }
};

/** The commands a remote session may not run at all. Three groups (docs/remote-client-plan.md
 *  §3.3, the R0 tightening):
 *
 *  1. Boundary wideners: `open_folder` widens the very boundary this gate enforces (a remote
 *     open of an arbitrary folder would make everything under it "the open workspace") — a
 *     session's roots arrive with ATTACH and `boot_context`, never through its own invoke;
 *     `app_new_instance` would spawn a sibling process the session then cannot name. Opening
 *     NEW windows is what the picker's sandboxed SPAWN is for.
 *  2. The PC's machine-level integrations, which a browser session must never reach: the
 *     settings file (`settings_write` — a session's settings are its device's own), the OS
 *     "open with" registrations (`assoc_apply`, `context_menu_apply`) and the bridged
 *     claude-code shell refresh (`providers_shell_refresh`, which rewrites the spawn
 *     environment from the settings). (`user_path_apply` is no command at all — it runs at
 *     boot inside the backend — so it needs no gate entry.)
 *  A remote session's transfers ride the confined wire commands — the chunked
 *  `fs_write_chunk` uploads (root-canonicalized server-side) and the daemon's
 *  `download_allowed` ticket downloads. (The desktop's `fs_import` / `fs_export` pair was
 *  deleted outright on 2026-10-15, K16 — its commands no longer exist to refuse.) */
export const REFUSED_COMMANDS = new Set<string>([
	'open_folder',
	'app_new_instance',
	'settings_write',
	'assoc_apply',
	'context_menu_apply',
	'providers_shell_refresh'
]);

/** Whether the command needs the roots fetched at all — the cheap pre-check that keeps
 *  the untimed majority of invokes free of the policy round trip. */
export function isPathGated(command: string): boolean {
	return REFUSED_COMMANDS.has(command) || PATH_GATED[command] !== undefined;
}

/** The canonical (symlink-resolved) form of a path, as the backend's
 *  `remote_canonical_paths` spells it: forward slashes, the Windows drive letter
 *  lower-cased, the extended-length prefixes (`\\?\C:\…`, `\\?\UNC\server\…`) stripped —
 *  `null` when the backend answers nothing (a path outside the boundary's own areas — the
 *  command's confinement — or one that cannot resolve at all). A symlink's canonical form
 *  is its target's — the fact the lexical gate cannot see; a missing tail resolves
 *  through its nearest existing ancestor, so a symlinked ancestor of a not-yet-created
 *  file is caught exactly like an existing one. */
export function canonicalForm(path: string, canonicalize: (candidate: string) => string | null): string | null {
	const canonical = canonicalize(path);
	if (canonical === null) return null;
	let text = canonical.replace(/\\/g, '/');
	const unc = text.match(/^\/\/\?\/UNC\/(.+)/);
	if (unc) return `//${unc[1]}`;
	const extended = text.match(/^\/\/\?\/([a-zA-Z]:\/.*)/);
	if (extended) text = extended[1];
	// A drive form keeps its (now prefix-free) spelling, drive letter lower-cased.
	if (/^[a-zA-Z]:\//.test(text)) return text[0].toLowerCase() + text.slice(1);
	return text.startsWith('/') ? text : null;
}

/** The gate's policy: the open folders (plus a single-file launch) and, for the rules
 *  that mark `extensionRoots`, the extension platform's own areas. */
export interface GatePolicy {
	roots: string[];
	extRoots?: string[];
}

/** One batch canonicalization for a whole argument set, riding the backend's
 *  `remote_canonical_paths` — the same `fs` resolution the reads and writes themselves
 *  follow. Answers positionally; a rejected promise fails the gate (closed). */
export type Canonicalizer = (paths: string[]) => Promise<(string | null)[]>;

/** The symlink-proof re-check (docs/ggs-remote-plan.md §23.6, the 2026-10-15 follow-up to
 *  the audit's F1): every absolute path argument that passed the lexical gate must ALSO
 *  resolve to a location that passes it — `fs` follows symlinks and junctions, so a
 *  repository entry linking to `~/.ggs` (the provider key store, the settings) passes
 *  lexically while its reads land outside. The batch canonicalizes the arguments AND the
 *  policy roots, and containment compares canonical against canonical: a workspace the
 *  desktop opened through a junction still contains its members' canonical forms. A
 *  `null` form (no answer — the backend's confinement or an unresolvable path) keeps its
 *  lexical answer; every resolved form must sit inside the resolved roots. Runs after
 *  `gateInvoke`, never instead of it. */
export async function gateInvokeCanonical(
	command: string,
	args: Record<string, unknown> | undefined,
	policy: GatePolicy,
	canonicalize: Canonicalizer
): Promise<void> {
	const rule = PATH_GATED[command];
	if (!rule) return;
	const record = args ?? {};
	// The ext areas widen exactly the rules the lexical gate widens them for.
	const lexicalRoots = rule.extensionRoots ? [...policy.roots, ...(policy.extRoots ?? [])] : policy.roots;
	// What each argument's check reads: the absolute value itself, or — for a
	// relativeAllowed rule's relative value — the form the backend will actually read,
	// joined against the (gated) repo. Relative values of every other rule never reach
	// here (the lexical gate refused them first).
	const entries: { name: string; spell: string }[] = [];
	for (const name of rule.args) {
		const value = record[name];
		if (value === undefined || value === null) continue;
		// An array argument (copy_into's `sources`) gates every string member the same
		// way — one outside value refuses the whole invoke.
		for (const item of Array.isArray(value) ? value : [value]) {
			if (typeof item !== 'string') continue;
			if (absoluteForm(item) !== null) {
				entries.push({ name, spell: item });
				continue;
			}
			if (rule.relativeAllowed && name !== 'repo') {
				const resolved = resolveRelative(item, record, policy.roots);
				if (resolved !== null) entries.push({ name, spell: resolved });
			}
		}
	}
	if (entries.length === 0) return;
	const spelled = [...new Set([...entries.map((entry) => entry.spell), ...lexicalRoots])];
	let forms: (string | null)[];
	try {
		forms = await canonicalize(spelled);
	} catch {
		throw new Error(`${command}: the path check could not resolve its paths — refused`);
	}
	const formOf = new Map<string, string | null>();
	spelled.forEach((spell, at) => formOf.set(spell, forms[at] ?? null));
	const canonicalRoots = lexicalRoots.map((root) => formOf.get(root) ?? root);
	const resolvesOutside = (spell: string): string | null => {
		const form = formOf.get(spell) ?? null;
		if (form === null) return null; // does not exist yet: the lexical answer stands
		if (withinRoots(form, canonicalRoots)) return null;
		if (rule.prefixTowardRoot && towardRoot(form, canonicalRoots)) return null;
		return form;
	};
	for (const { name, spell } of entries) {
		const form = resolvesOutside(spell);
		if (form === null) continue;
		if (rule.sameRootOnly || rule.prefixTowardRoot) {
			throw new Error(
				'a remote session cannot open new folders on this PC — open one from the PC, or spawn a sandboxed window'
			);
		}
		throw new Error(`${command}: ${record[name] as string} resolves to ${form}, outside the folders this window has open`);
	}
}/** Check one invoke's arguments against the roots; throws the message the session sees.
 *  `extRoots` are the extension platform's own areas (`remote_ext_roots`), applied only to
 *  the rules that mark `extensionRoots` — the extension host passes an installed package's
 *  own files, its storage and its log directory as `ext_fs` paths (an activation reading
 *  its bundled files is ordinary traffic), while every other command keeps the open
 *  folders alone. */
export function gateInvoke(
	command: string,
	args: Record<string, unknown> | undefined,
	roots: string[],
	extRoots: string[] = []
): void {
	if (REFUSED_COMMANDS.has(command)) {
		throw new Error(`${command} is the desktop's own — a remote session cannot run it`);
	}
	const rule = PATH_GATED[command];
	if (!rule) return;
	const allowed = rule.extensionRoots ? [...roots, ...extRoots] : roots;
	const record = args ?? {};
	for (const name of rule.args) {
		const value = record[name];
		if (value === undefined || value === null) continue;
		// An array argument (copy_into's `sources`) checks every string member: one
		// outside value refuses the whole invoke.
		for (const item of Array.isArray(value) ? value : [value]) {
			if (typeof item !== 'string') continue;
			const absolute = absoluteForm(item) !== null;
			if (!absolute) {
				if (rule.relativeAllowed && name !== 'repo') {
					// A relative value is not a free pass: the backend joins it against the
					// (gated) repo and reads raw, so confine the joined form like any path.
					const resolved = resolveRelative(item, record, roots);
					if (resolved === null || !withinRoots(resolved, allowed)) {
						throw new Error(`${command}: ${item} is outside the folders this window has open`);
					}
					continue;
				}
				throw new Error(`${command}: ${name} must be an absolute path inside the open folders`);
			}
			if (!withinRoots(item, allowed)) {
				if (rule.prefixTowardRoot && towardRoot(item, allowed)) continue;
				if (rule.sameRootOnly || rule.prefixTowardRoot) {
					throw new Error(
						'a remote session cannot open new folders on this PC — open one from the PC, or spawn a sandboxed window'
					);
				}
				throw new Error(`${command}: ${item} is outside the folders this window has open`);
			}
		}
	}
}
