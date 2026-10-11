// workbench.spec.ts (docs/ggs-remote-plan.md §17.4): the real remote workbench in a real
// browser — login, the workbench booting over the WebSocket Relay, the File Explorer listing
// the folder, and the phone layout's bottom tabs. Gated behind GGS_REMOTE_E2E_FULL=1: it
// needs the built app binary and the Vite dev server (the debug app loads relay.html from
// it), exactly what scripts/probes/remote-live-check.mjs boots — this is that flow as a spec.
import type { Page } from '@playwright/test';
import { test, expect, startDaemon, homeFor, appExe, freePort, PASSWORD, root } from './daemon.fixture';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';

// The daemon's control endpoint is a hash of its root path STRING: the app must get the
// very spelling the fixture gave the daemon (`resolve`d, native separators), or the two
// derive different endpoints and the instance never registers.
const hermeticEnv = (home: string) => ({ ...process.env, GGS_REMOTE_HOME: resolve(home, 'remote'), GGS_HOME: resolve(home, 'ggs') });
// The ggs-remote extension pushes its settings to the daemon at activation; seeded to
// match the test daemon, the push is a no-op instead of a rebind onto the default port.
const seedRemoteSettings = (page: Page, port: number) =>
	page.evaluate((value) => localStorage.setItem('ggstudio.extSettings.ggs.ggs-remote', value), JSON.stringify({ 'ggsRemote.port': port, 'ggsRemote.bind': '127.0.0.1', 'ggsRemote.tlsMode': 'none' }));
// From the window picker into the instance's workbench: the card's own Open (the folder
// form beside it has an "Open" too, which SPAWNS a new empty window), or the picker's
// auto-enter when one window runs — whichever comes first.
async function enterWorkbench(page: Page): Promise<void> {
	const card = page.locator('article.window button.primary').first();
	await Promise.race([
		card.waitFor({ timeout: 40_000 }).then(() => card.click().catch(() => undefined)),
		page.waitForURL(/remote\.html/, { timeout: 40_000 })
	]);
	await page.waitForURL(/remote\.html/, { timeout: 40_000 });
}
// Windows does not take a process's children along when it is killed: the app's
// extension backends (ggs-node) would outlive every run and lock the debug binaries.
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

test('the workbench boots and lists the folder over the Relay', async ({ browser }, testInfo) => {
	testInfo.skip(!process.env.GGS_REMOTE_E2E_FULL, 'set GGS_REMOTE_E2E_FULL=1 (needs the built app and the Vite dev server)');
	if (!existsSync(appExe)) testInfo.skip(true, `app binary missing: ${appExe}`);
	// A cold debug instance plus the workbench's first boot outlast the default minute.
	test.setTimeout(180_000);
	const home = homeFor('workbench');
	const daemon = await startDaemon(home);
	const children: ReturnType<typeof spawn>[] = [];
	try {
		if (!(await portOpen(5173))) {
			const vite = spawn('npm run dev:vite', { cwd: root, shell: true, stdio: 'ignore' });
			children.push(vite);
			for (let i = 0; i < 100 && !(await portOpen(5173)); i++) await sleep(200);
		}
		const app = spawn(appExe, ['--remote-host', root], {
			env: hermeticEnv(home),
			stdio: 'ignore'
		});
		children.push(app);

		const context = await browser.newContext({ ignoreHTTPSErrors: true }); // the daemon is TLS (self-signed)
		const page = await context.newPage();
		await page.goto(`${daemon.baseURL}/login`);
		await seedRemoteSettings(page, daemon.port);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('button[type=submit], form button.primary').first().click();
		await expect(page).toHaveURL(/\/windows/, { timeout: 15_000 });

		// The instance registers within seconds; its card appears, then opens the workbench.
		await enterWorkbench(page);
		await expect(page.locator('#activitybar .activity-item').first()).toBeVisible({ timeout: 90_000 });
		await expect(page.locator('#boot-splash')).toHaveCount(0, { timeout: 30_000 });
		await expect
			.poll(() => page.locator('#sidebar').innerText(), { timeout: 30_000 })
			.toMatch(/package\.json|README\.md|src/);

		// The phone shape: the shell reflows to bottom tabs (§11.2).
		const phone = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); // the daemon is TLS (self-signed)
		const phonePage = await phone.newPage();
		// A fresh browser context is a new device: it signs in before it reaches the page.
		await phonePage.goto(`${daemon.baseURL}/login`);
		await phonePage.locator('#password').fill(PASSWORD);
		await phonePage.locator('button[type=submit], form button.primary').first().click();
		await expect(phonePage).toHaveURL(/\/windows/, { timeout: 15_000 });
		await phonePage.goto(page.url());
		// The workbench boots (its activity bar exists — hidden on a phone, where the bottom
		// tabs take its place).
		await expect(phonePage.locator('#activitybar .activity-item').first()).toBeAttached({ timeout: 90_000 });
		await expect
			.poll(() => phonePage.evaluate(() => document.documentElement.dataset.formFactor).catch(() => null), { timeout: 20_000 })
			.toBe('phone');
		await expect(phonePage.locator('.ggs-bottom-tabs')).toBeVisible({ timeout: 20_000 });
		await phone.close();
		await context.close();
	} finally {
		daemon.kill();
		for (const child of children) killTree(child);
	}
});

// Two people on one PC through the same daemon (a Hub forwards the same way): user A opens
// the workbench first, user B attaches later from a phone. B missed the extensions'
// activation (it ran before B existed) and must still see the Claude Code entry and the
// Git Graph button; and what each one opens lands in that one's page only.
test('two remote users: the Claude Code and Git Graph entries, each user\'s pages its own', async ({ browser }, testInfo) => {
	testInfo.skip(!process.env.GGS_REMOTE_E2E_FULL, 'set GGS_REMOTE_E2E_FULL=1 (needs the built app and the Vite dev server)');
	if (!existsSync(appExe)) testInfo.skip(true, `app binary missing: ${appExe}`);
	// The spec asserts the Claude Code entry exists: it only runs against a build that packs
	// it (the default packs none — the Extensions view installs it online instead).
	if (!existsSync(resolve(root, 'target/studio/bundled/app-resources/extensions/claude-code.vsix'))) {
		testInfo.skip(true, 'this build bundles no claude-code (build with GGS_BUNDLE_CLAUDE_CODE=1 to run this spec)');
	}
	test.setTimeout(240_000);
	const home = homeFor('two-users');
	const daemon = await startDaemon(home);
	const children: ReturnType<typeof spawn>[] = [];
	const errors: string[] = [];
	try {
		if (!(await portOpen(5173))) {
			const vite = spawn('npm run dev:vite', { cwd: root, shell: true, stdio: 'ignore' });
			children.push(vite);
			for (let i = 0; i < 100 && !(await portOpen(5173)); i++) await sleep(200);
		}
		children.push(spawn(appExe, ['--remote-host', root], { env: hermeticEnv(home), stdio: 'ignore' }));

		const open = async (options: Parameters<typeof browser.newContext>[0], label: string) => {
			const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options }); // the daemon is TLS (self-signed)
			const page = await context.newPage();
			page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
			await page.goto(`${daemon.baseURL}/login`);
			await seedRemoteSettings(page, daemon.port);
			await page.locator('#password').fill(PASSWORD);
			await page.locator('button[type=submit], form button.primary').first().click();
			await expect(page).toHaveURL(/\/windows/, { timeout: 15_000 });
			await enterWorkbench(page);
			await expect(page.locator('#boot-splash')).toHaveCount(0, { timeout: 90_000 });
			// The instance's folder is open in this page (the repository the graph reads).
			await expect.poll(() => page.locator('#sidebar').innerText().catch(() => ''), { timeout: 30_000 }).toMatch(/package\.json|README\.md|src/);
			return { context, page };
		};
		const claudeItem = '#activitybar .activity-item[data-view^="ext-container:Anthropic.claude-code"]';
		const graphTabs = (page: Page) => page.locator('.tab', { hasText: 'Git Graph RS' });
		// A webview document (srcdoc) whose commit table rendered: branch and column labels.
		const renderedGraph = async (page: Page) => {
			for (const frame of page.frames()) {
				if (frame.url() !== 'about:srcdoc') continue;
				const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
				if (/(Branches|分支)[\s\S]*(Description|描述)/.test(text)) return true;
			}
			return false;
		};

		// User A, a desktop browser.
		const a = await open({ viewport: { width: 1400, height: 900 } }, 'A');
		await expect(a.page.locator(claudeItem)).toHaveCount(1, { timeout: 60_000 });

		// User B, a phone, attaching after every activation already ran.
		const b = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, 'B');
		await expect.poll(() => b.page.evaluate(() => document.documentElement.dataset.formFactor).catch(() => null), { timeout: 20_000 }).toBe('phone');
		await expect(b.page.locator(claudeItem)).toHaveCount(1, { timeout: 60_000 });
		const claudeTab = b.page.locator('.ggs-bottom-tabs button[data-tab^="ext-container:Anthropic.claude-code"]');
		await expect(claudeTab).toBeVisible({ timeout: 20_000 });

		// B opens the Git Graph from Source Control: it opens in B's page, not in A's.
		await b.page.locator('.ggs-bottom-tabs button[data-tab="scm"]').tap();
		const bGraphButton = b.page.locator('.scm-main-header .actions [title*="Git Graph"]').first();
		await expect(bGraphButton).toBeVisible({ timeout: 30_000 });
		await bGraphButton.tap();
		await expect(graphTabs(b.page)).toHaveCount(1, { timeout: 30_000 });
		await sleep(3000);
		await expect(graphTabs(a.page)).toHaveCount(0);
		// The graph page renders in B: its scripts load through B's own asset route and the
		// commit table fills in.
		await expect.poll(() => renderedGraph(b.page), { timeout: 60_000 }).toBe(true);
		await testInfo.attach('phone-git-graph', { body: await b.page.screenshot(), contentType: 'image/png' });

		// A asks for the Git Graph too. The extension keeps ONE panel and reveals it: it moves
		// to A — rendered there — and leaves B's page; it never shows up in both, nor stays
		// in B's page while A, who asked, sees nothing.
		await a.page.locator('#activitybar .activity-item[data-view="scm"]').click();
		const aGraphButton = a.page.locator('.scm-main-header .actions [title*="Git Graph"]').first();
		await a.page.locator('.scm-main-header').hover();
		await aGraphButton.click();
		await expect(graphTabs(a.page)).toHaveCount(1, { timeout: 30_000 });
		await expect(graphTabs(b.page)).toHaveCount(0, { timeout: 10_000 });
		await expect.poll(() => renderedGraph(a.page), { timeout: 60_000 }).toBe(true);

		// A opens Claude Code: the chat view mounts and its page renders in A.
		await a.page.locator(claudeItem).click();
		const chatFrame = a.page.locator('.ext-webview-view-pane iframe').first();
		await expect(chatFrame).toBeAttached({ timeout: 30_000 });
		await expect
			.poll(async () => {
				for (const frame of a.page.frames()) {
					const html = await frame.evaluate(() => document.body?.innerHTML.length ?? 0).catch(() => 0);
					if (frame !== a.page.mainFrame() && html > 200) return true;
				}
				return false;
			}, { timeout: 60_000 })
			.toBe(true);
		await testInfo.attach('desktop-claude', { body: await a.page.screenshot(), contentType: 'image/png' });

		// B taps its Claude Code tab: the chat comes up on the phone too.
		await claudeTab.tap();
		await expect(b.page.locator('.ext-webview-view-pane iframe').first()).toBeVisible({ timeout: 30_000 });
		await testInfo.attach('phone-claude', { body: await b.page.screenshot(), contentType: 'image/png' });

		expect(errors).toEqual([]);
		await a.context.close();
		await b.context.close();
	} finally {
		daemon.kill();
		for (const child of children) killTree(child);
	}
});
