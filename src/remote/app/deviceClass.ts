// The device classification (docs/remote-client-plan.md §4): which of the five form
// factors this viewport is — phone portrait/landscape, tablet portrait/landscape, desktop
// browser — from the LAYOUT viewport's size, aspect and orientation plus the pointer kind
// (§4.1: the layout viewport, never the visual one, or the soft keyboard would flap the
// class). The classifier is pure; responsive.ts owns the watching and the stability rules
// (§4.2): the 150 ms debounce, the keyboard freeze, the 24 px hysteresis and the manual
// override all live around it, and the result lands on <html> as `data-device` while the
// three-way `data-form-factor` (phone/tablet/desktop) is derived from it for the CSS that
// already keys on it.

export type DeviceClass = 'phone-portrait' | 'phone-landscape' | 'tablet-portrait' | 'tablet-landscape' | 'desktop';

/** The plan's classifier (§4.1), verbatim in shape: a short edge under 500 is a phone
 *  whatever its orientation; a touch device's short edge under 1100 is a tablet (iPad
 *  mini to iPad Pro 13); a narrow non-touch window under 600 reads as a phone; under
 *  1024 a tablet; above that, a desktop browser. */
export function classify(w: number, h: number, touch: boolean): DeviceClass {
	const short = Math.min(w, h);
	const portrait = h >= w;
	if (short < 500) return portrait ? 'phone-portrait' : 'phone-landscape';
	if (touch && short < 1100) return portrait ? 'tablet-portrait' : 'tablet-landscape';
	if (w < 600) return 'phone-portrait';
	if (w < 1024) return portrait ? 'tablet-portrait' : 'tablet-landscape';
	return 'desktop';
}

/** The three-way form factor a device class collapses to (the CSS vocabulary
 *  remote.css already keys on). */
export function formFactorOfClass(device: DeviceClass): 'phone' | 'tablet' | 'desktop' {
	if (device.startsWith('phone')) return 'phone';
	if (device.startsWith('tablet')) return 'tablet';
	return 'desktop';
}

/** The page-stack shells (§5.1–§5.3): the forms whose content is ONE full-screen column —
 *  a side view, the editor or the panel as full pages over each other — rather than the
 *  side-by-side frame. Both phone orientations and the portrait tablet page this way
 *  (§5.3's "页面单栏显示"); the landscape tablet and the desktop browser keep VS Code's
 *  side-by-side arrangement. remote.css's whole phone block keys on the attribute. */
export function pageStackOfClass(device: DeviceClass): boolean {
	return device === 'phone-portrait' || device === 'phone-landscape' || device === 'tablet-portrait';
}

/** The short-edge thresholds a classification can turn on — the hysteresis band's
 *  boundaries (§4.2: 24 px either side of a boundary keeps the current class, so dragging
 *  a window across one does not flap it). */
const BOUNDARIES = [500, 600, 1024, 1100];

/** Whether a switch from `current` to `candidate` sits too close to a boundary to act on.
 *  A first classification (`current === null`) always stands. The band is inclusive
 *  (§4.2's own example: a short edge anywhere in 476–524 keeps the current class). */
export function withinHysteresis(current: DeviceClass | null, w: number, h: number): boolean {
	if (current === null) return false;
	const short = Math.min(w, h);
	return BOUNDARIES.some((edge) => Math.abs(short - edge) <= 24 || Math.abs(w - edge) <= 24);
}

/** The manual override (§4.2): a device-level setting, spelled on <html> as
 *  `data-device-override="phone|tablet|desktop"` — the algorithm's answer is ignored while
 *  one is set, and the class is the override's portrait/landscape spelling after the
 *  aspect. */
export function overrideClass(override: string, w: number, h: number): DeviceClass | null {
	const portrait = h >= w;
	if (override === 'phone') return portrait ? 'phone-portrait' : 'phone-landscape';
	if (override === 'tablet') return portrait ? 'tablet-portrait' : 'tablet-landscape';
	if (override === 'desktop') return 'desktop';
	return null;
}

/** One stability-wrapped classification step (§4.2), as responsive.ts calls it from its
 *  debounced resize handling:
 *  - `frozen` (an editable holds the focus): only a WIDTH change may reclassify — the
 *    soft keyboard raising and lowering changes the height alone, and the class must not.
 *  - hysteresis: a candidate class different from the current one whose edges sit within
 *    the band keeps the current class.
 *  - the override, when set, wins outright (still aspect-aware). */
export function settleDeviceClass(
	current: DeviceClass | null,
	w: number,
	h: number,
	touch: boolean,
	previous: { w: number; h: number },
	frozen: boolean,
	override: string | null
): DeviceClass {
	if (override) {
		const forced = overrideClass(override, w, h);
		if (forced) return forced;
	}
	if (frozen && current !== null && w === previous.w) return current;
	const candidate = classify(w, h, touch);
	if (candidate === current) return candidate;
	if (withinHysteresis(current, w, h)) return current!;
	return candidate;
}
