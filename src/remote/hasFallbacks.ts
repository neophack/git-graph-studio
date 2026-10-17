// The `:has()` fallbacks (docs/remote-client-plan.md §10.2 item 2, C0): Firefox 115 ESR —
// an A-level browser of §10.1's floor — does not support `:has()`, and three layout rules
// keyed on it would silently not apply on a remote page there. The classes these rules
// target are maintained here instead, by one observer over the shell's DOM, so the
// stylesheet needs no `:has()` at all on the remote side:
//
//   .pane-header.no-twistie      — a header with no direct `.twistie` child keeps the
//                                  twistie's 16px text edge (shell.css).
//   .sidebar-title.label-only    — a side-view title that is only its name; the phone's
//                                  page starts at its content (remote.css).
//   .editor-split-child.no-focus — the split children without the focused editor group;
//                                  the phone shows one group at a time (remote.css).
//
// The desktop's own webviews (WebView2 evergreen, WKWebView) all carry `:has()`, so the
// desktop keeps its `:has()` spellings. Here both spellings stand in the stylesheets and
// the maintainer installs ONLY on an engine without `:has()` (Firefox 115 ESR): the sweep
// is three whole-document querySelectorAll passes per mutation batch, far too dear to run
// on engines whose CSS already answers the question.
let installed = false;

function sweep(): void {
	for (const header of document.querySelectorAll('.pane-header')) {
		header.classList.toggle('no-twistie', header.querySelector(':scope > .twistie') === null);
	}
	for (const title of document.querySelectorAll('.sidebar-title')) {
		title.classList.toggle('label-only', ![...title.children].some((child) => !child.classList.contains('label')));
	}
	for (const child of document.querySelectorAll('.editor-split-child')) {
		child.classList.toggle('no-focus', child.querySelector('.editor-group-box.focused') === null);
	}
}

/** Whether this engine needs the class maintainers at all: `:has()` carries the layout
 *  directly wherever it exists (Chrome 105+, Safari 15.4+, Firefox 121+); only Firefox
 *  115 ESR — §10.1's floor — lacks it. The stylesheets keep BOTH spellings (an engine
 *  that cannot parse `:has()` drops just that selector), so on a modern browser the
 *  maintainer never installs — its sweep was three whole-document querySelectorAll
 *  passes on every class change anywhere, the page switch's dominant local cost
 *  (2026-10-16, the response-latency pass). */
function hasSelectorSupport(): boolean {
	if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
	try {
		return CSS.supports('selector(:has(*))');
	} catch {
		return false;
	}
}

/** Install the class maintainers (idempotent — the remote shell installs once). Engines
 *  that carry `:has()` install nothing: the stylesheet's own `:has()` rules apply. */
export function installHasFallbacks(): void {
	if (installed) return;
	installed = true;
	if (hasSelectorSupport()) return;
	const observer = new MutationObserver(sweep);
	observer.observe(document.body, { childList: true, subtree: true, attributeFilter: ['class'] });
	sweep();
}
