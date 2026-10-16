// The phone portrait layout (docs/remote-client-plan.md §5.1): the app bar (48 px + the
// safe area), one full-screen column of pages (the side bar and the panel as pages over the
// editor — remote.css's page-stack block), the editing row while the keyboard is up, and
// the bottom navigation (56 px + the safe area) with its badges. The desktop chrome (title
// bar, activity bar, status bar) stays parked in the frame, hidden by CSS; the workbench
// keeps feeding it.
import type { LayoutInstance, LayoutParts } from './shared';
import { noopDispose, parkRest } from './shared';

export function buildPhonePortrait(parts: LayoutParts): LayoutInstance {
	const root = document.createElement('div');
	root.className = 'ggs-arrange';
	root.dataset.layout = 'phone-portrait';
	root.append(parts.appBar, parts.workbench, parts.editorAccessory, parts.bottomTabs);
	parkRest(root, parts, [parts.appBar, parts.workbench, parts.editorAccessory, parts.bottomTabs]);
	return { root, dispose: noopDispose };
}
