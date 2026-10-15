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
