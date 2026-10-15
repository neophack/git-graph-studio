// The transfer layer's desktop half (src/transfer.ts — 2026-10-13's rewrite): the native
// pickers drive `fs_import` / `fs_export` with streamed progress and the Cancel action,
// and the rows hide while a mirror viewer watches. This is the vitest over the tauriMock
// recording; the backend engine's own tests are cmd_fs's Rust suite, and the remote wire's
// tests live in remote.test.ts (the transport) and remoteMirror.test.ts (the viewer-side
// entries).
import { describe, expect, it, vi } from 'vitest';

import { setRemoteEnv } from '../src/remote/session';
import { provideHook } from '../src/platform/hooks';
import { installRemoteSessionHooks } from '../src/remote/desktopHooks';
import { backend, Channel } from './tauriMock';
import { flush, notifications } from './helpers';

// The cached mirror-viewer answer is host state nothing here drives — the platform hook is
// overridden with the switch in hand (the seam the transfer layer reads now).
const { mirrorRig } = vi.hoisted(() => ({ mirrorRig: { watching: false } }));
provideHook('mirror', {
	install: () => () => undefined,
	viewersActive: async () => mirrorRig.watching,
	viewersNow: () => mirrorRig.watching
});
// The remote-session hooks (the wire transport above all), as boot.ts installs them.
installRemoteSessionHooks();

interface ProgressEvent {
	name: string;
	bytes: number;
	total: number;
}

function scriptImport(result: { landed?: string[]; failed?: { name: string; error: string }[]; cancelled?: boolean }, events: ProgressEvent[] = []): void {
	backend.on('fs_import', (args) => {
		for (const event of events) (args.onProgress as Channel<ProgressEvent>).send(event);
		return result;
	});
}

describe('the transfer layer (desktop)', () => {
	it('an upload picks with the native dialog and lands through fs_import, progress streamed', async () => {
		backend.dialog.openResult = ['C:\\elsewhere\\notes.txt', 'C:\\elsewhere\\pack'] as unknown as string;
		let settle: ((value: unknown) => void) | null = null;
		backend.on('fs_import', (args) => {
			(args.onProgress as Channel<ProgressEvent>).send({ name: 'notes.txt', bytes: 4, total: 10 });
			return new Promise((resolve) => (settle = resolve));
		});
		const { uploadInto } = await import('../src/transfer');
		const picking = uploadInto('C:\\repo');
		await flush();
		// Mid-flight: the toast carries the streamed label and percent.
		const bar = document.querySelector<HTMLElement>('.notification .progress-track i')!;
		expect(document.querySelector('.notification .message')!.textContent).toContain('Uploading notes.txt');
		expect(bar.style.width).toBe('40%');
		settle!({ landed: ['C:\\repo\\notes.txt', 'C:\\repo\\pack'], failed: [], cancelled: false });
		await expect(picking).resolves.toEqual(['C:\\repo\\notes.txt', 'C:\\repo\\pack']);
		expect(backend.callsTo('fs_import')).toEqual([
			{ sources: ['C:\\elsewhere\\notes.txt', 'C:\\elsewhere\\pack'], targetDir: 'C:\\repo', onProgress: expect.any(Channel) }
		]);
		// The toast is done and removed; the count was notified.
		expect(document.querySelector('.progress-track')).toBeNull();
		expect(notifications().join('\n')).toContain('Uploaded 2 file(s)');
	});

	it('an upload the backend refuses is notified, never thrown', async () => {
		backend.dialog.openResult = 'C:\\elsewhere\\notes.txt';
		backend.on('fs_import', () => {
			throw new Error('the disk is full');
		});
		const { uploadInto } = await import('../src/transfer');
		await expect(uploadInto('C:\\repo')).resolves.toEqual([]);
		expect(notifications().join('\n')).toContain('the disk is full');
	});

	it('a mixed report notifies the failed names beside the landed count', async () => {
		backend.dialog.openResult = 'C:\\elsewhere\\notes.txt';
		scriptImport({ landed: ['C:\\repo\\notes.txt'], failed: [{ name: 'ghost.txt', error: 'no such file' }] });
		const { uploadInto } = await import('../src/transfer');
		await expect(uploadInto('C:\\repo')).resolves.toEqual(['C:\\repo\\notes.txt']);
		const text = notifications().join('\n');
		expect(text).toContain('ghost.txt');
		expect(text).toContain('Uploaded 1 file(s)');
	});

	it('the progress toast carries a Cancel that stops the job through fs_transfer_cancel', async () => {
		backend.dialog.openResult = 'C:\\elsewhere\\notes.txt';
		let settle: ((value: unknown) => void) | null = null;
		backend.on('fs_import', (args) => {
			(args.onProgress as Channel<ProgressEvent>).send({ name: 'notes.txt', bytes: 2, total: 10 });
			return new Promise((resolve) => (settle = resolve));
		});
		const { uploadInto } = await import('../src/transfer');
		const picking = uploadInto('C:\\repo');
		await flush();
		const cancel = document.querySelector<HTMLButtonElement>('.notification .buttons button');
		expect(cancel).not.toBeNull();
		expect(cancel!.textContent).toBe('Cancel');
		cancel!.click();
		settle!({ landed: [], cancelled: true });
		await picking;
		expect(backend.callsTo('fs_transfer_cancel')).toEqual([{}]);
	});

	it('a cancelled report notifies the cancel, not a failure', async () => {
		backend.dialog.openResult = 'C:\\elsewhere\\notes.txt';
		scriptImport({ landed: [], cancelled: true });
		const { uploadInto } = await import('../src/transfer');
		await expect(uploadInto('C:\\repo')).resolves.toEqual([]);
		expect(notifications().join('\n')).toContain('Transfer canceled');
	});

	it('a download names its destination through the save dialog and exports', async () => {
		backend.dialog.saveResult = 'C:\\Users\\me\\Desktop\\pack.zip';
		let settle: ((value: unknown) => void) | null = null;
		backend.on('fs_export', (args) => {
			(args.onProgress as Channel<ProgressEvent>).send({ name: 'pack.zip', bytes: 5, total: 5 });
			return new Promise((resolve) => (settle = resolve));
		});
		const { downloadTo } = await import('../src/transfer');
		const exporting = downloadTo('C:\\repo\\pack', true);
		await flush();
		expect(document.querySelector('.notification .message')!.textContent).toContain('Downloading pack.zip');
		settle!({ landed: ['C:\\Users\\me\\Desktop\\pack.zip'], failed: [], cancelled: false });
		await expect(exporting).resolves.toBe(true);
		expect(backend.callsTo('fs_export')).toEqual([
			{ path: 'C:\\repo\\pack', dest: 'C:\\Users\\me\\Desktop\\pack.zip', zip: true, onProgress: expect.any(Channel) }
		]);
		expect(notifications().join('\n')).toContain('Downloaded pack.zip');
	});

	it('a cancelled picker is silent — no transfer, no toast', async () => {
		backend.dialog.openResult = null;
		backend.dialog.saveResult = null;
		const { uploadInto, downloadTo } = await import('../src/transfer');
		await expect(uploadInto('C:\\repo')).resolves.toEqual([]);
		await expect(downloadTo('C:\\repo\\a.txt')).resolves.toBe(false);
		expect(backend.callsTo('fs_import')).toEqual([]);
		expect(backend.callsTo('fs_export')).toEqual([]);
		expect(notifications()).toEqual([]);
	});

	it('the transfer rows hide while a mirror viewer watches, on the desktop alone', async () => {
		const { transferMenuShown } = await import('../src/transfer');
		expect(transferMenuShown()).toBe(true);
		mirrorRig.watching = true;
		expect(transferMenuShown()).toBe(false);
		// A browser session's own UI keeps them whatever watches the PC's window.
		setRemoteEnv({ transport: {} as never, attached: { frontendId: 'remote/1' } as never, basePath: '/' });
		expect(transferMenuShown()).toBe(true);
		setRemoteEnv(undefined);
		mirrorRig.watching = false;
		expect(transferMenuShown()).toBe(true);
	});

	it('a remote session rides the wire transport instead of the desktop commands', async () => {
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
		// Warm the lazy transport first (the vm pool's in-src dynamic import needs the
		// module in the runner's cache to settle promptly), then drive the wrapper.
		await import('../src/remote/transfer');
		const { uploadInto } = await import('../src/transfer');
		const picking = uploadInto('C:\\repo');
		for (let i = 0; i < 20 && !document.querySelector('input[type=file]'); i++) await flush();
		const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
		Object.defineProperty(input, 'files', { value: [new File(['abc'], 'one.txt')] });
		input.dispatchEvent(new Event('change'));
		await expect(picking).resolves.toEqual(['C:\\repo\\one.txt']);
		expect(offsets).toEqual([{ path: 'C:\\repo\\one.txt', size: 3 }]);
		// The desktop commands never ran: the browser session's writes stay confined to
		// the wire's own chunked path.
		expect(backend.callsTo('fs_import')).toEqual([]);
	});
});
