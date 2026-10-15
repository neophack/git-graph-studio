// The typed IPC seam of the remote access host (plan §5.6): the mirror viewer's fit and
// focus, the host's status and hide, and the summary a frontend reports — the app's
// remote_host half behind the commands/remote adapters. The remote session's own wire
// (tauriShim) keeps its direct invokes: its tests drive the transport through the shim.
import { invoke } from './core';

/** What `remote_host_status` reports about the desktop host. */
export interface RemoteHostStatus {
	folders?: string[];
	remoteHostOnly?: boolean;
}

export const remoteHostStatus = () => invoke<RemoteHostStatus>('remote_host_status');
export const remoteHostHideMain = () => invoke<void>('remote_host_hide_main');
export const remoteHostSetSummary = (frontend: string, summary: unknown) =>
	invoke<void>('remote_host_set_summary', { frontend, summary });
export const remoteMirrorFit = (width: number, height: number) => invoke<void>('remote_mirror_fit', { width, height });
export const remoteMirrorFocus = (enabled: boolean) => invoke<void>('remote_mirror_focus', { enabled });
