// The desktop window's door for remote viewers: one event listener at boot, and the replica
// host (host.ts — the recorder, the input replay) loads only when the first viewer says
// hello, so the desktop's first paint carries none of it. The window keeps its desktop
// shell at every size (docs/remote-client-plan.md §11): a phone runs its own workbench, it
// is never mirrored onto the window.

import { listen } from '../../platform/ipc/core';
import { MIRROR_UP, type UpMessage } from './protocol';

let host: Promise<import('./host').MirrorHost> | null = null;

/** Whether a remote viewer is watching this window right now (silent ones dropped first). */
export async function mirrorViewersActive(): Promise<boolean> {
	if (!host) return false;
	const ready = await host;
	ready.prune();
	return ready.viewerCount > 0;
}

/** The last answer `mirrorViewersActive` gave, without the await: refreshed on every up
 *  message and on a slow interval, so a synchronous decision (the Explorer building its
 *  context menu) never waits on the host. A viewer that just said hello lands here within
 *  one message; the menu follows the last settled state. */
let viewersWatching = false;

function refreshViewers(): void {
	void mirrorViewersActive().then((active) => (viewersWatching = active));
}

/** Whether a mirror viewer watches this window (the cached, synchronous form). */
export function mirrorViewersNow(): boolean {
	return viewersWatching;
}

export function installMirrorHost(): () => void {
	let unlisten: (() => void) | null = null;
	let stopped = false;
	// The cached viewer answer stays fresh: every up message refreshes it, and a slow poll
	// catches a viewer going silent between messages (the host prunes at 5 s).
	const poll = setInterval(refreshViewers, 5000);
	void listen<UpMessage>(MIRROR_UP, (event) => {
		const message = event.payload;
		host ??= import('./host').then(({ createAppMirrorHost }) => createAppMirrorHost());
		void host.then((ready) => ready.receive(message));
		refreshViewers();
	})
		.then((stop) => {
			if (stopped) stop();
			else unlisten = stop;
		})
		.catch(() => undefined);
	return () => {
		stopped = true;
		clearInterval(poll);
		unlisten?.();
	};
}
