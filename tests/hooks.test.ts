// The platform hooks (plan §5.5): every extension point answers its desktop default until
// an installer replaces it, and a replacement is what later lookups see. The remote
// implementations themselves are exercised where they always were (remoteResponsive,
// remote, transfer, extensions); this file pins the registry's contract.

import { afterEach, describe, expect, it } from 'vitest';

import { hook, provideHook } from '../src/platform/hooks';
import { installDesktopRemoteHooks, installRemoteSessionHooks } from '../src/remote/desktopHooks';

const installed: (typeof import('../src/platform/hooks'))['provideHook'][] = [];

afterEach(() => {
	// Re-install the desktop set the test setup put in place, so one test's override never
	// leaks into the next (the registry is module state).
	installDesktopRemoteHooks();
	void installed.splice(0);
});

describe('platform hooks', () => {
	it('answers the desktop defaults', () => {
		installDesktopRemoteHooks();
		expect(hook('editLock').defaultLocked()).toBe(false);
		expect(hook('navigation').phoneShell()).toBe(false);
		expect(hook('navigation').fullScreenSideViewOpen()).toBe(false);
		expect(hook('openThreshold')(3 * 1024 * 1024)).toBe(3 * 1024 * 1024);
		expect(hook('assetUrl')('icons/x.svg')).toBe('ggs://localhost/icons/x.svg');
		expect(hook('session').remote()).toBe(false);
		expect(hook('session').frontendId()).toBe('main');
		expect(hook('session').frontendClass()).toBe('main');
		expect(hook('session').addressedHere('main')).toBe(true);
		expect(hook('session').addressedHere('remote/1')).toBe(false);
		expect(hook('webviewStreams')).not.toBeNull(); // the desktop shares its webviews
		expect(hook('mirror')).not.toBeNull(); // the desktop is the watched side
		expect(hook('workbenchSync')).toBeTypeOf('function');
		expect(typeof hook('summaryReporter')).toBe('function');
	});

	it('a replacement is what later lookups see', () => {
		provideHook('openThreshold', () => 512 * 1024);
		expect(hook('openThreshold')(3 * 1024 * 1024)).toBe(512 * 1024);
		provideHook('session', { remote: () => true, frontendId: () => 'remote/3', frontendClass: () => 'remote', addressedHere: () => true });
		expect(hook('session').remote()).toBe(true);
		expect(hook('session').frontendId()).toBe('remote/3');
	});

	it('the remote session set installs over the desktop set', () => {
		installRemoteSessionHooks();
		// Without a session env the installed session answers the desktop shape (the same
		// module answers both builds); the transfer wire it provides resolves the module.
		expect(hook('session').remote()).toBe(false);
		expect(hook('transferWire')).toBeTypeOf('function');
		expect(hook('mirror')).not.toBeNull(); // the desktop set's bridge stands until replaced
	});
});
