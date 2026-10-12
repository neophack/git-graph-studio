// Which UI a remote page runs (docs/ggs-remote-plan.md §22.5). The PC window has one DOM, so
// it wears one UI at a time, and whoever owns the window decides which: the person at the PC
// while the window is on its screen (the desktop UI), otherwise the first viewer. A page
// whose form factor differs from the owner's runs its own workbench instead of the copy
// (§9.2's browser-side frontend — the phone shell on a phone), so the PC keeps the PC UI
// while a phone uses the phone UI. `?frontend=1` and `?mirror=1` force either mode.

/** Below this viewport width a page is a phone (the responsive shell's own cut). */
export const PHONE_MAX_WIDTH = 600;

export type ModeRequest = 'auto' | 'frontend' | 'mirror';

export function isPhoneWidth(width: number): boolean {
	return width > 0 && width < PHONE_MAX_WIDTH;
}

/** The mode the page's URL asks for. */
export function requestedMode(search: string): ModeRequest {
	const params = new URLSearchParams(search);
	if (params.get('frontend') === '1') return 'frontend';
	if (params.get('mirror') === '1') return 'mirror';
	return 'auto';
}

/** Whether the page runs its own workbench. The auto rule: a phone watching a window the PC
 *  user has on screen — the window keeps the desktop UI for that user, the phone gets the
 *  phone app instead of a shrunken desktop. */
export function wantsOwnUi(request: ModeRequest, phone: boolean, pcVisible: boolean): boolean {
	if (request !== 'auto') return request === 'frontend';
	return phone && pcVisible;
}

/** The same page pinned to the other mode (pinned: the switch must survive a reload, or the
 *  auto rule could bounce the page straight back). */
export function modeUrl(href: string, mode: 'frontend' | 'mirror'): string {
	const url = new URL(href);
	url.searchParams.delete('frontend');
	url.searchParams.delete('mirror');
	url.searchParams.set(mode, '1');
	return url.href;
}
