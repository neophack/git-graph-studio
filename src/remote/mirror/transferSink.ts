// The replica page's transfer surface: transfer.ts reports through a sink, and its default
// is the workbench's own toasts — DOM this page never builds (`#notifications` belongs to
// the workbench the PC runs). The mirror's sink is one small card over the copy: a progress
// toast while an upload streams, the outcome notices after.
import { setTransferSink, type TransferSink } from '../../transfer';

function card(message: string, kind: 'info' | 'error' | 'progress' = 'info'): HTMLElement {
	const card = document.createElement('div');
	card.className = `mirror-toast${kind === 'error' ? ' error' : ''}`;
	card.setAttribute('role', 'status');
	const text = document.createElement('span');
	text.className = 'message';
	text.textContent = message;
	card.appendChild(text);
	document.body.appendChild(card);
	return card;
}

export const mirrorTransferSink: TransferSink = {
	// The mirror rides the remote wire, whose transport carries no cancel — the button the
	// desktop's own toasts would offer never shows here.
	progress(title) {
		const toast = card(title, 'progress');
		const fill = document.createElement('i');
		fill.className = 'indeterminate';
		const track = document.createElement('div');
		track.className = 'mirror-toast-track';
		track.appendChild(fill);
		toast.appendChild(track);
		return {
			update(percent, message) {
				toast.querySelector('.message')!.textContent = message && message !== '' ? message : title;
				if (percent === null) {
					fill.classList.add('indeterminate');
					fill.style.width = '';
				} else {
					fill.classList.remove('indeterminate');
					fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
				}
			},
			done() {
				toast.remove();
			}
		};
	},
	info(message) {
		const toast = card(message);
		setTimeout(() => toast.remove(), 4000);
	},
	error(message) {
		const toast = card(message, 'error');
		setTimeout(() => toast.remove(), 8000);
	}
};

/** Installed by the mirror boot (viewerBoot.ts), before any transfer can run. */
export function installMirrorTransferSink(): void {
	setTransferSink(mirrorTransferSink);
}
