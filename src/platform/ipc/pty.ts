// The typed IPC seam of the Integrated Terminal (plan §5.6): session creation (the
// shell a new terminal opens rides every pty_create, so the Terminal Shell setting
// reaches the next terminal without a restart), writes, resizes and kills — the app's
// pty.rs over portable-pty behind the commands/pty adapters.
import { invoke } from './core';

export const ptyCreate = (id: number, cols: number, rows: number, shell: string) =>
	invoke<string>('pty_create', { id, cols, rows, shell });
export const ptyWrite = (id: number, data: string) => invoke<void>('pty_write', { id, data });
export const ptyResize = (id: number, cols: number, rows: number) => invoke<void>('pty_resize', { id, cols, rows });
export const ptyKill = (id: number) => invoke<void>('pty_kill', { id });
/** The session's recent output, at most the backend's 64 KB tail - the catch-up replay a
 *  frontend re-taking its output subscription writes first (docs/remote-client-plan.md
 *  §6.6: the terminal page's follow). */
export const ptyTail = (id: number) => invoke<string>('pty_tail', { id });
/** One live terminal as `pty_list` answers it - the session-sync vocabulary (docs/
 *  ggs-remote-plan.md §8.6 #5): a frontend's terminal page adopts the terminals that
 *  already run in the instance (the PC's, from a remote session) instead of spawning
 *  its own beside them. */
export interface PtySessionInfo {
	id: number;
	name: string;
}
export const ptyList = () => invoke<PtySessionInfo[]>('pty_list');
