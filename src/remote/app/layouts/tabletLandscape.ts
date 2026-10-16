// The tablet landscape layout (docs/remote-client-plan.md §5.4): three columns — the
// activity bar in its own icon-only shape, the side bar as the 320 px collapsible main
// column, the editor area as the detail. This is the workbench's own frame wearing tablet
// sizes: the parts are NOT re-parented into custom slots, the frame's CSS (layouts.css,
// keyed on data-layout) re-sizes them in place, so nothing that lives in the editor area
// (a webview page, a terminal) is even moved. The status bar shows. The ≥1180 px fixed
// Claude column (§5.4's right pane) is S2's chat bridge work; the layout reserves nothing
// for it yet.
//
// The rail carries no titles under its icons (the owner's 2026-10-16 direction, 平板模式
// 下左边栏的图标不需要写标题 — VS Code's activity bar shape): the 72 px widening and the
// `.rail-label` injection that went with it are gone, and the bar keeps the desktop form's
// own 48 px icon-only drawing.
//
// The ☰ at the rail's head (the owner's 2026-10-16 direction, 平板界面没有菜单入口):
// this form draws no title bar (§5.4's three-column frame has none), so the drawer — every
// page, the workspace actions, the transfers, the full application menus, Settings — opens
// from the activity rail's first item instead, the same surface the phone's app bar and
// the portrait tablet's rail head open.
import { t } from '../../../platform/i18n';
import { codicon } from '../../widgets';
import { openWorkbenchDrawer } from '../../navDrawer';
import type { LayoutInstance, LayoutParts } from './shared';
import { noopDispose, parkRest } from './shared';

/** The menu button riding the activity rail's head; removed by the layout's dispose. */
function installActivityMenu(activitybar: HTMLElement): HTMLElement {
	const item = document.createElement('button');
	item.type = 'button';
	item.className = 'activity-item ggs-activity-menu';
	item.title = t('remote.menu');
	item.setAttribute('aria-label', t('remote.menu'));
	item.appendChild(codicon('menu'));
	item.addEventListener('click', () => openWorkbenchDrawer());
	activitybar.prepend(item);
	return item;
}

export function buildTabletLandscape(parts: LayoutParts): LayoutInstance {
	const root = document.createElement('div');
	root.className = 'ggs-arrange';
	root.dataset.layout = 'tablet-landscape';
	root.append(parts.titlebar, parts.workbench, parts.statusbar);
	parkRest(root, parts, [parts.titlebar, parts.workbench, parts.statusbar]);
	const activitybar = parts.workbench.querySelector<HTMLElement>('#activitybar');
	if (!activitybar) return { root, dispose: noopDispose };
	const menu = installActivityMenu(activitybar);
	return {
		root,
		dispose(): void {
			menu.remove();
		}
	};
}
