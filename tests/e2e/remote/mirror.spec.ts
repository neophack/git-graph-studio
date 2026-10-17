// mirror.spec.ts (module 19, the DOM replica's browser half): the copy's INPUT layer in a
// real engine — the exact Safari break the owner reported (2026-10-17: claude 的页面输入框
// 不能输入、new session 点击没反应, Chrome 正常). WebKit treats every listener the remote
// page registers on the copy's sandboxed document as that document's own script execution
// and silently drops them all unless the sandbox carries allow-scripts (Chromium runs them),
// so the copy renders but no tap, key or scroll ever reaches the PC. jsdom cannot see the
// rule (it dispatches without sandbox checks); only a real engine can. No daemon and no app
// needed — the page below mounts the viewer and its input layer over modules served by the
// Vite dev server, feeds a Claude-like snapshot (a chat, a "new session" button, a
// contenteditable composer) and collects the up-messages real clicks and typing produce.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
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

// The probe page: a fluid webview-stream copy (webviewCopy.ts's shape — embedded input,
// fluid layout) of a serialized PC page, mounted straight over the dev-server modules.
const PAGE = `<!doctype html><meta charset="utf-8"><style>
	body { margin: 0; font: 14px system-ui; background: #1e1e1e; color: #ccc }
	#host { width: 400px; height: 500px }
	button { padding: 6px 14px; margin: 8px 0 }
	.composer { border: 1px solid #444; padding: 10px 14px; min-height: 20px; white-space: pre-wrap; outline: none }
</style><div id="host" class="webview-copy"></div><script type="module">
	import { DomRecorder } from '/src/remote/mirror/recorder.ts';
	import { MirrorViewer } from '/src/remote/mirror/viewer.ts';
	import { ViewerInput } from '/src/remote/mirror/viewerInput.ts';
	const pc = document.implementation.createHTMLDocument('pc');
	pc.body.innerHTML = '<div class="msg">hello one</div><button id="new-session" type="button">New session</button><div id="composer" class="composer" contenteditable="true"></div>';
	const recorder = new DomRecorder(pc, () => {});
	const snap = recorder.snapshot();
	window.__sent = [];
	window.__resnaps = 0;
	const host = document.getElementById('host');
	let input;
	const viewer = new MirrorViewer(host, 'remote/1', {
		appBase: 'http://localhost:5173/',
		ggsBase: 'http://localhost:5173/',
		stream: 'view:chat',
		fluid: true,
		resnap: () => { window.__resnaps += 1; },
		onDocument: (doc) => input?.attach(doc),
		onCaret: (point) => input?.caretAt(point)
	});
	input = new ViewerInput(viewer, (m) => window.__sent.push(m), document, { embedded: true, parent: host });
	viewer.receive({ k: 'snap', to: 'remote/1', w: 'view:chat', seq: snap.seq, root: snap.root, doc: snap.doc, vp: { w: 400, h: 500 } });
	window.__ready = viewer.root?.querySelectorAll('*').length ?? -1;
</script>`;

let vite: ReturnType<typeof spawn> | null = null;
test.beforeAll(async () => {
	if (await portOpen(5173)) return;
	// strictPort makes every racing worker's extra spawn exit at once; the winner serves.
	vite = spawn('npm run dev:vite', { cwd: root, shell: true, stdio: 'ignore' });
	for (let i = 0; i < 150 && !(await portOpen(5173)); i += 1) await sleep(200);
});
test.afterAll(() => vite?.kill());

/** The probe page's globals (set by the module script PAGE embeds). */
interface ProbeWindow {
	__sent?: Array<{ k: string; ev?: string; v?: string; key?: string }>;
	__resnaps?: number;
	__ready?: number;
}

test('a copy takes input in a real engine — a tap reaches the PC as press and click, typing as text', async ({ page }) => {
	test.setTimeout(120_000);
	const blocked: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error' && /blocked script execution/i.test(m.text())) blocked.push(m.text());
	});
	await page.route('**/__mirror_probe.html', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
	await page.goto('http://localhost:5173/__mirror_probe.html');
	await page.waitForFunction(() => ((window as Window & typeof globalThis & ProbeWindow).__ready ?? -1) > 0);
	const frame = page.frames().find((f) => f !== page.mainFrame());
	expect(frame, 'the copy frame exists').toBeDefined();

	await frame!.locator('#new-session').click();
	await expect
		.poll(() => page.evaluate(() => (window as Window & typeof globalThis & ProbeWindow).__sent?.filter((m) => m.k === 'ptr').map((m) => m.ev) ?? []))
		.toEqual(['hover', 'down', 'up']);

	await frame!.locator('#composer').click();
	// The mousedown is the copy's own to swallow: the hidden proxy holds the focus after it.
	await expect.poll(() => page.evaluate(() => document.activeElement?.className)).toBe('mirror-proxy');
	await page.keyboard.type('hi', { delay: 30 });
	await page.keyboard.press('Enter');
	await expect
		.poll(() => page.evaluate(() => (window as Window & typeof globalThis & ProbeWindow).__sent?.filter((m) => m.k === 'text').map((m) => m.v).join('') ?? ''))
		.toBe('hi');
	await expect
		.poll(() => page.evaluate(() => ((window as Window & typeof globalThis & ProbeWindow).__sent?.some((m) => m.k === 'key' && m.key === 'Enter')) === true))
		.toBe(true);

	// The WebKit failure mode's own signature was a console error per blocked listener.
	expect(blocked).toEqual([]);
	expect(await page.evaluate(() => ((window as Window & typeof globalThis & ProbeWindow).__resnaps ?? -1))).toBe(0);
});
