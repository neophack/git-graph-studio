// The window picker (docs/ggs-remote-plan.md §13, R10/R20/R21): every GGS window on this
// PC as a card with its content summary and state, live over the ggs-remote/1 WebSocket —
// open, close (with the unsaved-files confirmation) and restart. The recent-paths list
// and the folder-path row (2026-10-12) open folders without the old "new window" button,
// which is gone at the owner's direction. The recent list carries only the folders NO
// window has open (2026-10-16, the owner's direction: one a window already shows is that
// window's card above — never re-listed here), each row with its open button. The
// typed-path row above the window list is
// KEPT at the owner's 2026-10-16 direction ("此 PC 上的窗口"上面输入文件夹路径打开 ggs 的要保留):
// it spawns a new (by default invisible) window for the path — the sandbox confines the
// spawn when on. What K4 still means: the remote WORKBENCH a session drives never opens
// folders, files or new windows; this landing page is the one door. Plus this device's
// settings: the device list and the password change; sign-out sits in the header.
import { t, translate, el, postJson } from './i18n.js';
import { T, encodeFrame, decodeFrames } from './wire.js';

translate();
const windowsEl = document.getElementById('windows');
const banner = document.getElementById('banner');
let ws;
let instances = [];
let recentFolders = [];
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

/** Open a folder from the recent list: a window already showing it is entered, anything
 *  else spawns a new (invisible) window for it — the same open either way (the typed-path
 *  row's own capability, 2026-10-16 kept at the owner's direction). The enter-if-open
 *  half is a click-time race guard: the list only carries closed folders, but a window
 *  may have taken one between the render and the click, and entering it beats spawning
 *  a duplicate. */
function openPath(path) {
	const info = instances.find((i) => (i.folders ?? []).includes(path));
	if (info) openInstance(info);
	else send(T.SPAWN, { folder: path, visible: false });
}

function renderRecent() {
	const card = document.getElementById('recent-card');
	const list = document.getElementById('recent');
	// Only the folders no window has open (2026-10-16, the owner's direction): a folder
	// some window already shows is that window's card above. The list re-renders on every
	// WINDOWS push, so a folder leaves the list when its window opens and returns when
	// that window closes.
	const closed = recentFolders.filter((path) => !instances.some((i) => (i.folders ?? []).includes(path)));
	card.hidden = closed.length === 0;
	list.replaceChildren(
		...closed.map((path) =>
			el(
				'li',
				{},
				el('span', { class: 'path' }, path),
				el('button', { class: 'primary', onclick: () => openPath(path) }, t('open'))
			)
		)
	);
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
	if (info.sandboxed) badges.push(el('span', { class: 'badge' }, t('sandboxed')));
	if (info.minimized) badges.push(el('span', { class: 'badge' }, t('minimized')));
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
			// The PC window's own lifecycle (docs/remote-client-plan.md §6.8, §17): hide or
			// show the desktop window — the instance keeps running, this session stays.
			info.visible && !info.minimized
				? el('button', { onclick: () => send(T.INSTANCE_DISPLAY, { instance: info.id, visible: false }) }, t('pcHide'))
				: el('button', { onclick: () => send(T.INSTANCE_DISPLAY, { instance: info.id, visible: true }) }, t('pcShow')),
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
	renderRecent();
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
			recentFolders = frame.body?.recentFolders ?? recentFolders;
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
	const { csrf, folderInput, sandbox } = await session.json();
	// The folder-path row is a setting (2026-10-12): off hides it, the recent list stays.
	// The sandbox (§24) hides it too — a typed path outside the sandbox root could never
	// open; everything a remote session opens lives under the root.
	if (folderInput === false || (sandbox && sandbox.enabled)) {
		document.getElementById('open-row').hidden = true;
	}
	// The sandbox's own open button (§24): with the typed-path row hidden there is no
	// other entry into an empty sandbox, and every spawn lands inside the root.
	document.getElementById('sandbox-row').hidden = !(sandbox && sandbox.enabled);
	document.getElementById('sandbox-open').addEventListener('click', () => {
		send(T.SPAWN, { folder: null, visible: false });
	});
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

// The folder-path row (kept at the owner's 2026-10-16 direction): type a path (or pick
// one from the recent list), open it as a new (invisible) window. The standalone "new
// window" button stays gone (2026-10-12, the owner's direction — it was unused); an
// empty path opens nothing.
function openTypedFolder() {
	const folder = document.getElementById('open-folder').value.trim();
	if (folder) send(T.SPAWN, { folder, visible: false });
}
document.getElementById('open-go').addEventListener('click', openTypedFolder);
document.getElementById('open-folder').addEventListener('keydown', (event) => {
	if (event.key === 'Enter') {
		event.preventDefault();
		openTypedFolder();
	}
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
