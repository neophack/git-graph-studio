// The phone landscape layout (docs/remote-client-plan.md §5.2): the height is 360–430 px,
// so the bottom navigation gives way to a 56 px icon rail on the leading edge and the
// content takes the full height; the app bar compresses to a 40 px top bar (its path line
// becomes the subtitle). The page model is the portrait's — one column of full-screen
// pages — only the navigation moved.
import type { LayoutInstance, LayoutParts } from './shared';
import { noopDispose, parkRest } from './shared';

export function buildPhoneLandscape(parts: LayoutParts): LayoutInstance {
	const root = document.createElement('div');
	root.className = 'ggs-arrange ggs-arrange-row';
	root.dataset.layout = 'phone-landscape';
	const main = document.createElement('div');
	main.className = 'ggs-arrange-main';
	main.append(parts.appBar, parts.workbench, parts.editorAccessory);
	root.append(parts.navRail, main);
	parkRest(root, parts, [parts.navRail, parts.appBar, parts.workbench, parts.editorAccessory]);
	return { root, dispose: noopDispose };
}
