// A thin banner across the top of the remote workbench (docs/ggs-remote-plan.md §9.2): the
// transport's notices — the relay restored, the PC reconnecting, a new version — that the
// user should see without a modal. One at a time; `ms = 0` keeps it until replaced.
import { t } from '../platform/i18n';

let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The banner's raw form: a resolved text and an optional labelled action — the keyed
 *  `showBanner` builds on it, and a caller with a dynamic title (a tab another frontend
 *  just opened) says its own directly. */
export function showBannerText(text: string, ms = 4000, actionLabel?: string, action?: () => void): void {
	current?.remove();
	clearTimeout(timer);
	const bar = document.createElement('div');
	bar.className = 'remote-banner';
	bar.setAttribute('role', 'status');
	const label = document.createElement('span');
	label.textContent = text;
	bar.appendChild(label);
	if (action !== undefined && actionLabel !== undefined) {
		const button = document.createElement('button');
		button.textContent = actionLabel;
		button.addEventListener('click', action);
		bar.appendChild(button);
	}
	document.body.appendChild(bar);
	current = bar;
	if (ms > 0) timer = setTimeout(() => hideBanner(), ms);
}

export function showBanner(key: string, ms = 4000, action?: () => void): void {
	showBannerText(t(key as never), ms, action !== undefined ? t('remote.banner.reload') : undefined, action);
}

export function hideBanner(): void {
	current?.remove();
	current = null;
}
