// transfer.spec.ts (module 3's transfer layer, the remote half): the browser's own
// Download entries against the REAL daemon and app — the exact click the owner reported
// failing (2026-10-13, "远程在浏览器上下载文件失败"): a file's context menu carries
// Download, the one-time ticket is minted, and the browser's download lands with the file's
// bytes; a folder's Download as Zip lands a real archive. Gated behind GGS_REMOTE_E2E_FULL
// exactly like workbench.spec.ts (the built app, the built remote bundle, the Vite dev
// server for the Relay webview).
import type { Page } from '@playwright/test';
import { test, expect, startDaemon, homeFor, appExe, freePort, PASSWORD, root } from './daemon.fixture';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';

const hermeticEnv = (home: string) => ({ ...process.env, GGS_REMOTE_HOME: resolve(home, 'remote'), GGS_HOME: resolve(home, 'ggs') });
const seedRemoteSettings = (page: Page, port: number) =>
	page.evaluate((value) => localStorage.setItem('ggstudio.extSettings.ggs.ggs-remote', value), JSON.stringify({ 'ggsRemote.port': port, 'ggsRemote.bind': '127.0.0.1', 'ggsRemote.tlsMode': 'none' }));
async function enterWorkbench(page: Page): Promise<void> {
	const card = page.locator('article.window button.primary').first();
	await Promise.race([
		card.waitFor({ timeout: 40_000 }).then(() => card.click().catch(() => undefined)),
		page.waitForURL(/remote\.html/, { timeout: 40_000 })
	]);
	await page.waitForURL(/remote\.html/, { timeout: 40_000 });
}
const killTree = (child: ReturnType<typeof spawn>) => {
	if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
	else child.kill();
};
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

test('the browser downloads a file and a folder zip through the Explorer menu', async ({ browser }, testInfo) => {
	testInfo.skip(!process.env.GGS_REMOTE_E2E_FULL, 'set GGS_REMOTE_E2E_FULL=1 (needs the built app and the Vite dev server)');
	if (!existsSync(appExe)) testInfo.skip(true, `app binary missing: ${appExe}`);
	test.setTimeout(180_000);
	const home = homeFor('transfer');
	const daemon = await startDaemon(home);
	const children: ReturnType<typeof spawn>[] = [];
	try {
		if (!(await portOpen(5173))) {
			const vite = spawn('npm run dev:vite', { cwd: root, shell: true, stdio: 'ignore' });
			children.push(vite);
			for (let i = 0; i < 100 && !(await portOpen(5173)); i++) await sleep(200);
		}
		const app = spawn(appExe, ['--remote-host', root], { env: hermeticEnv(home), stdio: 'ignore' });
		children.push(app);

		const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
		const page = await context.newPage();
		await page.goto(`${daemon.baseURL}/login`);
		await seedRemoteSettings(page, daemon.port);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('button[type=submit], form button.primary').first().click();
		await expect(page).toHaveURL(/\/windows/, { timeout: 15_000 });
		await enterWorkbench(page);
		await expect(page.locator('#boot-splash')).toHaveCount(0, { timeout: 30_000 });
		await expect
			.poll(() => page.locator('#sidebar').innerText(), { timeout: 30_000 })
			.toMatch(/package\.json|README\.md|src/);

		// A file row's menu offers Download (every environment's one vocabulary), and the
		// click lands the browser's download with the file's own bytes.
		const readme = page.locator('#sidebar .tree .row[data-path]').filter({ hasText: 'README.md' }).first();
		await readme.waitFor({ timeout: 30_000 });
		await readme.click({ button: 'right' });
		const downloadItem = page.locator('.context-menu .item').filter({ hasText: /^Download$/ }).first();
		await expect(downloadItem).toBeVisible({ timeout: 10_000 });
		const fileDownload = page.waitForEvent('download', { timeout: 30_000 });
		await downloadItem.click();
		const landed = await fileDownload;
		expect(landed.suggestedFilename()).toBe('README.md');
		const saveDir = resolve(home, 'downloaded');
		mkdirSync(saveDir, { recursive: true });
		const savedPath = resolve(saveDir, 'README.md');
		await landed.saveAs(savedPath);
		expect(readFileSync(savedPath).equals(readFileSync(resolve(root, 'README.md')))).toBe(true);

		// A folder row offers Download as Zip, and the archive is a real zip of the tree.
		const srcRow = page.locator('#sidebar .tree .row[data-path][data-dir="1"]').filter({ hasText: 'src' }).first();
		await srcRow.waitFor({ timeout: 10_000 });
		await srcRow.click({ button: 'right' });
		const zipItem = page.locator('.context-menu .item').filter({ hasText: 'Download as Zip' }).first();
		await expect(zipItem).toBeVisible({ timeout: 10_000 });
		const zipDownload = page.waitForEvent('download', { timeout: 60_000 });
		await zipItem.click();
		const zipped = await zipDownload;
		expect(zipped.suggestedFilename()).toBe('src.zip');
		const zipPath = resolve(saveDir, 'src.zip');
		await zipped.saveAs(zipPath);
		const zipBytes = readFileSync(zipPath);
		expect(zipBytes.subarray(0, 4).equals(Buffer.from('PK\x03\x04'))).toBe(true);
		// The zip carries the folder's own files (spot check one name from the tree).
		const central = zipBytes.lastIndexOf(Buffer.from('PK\x05\x06'));
		expect(central).toBeGreaterThan(0);
		expect(zipBytes.subarray(0, central).toString('latin1')).toContain('ui.ts');
		await context.close();
	} finally {
		daemon.kill();
		for (const child of children) killTree(child);
	}
});
