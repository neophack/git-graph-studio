// The desktop browser layout (docs/remote-client-plan.md §5.5): VS Code for the Web's own
// arrangement — title bar (menus filtered by the remote command profile, no window
// controls), activity bar, side bar, editor groups, panel, status bar — with the remote
// indicator leading the status bar's left cluster: `>< GGS: <workspace>` in the remote
// item's colour, one tap from the window switcher. Nothing else of the frame changes: the
// workbench's own CSS carries this arrangement, the layout only owns the indicator's seat.
import type { LayoutInstance, LayoutParts } from './shared';
import { parkRest } from './shared';

export function buildDesktop(parts: LayoutParts): LayoutInstance {
	const root = document.createElement('div');
	root.className = 'ggs-arrange';
	root.dataset.layout = 'desktop';
	root.append(parts.titlebar, parts.workbench, parts.statusbar);
	parkRest(root, parts, [parts.titlebar, parts.workbench, parts.statusbar]);
	// The indicator leads the status bar's left cluster (§5.5: the leftmost item). The
	// cluster exists once the workbench has built the bar — the host installs layouts after
	// the workbench's first frame, so it is there.
	const left = parts.statusbar.querySelector<HTMLElement>('.status-left');
	left?.prepend(parts.remoteIndicator);
	return {
		root,
		dispose(): void {
			parts.remoteIndicator.remove();
		}
	};
}
