// The phone's terminal key row (docs/ggs-remote-plan.md §11.3 Integrated Terminal): the keys
// a phone keyboard lacks — Esc, Tab, sticky Ctrl / Alt, arrows, Home / End and the shell's
// punctuation — sent to the active shell through the terminal's send event.
import { TERMINAL_SEND_EVENT } from '../terminal';

const ESC = String.fromCharCode(27);

export const KEYS: { label: string; data?: string; modifier?: 'ctrl' | 'alt' }[] = [
	{ label: 'Esc', data: ESC },
	{ label: 'Tab', data: '\t' },
	{ label: 'Ctrl', modifier: 'ctrl' },
	{ label: 'Alt', modifier: 'alt' },
	{ label: '↑', data: `${ESC}[A` },
	{ label: '↓', data: `${ESC}[B` },
	{ label: '←', data: `${ESC}[D` },
	{ label: '→', data: `${ESC}[C` },
	{ label: '|', data: '|' },
	{ label: '~', data: '~' },
	{ label: '/', data: '/' },
	{ label: '-', data: '-' },
	{ label: 'Home', data: `${ESC}[H` },
	{ label: 'End', data: `${ESC}[F` }
];

/** Apply a sticky modifier to one key: Ctrl+letter → the control character, Alt → ESC prefix. */
export function withModifier(data: string, modifier: 'ctrl' | 'alt' | null): string {
	if (modifier === 'ctrl' && data.length === 1) {
		const code = data.toUpperCase().charCodeAt(0);
		if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
		if (data === ' ') return String.fromCharCode(0);
	}
	if (modifier === 'alt') return `${ESC}${data}`;
	return data;
}

export function send(data: string): void {
	window.dispatchEvent(new CustomEvent(TERMINAL_SEND_EVENT, { detail: data }));
}

/** Build the key row; a sticky modifier also applies to the next letter typed on the device
 *  keyboard (caught on the terminal's own textarea). */
export function createTerminalKeys(): HTMLElement {
	const row = document.createElement('div');
	row.className = 'ggs-terminal-keys';
	let sticky: 'ctrl' | 'alt' | null = null;
	const buttons = new Map<string, HTMLButtonElement>();
	const setSticky = (next: 'ctrl' | 'alt' | null) => {
		sticky = next;
		for (const [label, button] of buttons) button.classList.toggle('on', label.toLowerCase() === sticky);
	};
	for (const key of KEYS) {
		const button = document.createElement('button');
		button.textContent = key.label;
		button.tabIndex = -1;
		// Keep the terminal focused (and the device keyboard up) while tapping the row.
		button.addEventListener('pointerdown', (event) => event.preventDefault());
		button.addEventListener('click', () => {
			if (key.modifier) {
				setSticky(sticky === key.modifier ? null : key.modifier);
				return;
			}
			send(withModifier(key.data!, sticky));
			setSticky(null);
		});
		buttons.set(key.label, button);
		row.appendChild(button);
	}
	document.addEventListener(
		'beforeinput',
		(event) => {
			const target = event.target as HTMLElement | null;
			if (!sticky || !target?.classList.contains('xterm-helper-textarea')) return;
			const data = (event as InputEvent).data;
			if (!data) return;
			event.preventDefault();
			send(withModifier(data, sticky));
			setSticky(null);
		},
		true
	);
	return row;
}
