// The remote workbench's session: the one Transport and what ATTACHED told it. The Tauri
// shims (src/remote/tauriShim/) reach the backend only through here; boot.ts installs it
// before the workbench module loads. On the desktop nothing sets it — `remoteEnv()` answers
// undefined and every shared module takes its desktop path.
import type { Attached, Transport } from './transport';

export interface RemoteEnv {
	transport: Transport;
	attached: Attached;
	/** The daemon base path (`/`, or `/u/<uuid>/` through a Hub). */
	basePath: string;
}

let env: RemoteEnv | undefined;

export function setRemoteEnv(next: RemoteEnv | undefined): void {
	env = next;
	(globalThis as { __GGS_REMOTE__?: RemoteEnv }).__GGS_REMOTE__ = next;
}

/** The remote session, when this workbench runs in a browser rather than in the app. */
export function remoteEnv(): RemoteEnv | undefined {
	return env ?? (globalThis as { __GGS_REMOTE__?: RemoteEnv }).__GGS_REMOTE__;
}

export function transport(): Transport {
	const current = remoteEnv();
	if (!current) throw new Error('the remote transport is not connected');
	return current.transport;
}

/** This frontend's id in the instance's eyes: `main` on the desktop, `remote/<n>` here. */
export function frontendId(): string {
	return remoteEnv()?.attached.frontendId ?? 'main';
}

/** Whether a backend host request addressed to `frontend` is this frontend's to answer
 *  (§8.6 #1): the desktop answers `main`; a remote page answers what the Relay handed it
 *  — `remote/<its session>` or the remote side at large — the Relay already picked the
 *  one session. */
export function addressedHere(frontend: string): boolean {
	return remoteEnv() ? frontend === 'remote' || frontend.startsWith('remote/') : frontend === 'main';
}

/** The frontend class a backend host request addresses (§8.6 #1): `main` or `remote`. */
export function frontendClass(): 'main' | 'remote' {
	return remoteEnv() ? 'remote' : 'main';
}
