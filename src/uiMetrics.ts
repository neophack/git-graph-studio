// UI metrics (the harness's second job): measure the laid-out workbench and check the size
// invariants that keep the visual design intact - region bounds, the fixed-height chrome
// (status bar, tab strip, title bar), the minimap's reserved strip, the find widget clearing
// it, sticky scroll sitting below an open panel, editor-group minimums and sashes. Each check
// passes, fails (with the measured numbers), or is skipped when its surface is not on screen;
// the dev harness renders the report and exposes it as `window.__uiMetrics` for automation.

export interface MetricResult {
	name: string;
	status: 'pass' | 'fail' | 'skipped';
	detail: string;
}

const rect = (element: Element): DOMRect => element.getBoundingClientRect();

const inRange = (value: number, min: number, max: number): boolean => value >= min && value <= max;

function measure(selector: string, name: string, check: (element: Element, box: DOMRect) => string | null): MetricResult {
	const element = document.querySelector(selector);
	if (!element || (element instanceof HTMLElement && element.hidden)) {
		return { name, status: 'skipped', detail: `${selector} is not on screen` };
	}
	// A laid-out element has size; a zero box means the surface exists but is not showing
	// (a hidden pane, a dismissed overlay) - nothing to assert about it.
	if (element instanceof HTMLElement && element.offsetWidth === 0 && element.offsetHeight === 0) {
		return { name, status: 'skipped', detail: `${selector} is present but not laid out` };
	}
	const box = rect(element);
	const problem = check(element, box);
	return problem === null
		? { name, status: 'pass', detail: describe(box) }
		: { name, status: 'fail', detail: `${problem} (${describe(box)})` };
}

function describe(box: DOMRect): string {
	return `${Math.round(box.width)}x${Math.round(box.height)} @${Math.round(box.left)},${Math.round(box.top)}`;
}

/** The invariant checks. Order follows the screen: window, chrome, side bar, editors. */
export function runUiMetrics(): MetricResult[] {
	const viewport = { width: window.innerWidth, height: window.innerHeight };
	const results: MetricResult[] = [];

	// The window itself: nothing may overflow horizontally (a runaway flex or a fixed-width
	// child shows up as a document-level scrollbar).
	results.push({
		name: 'window: no horizontal overflow',
		status: document.documentElement.scrollWidth <= viewport.width + 1 ? 'pass' : 'fail',
		detail: `scrollWidth ${document.documentElement.scrollWidth} vs viewport ${viewport.width}`
	});

	results.push(measure('#titlebar', 'title bar: one compact row', (_el, box) =>
		inRange(box.height, 28, 40) ? null : `height ${box.height.toFixed(1)} outside 28-40`));

	results.push(measure('#statusbar', 'status bar: full-width strip at the bottom', (el, box) => {
		if (!inRange(box.height, 18, 32)) return `height ${box.height.toFixed(1)} outside 18-32`;
		if (Math.abs(box.bottom - viewport.height) > 2) return `not at the window bottom`;
		if (Math.abs(box.left) > 2 || Math.abs(box.right - viewport.width) > 2) return 'not spanning the window width';
		return null;
	}));

	results.push(measure('#activitybar', 'activity bar: icon rail', (_el, box) => {
		if (!inRange(box.width, 44, 56)) return `width ${box.width.toFixed(1)} outside 44-56`;
		if (box.height < viewport.height * 0.5) return 'does not span the workbench height';
		return null;
	}));

	results.push(measure('#sidebar', 'side bar: within its bounds', (_el, box) =>
		inRange(box.width, 170, viewport.width - 360) ? null : `width ${box.width.toFixed(1)} outside 170-${viewport.width - 360}`));

	// The editor chrome: one tab strip row (every strip the same compact height), uniform
	// tabs, and (when split) real panes.
	const strips = Array.from(document.querySelectorAll<HTMLElement>('.tabs-container')).filter((strip) => strip.offsetWidth > 0);
	if (strips.length === 0) {
		results.push({ name: 'tab strip: one compact row', status: 'skipped', detail: 'no tab strip is on screen' });
	} else {
		const heights = strips.map((strip) => rect(strip).height);
		const bad = heights.filter((height) => !inRange(height, 28, 42));
		results.push({
			name: 'tab strip: one compact row',
			status: bad.length === 0 ? 'pass' : 'fail',
			detail: bad.length === 0 ? `${strips.length} strip(s) at ${Math.round(heights[0]!)}px` : `height(s) ${bad.map((h) => h.toFixed(1)).join(', ')} outside 28-42`
		});
	}
	const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab')).filter((tab) => !tab.hidden && tab.offsetWidth > 0);
	if (tabs.length === 0) {
		results.push({ name: 'tabs: every tab is wide enough to read', status: 'skipped', detail: 'no tab is open' });
	} else {
		const narrow = tabs.filter((tab) => tab.getBoundingClientRect().width < 60);
		results.push({
			name: 'tabs: every tab is wide enough to read',
			status: narrow.length === 0 ? 'pass' : 'fail',
			detail: narrow.length === 0 ? `${tabs.length} tab(s)` : `${narrow.length} tab(s) under 60px wide`
		});
	}

	const boxes = Array.from(document.querySelectorAll<HTMLElement>('.editor-group-box')).filter((box) => box.offsetWidth > 0);
	if (boxes.length > 1) {
		const cramped = boxes.filter((box) => box.getBoundingClientRect().width < 140);
		results.push({
			name: 'editor groups: every split stays usable',
			status: cramped.length === 0 ? 'pass' : 'fail',
			detail: cramped.length === 0 ? `${boxes.length} groups` : `${cramped.length} group(s) under 140px wide`
		});
		results.push(measure('.editor-sash', 'editor sashes: a grabbable sliver', (_el, box) =>
			inRange(box.width, 2, 8) ? null : `width ${box.width.toFixed(1)} outside 2-8`));
	}

	// The editor decorations: the minimap's fixed rail and the find widget clearing it.
	results.push(measure('.cm-editor .cm-minimap', 'minimap: the fixed right rail', (el, box) => {
		if (!inRange(box.width, 82, 90)) return `width ${box.width.toFixed(1)} outside 82-90`;
		const editor = el.closest('.cm-editor')!.getBoundingClientRect();
		if (Math.abs(box.right - editor.right) > 2) return 'not flush with the editor right edge';
		if (box.height > editor.height + 1) return 'taller than its editor';
		return null;
	}));

	results.push(measure('.cm-panel.cm-find-widget', 'find widget: clears the minimap, inside the editor', (el, box) => {
		const editor = el.closest('.cm-editor');
		const bounds = (editor ?? document.body).getBoundingClientRect();
		if (box.width > 480) return `width ${box.width.toFixed(1)} over the 480 budget`;
		if (box.right > bounds.right - 4) return 'overruns the editor right edge';
		if (editor?.classList.contains('has-minimap') && box.right > bounds.right - 80) return 'sits over the minimap';
		return null;
	}));

	results.push(measure('.cm-sticky', 'sticky scroll: below any open panel', (el, box) => {
		if (el.classList.contains('cm-sticky') && (el as HTMLElement).style.display === 'none') return null;
		const panels = document.querySelector('.cm-panels-top');
		const panelHeight = panels ? rect(panels).height : 0;
		if (Math.abs(box.top - ((panels ? rect(panels).top : box.top) + panelHeight)) > 1) return `top ${box.top.toFixed(1)} does not follow the panel height ${panelHeight.toFixed(1)}`;
		return null;
	}));

	results.push(measure('.notification-centre', 'notification centre: a bounded popover above the status bar', (_el, box) => {
		if (box.width > 400) return `width ${box.width.toFixed(1)} over 400`;
		const bar = document.querySelector('#statusbar');
		if (bar && box.bottom > rect(bar).top + 2) return 'overlaps the status bar';
		return null;
	}));

	results.push(measure('.quick-input', 'quick input: inside the window', (_el, box) =>
		box.left >= 0 && box.right <= viewport.width ? null : 'extends past the window edge'));

	results.push(measure('.diff-header', 'diff header: one compact row', (_el, box) => {
		if (!inRange(box.height, 20, 32)) return `height ${box.height.toFixed(1)} outside 20-32`;
		return null;
	}));

	// The graph tab: the iframe fills its pane (a collapsed iframe is the classic layout bug).
	const graphFrame = document.querySelector('.editor-pane iframe');
	if (graphFrame && rect(graphFrame.closest('.editor-pane')!).width > 10) {
		const frame = rect(graphFrame);
		const pane = rect(graphFrame.closest('.editor-pane')!);
		results.push({
			name: 'git graph: the iframe fills its pane',
			status: frame.width >= pane.width - 4 && frame.height >= pane.height - 4 ? 'pass' : 'fail',
			detail: `frame ${describe(frame)} in pane ${describe(pane)}`
		});
	}

	return results;
}
