// The transfer layer (src/features/explorer/transfer.ts): the remote wire's half — the
// chunked uploads and ticket downloads a browser session rides (K16,
// docs/remote-client-plan.md §11: upload and download are the browser's own; the desktop's
// native-picker pair left with its commands on 2026-10-15, so this suite no longer
// scripts `fs_import` / `fs_export` at all). The remote wire's transport tests live in
// remote.test.ts, the viewer-side entries' story in the mirror suites.
import { describe, expect, it, vi } from 'vitest';

import { setRemoteEnv } from '../src/remote/session';
import { provideHook } from '../src/platform/hooks';
import { installRemoteSessionHooks } from '../src/remote/desktopHooks';
import { backend } from './tauriMock';
import { flush, notifications } from './helpers';

// The remote-session hooks (the wire transport above all), as boot.ts installs them.
installRemoteSessionHooks();

describe('the transfer layer (the remote wire)', () => {
	it('a remote session rides the wire transport, never a desktop command', async () => {
		const offsets: unknown[] = [];
		const fakeTransport = {
			call: (cmd: string, args: unknown) => {
				if (cmd === 'fs_upload_offset') {
					offsets.push(args);
					return Promise.resolve(0);
				}
				return Promise.resolve(0);
			}
		};
		setRemoteEnv({ transport: fakeTransport as never, attached: { instance: 'ggs-1', frontendId: 'remote/1' } as never, basePath: '/' });
		try {
			// Warm the lazy transport first (the vm pool's in-src dynamic import needs the
			// module in the runner's cache to settle promptly), then drive the wrapper.
			await import('../src/remote/transfer');
			const { uploadInto } = await import('../src/features/explorer');
			const picking = uploadInto('C:\\repo');
			for (let i = 0; i < 20 && !document.querySelector('input[type=file]'); i++) await flush();
			const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
			Object.defineProperty(input, 'files', { value: [new File(['abc'], 'one.txt')] });
			input.dispatchEvent(new Event('change'));
			await expect(picking).resolves.toEqual(['C:\\repo\\one.txt']);
			expect(offsets).toEqual([{ path: 'C:\\repo\\one.txt', size: 3 }]);
			// The retired desktop pair never runs even by name: its commands no longer exist.
			expect(backend.callsTo('fs_import')).toEqual([]);
			expect(backend.callsTo('fs_export')).toEqual([]);
			expect(backend.callsTo('fs_transfer_cancel')).toEqual([]);
		} finally {
			setRemoteEnv(undefined);
		}
	});

	it('a frontend with no wire (the desktop app) answers empty — no picker, no toast', async () => {
		provideHook('transferWire', null);
		try {
			const { uploadInto, downloadTo } = await import('../src/features/explorer');
			await expect(uploadInto('C:\\repo')).resolves.toEqual([]);
			await expect(downloadTo('C:\\repo\\a.txt')).resolves.toBe(false);
			expect(notifications()).toEqual([]);
			expect(backend.calls.filter((call) => call.command.startsWith('fs_') && call.command.includes('transfer'))).toEqual([]);
		} finally {
			provideHook('transferWire', () => import('../src/remote/transfer'));
		}
	});
});
