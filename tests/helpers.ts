// DOM helpers for the UI tests.

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
