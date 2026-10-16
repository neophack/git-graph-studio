// This frontend's recent interactions with its own webview copies, per extension — the
// receiving half of §22.6's input replay. A tap inside a mirrored page (Claude's
// "new session" in the copy of its chat) replays into the PC's real page and the panel
// that opens arrives BACK here as a mirrored `webview.create`, which the K7 page hold
// (each frontend's layout is its own) keeps in the background. The input trail is the one
// honest way back: the backend reads a replayed tap as the PC user's own input and the
// mirror's `caller` names no one, so nothing on the PC side can say the create was this
// phone's act — only the phone, which sent the input, knows (2026-10-16: 手机端 claude
// 打开新的 session 页面没有到前台显示).

/** How long an interaction keeps counting as this frontend's own act — generous for the
 *  round trip it witnesses: the input's replay into the PC's page, the extension's panel
 *  create, and the state mirror back here. */
const OWN_ACT_WINDOW_MS = 8_000;

const lastInput = new Map<string, number>();

/** Note an input this frontend sent up for replay from a copy of `extId`'s webview. */
export function noteCopyInteraction(extId: string): void {
	lastInput.set(extId, Date.now());
}

/** Whether a copy of `extId`'s webview took this frontend's input within the window —
 *  stale entries prune themselves, so the map never outlives its answers. */
export function recentCopyInteraction(extId: string): boolean {
	const at = lastInput.get(extId);
	if (at === undefined) return false;
	if (Date.now() - at > OWN_ACT_WINDOW_MS) {
		lastInput.delete(extId);
		return false;
	}
	return true;
}

/** Forget every entry (tests isolate one case from the last). */
export function resetCopyInteractions(): void {
	lastInput.clear();
}
