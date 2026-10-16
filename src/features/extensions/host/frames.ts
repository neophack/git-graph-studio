// Frame/RPC plumbing: the per-extension sandbox frames, the real-Node remote handles, the message router and the frame-RPC call path.

import type { FrameHandle, PageFrameHandle, WebviewHandle } from './sharedTypes';
import type { ExtensionHost } from './extensionHost';

import { extProcessInvoke, extProcessPushEvent, extProcessRegistrations, extProcessRun, extProcessStart } from '../../../platform/ipc/extProcess';
import { describeDetail, extLog, levelForConsole } from '../extLog';
import { hook } from '../../../platform/hooks';



/** The delivery-gate half every webview surface carries — a tabbed panel's record and a
 *  sidebar view's alike: the frame hosting the page, the messages held until the page can
 *  receive them, and whether the frame's current document finished loading. */

/** The frames concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const framesMethods: ThisType<ExtensionHost> = {
	backendHosted(extId: string): boolean {
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		return ext?.capabilities?.backend?.kind === 'node' || (this.nodeHostExe !== null && this.extHasMain.has(extId));
	},

	remoteHandle(extId: string): FrameHandle {
		const existing = this.remoteHandles.get(extId);
		if (existing) return existing;
		const handle: FrameHandle = { remote: true, commandIds: new Set(), pendingCalls: new Set() };
		handle.send = (message) => {
			const data = message as { type?: string };
			// `__studioExtEvent` pushes translate one-to-one; the frame-only channels (the
			// child-process events of the frame's own spawns) do not apply — a real-Node
			// extension spawns real processes itself.
			if (data?.type !== '__studioExtEvent') return;
			void extProcessPushEvent(extId, message).catch(() => undefined);
		};
		handle.call = (method, args) => {
			if (method === 'runCommand') {
				const [command, commandArgs] = args as [string, unknown[] | undefined];
				return extProcessRun(extId, command, commandArgs ?? []);
			}
			return extProcessInvoke(extId, method, args);
		};
		this.remoteHandles.set(extId, handle);
		return handle;
	},

	async ensureNodeHost(extId: string): Promise<void> {
		this.frames.set(extId, this.remoteHandle(extId));
		const startedAt = performance.now();
		try {
			await extProcessStart(extId);
			// The duration is the whole activation (the handshake answers after it) — the
			// number to read against the backend's handshake deadline.
			extLog('info', extId, `extension host process started (${Math.round(performance.now() - startedAt)} ms)`);
		} catch (error) {
			this.frames.delete(extId);
			this.reportActivationFailure(extId, String(error), describeDetail(error));
			throw error;
		}
		// One backend per instance, several frontends: a remote page attaches to a backend
		// the desktop window activated long before, and every registration of that
		// activation (its commands, its `setContext` keys, its view providers) landed there.
		// The backend keeps them (`ext_process_registrations`); replayed here, the page shows
		// the same entries — the Claude Code container, the Git Graph button.
		if (hook('session').frontendClass() === 'remote') await this.replayRegistrations(extId);
	},

	async replayRegistrations(extId: string): Promise<void> {
		const entries = await extProcessRegistrations(extId).catch(() => null);
		for (const entry of entries ?? []) this.applyMirroredState(extId, entry.method, entry.args ?? []);
		if (entries?.length) extLog('info', extId, `replayed ${entries.length} registration(s) of the running backend`);
	},

	applyMirroredState(extId: string, method: string, args: unknown[]): void {
		const handle = this.frames.get(extId) ?? this.remoteHandle(extId);
		this.frames.set(extId, handle);
		// A mirrored create or reveal this frontend's own user caused — they were just
		// interacting with this extension's copy, and the tap's replay into the PC's real
		// page opened the panel (a "new session" tap in the mirrored chat, 2026-10-16: 手机端
		// claude 打开新的 session 页面没有到前台显示) — is the one create/reveal that may
		// take the foreground: the holds below are K7's "another frontend's act stays in the
		// background", and this act is not another frontend's. The backend cannot say it (a
		// replayed tap reads as the PC user's own input, and `caller` names no one); the
		// copy's input trail is the only witness.
		const ownAct = (method === 'webview.create' || method === 'webview.reveal') && hook('webviewStreams')?.recentCopyInteraction?.(extId) === true;
		if (this.sharesWebviews(extId)) {
			const panelId = args[0] as number;
			switch (method) {
				case 'webview.create': {
					// The own-act create takes the foreground — the tap that caused it was
					// this user's, so the copy's tab activates and (with the hold skipped
					// below) the page comes forward. Any other create keeps the extension's
					// own preserveFocus: the copy joins in exactly the posture the serving
					// frontend's real tab did. Forcing the foreground here would activate
					// this side's copy of a panel the other side opened in the background —
					// each side's fresh-tab suppression then eats the activation on both
					// ends, the open never reaches the other side, and its next activation
					// drags this phone's just-opened page away (2026-10-16: 远程某个界面
					// 打开，没有同步到 pc 端，导致又被 pc 端激活页面覆盖).
					if (ownAct) {
						const create = [...args];
						create[4] = false;
						args = create;
					}
					break;
				}
				case 'webview.dispose':
					this.releaseWebview(extId, panelId);
					return;
				case 'webview.reveal': {
					// Another frontend's reveal, mirrored here: the tab comes forward, but
					// never the page — a page hold wraps the reveal (its activation is the
					// OTHER side's act, not this user's; 2026-10-16, 文件页面会被其他页面
					// 顶到最前 — K7, each frontend's layout is its own). Except the reveal
					// this frontend's own copy interaction caused: that one comes forward.
					const release = ownAct ? null : hook('navigation').holdPage();
					try {
						const view = this.webviews.get(this.webviewKey(extId, panelId));
						// A copy closed here reopens: the panel itself lives on in the desktop window.
						if (view && !this.webviewCopies.has(this.webviewKey(extId, panelId))) this.onOpenWebview?.(panelId, view.title, extId, undefined, true);
						else if (view) this.onRevealWebviewTab?.(this.webviewTabId(extId, panelId));
					} finally {
						release?.();
					}
					return;
				}
			}
		}
		// The mirrored serve runs async (the tab opens when the request settles): the page
		// hold rides its whole length, so the create's own activation lands in the
		// background — unless the create is this frontend's own act (ownAct above).
		const release = ownAct ? null : hook('navigation').holdPage();
		void this.serveRequest(method, args, extId, handle)
			.catch((error) => extLog('warn', extId, `mirrored ${method} failed: ${String(error)}`))
			.finally(() => release?.());
	},

	callFrame(handle: FrameHandle, method: string, args: unknown[]): Promise<unknown> {
		// A remote handle (the real-Node extension host): the call crosses ggs-ext/1, and
		// the backend process dying fails it the way a closed frame would.
		if (handle.call) {
			return new Promise((resolve, reject) => {
				const cancel = (error: Error) => {
					handle.pendingCalls.delete(cancel);
					reject(error);
				};
				handle.pendingCalls.add(cancel);
				void handle.call!(method, args).then(resolve, (error) => cancel(error instanceof Error ? error : new Error(String(error))));
			});
		}
		return new Promise((resolve, reject) => {
			const id = this.nextCallId++;
			const send = handle.send;
			if (!send) return reject(new Error('extension frame is not loaded'));
			const finish = (event: MessageEvent) => {
				const data = event.data as { type?: string; id?: number; ok?: boolean; result?: unknown };
				if (data?.type === '__studioExtCallResult' && data.id === id) {
					window.removeEventListener('message', finish);
					handle.pendingCalls.delete(cancel);
					if (data.ok) resolve(data.result);
					else reject(data.result);
				}
			};
			const cancel = (error: Error) => {
				window.removeEventListener('message', finish);
				handle.pendingCalls.delete(cancel);
				reject(error);
			};
			handle.pendingCalls.add(cancel);
			window.addEventListener('message', finish);
			send({ type: '__studioExtCall', id, method, args });
		});
	},

	onMessage(event: MessageEvent): void {
		const data = event.data as { type?: string; id?: number; method?: string; args?: unknown[]; ok?: boolean; result?: unknown; extensionId?: string; error?: string; stack?: string; text?: string; kind?: string };
		if (!data || typeof data !== 'object') return;

		// An extension page's RPC (the composed bootstrap's acquireGgsApi): routed by the
		// frame it came from, the same way the logic frames' __studioExtRpc is.
		if ((data as { __ggsPage?: boolean }).__ggsPage === true) {
			const page = this.pageFor(event.source);
			if (!page) return;
			const message = data as { kind?: string; id?: number; method?: string; args?: unknown[], message?: { command?: string, commits?: number } };
			// A page's own render report — the one observation a frame cannot give any other
			// way (its DOM and its console live behind the process boundary). Any page may
			// report; the host only logs, and the automated full-app check reads the trail.
			if (message.kind === 'message' && message.message?.command === '__viewRendered') {
				console.debug(`[ggs] view rendered: ${message.message.commits ?? '?'} commits (${page.pageId})`);
				return;
			}
			if (message.kind === 'message' && message.message?.command === '__viewDiff') {
				const report = message.message as { file?: string; additions?: number; deletions?: number; header?: string };
				console.debug(`[ggs] view diff ready: ${report.file} (+${report.additions ?? 0}/-${report.deletions ?? 0}) ${report.header ?? ''}`);
				return;
			}
			if (message.kind === 'rpc' && typeof message.method === 'string') {
				// The page source is always a Window (a frame), and jsdom's postMessage takes
				// the targetOrigin string form — not the options object the DOM lib offers.
				const pageWindow = event.source as Window | null;
				this.servePageRpc(message.method, message.args ?? [], page).then(
					(result) => pageWindow?.postMessage({ __ggsHost: true, type: 'rpcResult', id: message.id, ok: true, result }, '*'),
					(error) => pageWindow?.postMessage({ __ggsHost: true, type: 'rpcResult', id: message.id, ok: false, result: String(error) }, '*')
				);
			}
			return;
		}

		// A webview panel's or webview view's message (the composed acquireVsCodeApi
		// bootstrap): it belongs to the panel or view whose frame sent it, and crosses to
		// the owning extension's frame.
			if ((data as { __ggsWebview?: boolean }).__ggsWebview === true) {
					const message = data as { kind?: string; message?: unknown };
					if (message.kind !== 'message') return;
					const view = this.webviewFor(event.source);
				if (view) {
					this.noteWebviewSessionTraffic(view.extId, view.panelId, message.message);
					this.noteClaudeTap(view.extId, view.panelId, 'in', message.message);
					this.frames.get(view.extId)?.send?.({ type: '__studioExtEvent', event: 'webviewMessage', panelId: view.panelId, message: message.message });
					return;
				}
				const webView = this.webviewViewFor(event.source);
				if (webView) {
					this.noteWebviewSessionTraffic(webView.extId, null, message.message);
					this.frames.get(webView.extId)?.send?.({ type: '__studioExtEvent', event: 'webviewViewMessage', viewId: webView.viewId, message: message.message });
					return;
				}
			// A page that speaks but belongs to no panel: its replies go nowhere and the
			// page usually waits forever — one of the blank-page shapes.
			extLog('warn', 'host', `a webview page sent ${String((message.message as { command?: string } | null)?.command ?? 'a message')} but no panel or view owns its frame — dropped`);
			return;
		}

		if (data.type === '__studioExtBootLog') {
			// The frames' own console, mirrored across the sandbox (their entries never reach
			// the workbench's console otherwise): a package's errors and warnings are
			// anomalies the log keeps; its chatter is debug.
			const handle = this.frameFor(event.source);
			const level = levelForConsole(String((data as { level?: string }).level ?? 'log'));
			extLog(level, handle ? this.extIdFor(handle) : 'frame', `console: ${String(data.text ?? '').slice(0, 2000)}`);
			return;
		}
		if (data.type === '__studioExtActivated') {
			// Lazy activation waits for exactly this; eager activation never set a waiter.
			extLog('info', data.extensionId ?? 'extension', 'activated');
			this.activationWaiters.get(data.extensionId ?? '')?.();
			this.activationWaiters.delete(data.extensionId ?? '');
			return; // activation succeeded; nothing to surface
		}
		if (data.type === '__studioExtActivateFailed') {
			// The failure surfaces as a notification; a lazy activation waiting on it settles
			// rather than hanging its trigger. The stack (when the frame captured one) is the
			// only way to point at the line in a foreign package that tripped.
			this.activationWaiters.get(data.extensionId ?? '')?.();
			this.activationWaiters.delete(data.extensionId ?? '');
			this.reportActivationFailure(data.extensionId ?? 'extension', String(data.error ?? 'unknown error'), typeof data.stack === 'string' ? data.stack : null);
			return;
		}

		if (data.type === '__studioExtRpc') {
			const handle = this.frameFor(event.source);
			if (!handle) return;
			const extId = this.extIdFor(handle);
			this.serve(data.method!, data.args ?? [], extId, handle).then(
				(result) => event.source?.postMessage({ type: '__studioExtRpcResult', id: data.id, ok: true, result }, { targetOrigin: '*' }),
				(error) => event.source?.postMessage({ type: '__studioExtRpcResult', id: data.id, ok: false, result: String(error) }, { targetOrigin: '*' })
			);
		}
	},

	frameFor(source: MessageEventSource | null): FrameHandle | null {
		for (const handle of this.frames.values()) {
			if (handle.frame && handle.frame.contentWindow === source) return handle;
		}
		return null;
	},

	pageFor(source: MessageEventSource | null): PageFrameHandle | null {
		for (const page of this.pageFrames.values()) {
			if (page.frame.contentWindow === source) return page;
		}
		return null;
	},

	webviewFor(source: MessageEventSource | null): WebviewHandle | null {
		for (const view of this.webviews.values()) {
			if (view.frame?.contentWindow === source) return view;
		}
		return null;
	},

	extIdFor(handle: FrameHandle): string {
		for (const [id, h] of this.frames) if (h === handle) return id;
		return 'extension';
	},

	extIdForHandle(handle: FrameHandle): string {
		return this.extIdFor(handle);
	},
};
