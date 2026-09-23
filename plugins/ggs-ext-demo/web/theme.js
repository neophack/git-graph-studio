// The GGX Demo pages' theme follower: the workbench's own stylesheet (the --vscode-* tokens
// theme.css maps the pages' palette onto) comes from the host's `theme.stylesheet` service,
// and the host pushes a `theme` event on every switch — the page re-asks and repaints, the
// same contract the Git Graph view's bridge follows. A page calls this once with the api it
// acquired (acquireGgsApi() may only be called once per page, so the page owns it).
'use strict';
window.ggxDemoFollowTheme = function (api) {
	function apply() {
		return api.request('theme.stylesheet', []).then(function (theme) {
			if (!theme) return;
			var style = document.getElementById('ggs-theme');
			if (!style) {
				style = document.createElement('style');
				style.id = 'ggs-theme';
				// First in <head>: the page's own theme.css maps onto the tokens it defines.
				document.head.insertBefore(style, document.head.firstChild);
			}
			style.textContent = theme.css || '';
			// The theme kind as a class (vscode-dark / vscode-light), for anything a page wants
			// to vary beyond the tokens, and the matching native control scheme.
			document.documentElement.classList.remove('vscode-dark', 'vscode-light');
			if (theme.kind) document.documentElement.classList.add(theme.kind);
			document.documentElement.style.colorScheme = theme.kind === 'vscode-light' ? 'light' : 'dark';
		}).catch(function () {
			// Outside the app (no host theme): the fallbacks in theme.css stay in effect.
		});
	}
	api.onMessage(function (event) {
		if (event && event.kind === 'theme') apply();
	});
	return apply();
};
