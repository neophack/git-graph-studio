// DOM helpers for the UI tests.

/** The workbench's shell skeleton — the element ids boot.ts wires itself onto, empty: the
 *  suites that boot the real Workbench (commandSweep, selfTest, workbenchLifecycle,
 *  scenarioHarness, singleFile, uiSweep) all reset the document to this shape per test. */
export function workbenchShell(): void {
	document.body.innerHTML = `
		<div id="titlebar"></div>
		<div id="workbench">
			<div id="activitybar"></div>
			<div id="sidebar"></div>
			<div id="sidebarSash"></div>
			<div id="editorPart"><div id="editorGroup"></div><div id="panelSash" hidden></div><div id="panel" hidden></div></div>
		</div>
		<div id="statusbar"></div>
		<div id="notifications"></div>
		<div id="overlays"></div>`;
}

/** Every command not scripted in the map answers `null` (a write that succeeded) — the
 *  full-boot suites' handler table. */
export class DefaultingHandlers extends Map<string, (args: Record<string, unknown>) => unknown> {
	override get(command: string) {
		return super.get(command) ?? (() => null);
	}
}

export function click(element: Element | null | undefined, options: MouseEventInit = {}): void {
	if (!element) throw new Error('no element to click');
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...options }));
	element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, ...options }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...options }));
}

export function rightClick(element: Element | null | undefined): void {
	if (!element) throw new Error('no element to right-click');
	element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
}

export function hover(element: Element | null | undefined): void {
	element?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
}

export function key(target: Element | Document, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

export function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function texts(selector: string, root: ParentNode = document): string[] {
	return Array.from(root.querySelectorAll(selector)).map((e) => (e.textContent ?? '').trim());
}

export function menuLabels(): string[] {
	const menus = document.querySelectorAll('.context-menu');
	const last = menus[menus.length - 1];
	return last ? texts('.item .label', last) : [];
}

export function menuItem(label: string): HTMLElement | null {
	for (const item of Array.from(document.querySelectorAll<HTMLElement>('.context-menu .item'))) {
		if (item.querySelector('.label')?.textContent === label) return item;
	}
	return null;
}

export function notifications(): string[] {
	return texts('#notifications .notification .message');
}

export function notificationButton(label: string): HTMLElement | null {
	return Array.from(document.querySelectorAll<HTMLElement>('#notifications .buttons .button')).find((b) => b.textContent === label) ?? null;
}

/** Let queued promises and microtasks settle. */
export async function flush(times = 5): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Poll an async end state into view: each round lets queued promises settle, so a
 *  starved worker reaches the state a fast one does — just more rounds later. */
export async function until(condition: () => boolean, rounds = 40): Promise<void> {
	for (let i = 0; i < rounds && !condition(); i++) await flush(1);
}
