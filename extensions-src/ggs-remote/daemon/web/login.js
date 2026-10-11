// The login page: POST api/login, then the window picker. A `reason` query parameter explains
// why the user landed here (password changed, signed out, session expired).
import { t, translate, postJson } from './i18n.js';

translate();
const params = new URLSearchParams(location.search);
const reason = params.get('reason');
if (reason) {
	const box = document.getElementById('reason');
	box.textContent = t(`reason.${reason}`);
	box.hidden = false;
}
// A fresh login is a fresh start: no stale workbench state from a previous session.
try {
	sessionStorage.clear();
} catch {
	/* storage unavailable */
}
const device = document.getElementById('device');
try {
	device.value = localStorage.getItem('ggsr.device') ?? '';
} catch {
	/* storage unavailable */
}

let lockTimer;
document.getElementById('form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const error = document.getElementById('error');
	const submit = document.getElementById('submit');
	error.textContent = '';
	submit.disabled = true;
	try {
		const response = await postJson('api/login', {
			password: document.getElementById('password').value,
			device: device.value,
			remember: document.getElementById('remember').checked
		});
		if (response.ok) {
			try {
				localStorage.setItem('ggsr.device', device.value);
			} catch {
				/* storage unavailable */
			}
			location.replace(params.get('next') && params.get('next').startsWith('w/') ? params.get('next') : 'windows');
			return;
		}
		if (response.status === 429) {
			let left = response.data?.retryAfter ?? 60;
			clearInterval(lockTimer);
			const show = () => {
				error.textContent = t('locked', { n: left });
				if (left-- <= 0) {
					clearInterval(lockTimer);
					error.textContent = '';
					submit.disabled = false;
				}
			};
			show();
			lockTimer = setInterval(show, 1000);
			return;
		}
		error.textContent = response.status === 401 ? t('wrongPassword') : t('failed', { msg: response.data?.error ?? response.status });
	} catch (e) {
		error.textContent = t('failed', { msg: String(e) });
	}
	submit.disabled = false;
});
