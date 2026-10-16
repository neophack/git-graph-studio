// The page-stack shells' back affordance (docs/remote-client-plan.md §5.1's 层级 rule: 返回
// 手势、系统返回键和 App 栏的返回按钮都弹出栈顶): on the phone orientations and the
// portrait tablet, a full-screen page — a side view (Files, Search, Changes, an extension's
// container) or the panel — covers the editor, and until this module the only ways back were
// the edge swipe and the destination bars. Three surfaces share this one vocabulary: the app
// bar's leading ‹ (the phone forms), the navigation rail's head ‹ (the portrait tablet,
// which draws no app bar), and the system back key — the page rides backStack as the BOTTOM
// closer, so a back closes the page (any sheet over it peels first) before it could ever
// leave the workbench.
//
// "Back" always means the editor page (pages.ts's model: the side views are pages OVER the
// editor): a launcher page (Git Graph) answers with the most recent regular tab, exactly the
// Editor destination's own semantics.
import { currentPage, goTo, onWorkbenchChange } from './pages';
import { pushBack } from './backStack';

/** Whether a page sits over the editor and a back target exists — only on a page-stack
 *  shell (the phone orientations, the portrait tablet); the wide forms keep their columns. */
export function pageBackAvailable(): boolean {
	if (typeof document === 'undefined') return false;
	const root = document.documentElement;
	if (!root.hasAttribute('data-remote-shell') || !root.hasAttribute('data-page-stack')) return false;
	return currentPage() !== 'editor';
}

/** Pop the page over the editor: the editor page (the file, or its empty state). */
export async function pageBack(): Promise<void> {
	if (!pageBackAvailable()) return;
	await goTo('editor');
}

let release: (() => void) | null = null;

/** Arm or drop the system-back entry for the page over the editor. Idempotent; the
 *  workbench watcher drives it (a page opening arms, the editor returning drops). */
function sync(): void {
	const should = pageBackAvailable();
	if (should === Boolean(release)) return;
	if (should) release = pushBack(() => void pageBack());
	else {
		release?.();
		release = null;
	}
}

/** Install the back entry's watcher (once per shell, installOnce). A stale entry from a
 *  torn-down DOM (a test, a reload) is dropped first — it must not ride along. */
export function installPageBack(): void {
	resetPageBack();
	onWorkbenchChange(sync);
	sync();
}

/** Drop the entry without traversing (tests reset the DOM between cases). */
export function resetPageBack(): void {
	release?.();
	release = null;
}
