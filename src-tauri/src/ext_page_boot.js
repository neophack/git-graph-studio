// The ggx page bootstrap: composed into every extension page the `ggx` protocol serves
// (cmd_ext.rs's serve_ggx_asset), the way graphPreload composes the host environment into the
// Git Graph page. It defines the page's one entry into the host — acquireGgsApi(), the
// webview's counterpart of the extension frame's require('vscode') — over postMessage to the
// parent window; the page's own scripts never learn anything about the transport.
(function () {
	'use strict';
	var acquired = false;
	var nextId = 1;
	var pending = new Map();
	var listeners = [];
	var readyPromise;
	var readyResolve;
	readyPromise = new Promise(function (resolve) { readyResolve = resolve; });
	window.acquireGgsApi = function () {
		if (acquired) throw new Error('acquireGgsApi may only be called once');
		acquired = true;
		return {
			// Resolves once the host has delivered the page's context: which extension and
			// page this is, the open parameters, and the extension's settings.
			ready: readyPromise,
			postMessage: function (message) {
				parent.postMessage({ __ggxPage: true, kind: 'message', message: message }, '*');
			},
			request: function (method, args) {
				return new Promise(function (resolve, reject) {
					var id = nextId++;
					pending.set(id, { resolve: resolve, reject: reject });
					parent.postMessage({ __ggxPage: true, kind: 'rpc', id: id, method: method, args: args || [] }, '*');
				});
			},
			onMessage: function (listener) { listeners.push(listener); }
		};
	};
	window.addEventListener('message', function (event) {
		var data = event.data;
		if (!data || data.__ggxHost !== true) return;
		if (data.type === 'init') {
			readyResolve(data.context);
		} else if (data.type === 'rpcResult') {
			var entry = pending.get(data.id);
			if (entry) {
				pending.delete(data.id);
				if (data.ok) entry.resolve(data.result);
				else entry.reject(new Error(String(data.result)));
			}
		} else if (data.type === 'event') {
			for (var i = 0; i < listeners.length; i++) listeners[i](data.event);
		}
	});
})();
