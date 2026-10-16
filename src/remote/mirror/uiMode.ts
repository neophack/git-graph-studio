// Which UI a remote page runs (docs/ggs-remote-plan.md §22.5, docs/remote-client-plan.md
// §3.1): the page ALWAYS runs its own workbench — remote.html's composition root — and the
// PC window's live DOM copy (the replica) is the explicit `?mirror=1` (or the
// remote.liveView command), never the default anyone lands in. The PC window keeps its
// desktop shell at every size: the phone-shell path is gone (§11 — a phone runs the phone
// app, it is not mirrored onto the window), so only the URL's mode vocabulary lives here.

export type ModeRequest = 'auto' | 'frontend' | 'mirror';

/** The mode the page's URL asks for. */
export function requestedMode(search: string): ModeRequest {
	const params = new URLSearchParams(search);
	if (params.get('frontend') === '1') return 'frontend';
	if (params.get('mirror') === '1') return 'mirror';
	return 'auto';
}

/** The same page pinned to the other mode (pinned: the switch must survive a reload, or the
 * auto rule could bounce the page straight back). */
export function modeUrl(href: string, mode: 'frontend' | 'mirror'): string {
	const url = new URL(href);
	url.searchParams.delete('frontend');
	url.searchParams.delete('mirror');
	url.searchParams.set(mode, '1');
	return url.href;
}
