// visual-baseline.spec.ts (docs/ggs-remote-plan.md §17.4): the engines' own render of the
// daemon's stable pages — the login page and the not-online page — at the desktop and phone
// shapes, kept as the visual baseline record. The shots land under
// target/studio/remote-e2e-shots/<engine>-<shape>-<page>.png so a later change can be
// eyeballed against them; they assert nothing (no committed pixel baselines to rot — the
// DOM assertions in the other specs carry the correctness).
import { test, expect, startDaemon, homeFor, hubExe, freePort, PASSWORD } from './daemon.fixture';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port: number) =>
	new Promise<boolean>((ok) => {
		const socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			ok(true);
		});
		socket.once('error', () => ok(false));
	});
const shots = resolve(process.cwd(), 'target/studio/remote-e2e-shots');

const SHAPES = {
	desktop: { viewport: { width: 1400, height: 900 } },
	phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
} as const;

test.describe('the visual baseline', () => {
	for (const [shape, options] of Object.entries(SHAPES)) {
		test(`login — ${shape}`, async ({ browser }) => {
			const home = homeFor(`visual-login-${shape}`);
			const daemon = await startDaemon(home);
			try {
				const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
				const page = await context.newPage();
				await page.goto(`${daemon.baseURL}/login`);
				await expect(page.locator('#password')).toBeVisible();
				mkdirSync(shots, { recursive: true });
				writeFileSync(resolve(shots, `${browser.browserType().name()}-${shape}-login.png`), await page.screenshot());
				await context.close();
			} finally {
				daemon.kill();
			}
		});

		test(`not-online — ${shape}`, async ({ browser }) => {
			test.skip(!existsSync(hubExe), `hub binary missing: ${hubExe}`);
			const port = await freePort();
			const config = resolve(process.cwd(), 'target/studio', `visual-hub-${shape}.toml`);
			writeFileSync(config, `listen = "127.0.0.1:${port}"\npublic_url = ""\njoin_key = ""\nlanding_page = false\n`);
			const hub = spawn(hubExe, ['--config', config], { stdio: 'ignore' });
			for (let i = 0; i < 50; i++) {
				if (await portOpen(port)) break;
				await sleep(100);
			}
			try {
				const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
				const page = await context.newPage();
				const response = await page.goto(`http://127.0.0.1:${port}/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/login`);
				expect(response?.status()).toBe(503);
				await expect(page.locator('body')).toContainText(/not online|没有连上中继/i);
				mkdirSync(shots, { recursive: true });
				writeFileSync(resolve(shots, `${browser.browserType().name()}-${shape}-offline.png`), await page.screenshot());
				await context.close();
			} finally {
				hub.kill();
			}
		});
	}
});
