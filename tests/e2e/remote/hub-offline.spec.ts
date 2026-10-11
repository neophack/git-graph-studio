// hub-offline.spec.ts (docs/ggs-remote-plan.md §20.5): the Hub's front door in a real
// browser — a link whose PC is not online answers the one same page, whatever the uuid's
// shape, and the landing stays off by default.
import { test, expect, freePort, hubExe } from './daemon.fixture';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
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

test('every not-online link answers the same page', async ({ page }, testInfo) => {
	if (!existsSync(hubExe)) testInfo.skip(true, `hub binary missing: ${hubExe}`);
	const port = await freePort();
	const config = testInfo.outputPath('hub.toml');
	writeFileSync(config, `listen = "127.0.0.1:${port}"\npublic_url = ""\njoin_key = ""\nlanding_page = false\n`);
	const hub = spawn(hubExe, ['--config', config], { stdio: 'ignore' });
	for (let i = 0; i < 50; i++) {
		if (await portOpen(port)) break;
		await sleep(100);
	}
	const base = `http://127.0.0.1:${port}`;
	try {
		const known = '3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3';
		const snapshots: string[] = [];
		for (const path of [`/u/${known}/login`, '/u/00000000-0000-8000-8000-000000000000/login', '/u/not-a-uuid/login']) {
			const response = await page.goto(`${base}${path}`);
			expect(response?.status()).toBe(503);
			await expect(page.locator('body')).toContainText(/not online|没有连上中继/i);
			snapshots.push(await page.locator('body').innerText());
		}
		// Malformed, unknown and merely-away all render the same text (§20.5).
		expect(snapshots[0]).toBe(snapshots[1]);
		// The bare root is a 404 — no landing, no index to probe. Over the request API, not
		// a page navigation: after the three 503s, Firefox's connection pool hands the next
		// navigation a socket it will not retry (WebKit and Chromium do), and the answer
		// reads as NS_ERROR_NET_EMPTY_RESPONSE — the status is the assertion, the socket is
		// none of its business.
		const rootResponse = await page.request.get(base);
		expect(rootResponse.status()).toBe(404);
		// The health check answers for the orchestrator.
		const health = await page.request.get(`${base}/healthz`);
		expect(health.status()).toBe(200);
	} finally {
		hub.kill();
	}
});
