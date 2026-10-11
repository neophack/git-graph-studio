// The daemon fixture every Remote Access browser spec shares (docs/ggs-remote-plan.md §17.4):
// a hermetic ggs-remote on a random loopback port — nothing of the user's ~/.ggs/remote is
// touched — with its password set, plus the same for the hub when a spec needs the relay's
// pages. The daemon-only specs need no GGS instance; the workbench spec boots one and is
// gated behind GGS_REMOTE_E2E_FULL because it needs the built app.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { test as base, expect } from '@playwright/test';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
export const daemonExe = process.env.GGS_REMOTE_DAEMON_EXE ?? resolve(root, 'extensions-src/ggs-remote/daemon/target/release', `ggs-remote${exe}`);
export const hubExe = process.env.GGS_REMOTE_HUB_EXE ?? resolve(root, 'extensions-src/ggs-remote/hub/target/release', `ggs-remote-hub${exe}`);
export const appExe = process.env.GGS_REMOTE_APP_EXE ?? resolve(root, 'target/studio/cargo/debug', `git-graph-studio${exe}`);
export const PASSWORD = 'e2e-probe-kayak-42';

export const freePort = (): Promise<number> =>
	new Promise((ok) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => ok(port));
		});
	});

const portOpen = (port: number): Promise<boolean> =>
	new Promise((ok) => {
		const socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			ok(true);
		});
		socket.once('error', () => ok(false));
	});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DaemonHandle = {
	baseURL: string;
	port: number;
	kill: () => void;
};

export async function startDaemon(home: string, options: { password?: string | null; paused?: boolean } = {}): Promise<DaemonHandle> {
	mkdirSync(resolve(home, 'remote'), { recursive: true });
	const port = await freePort();
	const env = { ...process.env, GGS_REMOTE_HOME: resolve(home, 'remote'), GGS_HOME: resolve(home, 'ggs') };
	// The daemon's shipping shape is TLS: self-signed on a random loopback port. (Plain
	// HTTP works for Chromium and Firefox, which exempt localhost from the Secure-cookie
	// rule — WebKit does not, and the session cookie is always Secure.)
	writeFileSync(
		resolve(home, 'remote/config.json'),
		JSON.stringify({ port, bind: '127.0.0.1', tls: { mode: 'self-signed' }, autostart: false, mdns: false, paused: Boolean(options.paused) })
	);
	if (options.password !== null) {
		await new Promise<void>((ok, fail) => {
			const child = spawn(daemonExe, ['set-password', options.password ?? PASSWORD], { env });
			child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`set-password exited ${code}`))));
		});
	}
	const child = spawn(daemonExe, ['run', '--no-tray'], { env, stdio: 'ignore' });
	for (let i = 0; i < 100 && !(await portOpen(port)); i++) await sleep(100);
	if (!(await portOpen(port))) {
		child.kill();
		throw new Error(`the daemon did not listen on ${port}`);
	}
	return {
		baseURL: `https://127.0.0.1:${port}`,
		port,
		kill: () => child.kill()
	};
}

/** A fresh home per test under target/studio — wiped by the fixture's teardown. */
export function homeFor(name: string): string {
	const home = resolve(root, 'target/studio/remote-e2e', name.replace(/[^\w-]/g, '_'));
	rmSync(home, { recursive: true, force: true });
	mkdirSync(home, { recursive: true });
	return home;
}

/** One daemon for the whole spec file (login state survives between tests by design). */
type FixedDaemon = {
	daemon: DaemonHandle;
};
export const test = base.extend<FixedDaemon>({
	daemon: async ({}, use, testInfo) => {
		if (!existsSync(daemonExe)) testInfo.skip(true, `daemon binary missing: ${daemonExe}`);
		const daemon = await startDaemon(homeFor(testInfo.titlePath.join('-')));
		await use(daemon);
		daemon.kill();
	}
});
export { expect };


export { root, spawn, ChildProcess };
