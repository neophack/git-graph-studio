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
	if (!status.unlocked) return;
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
	const first = status.links?.[0];
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

document.getElementById('unlock-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const error = document.getElementById('unlock-error');
	const response = await postJson('pair/unlock', { ticket, password: document.getElementById('unlock-password').value });
	if (response.ok) {
		unlock = response.data.unlock;
		error.textContent = '';
		render();
	} else if (response.status === 429) error.textContent = t('locked', { n: response.data?.retryAfter ?? 60 });
	else error.textContent = t('wrongPassword');
});

async function setPassword(input, errorId) {
	const error = document.getElementById(errorId);
	const response = await postJson('pair/password', { ticket, unlock, password: document.getElementById(input).value });
	if (response.ok) {
		unlock = response.data.unlock;
		error.textContent = t('saved');
		render();
	} else {
		error.textContent = response.data?.error === 'weak-password' ? t('weak') : String(response.data?.error ?? response.status);
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
