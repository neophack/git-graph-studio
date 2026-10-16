// The layout framework's shared vocabulary (docs/remote-client-plan.md §4.2, §5): the five
// form factors each own a layout module that arranges ONE persistent set of parts — the
// workbench frame's own elements plus the remote chrome built once — inside the one frame
// root that lives as long as the page. A layout never rebuilds a part: it MOVES the part
// elements into its arrangement (the switch keeps every editor buffer, terminal session and
// open tab alive), the frame root's `data-layout` carries the CSS, and dispose hands the
// parts back for the next layout to re-parent.

/** What a built layout answers: its arrangement root (parented into the frame root by the
 *  host) and the teardown of anything the layout alone created — the parts themselves are
 *  never disposed; the next layout re-parents them. */
export interface LayoutInstance {
	root: HTMLElement;
	dispose(): void;
}

/** The persistent parts every layout arranges. Collected once by parts.ts; the element
 *  identities are stable across switches, which is exactly what "tabs, dirty buffers and
 *  terminal sessions survive a form change" rests on. */
export interface LayoutParts {
	/** The desktop title bar (the workbench keeps filling it whatever shows it). */
	titlebar: HTMLElement;
	/** The workbench frame: activity bar, side bar, sash, editor area (with the panel). */
	workbench: HTMLElement;
	/** The status bar (hidden by CSS on the page-stack shells, shown elsewhere). */
	statusbar: HTMLElement;
	/** The phone's app bar (§5.1; the landscape form's top bar is the same element at 40 px). */
	appBar: HTMLElement;
	/** The bottom navigation (§5.1). */
	bottomTabs: HTMLElement;
	/** The vertical navigation rail (§5.2 at 56 px icon-only, §5.3 at 72 px with labels). */
	navRail: HTMLElement;
	/** The editor's auxiliary key row, docked above the navigation while the keyboard is up. */
	editorAccessory: HTMLElement;
	/** The desktop form's remote indicator (§5.5): `>< GGS: <PC>`, placed into the status
	 *  bar's left cluster by the desktop layout alone and detached by its dispose. */
	remoteIndicator: HTMLElement;
}

const PART_KEYS: (keyof LayoutParts)[] = ['titlebar', 'workbench', 'statusbar', 'appBar', 'bottomTabs', 'navRail', 'editorAccessory'];

/** Append every part the layout did not place itself. A part not shown by a layout still
 *  lives in the DOM — the workbench keeps feeding the title bar's menus and the status
 *  bar's items — while the layout's CSS keeps it out of sight. */
export function parkRest(root: HTMLElement, parts: LayoutParts, placed: HTMLElement[]): void {
	const placedSet = new Set(placed);
	for (const key of PART_KEYS) {
		const part = parts[key];
		if (!placedSet.has(part) && part.parentElement !== root) root.append(part);
	}
}

/** A no-op dispose for layouts that create nothing of their own. */
export function noopDispose(): void {
	/* the parts outlive the layout */
}
