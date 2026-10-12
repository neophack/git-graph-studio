// The cross-frontend operation sync's live pass (module 19, docs/ggs-remote-plan.md §22.7):
// the dev harness as the PC's window and dev/remote-phone.html as a phone's own workbench —
// two real frontends in one browser, exchanging app events over dev/dev-events.js's
// BroadcastChannel (the Relay's dev stand-in). Clicks a matrix of page buttons on both sides
// — activity views, the phone's bottom tabs, file rows, tab switches, tab closes — and
// asserts the OTHER side's workbench reacts to each. Then it measures the wire: the sync's
// own messages (window.__ggsDevEvents) against what the DOM replica would have paid for the
// very same session — a real DomRecorder (src/remote/mirror/recorder.ts) observing the PC
// page, its snapshot plus every mutation batch counted — asserting the operation sync stays
// under a TENTH of the replica's bytes (the owner's bar, 2026-10-12: "1/10 的流量实现同步，
// 防止流量浪费"). The phone's Git Graph / Claude Code bottom tabs are the preview's no-op
// stand-ins (a no-op command has nothing to sync); the real extension pages are covered by
// the mirror-policy tests in tests/extensions.test.ts.
//
//   npx vite --port 5291 &   # the dev server
//   node scripts/probes/remote-sync-check.mjs [--url http://localhost:5291]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(name);
	return at === -1 ? fallback : args[at + 1];
};
const base = option('--url', 'http://localhost:5291');
const out = join('target', 'studio', 'remote-sync');
mkdirSync(out, { recursive: true });

// One context, two pages: the dev bridge crosses pages over a BroadcastChannel, which only
// reaches pages of the same browsing context — and the per-page viewports give each side its
// form factor (the PC 1280×800, the phone 390×844).
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
// The harness's scripted launch is a no-argument one (boot_context answers repo: null), so
// the folder it opens is the remembered one — seed it, or a fresh profile boots folderless
// and the Explorer (and this probe's tree clicks) has nothing to click.
await context.addInitScript(() => localStorage.setItem('ggstudio.lastFolder', '"/repo"'));
const pc = await context.newPage();
const phone = await context.newPage();
await phone.setViewportSize({ width: 390, height: 844 });
const errors = [];
for (const page of [pc, phone]) {
	page.on('pageerror', (error) => errors.push(`${page === pc ? 'pc' : 'phone'}: ${String(error)}`));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(`${page === pc ? 'pc' : 'phone'} console: ${message.text()}`);
	});
}

await pc.goto(`${base}/dev/dev-harness.html`);
await pc.waitForSelector('.tree .row', { timeout: 30_000 });
await phone.goto(`${base}/dev/remote-phone.html`);
await phone.waitForFunction(() => window.__phonePreviewReady === true, null, { timeout: 30_000 });
await pc.waitForTimeout(1500);
await phone.waitForTimeout(1500);

// The replica's price tag, measured live: a real DomRecorder over the PC page, exactly what
// mirror mode would run there. Its snapshot is what a viewer's connect pays; every mutation
// batch is what the session's DOM churn costs — through the whole matrix below, reactions
// included. Installed before a single button is clicked.
await pc.evaluate(() => {
	window.__mirror = { snapshot: 0, ops: 0, batches: 0, messages: 0 };
	const script = document.createElement('script');
	script.type = 'module';
	script.textContent = [
		'try {',
		"  const { DomRecorder } = await import('/src/remote/mirror/recorder.ts');",
		'  const recorder = new DomRecorder(document, (ops, seq) => {',
		"    window.__mirror.ops += JSON.stringify({ k: 'ops', to: '*', seq, ops }).length;",
		'    window.__mirror.batches++;',
		'  });',
		'  const snap = recorder.snapshot();',
		"  window.__mirror.snapshot = JSON.stringify({ k: 'snap', to: '*', ...snap }).length;",
		'  window.__mirrorRecorder = recorder;',
		"} catch (error) { window.__mirror.error = String(error); }"
	].join('\n');
	document.head.appendChild(script);
});
await pc.waitForFunction(() => window.__mirror && (window.__mirror.snapshot > 0 || window.__mirror.error), null, { timeout: 15_000 });

const workbenchState = () => ({
	view: document.querySelector('#activitybar .activity-item.active')?.dataset.view ?? null,
	sidebarHidden: document.getElementById('sidebar').hidden,
	tabs: [...document.querySelectorAll('#editorGroup .tab')].map((tab) => tab.textContent.trim()),
	active: document.querySelector('#editorGroup .tab.active')?.textContent ?? null
});
const pcState = () => pc.evaluate(workbenchState);
const phoneState = () => phone.evaluate(workbenchState);

const syncBytes = async () => {
	const read = (page) => page.evaluate(() => (window.__ggsDevEvents ? window.__ggsDevEvents.emitted : [])
		.filter((entry) => entry.event === 'studio://workbench-sync')
		.reduce((sum, entry) => sum + entry.bytes, 0));
	return (await read(pc)) + (await read(phone));
};
const baseline = await syncBytes();

const rows = [];
let failures = 0;
const step = async (name, act, expect) => {
	const before = await syncBytes();
	await act();
	await pc.waitForTimeout(700);
	const syncSide = await pcState();
	const phoneSide = await phoneState();
	const failure = expect(syncSide, phoneSide);
	const bytes = (await syncBytes()) - before;
	rows.push({ step: name, ok: failure === null, bytes, detail: failure ?? 'ok' });
	if (failure !== null) failures++;
	console.log(`${failure === null ? 'PASS' : 'FAIL'}  ${name}  (${bytes} B synced)${failure === null ? '' : ` — ${failure}`}`);
};

const clickActivity = (page, view) => page.evaluate((id) => {
	document.querySelector(`#activitybar .activity-item[data-view='${id}']`)?.click();
}, view);
const clickTreeRow = (page, text) => page.evaluate((label) => {
	const row = [...document.querySelectorAll('.tree .row')].find((candidate) => candidate.textContent.includes(label));
	if (!row) throw new Error(`no tree row '${label}'`);
	row.click();
}, text);
const clickTab = (page, label) => page.evaluate((text) => {
	const tab = [...document.querySelectorAll('#editorGroup .tab')].find((candidate) => candidate.textContent.trim() === text);
	if (!tab) throw new Error(`no tab '${text}'`);
	tab.click();
}, label);
const closeTab = (page, label) => page.evaluate((text) => {
	const tab = [...document.querySelectorAll('#editorGroup .tab')].find((candidate) => candidate.textContent.trim() === text);
	if (!tab) throw new Error(`no tab '${text}'`);
	const close = tab.querySelector('.close');
	if (!close) throw new Error(`tab '${text}' has no close button`);
	close.click();
}, label);

// ---------- The button matrix: one side clicks, the other reacts ----------
// (The first click is Search, not Explorer: clicking the already-active activity item is a
// sidebar TOGGLE, and a fresh profile boots with the sidebar showing — Search guarantees a
// real view switch, and the phone follows it before Explorer is asked for.)
await step('PC opens Search → the phone shows its Search page', () => clickActivity(pc, 'search'),
	(pcS, phoneS) => phoneS.view === 'search' && !phoneS.sidebarHidden ? null : `phone view=${phoneS.view} sidebarHidden=${phoneS.sidebarHidden}`);
await step('PC opens Explorer → the phone is on its Files page', () => clickActivity(pc, 'explorer'),
	(pcS, phoneS) => phoneS.view === 'explorer' && !phoneS.sidebarHidden ? null : `phone view=${phoneS.view} sidebarHidden=${phoneS.sidebarHidden}`);
await step('PC opens file.txt → the phone opens it, editor page active', () => clickTreeRow(pc, 'file.txt'),
	(pcS, phoneS) => phoneS.active === 'file.txt' && phoneS.sidebarHidden ? null : `phone active=${phoneS.active} sidebarHidden=${phoneS.sidebarHidden}`);
await step('phone opens README.md → the PC opens it', async () => {
	await phone.locator(".ggs-bottom-tabs button[data-tab='explorer']").click();
	await phone.waitForTimeout(400);
	await clickTreeRow(phone, 'README.md');
}, (pcS) => pcS.active === 'README.md' ? null : `pc active=${pcS.active}`);
await step('PC switches back to the file.txt tab → the phone follows', () => clickTab(pc, 'file.txt'),
	(pcS, phoneS) => phoneS.active === 'file.txt' ? null : `phone active=${phoneS.active}`);
await step('phone taps Changes → the PC sidebar is on Source Control', () => phone.locator(".ggs-bottom-tabs button[data-tab='scm']").click(),
	(pcS) => pcS.view === 'scm' && !pcS.sidebarHidden ? null : `pc view=${pcS.view}`);
await step('phone taps Files → the PC sidebar is back on Explorer', () => phone.locator(".ggs-bottom-tabs button[data-tab='explorer']").click(),
	(pcS) => pcS.view === 'explorer' ? null : `pc view=${pcS.view}`);
await step('PC opens Source Control → the phone shows its Changes page', () => clickActivity(pc, 'scm'),
	(pcS, phoneS) => phoneS.view === 'scm' && !phoneS.sidebarHidden ? null : `phone view=${phoneS.view} sidebarHidden=${phoneS.sidebarHidden}`);
await step('PC closes the README.md tab → the phone closes it too', () => closeTab(pc, 'README.md'),
	(pcS, phoneS) => !phoneS.tabs.includes('README.md') && phoneS.tabs.includes('file.txt') ? null : `phone tabs=${JSON.stringify(phoneS.tabs)}`);
await step('PC opens Extensions → the phone follows', () => clickActivity(pc, 'extensions'),
	(pcS, phoneS) => phoneS.view === 'extensions' && !phoneS.sidebarHidden ? null : `phone view=${phoneS.view}`);
await step('phone opens package.json → the PC opens it', async () => {
	await phone.locator(".ggs-bottom-tabs button[data-tab='explorer']").click();
	await phone.waitForTimeout(400);
	await clickTreeRow(phone, 'package.json');
}, (pcS) => pcS.active === 'package.json' ? null : `pc active=${pcS.active}`);

// ---------- The wire: operation sync vs the DOM replica, same session ----------
await pc.waitForTimeout(1000);
const syncTotal = (await syncBytes()) - baseline;
const mirror = await pc.evaluate(() => window.__mirror);
const mirrorTotal = mirror.snapshot + mirror.ops;
const syncMessages = await pc.evaluate(() => (window.__ggsDevEvents.emitted || []).filter((entry) => entry.event === 'studio://workbench-sync').length)
	+ await phone.evaluate(() => (window.__ggsDevEvents.emitted || []).filter((entry) => entry.event === 'studio://workbench-sync').length);

await pc.screenshot({ path: join(out, 'pc-final.png') });
await phone.screenshot({ path: join(out, 'phone-final.png') });

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const ratio = syncTotal === 0 ? Infinity : mirrorTotal / syncTotal;
console.log('');
console.log(`operation sync:   ${syncMessages} messages, ${kb(syncTotal)} total (avg ${Math.round(syncTotal / Math.max(1, syncMessages))} B)`);
console.log(`DOM replica:      snapshot ${kb(mirror.snapshot)} + ${mirror.batches} mutation batches ${kb(mirror.ops)} = ${kb(mirrorTotal)}`);
console.log(`ratio:            1/${Math.round(ratio)} of the replica's wire — the bar is 1/10`);
const underBar = syncTotal * 10 <= mirrorTotal;
console.log(underBar ? 'traffic bar: PASS (≤ 1/10)' : 'traffic bar: FAIL (> 1/10)');
if (!underBar) failures++;

const report = {
	url: base,
	rows,
	traffic: { syncTotal, syncMessages, mirrorSnapshot: mirror.snapshot, mirrorOps: mirror.ops, mirrorBatches: mirror.batches, ratio: Math.round(ratio), underBar },
	errors
};
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`report: ${join(out, 'report.json')}${errors.length ? `\npage errors: ${errors.join('; ')}` : ''}`);

await browser.close();
process.exit(failures > 0 ? 1 : 0);
