// The activation-settled flush hook: the hosts call `__ggsFlushRegistrations`
// once an activation settles, crossing the queued command registrations and
// output-channel lines as single batched requests.

import type { ShimState } from './state';

export function installFlushHook(s: ShimState): void {
	(globalThis as { __ggsFlushRegistrations?: () => void }).__ggsFlushRegistrations = () => {
		s.flushCommandRegistrations();
		s.flushOutputLines();
	};
}
