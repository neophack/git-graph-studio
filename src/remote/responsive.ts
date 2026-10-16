// The device classification and the viewport variables (docs/remote-client-plan.md §4, the
// 2026-10-15 rewrite of ggs-remote-plan §11.1): the five form factors — phone and tablet,
// each orientation, and the desktop browser — decided by the LAYOUT viewport's size, aspect
// and pointer kind (deviceClass.ts's classifier), wrapped in the stability rules (§4.2: a
// 150 ms debounce, a keyboard freeze that lets only widths reclassify, a 24 px hysteresis
// band, and a manual override). Written onto <html> as `data-device` (the five-way class)
// and `data-form-factor` / `data-pointer` (the collapsed vocabulary the CSS already keys
// on); the virtual keyboard's visible height rides in `--vvh` (and the visual viewport's
// offset in `--vv-top`, which iOS pans instead of resizing) for the views that must stay
// above it, and `data-keyboard="open"` marks a raised keyboard — the bottom navigation
// steps aside and the editing rows show.
import { formFactorOfClass, pageStackOfClass, settleDeviceClass, type DeviceClass } from './app/deviceClass';

export type FormFactor = 'phone' | 'tablet' | 'desktop';

const listeners = new Set<(factor: FormFactor) => void>();
const deviceListeners = new Set<(device: DeviceClass) => void>();
let current: FormFactor | null = null;
let device: DeviceClass | null = null;
let lastSize = { w: 0, h: 0 };
let settleTimer: number | null = null;

export function formFactorFor(width: number): FormFactor {
	return formFactorOfClass(device ? device : nullDeviceFor(width));
}

function nullDeviceFor(width: number): DeviceClass {
	// Before the first settle (and in the shimmed tests), the width-only cut answers.
	return width < 600 ? 'phone-portrait' : width < 1024 ? 'tablet-landscape' : 'desktop';
}

export function formFactor(): FormFactor {
	return current ?? formFactorFor(typeof window === 'undefined' ? 1280 : window.innerWidth);
}

/** The settled device class, or null before the first settle (the layouts host waits for
 *  the workbench's first frame — by then the class has long settled). */
export function currentDeviceClass(): DeviceClass | null {
	return device;
}

/** The manual override's storage key (§4.2's "设备级设置"): this browser's own choice,
 *  like Data Saver — never the backend's registry, which is shared with the PC. */
const OVERRIDE_KEY = 'ggsr.deviceOverride';

/** The override vocabulary: one of the three form factors forced, or null for the
 *  algorithm's own answer (the default). */
export type DeviceOverride = 'phone' | 'tablet' | 'desktop' | null;

export function deviceOverride(): DeviceOverride {
	const value = document.documentElement.dataset['deviceOverride'];
	return value === 'phone' || value === 'tablet' || value === 'desktop' ? value : null;
}

/** Set the override (null clears it back to auto): persisted, spelled on <html>, and
 *  reclassified AT ONCE — an explicit user action never waits the resize debounce. */
export function setDeviceOverride(override: DeviceOverride): void {
	try {
		if (override === null) localStorage.removeItem(OVERRIDE_KEY);
		else localStorage.setItem(OVERRIDE_KEY, override);
	} catch {
		/* storage unavailable */
	}
	applyDeviceOverride();
}

/** Read the persisted override onto <html> (the settle reads it off the attribute). */
function seedDeviceOverride(): void {
	let stored: string | null = null;
	try {
		stored = localStorage.getItem(OVERRIDE_KEY);
	} catch {
		/* storage unavailable */
	}
	if (stored === 'phone' || stored === 'tablet' || stored === 'desktop') {
		document.documentElement.dataset['deviceOverride'] = stored;
	} else {
		delete document.documentElement.dataset['deviceOverride'];
	}
}

/** Read the persisted override onto <html> and settle. */
function applyDeviceOverride(): void {
	seedDeviceOverride();
	if (settleTimer !== null) window.clearTimeout(settleTimer);
	settleClass();
}

/** The pointer kind a replica viewer imposes (docs/ggs-remote-plan.md §22): the PC window
 *  laid out for a phone that watches it has a mouse of its own, but is driven by touch. */
let pointerOverride: 'coarse' | 'fine' | null = null;

export function setPointerOverride(kind: 'coarse' | 'fine' | null): void {
	pointerOverride = kind;
}

export function coarsePointer(): boolean {
	if (pointerOverride !== null) return pointerOverride === 'coarse';
	return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export function onFormFactorChange(listener: (factor: FormFactor) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The device-class granularity (§4.2's switch process): the layouts swap their frames on
 *  every device change — including a portrait↔landscape flip inside one form factor, which
 *  the three-way `onFormFactorChange` never reports. */
export function onDeviceClassChange(listener: (device: DeviceClass) => void): () => void {
	deviceListeners.add(listener);
	return () => deviceListeners.delete(listener);
}

/** The tallest viewport seen per width (an orientation): the keyboard-down height. With
 *  `interactive-widget=resizes-content` the layout viewport itself shrinks under a keyboard,
 *  so the comparison has to be against a remembered height, not the current one. */
const fullHeight = new Map<number, number>();

/** Whether the focus sits in something that raises the on-screen keyboard. */
export function editableFocused(target: Element | null = document.activeElement): boolean {
	if (!target) return false;
	if (target instanceof HTMLTextAreaElement) return !target.readOnly;
	if (target instanceof HTMLInputElement) return !target.readOnly && !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color'].includes(target.type);
	return (target as HTMLElement).isContentEditable === true;
}

/** A keyboard is up: an editable has the focus and the visible height fell well below the
 *  keyboard-down height of this orientation (a 120 px margin rides out the browser's own
 *  toolbars collapsing). */
export function keyboardOpen(visible: number, full: number, editable: boolean): boolean {
	return editable && full - visible > 120;
}

/** The layout viewport's size — the classifier's input (§4.1: never the visual viewport,
 *  the soft keyboard would flap the class). */
function layoutSize(): { w: number; h: number } {
	const root = document.documentElement;
	return { w: root.clientWidth, h: root.clientHeight };
}

/** Run one classification step through the stability rules and publish both attributes.
 *  The three-way factor's change is what listeners hear; a portrait↔landscape flip inside
 *  one factor is CSS's business (`data-device` changed, `data-form-factor` did not). */
function settleClass(): void {
	settleTimer = null;
	const { w, h } = layoutSize();
	const override = document.documentElement.dataset['deviceOverride'] ?? null;
	const next = settleDeviceClass(device, w, h, coarsePointer(), lastSize, editableFocused(), override);
	lastSize = { w, h };
	if (next === device) return;
	device = next;
	const root = document.documentElement;
	root.dataset.device = next;
	const factor = formFactorOfClass(next);
	root.dataset.formFactor = factor;
	// The page-stack shells' marker (§5.1–§5.3): the phone CSS block keys on it, and the
	// portrait tablet joins the phone's page model through the same attribute.
	root.toggleAttribute('data-page-stack', pageStackOfClass(next));
	// The attributes are consistent before any listener runs (the layout host reads the
	// marker while switching, and the CSS has already turned on the new form).
	for (const listener of deviceListeners) listener(next);
	if (factor !== current) {
		current = factor;
		for (const listener of listeners) listener(factor);
	}
}

/** The debounced settle (§4.2: 150 ms after the last resize/orientation event); the first
 *  classification is immediate — the page must wear a class on its first frame. */
function scheduleSettle(): void {
	if (settleTimer !== null) window.clearTimeout(settleTimer);
	if (device === null) {
		settleClass();
		return;
	}
	settleTimer = window.setTimeout(settleClass, 150);
}

function apply(): void {
	const root = document.documentElement;
	const next = formFactorFor(window.innerWidth);
	root.dataset.pointer = coarsePointer() ? 'coarse' : 'fine';
	const viewport = window.visualViewport;
	const visible = Math.round(viewport?.height ?? window.innerHeight);
	root.style.setProperty('--vvh', `${visible}px`);
	root.style.setProperty('--vv-top', `${Math.round(viewport?.offsetTop ?? 0)}px`);
	const full = Math.max(fullHeight.get(window.innerWidth) ?? 0, window.innerHeight, visible);
	fullHeight.set(window.innerWidth, full);
	root.toggleAttribute('data-keyboard', keyboardOpen(visible, full, editableFocused()));
	if (next !== current && current === null) {
		// The pre-settle fallback: until the first class settles, the width cut keeps the
		// CSS from flashing the wrong shell.
		current = next;
		root.dataset.formFactor = next;
		root.toggleAttribute('data-page-stack', next === 'phone');
	}
	scheduleSettle();
}

/** Start following the viewport (rotation, resize, the virtual keyboard, the focus). The
 *  returned stop drops every listener (the remote page never stops; tests do). */
export function initResponsive(): () => void {
	document.documentElement.classList.add('remote-shell');
	// The persisted override (§4.2) seeds <html> before the first settle — a forced form
	// factor never flashes the algorithm's own answer first.
	seedDeviceOverride();
	apply();
	const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
	// Focus moves without a resize (one field to the next, a blur that drops the keyboard
	// before the viewport reports it): re-read on the next frame.
	const later = () => requestAnimationFrame(apply);
	window.addEventListener('resize', apply);
	window.visualViewport?.addEventListener('resize', apply);
	window.visualViewport?.addEventListener('scroll', apply);
	coarse?.addEventListener?.('change', apply);
	document.addEventListener('focusin', later);
	document.addEventListener('focusout', later);
	return () => {
		window.removeEventListener('resize', apply);
		window.visualViewport?.removeEventListener('resize', apply);
		window.visualViewport?.removeEventListener('scroll', apply);
		coarse?.removeEventListener?.('change', apply);
		document.removeEventListener('focusin', later);
		document.removeEventListener('focusout', later);
		if (settleTimer !== null) window.clearTimeout(settleTimer);
		settleTimer = null;
		document.documentElement.classList.remove('remote-shell');
		document.documentElement.removeAttribute('data-keyboard');
		document.documentElement.removeAttribute('data-page-stack');
		delete document.documentElement.dataset.device;
		delete document.documentElement.dataset.deviceOverride;
		current = null;
		device = null;
		lastSize = { w: 0, h: 0 };
	};
}
