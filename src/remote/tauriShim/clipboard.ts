// `@tauri-apps/plugin-clipboard-manager` for the remote workbench (§9.3, §11.5): the
// browser's clipboard, with the classic fallbacks where it is unavailable (an insecure
// context — a self-signed certificate the device does not trust): `execCommand('copy')` to
// write, a prompt to paste into.
import { quickInput } from '../../platform/ui';
import { t } from '../../platform/i18n';

export async function writeText(text: string): Promise<void> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return;
		}
	} catch {
		/* fall through to the legacy path */
	}
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.opacity = '0';
	document.body.appendChild(area);
	area.select();
	try {
		document.execCommand('copy');
	} finally {
		area.remove();
	}
}

export async function readText(): Promise<string> {
	try {
		if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
	} catch {
		/* permission denied or insecure context */
	}
	return (await quickInput({ title: t('remote.clipboard.pasteTitle'), placeholder: t('remote.clipboard.pastePlaceholder') })) ?? '';
}
