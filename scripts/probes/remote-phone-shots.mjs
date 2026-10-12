// The phone shell's visual pass (module 19, docs/ggs-remote-plan.md §11.2): drives
// dev/remote-phone.html (the phone chrome over the scripted fake backend) in a headless
// Chromium at iPhone size with touch, walks every page and overlay — the empty editor, Files,
// a file open, the open editors sheet, the editor's actions, Changes, the extension pages, the
// Terminal, the drawer, the Settings page (root, a category, a choice sheet) — and saves one
// screenshot each under target/studio/phone-shots/, plus any page error it saw. Layout
// evidence, not a test gate.
//
//   npx vite --port 5291 &   # the dev server
//   node scripts/probes/remote-phone-shots.mjs [--url http://localhost:5291] [--theme light]
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(name);
	return at === -1 ? fallback : args[at + 1];
};
const base = option('--url', 'http://localhost:5291');
const out = join('target', 'studio', 'phone-shots');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 13'], colorScheme: option('--theme', 'dark') });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
	if (message.type() === 'error') errors.push(message.text());
});
await page.goto(`${base}/dev/remote-phone.html`);
await page.waitForFunction(() => window.__phonePreviewReady === true, null, { timeout: 30_000 });
await page.waitForTimeout(800);

const shot = async (name) => {
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(out, `${name}.png`) });
	console.log(`saved ${name}.png`);
};
const tab = (id) => page.locator(`.ggs-bottom-tabs button[data-tab="${id}"]`);

await shot('01-start');
await tab('explorer').tap();
await shot('02-files');
await page.locator('#sidebar .row', { hasText: 'src' }).first().tap();
await page.waitForTimeout(300);
await page.locator('#sidebar .row', { hasText: 'workbench.ts' }).first().tap();
await shot('03-editor');
await page.locator('.ggs-appbar-heading').tap();
await shot('04-open-editors');
await page.locator('.ggs-action-sheet-backdrop').tap({ position: { x: 20, y: 40 } });
await page.locator('.ggs-appbar-actions .ggs-appbar-btn').last().tap();
await shot('05-editor-actions');
await page.locator('.ggs-action-sheet .row.cancel').tap();
await tab('scm').tap();
await shot('06-changes');
await page.locator('.ggs-appbar-actions .ggs-appbar-btn').last().tap();
await shot('07-git-actions');
await page.locator('.ggs-action-sheet .row.cancel').tap();
const extTabs = page.locator('.ggs-bottom-tabs button[data-ext]');
for (let i = 0; i < (await extTabs.count()); i++) {
	await extTabs.nth(i).tap();
	await shot(`08-extension-${i + 1}`);
}
await page.locator('.ggs-appbar .ggs-appbar-btn.leading').tap();
await shot('09-drawer');
await page.locator('.ggs-drawer-row', { hasText: /Terminal|终端/ }).first().tap();
await shot('10-terminal');
// The phone's Settings page: the root's categories, a category's rows, a choice sheet.
await page.locator('.ggs-appbar .ggs-appbar-btn.leading').tap();
await page.locator('.ggs-drawer-row', { hasText: /Settings|设置/ }).first().tap();
await shot('11-settings-root');
await page.locator('.ggs-settings-row', { hasText: /Appearance|外观/ }).first().tap();
await shot('12-settings-appearance');
await page.locator('.ggs-settings-row', { hasText: /Color Theme|颜色主题/ }).first().tap();
await shot('13-settings-theme-sheet');
await page.locator('.ggs-action-sheet .row.cancel').tap();
await page.locator('.ggs-settings-back').tap();
await page.locator('.ggs-settings-back').tap();
await tab('editor').tap();
await shot('14-editor-again');
// The keyboard: unlock, put the caret in the text, then shrink the viewport the way a raised
// on-screen keyboard does — the navigation steps aside and the editing row shows.
await page.locator('.edit-lock-bar button').tap();
await page.locator('.cm-content').tap();
await page.setViewportSize({ width: 390, height: 480 });
await page.waitForTimeout(300);
await shot('15-editing-keyboard');

console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'no page errors');
await browser.close();
