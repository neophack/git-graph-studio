// The window picker (docs/ggs-remote-plan.md §13, R10/R12/R20/R21): every GGS window on this
// PC as a card with its content summary and state, live over the ggs-remote/1 WebSocket —
// open, new, close (with the unsaved-files confirmation) and restart. Plus this device's
// settings: the device list, the password change and sign-out.
import { t, translate, el, postJson } from './i18n.js';
import { T, encodeFrame, decodeFrames } from './wire.js';

translate();
const windowsEl = document.getElementById('windows');
const banner = document.getElementById('banner');
let ws;
let instances = [];
let pendingOpen = null;
let retry = 500;

const params = new URLSearchParams(location.search);
const AUTO_KEY = 'ggsr.autoEnter';
const autoEnter = document.getElementById('auto-enter');
try {
	autoEnter.checked = localStorage.getItem(AUTO_KEY) === '1';
} catch {
	/* storage unavailable */
}
autoEnter.addEventListener('change', () => {
	try {
		localStorage.setItem(AUTO_KEY, autoEnter.checked ? '1' : '0');
	} catch {
		/* storage unavailable */
	}
});

function toLogin(reason) {
	location.replace(`login${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`);
}

function openInstance(info) {
	location.href = `w/${encodeURIComponent(info.id)}/v/${encodeURIComponent(info.version)}/remote.html`;
}

function duration(secs) {
	if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))} min`;
	if (secs < 86400) return `${Math.round(secs / 3600)} h`;
	return `${Math.round(secs / 86400)} d`;
}

function send(type, body) {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(type, body));
}

function card(info, now) {
	const summary = info.summary ?? {};
	const tabs = summary.tabs ?? [];
	const badges = [];
	if (info.state === 'unresponsive') badges.push(el('span', { class: 'badge bad' }, t('unresponsive')));
	if (!info.visible) badges.push(el('span', { class: 'badge' }, t('hidden')));
	if (info.remoteSessions) badges.push(el('span', { class: 'badge' }, t('sessions', { n: info.remoteSessions })));
	if (summary.terminals) badges.push(el('span', { class: 'badge' }, t('terminals', { n: summary.terminals })));
	if (summary.dirty) badges.push(el('span', { class: 'badge warn' }, t('unsaved', { n: summary.dirty })));
	if (summary.scmChanges) badges.push(el('span', { class: 'badge' }, t('changes', { n: summary.scmChanges })));
	if (info.startedAt) badges.push(el('span', { class: 'badge' }, t('uptime', { t: duration(now - info.startedAt) })));
	const active = tabs.find((tab) => tab.active);
	const tabList = el(
		'ul',
		{ class: 'tabs' },
		tabs.length === 0
			? el('li', { class: 'muted' }, t('noTabs'))
			: tabs.map((tab) => el('li', { class: [tab.active ? 'active' : '', tab.dirty ? 'dirty' : ''].join(' ').trim() }, tab.path))
	);
	const restart = () => {
		if (confirm(t('restartConfirm'))) send(T.INSTANCE_RESTART, { instance: info.id });
	};
	return el(
		'article',
		{ class: 'window' },
		el('h3', {}, info.title || info.id),
		el('div', { class: 'folders' }, (info.folders ?? []).join(' · ')),
		el('div', { class: 'badges' }, badges),
		active ? el('div', { class: 'muted' }, active.path) : null,
		el('details', {}, el('summary', {}, `${t('details')} (${tabs.length})`), tabList),
		el(
			'div',
			{ class: 'actions' },
			el('button', { class: 'primary', onclick: () => openInstance(info) }, t('open')),
			el('button', { onclick: () => send(T.INSTANCE_CLOSE, { instance: info.id, force: false }) }, t('close')),
			el('button', { onclick: restart }, t('restart'))
		)
	);
}

let entered = false;
function render() {
	const now = Date.now() / 1000;
	windowsEl.replaceChildren(...instances.map((info) => card(info, now)));
	document.getElementById('empty').hidden = instances.length > 0;
	if (!entered && instances.length === 1 && autoEnter.checked && !params.get('reason')) {
		entered = true;
		openInstance(instances[0]);
	}
}

function onFrame(frame) {
	switch (frame.type) {
		case T.HELLO_ACK:
			retry = 500;
			banner.hidden = true;
			break;
		case T.WINDOWS:
			instances = frame.body?.instances ?? [];
			render();
			if (pendingOpen) {
				const info = instances.find((i) => i.id === pendingOpen);
				if (info) openInstance(info);
			}
			break;
		case T.SPAWNED: {
			const id = frame.body?.instance;
			const info = instances.find((i) => i.id === id);
			if (info) openInstance(info);
			else pendingOpen = id;
			break;
		}
		case T.NOTICE: {
			const notice = frame.body ?? {};
			if (notice.kind === 'close-blocked') {
				if (confirm(t('closeBlocked', { files: (notice.dirty ?? []).join('\n') }))) {
					send(T.INSTANCE_CLOSE, { instance: notice.instance, force: true });
				}
			} else if (notice.kind === 'spawn-failed') alert(t('spawnFailed', { msg: notice.message ?? '' }));
			else if (notice.kind === 'restart-failed') alert(t('restartFailed', { msg: notice.message ?? '' }));
			break;
		}
		case T.CLOSE:
			if (frame.body?.code === 4401) toLogin(frame.body.reason);
			break;
	}
}

function reconnectLater() {
	banner.textContent = t('reconnecting');
	banner.hidden = false;
	retry = Math.min(retry * 2, 8000);
	setTimeout(connect, retry);
}

async function connect() {
	let session;
	try {
		session = await fetch('api/session', { credentials: 'same-origin' });
	} catch {
		return reconnectLater();
	}
	if (session.status === 401) return toLogin();
	if (!session.ok) return reconnectLater();
	const { csrf } = await session.json();
	const url = new URL('ws', document.baseURI);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	ws = new WebSocket(url);
	ws.binaryType = 'arraybuffer';
	ws.onopen = () => send(T.HELLO, { proto: 1, client: 'picker', ver: '1', caps: { deflate: false }, csrf });
	ws.onmessage = (event) => decodeFrames(event.data).forEach(onFrame);
	ws.onclose = (event) => {
		if (event.code === 4401) return toLogin(event.reason);
		reconnectLater();
	};
}

setInterval(() => send(T.PING, {}), 20000);

document.getElementById('new-window').addEventListener('click', () => {
	const row = document.getElementById('new-row');
	row.hidden = !row.hidden;
	if (!row.hidden) document.getElementById('new-folder').focus();
});
document.getElementById('new-go').addEventListener('click', () => {
	const folder = document.getElementById('new-folder').value.trim();
	send(T.SPAWN, { folder: folder || null, visible: false });
});

async function loadDevices() {
	const response = await fetch('api/devices', { credentials: 'same-origin' });
	if (!response.ok) return;
	const { devices } = await response.json();
	const remove = async (id) => {
		await fetch(`api/devices/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
		loadDevices();
	};
	document.getElementById('devices').replaceChildren(
		...devices.map((d) =>
			el(
				'li',
				{},
				el('span', {}, d.device),
				el('span', { class: 'muted' }, d.current ? `(${t('thisDevice')})` : d.ip),
				el('span', { class: 'spacer' }),
				d.current ? null : el('button', { class: 'danger', onclick: () => remove(d.id) }, t('disconnect'))
			)
		)
	);
}
document.getElementById('settings').addEventListener('toggle', (event) => {
	if (event.target.open) loadDevices();
});

document.getElementById('password-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const error = document.getElementById('password-error');
	const response = await postJson('api/password', {
		current: document.getElementById('current').value,
		password: document.getElementById('next').value
	});
	if (response.ok) return toLogin('password-changed');
	error.textContent =
		response.data?.error === 'weak-password' ? t('weak') : response.status === 401 ? t('wrongPassword') : String(response.data?.error ?? response.status);
});

document.getElementById('sign-out').addEventListener('click', async () => {
	await postJson('api/logout', {});
	toLogin();
});

connect();
