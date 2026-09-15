// Attach to a WebView2 CDP target, reload the Git Graph iframe, and collect console
// messages / exceptions for a few seconds.
const port = process.argv[2] ?? '9224';
const seconds = Number(process.argv[3] ?? 6);
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page');
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
const entries = [];
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
	} else if (msg.method === 'Runtime.consoleAPICalled') {
		entries.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
	} else if (msg.method === 'Runtime.exceptionThrown') {
		entries.push('[exception] ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 800));
	} else if (msg.method === 'Log.entryAdded') {
		entries.push(`[log:${msg.params.entry.level}] ${msg.params.entry.source}: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
	} else if (msg.method === 'Runtime.bindingCalled') {
		// ignore
	}
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Runtime.evaluate', { expression: `document.querySelector('iframe[title="Git Graph"]').src = document.querySelector('iframe[title="Git Graph"]').src` });
await new Promise((r) => setTimeout(r, seconds * 1000));
console.log(entries.join('\n') || '(no console entries)');
ws.close();
