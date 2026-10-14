// Progress toasts (`withProgress`: an extension task with a visible bar).

import { el } from './dom';
import { icon } from './codicon';
import { t } from '../i18n';

/** A progress toast's handle: `update` moves the bar (null keeps the indeterminate pulse),
 *  `done` removes it. */
export interface ProgressToast {
	update(percent: number | null, message?: string): void;
	done(): void;
}

/** Show a toast with a progress bar that lives until `done` — the UI behind
 *  `vscode.window.withProgress`. The bar starts indeterminate (the null pulse) until the
 *  first report with a value arrives. `onCancel`, when given, renders the Cancel action a
 *  cancellable long task offers (a file transfer's stop button). */
export function progressToast(title: string, onCancel?: () => void): ProgressToast {
	const container = document.getElementById('notifications')!;
	const fill = el('i');
	const track = el('div', 'progress-track', [fill]);
	fill.classList.add('indeterminate');
	const label = el('div', 'message', [title]);
	const body = el('div', 'body', [label, track]);
	const toast = el('div', 'notification', [icon('sync', 'codicon-modifier-spin'), body]);
	let cancelled = false;
	if (onCancel) {
		const buttons = el('div', 'buttons');
		const button = el('button', 'button', [t('transfer.cancel')]);
		button.addEventListener('click', () => {
			cancelled = true;
			toast.remove();
			onCancel();
		});
		buttons.appendChild(button);
		body.appendChild(buttons);
	}
	container.appendChild(toast);
	return {
		update(percent, message): void {
			label.textContent = message && message !== '' ? message : title;
			if (percent === null) {
				fill.classList.add('indeterminate');
				fill.style.width = '';
			} else {
				fill.classList.remove('indeterminate');
				fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
			}
		},
		done(): void {
			// A cancel already removed the toast; the report that follows only closes it.
			if (cancelled) return;
			toast.remove();
		}
	};
}
