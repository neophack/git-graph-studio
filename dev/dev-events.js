// The dev pages' app-event plumbing: `plugin:event|listen` / `emit` / `unlisten` served
// from a page's mocked Tauri internals, with every emit ALSO crossing to the other dev
// pages of this origin over a BroadcastChannel — the dev stand-in for the Relay. This is
// what lets two dev pages (the harness as the PC, remote-phone.html as a phone frontend)
// exercise the cross-frontend workbench sync (module 19, §22.7) in a plain browser, no
// daemon and no PC. Also records every emit (`window.__ggsDevEvents.emitted`) so a probe
// can assert what crossed and how large it was. Never ships.
(function () {
	'use strict';
	var nextCallbackId = 1;
	var nextEventId = 1;
	var callbacks = {};
	/** event name -> Set of callback ids. */
	var listeners = {};
	/** the listen round trip's event id -> { event, handlerId } (unlisten addresses these). */
	var eventIds = {};
	var channel = null;
	try { channel = new BroadcastChannel('ggs-dev-app-events'); } catch (error) { /* no channel: single-page use */ }

	function dispatchLocal(event, payload) {
		var ids = listeners[event];
		if (!ids) return;
		ids.forEach(function (handlerId) {
			var handler = callbacks[handlerId];
			if (handler) handler({ event: event, id: 0, payload: payload });
		});
	}

	if (channel) channel.onmessage = function (message) {
		var data = message.data || {};
		dispatchLocal(data.event, data.payload);
	};

	window.__ggsDevEvents = {
		/** Every emit this page made (for probes: what crossed, and its serialized size). */
		emitted: [],
		/** Deliver an event into this page's listeners, as the runtime would. */
		dispatch: dispatchLocal,
		/** Serve the event plugin over a page's mocked internals. */
		bridge: function (internals) {
			var baseTransform = internals.transformCallback;
			internals.transformCallback = function (callback) {
				var id = nextCallbackId++;
				callbacks[id] = callback;
				return id;
			};
			var baseInvoke = internals.invoke;
			internals.invoke = function (command, args) {
				args = args || {};
				if (command === 'plugin:event|listen') {
					var ids = listeners[args.event] || (listeners[args.event] = new Set());
					ids.add(args.handler);
					var eventId = nextEventId++;
					eventIds[eventId] = { event: args.event, handlerId: args.handler };
					return Promise.resolve(eventId);
				}
				if (command === 'plugin:event|unlisten') {
					var entry = eventIds[args.eventId];
					if (entry) {
						var set = listeners[entry.event];
						if (set) set.delete(entry.handlerId);
						delete eventIds[args.eventId];
					}
					return Promise.resolve(null);
				}
				if (command === 'plugin:event|emit') {
					window.__ggsDevEvents.emitted.push({
						event: args.event,
						payload: args.payload,
						bytes: JSON.stringify({ event: args.event, payload: args.payload }).length
					});
					dispatchLocal(args.event, args.payload);
					if (channel) channel.postMessage({ event: args.event, payload: args.payload });
					return Promise.resolve(null);
				}
				return baseInvoke(command, args);
			};
		}
	};
})();
