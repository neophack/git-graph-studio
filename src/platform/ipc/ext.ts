// The typed IPC seam of the extension store domain (plan §5.6): listing, installing
// (VSIX / bundled), uninstalling, reading a package's files, the bounded loadable-code
// map, storage/log paths, the Node environment facts, the workspace-confined fs api and
// the pages' revision/window byte services — the ggs-ext crate's store/vsix/fsapi halves
// behind the app's cmd_ext adapters.
import { invoke } from './core';

/** The `ggs` key declaration a package installed from one carries. */
export interface StudioManifest {
	format: string;
	id: string;
	version: string;
	/** The process backend declaration the install derived for this package — `ext_process.rs`
	 *  spawns it on demand. `protocol` names the one wire protocol (`ggs-ext/1` when absent;
	 *  anything else fails the start with an upgrade hint); `binaries` is the per-platform
	 *  command map, when the package carries more than one platform's binary. */
	backend?: { kind: string; command: string; args?: string[]; protocol?: string; binaries?: Record<string, string> } | null;
}

/** One installed (or bundled-not-yet-installed) package, as `ext_list` answers. */
export interface ExtInfo {
	id: string;
	name: string;
	displayName: string | null;
	publisher: string;
	version: string;
	description: string;
	builtin: boolean;
	icon: string | null;
	path: string;
	categories: string[];
	keywords: string[];
	repository: string | null;
	license: string | null;
	enginesVscode: string | null;
	extensionDependencies: string[];
	extensionPack: string[];
	/** README / CHANGELOG file names inside the install, when present (the detail page renders them). */
	readme: string | null;
	changelog: string | null;
	/** `bundled` (a not-yet-installed package the installer ships) or `vsix`. */
	format: 'bundled' | 'vsix' | 'ggs';
	/** The packer's page bundle (`webview/index.js`) is present in the install — the prewarm
	 *  fetches it only then (otherwise the fetch is a guaranteed 404: silent under the
	 *  desktop's `ggs://` protocol, one red console line per package in a browser session).
	 *  Optional because older `ext_list` recordings predate it. */
	pageBundle?: boolean;
	/** The extension's webview pages are per-frontend instances: every frontend (the
	 *  desktop window, a remote phone) runs its OWN page of the view — its own size, its own
	 *  scroll, nothing shared with the PC's copy — and the backend's pushes reach each.
	 *  Optional because older `ext_list` recordings predate it. */
	perFrontendWebviews?: boolean;
	/** The `ggs` key declaration, for packages installed from one. */
	capabilities: StudioManifest | null;
}

/** `ext_load_code`: the package's bounded loadable-code map the frame's CommonJS
 *  resolver resolves against. */
export interface ExtLoadCode {
	files: Record<string, string>;
	truncated: boolean;
	binaries?: string[];
	blobFiles?: Record<string, string>;
}

/** `ext_storage_paths`: where a package's global/workspace state and log live. */
export interface ExtStoragePaths {
	global: string;
	workspace?: string | null;
	log: string;
}

/** The Node environment facts the frame's `os`/`process` shims carry (`ext_node_env`). */
export interface NodeEnv {
	platform: string;
	arch: string;
	homedir: string;
	tmpdir: string;
	hostname: string;
	release: string;
	eol: string;
	separator: string;
	delimiter: string;
	/** The host's real environment (`process.env`) — tool discovery reads it. */
	env?: Record<string, string>;
	[key: string]: unknown;
}

export const extList = () => invoke<ExtInfo[]>('ext_list');
export const extInstallFromVsix = (path: string) => invoke<ExtInfo>('ext_install_from_vsix', { path });
export const extInstallBundled = (extId: string) => invoke<ExtInfo>('ext_install_bundled', { extId });
export const extUninstall = (extId: string) => invoke<void>('ext_uninstall', { extId });
export const extReadFile = (extId: string, relPath: string) => invoke<string>('ext_read_file', { extId, relPath });
export const extReadFileBase64 = (extId: string, relPath: string) => invoke<string>('ext_read_file_base64', { extId, relPath });
export const extLoadCode = (extId: string) => invoke<ExtLoadCode>('ext_load_code', { extId });
export const extStoragePaths = (extId: string, workspace: string | null) => invoke<ExtStoragePaths | null>('ext_storage_paths', { extId, workspace });
export const extLogPath = () => invoke<string>('ext_log_path');
export const extLogAppend = (lines: string[]) => invoke<void>('ext_log_append', { lines });
export const extNodeEnv = () => invoke<NodeEnv>('ext_node_env');
/** The workspace-confined fs api the frames' `fs` shim rides: one op word, the roots the
 *  package may touch, and the op's operands. */
export const extFs = (op: string, roots: string[], path: string | null, to?: string | null, data?: string | null) =>
	invoke<unknown>('ext_fs', { op, roots, path, to, data });
/** The pages' revision/window byte services (the `__revisionFileBytes` / `__fileChunk`
 *  halves of the generic page services). */
export const extPageRevisionBytes = (roots: string[], repo: string, revision: string, path: string) =>
	invoke('ext_page_revision_bytes', { roots, repo, revision, path });
export const extPageFileChunk = (roots: string[], repo: string, path: string, offset: number, len: number) =>
	invoke('ext_page_file_chunk', { roots, repo, path, offset, len });
