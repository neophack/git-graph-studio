// The tablet landscape layout (docs/remote-client-plan.md §5.4): three columns — the
// activity bar widened to a 72 px navigation rail (icon over label), the side bar as the
// 320 px collapsible main column, the editor area as the detail. This is the workbench's
// own frame wearing tablet sizes: the parts are NOT re-parented into custom slots, the
// frame's CSS (layouts.css, keyed on data-layout) re-sizes them in place, so nothing that
// lives in the editor area (a webview page, a terminal) is even moved. The status bar
// shows. The ≥1180 px fixed Claude column (§5.4's right pane) is S2's chat bridge work;
// the layout reserves nothing for it yet.
//
// The rail's labels are this layout's own chrome: spans injected under the activity items'
// icons (their title or aria-label — the same text pages.ts trusts), kept current through
// the activity bar's own mutations, and removed on dispose.
import type { LayoutInstance, LayoutParts } from './shared';
import { noopDispose, parkRest } from './shared';

function labelOf(item: HTMLElement): string {
	return item.title || item.getAttribute('aria-label') || '';
}

function applyRailLabels(activitybar: HTMLElement): void {
	for (const item of activitybar.querySelectorAll<HTMLElement>('.activity-item')) {
		const text = labelOf(item);
		let label = item.querySelector<HTMLElement>(':scope > .rail-label');
		if (!text) {
			label?.remove();
			continue;
		}
		if (!label) {
			label = document.createElement('span');
			label.className = 'rail-label';
			item.appendChild(label);
		}
		if (label.textContent !== text) label.textContent = text;
	}
}

export function buildTabletLandscape(parts: LayoutParts): LayoutInstance {
	const root = document.createElement('div');
	root.className = 'ggs-arrange';
	root.dataset.layout = 'tablet-landscape';
	root.append(parts.titlebar, parts.workbench, parts.statusbar);
	parkRest(root, parts, [parts.titlebar, parts.workbench, parts.statusbar]);
	const activitybar = parts.workbench.querySelector<HTMLElement>('#activitybar');
	if (!activitybar) return { root, dispose: noopDispose };
	applyRailLabels(activitybar);
	// The activity set changes while the tablet layout shows (an extension installs, its
	// container's icon loads): keep every item labelled.
	const observer = new MutationObserver(() => applyRailLabels(activitybar));
	observer.observe(activitybar, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'aria-label'] });
	return {
		root,
		dispose(): void {
			observer.disconnect();
			for (const label of activitybar.querySelectorAll('.rail-label')) label.remove();
		}
	};
}
