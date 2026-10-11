// A thin banner across the top of the remote workbench (docs/ggs-remote-plan.md §9.2): the
// transport's notices — the relay restored, the PC reconnecting, a new version — that the
// user should see without a modal. One at a time; `ms = 0` keeps it until replaced.
import { t } from '../i18n';

let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function showBanner(key: string, ms = 4000, action?: () => void): void {
	current?.remove();
	clearTimeout(timer);
	const bar = document.createElement('div');
	bar.className = 'remote-banner';
	bar.setAttribute('role', 'status');
	const text = document.createElement('span');
	text.textContent = t(key as never);
	bar.appendChild(text);
	if (action) {
		const button = document.createElement('button');
		button.textContent = t('remote.banner.reload');
		button.addEventListener('click', action);
		bar.appendChild(button);
	}
	document.body.appendChild(bar);
	current = bar;
	if (ms > 0) timer = setTimeout(() => hideBanner(), ms);
}

export function hideBanner(): void {
	current?.remove();
	current = null;
}
