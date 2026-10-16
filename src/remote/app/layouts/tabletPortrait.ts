// The tablet portrait layout (docs/remote-client-plan.md §5.3): the 72 px navigation rail
// with icon AND label, and one single-column stage beside it — the same page-stack model as
// the phone (a side view covers the stage, the editor beneath it). Hardware keyboards work
// (§5.3), so the phone's key gating does not apply to this form. The list-then-detail
// slide-over (the editor entering from the right over 85% of the width, the list edge
// staying tappable to go back) is the files page's own interaction and lands with P1/P2.
import type { LayoutInstance, LayoutParts } from './shared';
import { noopDispose, parkRest } from './shared';

export function buildTabletPortrait(parts: LayoutParts): LayoutInstance {
	const root = document.createElement('div');
	root.className = 'ggs-arrange ggs-arrange-row';
	root.dataset.layout = 'tablet-portrait';
	root.append(parts.navRail, parts.workbench, parts.editorAccessory);
	parkRest(root, parts, [parts.navRail, parts.workbench, parts.editorAccessory]);
	return { root, dispose: noopDispose };
}
