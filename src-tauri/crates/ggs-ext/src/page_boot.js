// The extension page bootstrap: composed into every extension page the `ggs` protocol serves
// (cmd_ext.rs's serve_ext_asset), the way graphPreload composes the host environment into the
// Git Graph page. It defines the page's one entry into the host — acquireGgsApi(), the
// webview's counterpart of the extension frame's require('vscode') — over postMessage to the
// parent window; the page's own scripts never learn anything about the transport.
(function () {
	'use strict';
	// monaco-class bundles (claude-code's webview is one) resolve their language-worker
	// module ids against `globalThis._VSCODE_FILE_ROOT`; unset, the loader's ESM path falls
	// into its AMD branch and dies reading `require.toUrl` of undefined. Pin the page's own
	// directory — the base its bundle's relative imports already resolve against — before
	// any page script runs (this boot is the head's first script). A location that cannot
	// serve as a URL base leaves it unset, and a page that pinned its own value first keeps
	// that one.
	if (globalThis._VSCODE_FILE_ROOT === undefined) {
		try { globalThis._VSCODE_FILE_ROOT = new URL('.', location.href).toString(); } catch (e) { /* unresolvable base — leave unset */ }
	}
	var acquired = false;
	var nextId = 1;
	var pending = new Map();
	var listeners = [];
	var readyPromise;
	var readyResolve;
	readyPromise = new Promise(function (resolve) { readyResolve = resolve; });
	// VS Code's webview host writes every --vscode-* theme variable into the document's
	// *inline* style (documentElement.style), not just its stylesheets — package script
	// reads them back that way (colours derived in script through getPropertyValue see
	// stylesheets never). The host parses the active theme's variables and delivers them:
	// with the init context, on theme-change events, re-applied after a document.open
	// swap (the swap wipes the inline attribute with the rest of the document).
	var themeVars = null;
	function applyThemeVars(vars) {
		if (!vars || !document.documentElement) return;
		themeVars = vars;
		var style = document.documentElement.style;
		for (var name in vars) style.setProperty(name, vars[name]);
	}
	window.acquireGgsApi = function () {
		if (acquired) throw new Error('acquireGgsApi may only be called once');
		acquired = true;
		return {
			// Resolves once the host has delivered the page's context: which extension and
			// page this is, the open parameters, and the extension's settings.
			ready: readyPromise,
			postMessage: function (message) {
				parent.postMessage({ __ggsPage: true, kind: 'message', message: message }, '*');
			},
			request: function (method, args) {
				return new Promise(function (resolve, reject) {
					var id = nextId++;
					pending.set(id, { resolve: resolve, reject: reject });
					parent.postMessage({ __ggsPage: true, kind: 'rpc', id: id, method: method, args: args || [] }, '*');
				});
			},
			onMessage: function (listener) { listeners.push(listener); }
		};
	};
	function onHostMessage(event) {
		var data = event.data;
		if (!data || data.__ggsHost !== true) return;
		if (data.type === 'init') {
			// Before `ready` resolves: a page boots from the context the moment it observes
			// it, and its boot must read the theme the way it would in VS Code.
			applyThemeVars(data.context && data.context.themeVars);
			readyResolve(data.context);
		} else if (data.type === 'rpcResult') {
			var entry = pending.get(data.id);
			if (entry) {
				pending.delete(data.id);
				if (data.ok) entry.resolve(data.result);
				else entry.reject(new Error(String(data.result)));
			}
		} else if (data.type === 'event') {
			if (data.event && data.event.kind === 'theme') applyThemeVars(data.event.vars);
			for (var i = 0; i < listeners.length; i++) listeners[i](data.event);
		}
	}
	window.addEventListener('message', onHostMessage);
	// A page that swaps its own document (document.open/write — the Git Graph view renders the
	// extension's generated page that way) keeps this window, but document.open() erases every
	// event listener on it (HTML spec), this one included: every host reply after the swap
	// would then go unheard and the page's requests hang. Re-attach right after the erase —
	// and re-write the theme variables, the erase took the inline style attribute with it.
	var openDocument = document.open;
	document.open = function () {
		var result = openDocument.apply(this, arguments);
		window.removeEventListener('message', onHostMessage);
		window.addEventListener('message', onHostMessage);
		// The fresh document element does not exist until the page's write lands (the view
		// writes synchronously right after open) — try now, and again once that task ends.
		applyThemeVars(themeVars);
		Promise.resolve().then(function () { applyThemeVars(themeVars); });
		return result;
	};
})();
