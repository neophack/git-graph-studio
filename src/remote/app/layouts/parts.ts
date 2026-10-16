// The layout parts (docs/remote-client-plan.md §4.2): the persistent elements the five
// layouts arrange, built exactly once — the workbench frame's own top-level elements plus
// the remote chrome (the app bar, the bottom navigation, the nav rail, the editing row, the
// remote indicator). parts.ts collects them for the layout host; which layout shows which
// part is the layouts' business, but the ELEMENTS never change identity across a switch —
// that stability is what keeps open tabs, dirty buffers and terminal sessions alive while
// the device rotates.
//
// The panel-scoped and editor-scoped chrome (the terminal key row, the editor empty state)
// is placed once into ITS part here: those live inside #panel / #editorPart and move with
// the workbench, whatever layout arranges it.
import { el } from '../../../platform/ui';
import { createAppBar } from '../../appBar';
import { createBottomTabs } from '../../bottomTabs';
import { createEditorAccessory } from '../../editorAccessory';
import { createEditorEmptyState, openEditorActions, openEditorsSheet } from '../../editorSwitcher';
import { createNavRail } from '../../navRail';
import { createTerminalKeys } from '../../terminalKeys';
import { openDrawer } from '../../navDrawer';
import { currentWorkbench } from '../../../workbench';
import { workspaceName } from '../../appBar';
import { openWindowSwitcher } from '../../windowSwitcher';
import type { LayoutParts } from './shared';

/** The desktop form's remote indicator (§5.5): `>< GGS: <workspace>` in the status bar's
 *  leftmost slot, in the remote item's own colour; a tap opens the window switcher. The
 *  workspace name is refreshed by the host on every switch (refreshLayoutParts). */
function createRemoteIndicator(): HTMLElement {
	const item = el('div', 'status-item ggs-indicator-remote');
	const mark = el('span', 'remote-mark');
	mark.textContent = '><';
	const name = el('span', 'remote-name');
	name.textContent = workspaceName() || 'GGS';
	item.append(mark, name);
	item.addEventListener('click', () => void openWindowSwitcher());
	return item;
}

/** Collect the persistent parts. The workbench must have booted (its skeleton elements
 *  exist); the chrome is built here, once, in the order the layouts adopt them. */
export function collectLayoutParts(): LayoutParts {
	const workbench = document.getElementById('workbench')!;
	const panel = document.getElementById('panel');
	if (panel && !panel.querySelector('.ggs-terminal-keys')) panel.appendChild(createTerminalKeys());
	const editorPart = document.getElementById('editorPart');
	if (editorPart && !editorPart.querySelector('.ggs-editor-empty')) editorPart.appendChild(createEditorEmptyState());
	return {
		titlebar: document.getElementById('titlebar')!,
		workbench,
		statusbar: document.getElementById('statusbar')!,
		appBar: createAppBar({
			openDrawer: () => openDrawer(() => currentWorkbench?.titleBar.menuDefinitions() ?? []),
			openEditors: openEditorsSheet,
			editorActions: openEditorActions
		}),
		bottomTabs: createBottomTabs((page) => {
			if (page === 'editor') openEditorsSheet();
		}),
		navRail: createNavRail(),
		editorAccessory: createEditorAccessory(),
		remoteIndicator: createRemoteIndicator()
	};
}

/** Refresh the parts whose content follows the workbench (the indicator's workspace name);
 *  the host calls it after every layout switch. */
export function refreshLayoutParts(parts: LayoutParts): void {
	const name = parts.remoteIndicator.querySelector('.remote-name');
	if (name) name.textContent = workspaceName() || 'GGS';
}
