// The loopback pair page (docs/ggs-remote-plan.md §7.6, §7.9, R19): opened from the tray or
// the Remote Access page with a one-time ticket; nothing — no address, no QR code — shows
// until the access password unlocks it, and it locks again after five minutes. The first
// visit on a fresh install sets the password instead.
import { t, translate, el, postJson } from './i18n.js';

translate();
const ticket = new URLSearchParams(location.search).get('t') ?? '';
let unlock = '';
let relockTimer;

const show = (id, visible) => {
	document.getElementById(id).hidden = !visible;
};

async function state() {
	const response = await fetch(`pair/state?t=${encodeURIComponent(ticket)}&u=${encodeURIComponent(unlock)}`);
	if (!response.ok) {
		document.querySelector('main').replaceChildren(el('section', { class: 'card' }, el('p', {}, t('reason.expired'))));
		return null;
	}
	return response.json();
}

function relativeTime(secs) {
	if (!secs) return t('never');
	const ago = Math.max(0, Date.now() / 1000 - secs);
	if (ago < 90) return `${Math.round(ago)} s`;
	if (ago < 5400) return `${Math.round(ago / 60)} min`;
	return `${Math.round(ago / 3600)} h`;
}

async function render() {
	const status = await state();
	if (!status) return;
	show('first-form', !status.passwordSet);
	show('unlock-form', status.passwordSet && !status.unlocked);
	show('unlocked', status.unlocked);
	show('change', status.unlocked);
	show('ca', status.unlocked && status.tls?.mode === 'self-signed');
	// The server card lives on the password screens themselves: a server saved before any
	// password exists is held and connects the moment one lands.
	renderRelay(status.hub ?? {});
	if (!status.unlocked) return;
	// While the relay is online its link is the one QR shown (the LAN codes hide,
	// 2026-10-12) — the intro says so; otherwise the LAN scan line stands.
	document.getElementById('links-intro').textContent =
		status.hub?.state === 'online' ? t('linksRelay') : t('links');
	const links = document.getElementById('links');
	links.replaceChildren(
		...(status.links ?? []).map((link) =>
			el(
				'div',
				{ class: 'link' },
				el('img', {
					alt: link,
					src: `pair/qr?t=${encodeURIComponent(ticket)}&u=${encodeURIComponent(unlock)}&text=${encodeURIComponent(link)}`
				}),
				el('code', {}, link)
			)
		)
	);
	const foreign = document.getElementById('foreign');
	foreign.textContent = status.lastForeignAccess ? t('lastForeign', { t: relativeTime(status.lastForeignAccess) }) : t('firewall');
	document.getElementById('fingerprint').textContent = status.tls?.caFingerprint ?? '';
	// The CA anchors on a LAN link: the certificate belongs to the daemon's own listener,
	// not the relay that (when online) leads `links`.
	const first = status.lanLinks?.[0] ?? status.links?.[0];
	if (first) {
		document.getElementById('ca-ios').href = new URL('ca.mobileconfig', first).href;
		document.getElementById('ca-crt').href = new URL('ca.crt', first).href;
	}
	clearTimeout(relockTimer);
	relockTimer = setTimeout(() => {
		unlock = '';
		render();
		document.getElementById('unlock-error').textContent = t('relocked');
	}, 5 * 60 * 1000);
}

function relayState(hub) {
	switch (hub.state) {
		case 'no-password':
			return t('relay.noPassword');
		case 'connecting':
			return t('relay.connecting', { url: hub.url ?? '' });
		case 'online':
			return t('relay.online', { base: hub.publicBase ?? '' });
		case 'rejected':
			return t('relay.rejected', { reason: hub.reason ?? '' });
		case 'replaced':
			return t('relay.replaced');
		default:
			return t('relay.unconfigured');
	}
}

function renderRelay(hub) {
	document.getElementById('relay').hidden = false;
	const settings = hub.settings ?? {};
	const url = document.getElementById('relay-url');
	const key = document.getElementById('relay-key');
	if (document.activeElement !== url) url.value = settings.url ?? '';
	if (document.activeElement !== key) key.value = settings.joinKey ?? '';
	document.getElementById('relay-state').textContent = relayState(hub);
	document.getElementById('relay-disconnect').hidden = hub.state === 'unconfigured';
}

document.getElementById('relay-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const error = document.getElementById('relay-error');
	const response = await postJson('pair/hub/connect', {
		ticket,
		url: document.getElementById('relay-url').value.trim(),
		joinKey: document.getElementById('relay-key').value
	});
	if (response.ok) {
		error.textContent = '';
		render();
	} else {
		const message = String(response.data?.error ?? response.status);
		alert(message);
		error.textContent = message;
	}
});

document.getElementById('relay-disconnect').addEventListener('click', async () => {
	await postJson('pair/hub/disconnect', { ticket });
	render();
});

document.getElementById('unlock-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const error = document.getElementById('unlock-error');
	const response = await postJson('pair/unlock', { ticket, password: document.getElementById('unlock-password').value });
	if (response.ok) {
		unlock = response.data.unlock;
		error.textContent = '';
		render();
	} else if (response.status === 429) {
		error.textContent = t('locked', { n: response.data?.retryAfter ?? 60 });
	} else {
		alert(t('wrongPassword'));
		error.textContent = t('wrongPassword');
	}
});

async function setPassword(input, errorId) {
	const error = document.getElementById(errorId);
	const response = await postJson('pair/password', { ticket, unlock, password: document.getElementById(input).value });
	if (response.ok) {
		unlock = response.data.unlock;
		error.textContent = t('saved');
		render();
	} else {
		const message = response.data?.error === 'weak-password' ? t('weak') : String(response.data?.error ?? response.status);
		alert(message);
		error.textContent = message;
	}
}

document.getElementById('first-form').addEventListener('submit', (event) => {
	event.preventDefault();
	setPassword('first-password', 'first-error');
});
document.getElementById('change-form').addEventListener('submit', (event) => {
	event.preventDefault();
	setPassword('change-password', 'change-error');
});

render();
