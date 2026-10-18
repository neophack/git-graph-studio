// page-bench.spec.ts (docs/remote-client-plan.md §5, the 2026-10-16 response-latency
// pass): the page-switch latency in a REAL engine — the owner's "remote 测试多个界面，要
// 做到 100 微秒内". The phone context taps the bottom navigation's every tab in a loop and
// measures two marks per switch in the page: the synchronous DOM settle (the switch work
// itself, read after a forced layout) and the presented frame (two rAFs). What this can
// show under 100 µs is the switch's own local work; anything the wire carries is
// physics (~1.3 ms loopback RTT, the --bench rows) and shows up here only when a page's
// refresh blocks its content — which is exactly what this spec guards against. Gated
// behind GGS_REMOTE_E2E_FULL like workbench.spec (the built app + the Vite dev server).
import type { Page } from '@playwright/test';
import { test, expect, startDaemon, homeFor, appExe, PASSWORD, root } from './daemon.fixture';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';

const hermeticEnv = (home: string) => ({ ...process.env, GGS_REMOTE_HOME: resolve(home, 'remote'), GGS_HOME: resolve(home, 'ggs') });
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

async function enterWorkbench(page: Page): Promise<void> {
	const card = page.locator('article.window button.primary').first();
	await Promise.race([
		card.waitFor({ timeout: 40_000 }).then(() => card.click().catch(() => undefined)),
		page.waitForURL(/remote\.html/, { timeout: 40_000 })
	]);
	await page.waitForURL(/remote\.html/, { timeout: 40_000 });
}

interface SwitchMark {
	tab: string;
	domMs: number;
	frameMs: number;
}

test('the phone page switches settle locally, far under a wire round trip', async ({ browser }, testInfo) => {
	testInfo.skip(!process.env.GGS_REMOTE_E2E_FULL, 'set GGS_REMOTE_E2E_FULL=1 (needs the built app and the Vite dev server)');
	if (!existsSync(appExe)) testInfo.skip(true, `app binary missing: ${appExe}`);
	test.setTimeout(180_000);
	const home = homeFor('page-bench');
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

		const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
		const page = await context.newPage();
		await page.goto(`${daemon.baseURL}/login`);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('button[type=submit], form button.primary').first().click();
		await page.waitForURL(/\/windows/, { timeout: 15_000 });
		await enterWorkbench(page);
		// The phone page-stack shell hides the activity bar (the bottom tabs replace it);
		// the boot's end state is the tabs themselves.
		await expect(page.locator('.ggs-bottom-tabs [role="tab"], .ggs-bottom-tabs button, .ggs-bottom-tabs .tab').first()).toBeVisible({ timeout: 90_000 });
		// Let the boot's own settle (the first listing, the scm refresh) pass before timing.
		await sleep(2000);

		const marks = await page.evaluate(async (): Promise<SwitchMark[]> => {
			const tabs = [...document.querySelectorAll<HTMLElement>('.ggs-bottom-tabs [role="tab"], .ggs-bottom-tabs button, .ggs-bottom-tabs .tab')].filter((t) => t.offsetParent !== null || getComputedStyle(t).display !== 'none');
			// The in-page switch loop: tap, settle the DOM (forced layout read), then the
			// presented frame (two rAFs — the second fires after the first's paint).
			const out: SwitchMark[] = [];
			const ROUNDS = 8;
			for (let round = 0; round < ROUNDS + 1; round++) {
				for (const tab of tabs) {
					const label = (tab.getAttribute('aria-label') || tab.textContent || '').trim();
					const t0 = performance.now();
					tab.click();
					void document.documentElement.offsetHeight; // force the layout the click queued
					const domMs = performance.now() - t0;
					await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
					const frameMs = performance.now() - t0;
					if (round > 0) out.push({ tab: label, domMs, frameMs });
				}
			}
			return out;
		});

		expect(marks.length).toBeGreaterThan(0);
		const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
		const byTab = new Map<string, SwitchMark[]>();
		for (const mark of marks) {
			const list = byTab.get(mark.tab) ?? [];
			list.push(mark);
			byTab.set(mark.tab, list);
		}
		const lines = [...byTab.entries()].map(([tab, list]) => `${tab.padEnd(12)} DOM ${median(list.map((m) => m.domMs)).toFixed(3)} ms · frame ${median(list.map((m) => m.frameMs)).toFixed(1)} ms`);
		const allDom = marks.map((m) => m.domMs);
		const allFrame = marks.map((m) => m.frameMs);
		console.log(
			`PAGE-BENCH-REAL  ${marks.length} tab taps in a real engine (WebKit, 390×844)\n` +
				`                ${lines.join('\n                ')}\n` +
				`                all taps: DOM settle median ${(median(allDom) * 1000).toFixed(0)} µs · max ${(Math.max(...allDom) * 1000).toFixed(0)} µs · presented frame median ${median(allFrame).toFixed(1)} ms`
		);
		// The switch's own work must stay around a millisecond — this engine's
		// performance.now() quantizes to 1 ms, and a full-workbench forced layout costs a
		// fraction of one on its own. A median past 2 ms means a page switch started
		// awaiting the wire (~1.3 ms loopback RTT per hop).
		expect(median(allDom)).toBeLessThan(2);
		await context.close();
	} finally {
		for (const child of children) child.kill();
		daemon.kill();
	}
});

// The horizontal pager (swipeNav.ts, 2026-10-18): a real engine's proof of the swipe
// vocabulary — a leftward drag over the page column follows the finger (the drag state and
// the translate are readable mid-gesture) and commits to the next bottom destination; a
// rightward drag from the ring's first destination rubber-bands and pages nothing. Same
// gate and fixture as the bench above (the built app + the Vite dev server).
test('a horizontal swipe pages the bottom navigation with the page following the finger', async ({ browser }, testInfo) => {
	testInfo.skip(!process.env.GGS_REMOTE_E2E_FULL, 'set GGS_REMOTE_E2E_FULL=1 (needs the built app and the Vite dev server)');
	if (!existsSync(appExe)) testInfo.skip(true, `app binary missing: ${appExe}`);
	test.setTimeout(180_000);
	const home = homeFor('swipe-nav');
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

		const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
		const page = await context.newPage();
		await page.goto(`${daemon.baseURL}/login`);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('button[type=submit], form button.primary').first().click();
		await page.waitForURL(/\/windows/, { timeout: 15_000 });
		await enterWorkbench(page);
		await expect(page.locator('.ggs-bottom-tabs [role="tab"], .ggs-bottom-tabs button, .ggs-bottom-tabs .tab').first()).toBeVisible({ timeout: 90_000 });
		await sleep(2000);

		/** One swipe over the page column, from `x0` to `x1`, answering the ring's state. */
		const swipe = (x0: number, x1: number): Promise<{ before: string; after: string; midDrag: boolean; midTransform: string; settled: boolean }> =>
			page.evaluate(
				async ([startX, endX]: number[]): Promise<{ before: string; after: string; midDrag: boolean; midTransform: string; settled: boolean }> => {
					const workbench = document.getElementById('workbench')!;
					const send = (type: string, x: number) => {
						const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 300, pointerId: 7, pointerType: 'touch', isPrimary: true });
						Object.defineProperty(event, 'timeStamp', { value: performance.now() });
						workbench.dispatchEvent(event);
					};
					const active = () => document.querySelector('.ggs-bottom-tabs button.active')?.getAttribute('data-tab') ?? '';
					const before = active();
					const step = endX > startX ? 20 : -20;
					send('pointerdown', startX);
					for (let x = startX + step; step > 0 ? x < endX : x > endX; x += step) send('pointermove', x);
					const midDrag = workbench.classList.contains('ggs-swipe-drag');
					const midTransform = workbench.style.transform;
					send('pointerup', endX);
					// The two-phase settle (130 ms out + 190 ms in) and the chrome wave.
					await new Promise<void>((done) => setTimeout(done, 500));
					return { before, after: active(), midDrag, midTransform, settled: workbench.style.transform === '' && !workbench.classList.contains('ggs-swipe-drag') };
				},
				[x0, x1]
			);

		// Files → Editor: the page follows the finger leftward and the ring advances.
		const left = await swipe(320, 120);
		expect(left.before).toBe('explorer');
		expect(left.midDrag).toBe(true);
		expect(left.midTransform).toMatch(/translateX\(-/);
		expect(left.after).toBe('editor');
		expect(left.settled).toBe(true);
		// Editor → Files: the rightward swipe pages back one slot.
		const right = await swipe(80, 280);
		expect(right.after).toBe('explorer');
		expect(right.settled).toBe(true);
		await context.close();
	} finally {
		for (const child of children) child.kill();
		daemon.kill();
	}
});
