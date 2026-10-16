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
import { editorTabs } from '../../pages';
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
	// The Editor destination is the phone's tab strip (§6.2): every tap of it — the bar's
	// and the rail's alike, the first no less than a reselect — opens the open editors
	// list, the chooser between the pages the PC and this device have open. With nothing
	// open the page's own empty state is the better surface, so the chooser only answers
	// when there is something to choose.
	const editorChooser = (): void => {
		if (editorTabs().length > 0) openEditorsSheet();
	};
	return {
		titlebar: document.getElementById('titlebar')!,
		workbench,
		statusbar: document.getElementById('statusbar')!,
		appBar: createAppBar({
			openDrawer: () => openDrawer(() => currentWorkbench?.titleBar.menuDefinitions() ?? []),
			openEditors: openEditorsSheet,
			editorActions: openEditorActions
		}),
		bottomTabs: createBottomTabs(() => undefined, editorChooser),
		navRail: createNavRail((page) => {
			if (page === 'editor') editorChooser();
		}),
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
