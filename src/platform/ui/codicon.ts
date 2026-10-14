// Codicon glyphs (`@vscode/codicons`) — the icon font VS Code itself draws with — and the
// button shapes built on them.

import { el } from './dom';

/** A codicon glyph (`@vscode/codicons`), the icon font VS Code itself draws with. */
export function icon(name: string, className = ''): HTMLElement {
	return el('span', `codicon codicon-${name}${className ? ' ' + className : ''}`);
}

/** A label in VS Code's icon syntax — `$(sync~spin) Indexing` — as text and codicon nodes
 *  (status bar items, tree labels and title actions all spell icons this way). */
export function labelWithIcons(text: string): (string | HTMLElement)[] {
	const out: (string | HTMLElement)[] = [];
	let at = 0;
	for (const match of text.matchAll(/\$\(([\w-]+)(~spin)?\)/g)) {
		if (match.index! > at) out.push(text.slice(at, match.index));
		out.push(icon(match[1]!, match[2] ? 'codicon-modifier-spin' : ''));
		at = match.index! + match[0].length;
	}
	if (at < text.length) out.push(text.slice(at));
	return out;
}

/** A 22px toolbar button: a codicon with a title, as VS Code's view title actions. */
export function actionButton(iconName: string, title: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
	const button = el('button', 'action-btn', [icon(iconName)]);
	button.title = title;
	button.setAttribute('aria-label', title);
	button.addEventListener('click', (event) => {
		event.stopPropagation();
		onClick(event);
	});
	return button;
}
