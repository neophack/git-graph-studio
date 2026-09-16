// Attach to the app's WebView2 over CDP, wait for the CAN raw view of the launched .asc to
// finish parsing, drag the scrollbar to the very bottom, and verify — in real layout — that
// the tail rows are visible inside the scroller. This is the check jsdom cannot make: real
// engine clamping, real layout, real bounding rectangles.
const port = process.argv[2] ?? '9223';
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
	}
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
await send('Runtime.enable');
const expr = `
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	let view = null;
	for (let i = 0; i < 120; i++) {
		view = document.querySelector('.can-raw-view');
		if (view) break;
		await sleep(1000);
	}
	if (!view) return { ok: false, step: 'the raw view never appeared', url: location.href };
	let chip = '';
	for (let i = 0; i < 300; i++) {
		chip = document.querySelector('.can-raw-view .can-live-text')?.textContent ?? '';
		if (/frames\\s*$/.test(chip) && !chip.includes('parsing')) break;
		await sleep(1000);
	}
	const scroller = document.querySelector('.can-raw-scroll');
	const spacer = document.querySelector('.can-raw-spacer');
	scroller.scrollTop = scroller.scrollHeight;
	scroller.dispatchEvent(new Event('scroll'));
	await sleep(1200);
	const rows = Array.from(document.querySelectorAll('.can-raw-rows .can-raw-row'));
	const srect = scroller.getBoundingClientRect();
	const inView = rows.filter((r) => {
		const rect = r.getBoundingClientRect();
		return rect.height > 0 && rect.bottom > srect.top - 60 && rect.top < srect.bottom + 60;
	});
	const frames = rows.map((r) => Number(r.dataset.frame));
	return {
		ok: inView.length > 0 && rows.length > 0,
		url: location.href,
		chip,
		spacerHeight: spacer.style.height,
		scrollHeight: scroller.scrollHeight,
		scrollTopAfterDrag: scroller.scrollTop,
		rowsRendered: rows.length,
		rowsVisibleInViewport: inView.length,
		firstFrame: frames.length ? Math.min(...frames) : null,
		lastFrame: frames.length ? Math.max(...frames) : null
	};
})()
`;
const result = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(result.result?.value ?? result, null, 2));
ws.close();
