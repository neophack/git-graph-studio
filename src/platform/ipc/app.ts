// The typed IPC seam of the app-domain commands (plan §5.6): the boot handshakes, the
// window/folder lifecycle and the instance-level actions. The backend halves live in the
// app crate's boot/window adapters; the names are the wire contract check-ipc.mjs reads.
import { invoke } from './core';

/** One queued startup action `boot_context` hands the workbench (a diff to open, a file
 *  to reveal — the `--diff` / `--file` command-line forms). */
export interface BootAction {
	type: string;
	left?: string;
	right?: string;
	path?: string;
}

/** A root the window opened: the folder path and whether it carries a `.git`. */
export interface OpenedRoot {
	root: string;
	isRepo: boolean;
}

/** `boot_context`: what the window booted with — the launch file, the queued startup
 *  actions, the open repo/workspace, and whether an app-level reload re-seeded them. */
export interface BootContext {
	file: string | null;
	actions: BootAction[];
	repo: string | null;
	workspace: string | null;
	reloaded: boolean;
	opened: OpenedRoot | null;
	openedFor: string | null;
	/** The window's current roots with per-root repo-ness — the restore set a frontend
	 *  that did not open them itself applies (a remote session, whose `open_folder` the
	 *  path gate refuses). */
	roots: OpenedRoot[];
	/** The `.ggs-workspace` file the current roots came from, if any. */
	workspaceFile: string | null;
}

export const bootStage = (stage: string, pageMs: number) => invoke<void>('boot_stage', { stage, pageMs });
/** The page's answer to the backend's liveness probe (window.rs's sweep): proof the page is
 *  alive, which stands the reload decision down. */
export const webviewBeat = () => invoke<void>('webview_beat');
/** The close handler's first word (boot.ts), before any await: proof the page is alive and
 *  handling the request, so the backend's close watchdog leaves the window to it — a dead
 *  page cannot ack, and Rust then performs the close itself. */
export const windowCloseAck = () => invoke<void>('window_close_ack');
export const bootContext = () => invoke<BootContext>('boot_context');
export const postFirstPaint = () => invoke<void>('post_first_paint');
export const openDevtools = () => invoke<void>('open_devtools');
export const appNewInstance = (folder?: string) => invoke<void>('app_new_instance', folder === undefined ? undefined : { folder });
export const openFolder = (path: string) => invoke<OpenedRoot>('open_folder', { path });
export const openWorkspace = (path: string) => invoke<{ roots: OpenedRoot[] }>('open_workspace', { path });
export const openSingleFile = (path: string) => invoke<void>('open_single_file', { path });
export const closeFolder = () => invoke<void>('close_folder');
