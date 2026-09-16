// One CDP run against the app page (targeted by URL, not "the first page"): waits for the
// CAN raw view, clicks Text (the 1 GB file must land in the indexed, memory-bounded fast
// viewer), then reports mount time, first text, drag-to-bottom latency and content.
const port = process.argv[2] ?? '9223';
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'));
if (!page) throw new Error('no app page target');
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
	const click = (el) => { for (const t of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(t, {bubbles: true, cancelable: true})); };
	// 1. The raw CAN view finishes its walk.
	let chip = '';
	for (let i = 0; i < 300; i++) {
		chip = document.querySelector('.can-raw-view .can-live-text')?.textContent ?? '';
		if (/frames\\s*$/.test(chip) && !chip.includes('parsing')) break;
		await sleep(500);
	}
	// 2. Text: the 1 GB file must open in the indexed fast viewer.
	const t0 = performance.now();
	click(document.querySelector('.can-text'));
	let scroller = null;
	for (let i = 0; i < 200; i++) { scroller = document.querySelector('.fast-scroll'); if (scroller) break; await sleep(10); }
	const mountMs = Math.round(performance.now() - t0);
	let row = null;
	for (let i = 0; i < 200; i++) { row = document.querySelector('.fast-row .fast-code'); if (row) break; await sleep(10); }
	const firstTextMs = Math.round(performance.now() - t0);
	const firstText = row?.textContent?.slice(0, 50) ?? null;
	await sleep(2500); // the index lands meanwhile
	// 3. Drag to the very bottom: the tail lines must appear, fast.
	const before = document.querySelector('.fast-row .fast-code')?.textContent ?? '';
	const t1 = performance.now();
	scroller.scrollTop = scroller.scrollHeight;
	scroller.dispatchEvent(new Event('scroll'));
	let bottom = null, bottomMs = -1;
	for (let i = 0; i < 400; i++) {
		await sleep(5);
		const rows = Array.from(document.querySelectorAll('.fast-row'));
		const last = rows[rows.length - 1]?.querySelector('.fast-code')?.textContent ?? '';
		if (rows.length && last && last !== before && /990\\.|989\\./.test(last)) {
			bottom = last.slice(0, 60); bottomMs = Math.round(performance.now() - t1); break;
		}
	}
	// 4. A mid-file drag.
	const t2 = performance.now();
	scroller.scrollTop = Math.floor(scroller.scrollHeight / 2);
	scroller.dispatchEvent(new Event('scroll'));
	let mid = null, midMs = -1;
	for (let i = 0; i < 400; i++) {
		await sleep(5);
		const first = document.querySelector('.fast-row .fast-code')?.textContent ?? '';
		if (first && first !== before && !/date Mon/.test(first) && !/989\\.|990\\./.test(first)) {
			mid = first.slice(0, 60); midMs = Math.round(performance.now() - t2); break;
		}
	}
	return { chip, mountMs, firstTextMs, firstText, bottomMs, bottom, midMs, mid, spacer: document.querySelector('.fast-spacer')?.style.height ?? null, docEdit: !!document.querySelector('.doc-edit') };
})()
`;
const result = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(result.result?.value ?? result, null, 2));
ws.close();
