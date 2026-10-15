import type { ClaudeChatTicket, ClaudeRcState, ClaudeTapSub } from './sharedTypes';
// The host's Claude chat driver and conversation tap: the ggs.claudeChat.* service, the rc (remote-control) scanning and the tap fan-out.

import { CLAUDE_OPEN_COMMAND, commandsRegistered } from './dispatch';
import { FrameHandle } from './sharedTypes';
import { WebviewHandle } from './sharedTypes';
import type { ExtensionHost } from './extensionHost';

import { Channel } from '../../../platform/ipc/core';
import { writeFile } from '../../../platform/ipc/fs';
import { extChildEndStdin, extChildKill, type ExtChildEvent, extChildSpawn, extChildStopFor, extChildWrite, extNodeRuntimePath } from '../../../platform/ipc/extChild';
import { type ExtInfo, extInstallBundled, extInstallFromVsix, extList, extLoadCode, extLogPath, type NodeEnv, extNodeEnv, extPageFileChunk, extPageRevisionBytes, extReadFile, extStoragePaths, extUninstall, type StudioManifest } from '../../../platform/ipc/ext';
import { type ExtProcessInfo, extNodeRuntime, extProcessHostRespond, extProcessInvoke, extProcessPushEvent, extProcessRegistrations, extProcessRun, extProcessStart, extProcessStatus, extProcessStop } from '../../../platform/ipc/extProcess';
import { type GalleryEntry, extGalleryAsset, extGalleryFeatured, extGalleryInstall, extGalleryLookup } from '../../../platform/ipc/gallery';
import { extFs } from '../../../platform/ipc/ext';
import { listen } from '../../../platform/ipc/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { commands } from '../../../platform/commands';
import { applyContributions, applyExtensionSettings, declaredCommand, extensionSettingDefs, extensionThemeList, extensionViewContributions, languageIdFor, localize, registerContextProvider, registerExtensionSnippets, registerExtensionThemes, removeContributions, type ExtensionThemeDef, type ManifestContributes } from '../contributions';
import { describeDetail, extLog, extLogEnabled, extLogLevel, extLogOnce, flushExtLog, levelForConsole, setExtLogOutput, type ExtLogLevel } from '../extLog';
import { defaultNodeEnv } from '../../../hosts/extModuleLoader';
import type { EditorPlacement } from '../../editor/types';
import { setFileDiagnostics, type SerializableDiagnostic } from '../editorDiagnostics';
import { settings as appSettings, syncExtensionThemes, themeById } from '../../../platform/settings';
import { locale, registerZhCnText, t, tf } from '../../../platform/i18n';
import * as state from '../../../platform/state';
import { notify, progressToast, quickInput, type ProgressToast } from '../../../platform/ui/index';
import { extFileDataUrl, forgetExtDataUrls, imageMime } from '../../../platform/extAssets';
import { hook } from '../../../platform/hooks';
import type { SerializedTreeItem } from '../treeView';
import { answerChatPermission, answerChatQuestion, chatBusy, chatControls, interruptChat, pickChatModel, pressSend, setChatInput, setChatPermissionMode, type ChatAnswer } from '../claudeChatInject';

/** The remote-control state of one conversation, as the chat page itself reports it. */

/** The refusal message a remote-control answer carries, wherever the versions put it. */

function claudeRefusalOf(response: unknown): string | null {
	const value = response as { error?: unknown; message?: unknown; request?: { error?: unknown; message?: unknown } } | null;
	for (const candidate of [value?.error, value?.message, value?.request?.error, value?.request?.message]) {
		if (typeof candidate === 'string' && /remote control/i.test(candidate)) return candidate;
		if (candidate && typeof candidate === 'object' && typeof (candidate as { message?: unknown }).message === 'string') {
			const message = (candidate as { message: string }).message;
			if (/remote control/i.test(message)) return message;
		}
	}
	return null;
}

/** The protocol message inside an extension → page post. Claude Code posts every message
 *  to its chat page wrapped — `{type: "from-extension", message}` (the page listens for
 *  exactly that) — while the page posts back bare. Reading the wrapper's own type as the
 *  message's missed all of it: the tap forwarded nothing, the remote-control answer was
 *  never recognized. A bare message passes through. */

export function claudePageMessage(message: unknown): unknown {
	const wrapper = message as { type?: unknown; message?: unknown } | null;
	return wrapper && wrapper.type === 'from-extension' && wrapper.message && typeof wrapper.message === 'object' ? wrapper.message : message;
}

/** Which kind of Claude-conversation traffic a relayed webview message is — the tap only
 *  ever copies these shapes, and everything else a panel exchanges stays private to it. */

export function claudeTapKind(message: unknown): 'sdk' | 'permission' | 'rc' | null {
	const envelope = message as { type?: unknown; request?: { type?: unknown } | null; response?: { type?: unknown } | null } | null;
	// The page protocol wraps a request as {type: "request", requestId, request: {type, …}}
	// and its answer as {type: "response", requestId, response: {type, …}}: the inner type
	// names it. Reading only the outer one missed every real permission prompt.
	const outer = typeof envelope?.type === 'string' ? envelope.type : '';
	const inner = outer === 'request' || !outer ? (typeof envelope?.request?.type === 'string' ? envelope.request.type : '') : outer === 'response' ? (typeof envelope?.response?.type === 'string' ? envelope.response.type : '') : '';
	const type = inner || outer;
	if (type === 'io_message') return 'sdk';
	// The prompt (extension → page), its withdrawal, and the page's answer (page → extension).
	if (type === 'tool_permission_request' || type === 'tool_permission_response' || type === 'cancel_request' || type === 'control_cancel_request' || type === 'permission_request') return 'permission';
	if (type === 'interrupt_claude') return 'sdk';
	if (claudeRemoteControlScan(message, 'channelRemoteControlState') !== undefined) return 'rc';
	if (claudeRemoteControlScan(message, 'channelRemoteControlAvailable') !== undefined) return 'rc';
	return null;
}

/** Read a remote-control field out of a message, wherever the page's protocol nests it
 *  (`channelRemoteControlState`, `.state.channelRemoteControlState`,
 *  `.request.state.…` are all shapes the versions have shipped). */

function claudeRemoteControlScan(message: unknown, key: string, depth = 0): unknown {
	if (!message || typeof message !== 'object' || depth > 3) return undefined;
	const record = message as Record<string, unknown>;
	if (key in record) return record[key];
	for (const nested of ['state', 'request']) {
		if (nested in record) {
			const found = claudeRemoteControlScan(record[nested], key, depth + 1);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function claudeRcStateOf(message: unknown): ClaudeRcState | null {
	// The versions have shipped both spellings (`channelRemoteControlState` and the
	// channel-state bundle's `remoteControlState`); either names the same payload.
	const raw = claudeRemoteControlScan(message, 'channelRemoteControlState')
		?? claudeRemoteControlScan(message, 'remoteControlState');
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	return {
		status: typeof record.status === 'string' ? record.status : '',
		connectUrl: typeof record.connectUrl === 'string' ? record.connectUrl : null,
		sessionUrl: typeof record.sessionUrl === 'string' ? record.sessionUrl : null,
		bridgeEpoch: typeof record.bridgeEpoch === 'number' ? record.bridgeEpoch : null
	};
}

/** One subscriber of the Claude-conversation tap: its queue is bounded, its flush is
 *  asynchronous, and nothing it does may delay or drop the original delivery. */


const TAP_QUEUE_MAX = 256;
const TAP_BATCH = 32;

/** VS Code dialog filters (`{ 'TypeScript': ['ts', 'tsx'] }`) onto the Tauri plugin's shape. */

/** The claude concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const claudeMethods: ThisType<ExtensionHost> = {
	claudeExtId(): string | null {
		return commandsRegistered.get(CLAUDE_OPEN_COMMAND)?.extId ?? this.declaringExtension(CLAUDE_OPEN_COMMAND);
	},

	claudePanels(): WebviewHandle[] {
		const extId = this.claudeExtId();
		return extId ? [...this.webviews.values()].filter((view) => view.extId === extId) : [];
	},

	panelForSession(sessionId: string): WebviewHandle | null {
		for (const [key, hosted] of this.webviewSessions) {
			if (hosted === sessionId) {
				const view = this.webviews.get(key);
				if (view) return view;
			}
		}
		return null;
	},

	async pollFor<T>(probe: () => T | null | undefined | false, ms: number): Promise<T | null> {
		const until = Date.now() + ms;
		for (;;) {
			const value = probe();
			if (value) return value;
			if (Date.now() > until) return null;
			await new Promise((resolve) => setTimeout(resolve, 120));
		}
	},

	claudeChatStart(raw: unknown, send: boolean): { ticket: string } {
		const request = (raw ?? {}) as { sessionId?: unknown; text?: unknown; interrupt?: unknown; model?: unknown };
		const text = typeof request.text === 'string' ? request.text : '';
		if (send && !text.trim()) throw new Error('empty prompt');
		const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : null;
		// The phone's model pick (a tier alias or a full id), validated as the extension's
		// own runner validates it — applied in the tab's picker before the prompt is typed.
		const model = typeof request.model === 'string' && /^[\w.\-[\]:/]{1,80}$/.test(request.model.trim()) ? request.model.trim() : null;
		if (!this.claudeExtId()) throw new Error('the Claude Code extension is not installed');
		const now = Date.now();
		for (const [id, old] of this.claudeChatTickets) if (now - old.at > 10 * 60_000) this.claudeChatTickets.delete(id);
		const ticket: ClaudeChatTicket = { id: `cc${++this.claudeChatSerial}`, at: now, phase: 'opening', error: null, panelKey: null, sessionId };
		this.claudeChatTickets.set(ticket.id, ticket);
		void this.claudeChatRun(ticket, send ? text : null, request.interrupt === true, model).catch((error) => {
			ticket.phase = 'error';
			ticket.error = error instanceof Error ? error.message : String(error);
			extLog('warn', 'host', `claude chat ${ticket.id}: ${ticket.error}`);
		});
		return { ticket: ticket.id };
	},

	async claudeChatRun(ticket: ClaudeChatTicket, text: string | null, interrupt: boolean, model: string | null): Promise<void> {
		const keyOf = (view: WebviewHandle) => this.webviewKey(view.extId, view.panelId);
		let view = ticket.sessionId ? this.panelForSession(ticket.sessionId) : null;
		if (view) {
			this.onRevealWebviewTab?.(this.webviewTabId(view.extId, view.panelId));
		} else {
			const before = new Set(this.claudePanels().map(keyOf));
			// (sessionId, initialPrompt, viewColumn, groupId, fullEditor, { programmatic }):
			// "pin-to-panel" lands it in an editor tab whatever the sidebar preference
			await this.executeCommand(CLAUDE_OPEN_COMMAND, [ticket.sessionId ?? undefined, undefined, undefined, undefined, undefined, { programmatic: 'pin-to-panel' }]);
			view = await this.pollFor(() => (ticket.sessionId ? this.panelForSession(ticket.sessionId) : null) ?? this.claudePanels().find((candidate) => !before.has(keyOf(candidate))), 20_000);
			if (!view) throw new Error('the Claude Code tab did not open');
		}
		ticket.panelKey = keyOf(view);
		const target = view;
		const controls = await this.pollFor(() => chatControls(target.frame?.contentDocument), 20_000);
		if (!controls) throw new Error('the Claude Code chat did not become ready');
		if (text === null) {
			ticket.phase = 'sent';
			return;
		}
		if (model) {
			// The phone chose a model: pick it in the tab's own picker first, so the desktop
			// runs exactly what the phone asked for. Best effort — a name the picker does not
			// offer sends with the tab's current model, logged.
			const picked = await pickChatModel(target.frame?.contentDocument, model);
			if (picked === null) extLog('warn', 'host', `claude chat ${ticket.id}: no model matching "${model}" in the tab's picker; sending with its current model`);
		}
		ticket.phase = 'typing';
		if (interrupt && chatBusy(controls)) {
			interruptChat(controls);
			await this.pollFor(() => !chatBusy(controls), 15_000);
		}
		setChatInput(controls, text);
		const sent = await this.pollFor(() => pressSend(controls), 3_000);
		if (!sent) throw new Error('the Claude Code chat did not take the prompt');
		ticket.phase = 'sent';
		ticket.sentAt = Date.now();
	},

	claudeChatRespond(raw: unknown): { ok: boolean } {
		const request = (raw ?? {}) as { requestId?: unknown; result?: unknown };
		const requestId = typeof request.requestId === 'string' ? request.requestId : '';
		const result = request.result as { behavior?: unknown } | null | undefined;
		if (!requestId) throw new Error('a permission answer names its request');
		if (!result || typeof result !== 'object' || (result.behavior !== 'allow' && result.behavior !== 'deny')) throw new Error('a permission answer is allow or deny');
		const panelKey = this.claudePermissionPanels.get(requestId);
		const view = panelKey ? this.webviews.get(panelKey) ?? null : null;
		if (!view) throw new Error('that permission prompt is no longer open');
		const claudeFrame = this.frames.get(view.extId) ?? null;
		if (!claudeFrame?.send) throw new Error('the Claude Code extension has no live frame');
		const answer = { type: 'response', requestId, response: { type: 'tool_permission_response', result } };
		claudeFrame.send({ type: '__studioExtEvent', event: 'webviewMessage', panelId: view.panelId, message: answer });
		this.claudePermissionPanels.delete(requestId);
		// The tap sees the answer as the page's own (the remotes close their prompt), and
		// the page's card closes the way an answer from elsewhere closes it.
		this.noteClaudeTap(view.extId, view.panelId, 'in', answer);
		this.gateWebviewMessage(view, { type: 'from-extension', message: { type: 'cancel_request', targetRequestId: requestId } }, `${view.extId}#${view.panelId}`);
		return { ok: true };
	},

	claudeChatState(raw: unknown): { phase: string; error: string | null; sessionId: string | null; open: boolean; busy: boolean | null; rc: ClaudeRcState | null } {
		const request = (raw ?? {}) as { ticket?: unknown; sessionId?: unknown };
		const ticket = typeof request.ticket === 'string' ? this.claudeChatTickets.get(request.ticket) ?? null : null;
		if (typeof request.ticket === 'string' && !ticket) return { phase: 'error', error: 'unknown ticket', sessionId: null, open: false, busy: null, rc: null };
		const view = ticket?.panelKey ? this.webviews.get(ticket.panelKey) ?? null : typeof request.sessionId === 'string' ? this.panelForSession(request.sessionId) : null;
		const sessionId = (view ? this.webviewSessions.get(this.webviewKey(view.extId, view.panelId)) : undefined) ?? ticket?.sessionId ?? null;
		if (ticket && sessionId) ticket.sessionId = sessionId;
		const controls = chatControls(view?.frame?.contentDocument);
		return { phase: ticket?.phase ?? (view ? 'sent' : 'none'), error: ticket?.error ?? null, sessionId, open: !!view, busy: controls ? chatBusy(controls) : null, rc: ticket?.rc ?? null };
	},

	claudeChatStop(raw: unknown): { stopped: boolean } {
		const request = (raw ?? {}) as { ticket?: unknown; sessionId?: unknown };
		const ticket = typeof request.ticket === 'string' ? this.claudeChatTickets.get(request.ticket) ?? null : null;
		const view = ticket?.panelKey ? this.webviews.get(ticket.panelKey) ?? null : typeof request.sessionId === 'string' ? this.panelForSession(request.sessionId) : null;
		const controls = chatControls(view?.frame?.contentDocument);
		return { stopped: controls ? interruptChat(controls) : false };
	},

	claudeChatAnswer(raw: unknown): { ticket: string } {
		const request = (raw ?? {}) as { sessionId?: unknown; answers?: unknown };
		const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : null;
		if (!sessionId) throw new Error('a question belongs to a conversation');
		const answers: ChatAnswer[] = [];
		for (const entry of Array.isArray(request.answers) ? request.answers : []) {
			if (!entry || typeof entry !== 'object') throw new Error('malformed answer');
			const answer = entry as Record<string, unknown>;
			const picks = (Array.isArray(answer.picks) ? answer.picks : []).map(String).filter(Boolean).slice(0, 8);
			if (!picks.length) throw new Error('an answer picks nothing');
			answers.push({
				question: String(answer.question ?? '').slice(0, 600),
				header: String(answer.header ?? '').slice(0, 24),
				picks,
				other: typeof answer.other === 'string' ? answer.other.slice(0, 500) : undefined
			});
		}
		if (!answers.length) throw new Error('no answers to give');
		if (!this.claudeExtId()) throw new Error('the Claude Code extension is not installed');
		const now = Date.now();
		for (const [id, old] of this.claudeChatTickets) if (now - old.at > 10 * 60_000) this.claudeChatTickets.delete(id);
		const ticket: ClaudeChatTicket = { id: `cc${++this.claudeChatSerial}`, at: now, phase: 'opening', error: null, panelKey: null, sessionId };
		this.claudeChatTickets.set(ticket.id, ticket);
		void this.claudeChatAnswerRun(ticket, answers).catch((error) => {
			ticket.phase = 'error';
			ticket.error = error instanceof Error ? error.message : String(error);
			extLog('warn', 'host', `claude chat ${ticket.id}: ${ticket.error}`);
		});
		return { ticket: ticket.id };
	},

	async claudeChatAnswerRun(ticket: ClaudeChatTicket, answers: ChatAnswer[]): Promise<void> {
		const keyOf = (view: WebviewHandle) => this.webviewKey(view.extId, view.panelId);
		let view = this.panelForSession(ticket.sessionId!);
		if (view) {
			this.onRevealWebviewTab?.(this.webviewTabId(view.extId, view.panelId));
		} else {
			await this.executeCommand(CLAUDE_OPEN_COMMAND, [ticket.sessionId ?? undefined, undefined, undefined, undefined, undefined, { programmatic: 'pin-to-panel' }]);
			view = await this.pollFor(() => this.panelForSession(ticket.sessionId!), 20_000);
			if (!view) throw new Error('the Claude Code tab did not open');
		}
		ticket.panelKey = keyOf(view);
		ticket.phase = 'answering';
		const answered = await answerChatQuestion(view.frame?.contentDocument, answers);
		if (!answered) throw new Error('the question card did not take the answer');
		ticket.phase = 'sent';
		ticket.sentAt = Date.now();
	},

	claudeChatRemoteControl(raw: unknown): { ticket: string } {
		const request = (raw ?? {}) as { sessionId?: unknown; enable?: unknown };
		const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : null;
		if (!sessionId) throw new Error('remote control belongs to a conversation');
		if (!this.claudeExtId()) throw new Error('the Claude Code extension is not installed');
		const now = Date.now();
		for (const [id, old] of this.claudeChatTickets) if (now - old.at > 10 * 60_000) this.claudeChatTickets.delete(id);
		const ticket: ClaudeChatTicket = { id: `cc${++this.claudeChatSerial}`, at: now, phase: 'requesting', error: null, panelKey: null, sessionId, rc: null };
		this.claudeChatTickets.set(ticket.id, ticket);
		void this.claudeChatRemoteControlRun(ticket, request.enable !== false).catch((error) => {
			ticket.phase = 'error';
			ticket.error = error instanceof Error ? error.message : String(error);
			extLog('warn', 'host', `claude chat ${ticket.id}: ${ticket.error}`);
		});
		return { ticket: ticket.id };
	},

	async claudeChatRemoteControlRun(ticket: ClaudeChatTicket, enable: boolean): Promise<void> {
		let view = this.panelForSession(ticket.sessionId!);
		if (!view) {
			await this.executeCommand(CLAUDE_OPEN_COMMAND, [ticket.sessionId ?? undefined, undefined, undefined, undefined, undefined, { programmatic: 'pin-to-panel' }]);
			view = await this.pollFor(() => this.panelForSession(ticket.sessionId!), 20_000);
			if (!view) throw new Error('the Claude Code tab did not open');
		}
		this.onRevealWebviewTab?.(this.webviewTabId(view.extId, view.panelId));
		const panelKey = this.webviewKey(view.extId, view.panelId);
		ticket.panelKey = panelKey;
		// The channel id is learned from the page's own traffic; a fresh conversation that
		// has not shown a message yet takes a moment to speak one.
		const channelId = await this.pollFor(() => this.webviewChannels.get(panelKey) ?? null, 10_000);
		if (!channelId) throw new Error('the conversation tab has not reported its channel yet');
		const claudeFrame = this.frames.get(this.claudeExtId()!) ?? null;
		if (!claudeFrame?.send) throw new Error('the Claude Code extension has no live frame');
		const answer = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.claudeRcWaiters.delete(panelKey);
				reject(new Error('the chat page did not answer the remote-control request'));
			}, 15_000);
			this.claudeRcWaiters.set(panelKey, {
				channelId,
				resolve: (response) => {
					clearTimeout(timer);
					this.claudeRcWaiters.delete(panelKey);
					resolve(response);
				}
			});
		});
		// Exactly the request the page's own capsule sends (plan §1.1) — the page's UI
		// never learns the host asked, and the answer is consumed below.
		const requestId = `ggs-rc-${ticket.id}`;
		this.claudeRcRequestIds.set(panelKey, requestId);
		claudeFrame.send({ type: '__studioExtEvent', event: 'webviewMessage', panelId: view.panelId, message: { type: 'request', channelId, requestId, request: { type: 'toggle_remote_control', enable } } });
		const response = await answer;
		const state = claudeRcStateOf(response) ?? this.claudeRcStates.get(panelKey) ?? null;
		ticket.rc = state;
		// The CLI refuses third-party endpoints ("Remote Control is only available when
		// using Claude via api.anthropic.com…") inside the answer payload, not as a state
		// — surface its text so the caller reports the reason instead of a bare status.
		const refusal = claudeRefusalOf(response);
		if (refusal) {
			ticket.rc = { ...(state ?? { status: 'error', connectUrl: null, sessionUrl: null, bridgeEpoch: null }), status: 'error', reason: refusal };
		}
		ticket.phase = 'sent';
		ticket.sentAt = Date.now();
	},

	claudeChatRemoteState(raw: unknown): { available: boolean | null; rc: ClaudeRcState | null; sessionId: string | null } {
		const request = (raw ?? {}) as { sessionId?: unknown };
		const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : null;
		const view = sessionId ? this.panelForSession(sessionId) : this.claudePanels()[0] ?? null;
		if (!view) return { available: null, rc: null, sessionId };
		const panelKey = this.webviewKey(view.extId, view.panelId);
		const availableRaw = this.claudeRcAvailable.get(panelKey);
		return { available: availableRaw === undefined ? null : availableRaw, rc: this.claudeRcStates.get(panelKey) ?? null, sessionId: this.webviewSessions.get(panelKey) ?? sessionId };
	},

	claudeChatPermission(raw: unknown): { ticket: string } {
		const request = (raw ?? {}) as { sessionId?: unknown; decision?: unknown; message?: unknown };
		const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : null;
		if (!sessionId) throw new Error('a permission belongs to a conversation');
		const decision = request.decision === 'allowAlways' ? 'allowAlways' : request.decision === 'allow' ? 'allow' : request.decision === 'deny' ? 'deny' : null;
		if (!decision) throw new Error('the decision must be allow, allowAlways or deny');
		const message = typeof request.message === 'string' ? request.message.slice(0, 500) : undefined;
		if (!this.claudeExtId()) throw new Error('the Claude Code extension is not installed');
		const now = Date.now();
		for (const [id, old] of this.claudeChatTickets) if (now - old.at > 10 * 60_000) this.claudeChatTickets.delete(id);
		const ticket: ClaudeChatTicket = { id: `cc${++this.claudeChatSerial}`, at: now, phase: 'opening', error: null, panelKey: null, sessionId };
		this.claudeChatTickets.set(ticket.id, ticket);
		void this.claudeChatCardRun(ticket, (doc) => answerChatPermission(doc, decision, message)).catch((error) => {
			ticket.phase = 'error';
			ticket.error = error instanceof Error ? error.message : String(error);
			extLog('warn', 'host', `claude chat ${ticket.id}: ${ticket.error}`);
		});
		return { ticket: ticket.id };
	},

	claudeChatMode(raw: unknown): { ticket: string } {
		const request = (raw ?? {}) as { sessionId?: unknown; mode?: unknown };
		const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : null;
		if (!sessionId) throw new Error('a permission mode belongs to a conversation');
		const mode = typeof request.mode === 'string' && /^[\w -]{2,24}$/.test(request.mode.trim()) ? request.mode.trim() : '';
		if (!mode) throw new Error('not a permission mode');
		if (!this.claudeExtId()) throw new Error('the Claude Code extension is not installed');
		const now = Date.now();
		for (const [id, old] of this.claudeChatTickets) if (now - old.at > 10 * 60_000) this.claudeChatTickets.delete(id);
		const ticket: ClaudeChatTicket = { id: `cc${++this.claudeChatSerial}`, at: now, phase: 'opening', error: null, panelKey: null, sessionId };
		this.claudeChatTickets.set(ticket.id, ticket);
		void this.claudeChatCardRun(ticket, (doc) => setChatPermissionMode(doc, mode)).catch((error) => {
			ticket.phase = 'error';
			ticket.error = error instanceof Error ? error.message : String(error);
			extLog('warn', 'host', `claude chat ${ticket.id}: ${ticket.error}`);
		});
		return { ticket: ticket.id };
	},

	async claudeChatCardRun(ticket: ClaudeChatTicket, drive: (doc: Document | null | undefined) => Promise<boolean>): Promise<void> {
		let view = this.panelForSession(ticket.sessionId!);
		if (view) {
			this.onRevealWebviewTab?.(this.webviewTabId(view.extId, view.panelId));
		} else {
			await this.executeCommand(CLAUDE_OPEN_COMMAND, [ticket.sessionId ?? undefined, undefined, undefined, undefined, undefined, { programmatic: 'pin-to-panel' }]);
			view = await this.pollFor(() => this.panelForSession(ticket.sessionId!), 20_000);
			if (!view) throw new Error('the Claude Code tab did not open');
		}
		ticket.panelKey = this.webviewKey(view.extId, view.panelId);
		ticket.phase = 'answering';
		const done = await drive(view.frame?.contentDocument);
		if (!done) throw new Error('the chat page did not take the action');
		ticket.phase = 'sent';
		ticket.sentAt = Date.now();
	},

	async claudeTapSubscribe(caller?: FrameHandle): Promise<{ ok: boolean; reason?: string }> {
		const extId = caller ? this.extIdForHandle(caller) : 'host';
		if (appSettings.claudeTapAccess === 'deny') return { ok: false, reason: 'denied by the Claude-conversation access setting' };
		if (!this.claudeTapGrants[extId]) {
			const allow = t('extensions.claudeTap.allow');
			const denyLabel = t('extensions.claudeTap.deny');
			// The notification is fire-and-forget UI; its buttons (or its dismissal — a
			// dismissal is a no) settle the one promise the subscription waits on.
			const answer = await new Promise<'allow' | 'deny'>((resolve) => {
				let settled = false;
				const done = (value: 'allow' | 'deny') => {
					if (!settled) {
						settled = true;
						resolve(value);
					}
				};
				notify('warning', t('extensions.claudeTap.askTitle') + '\n' + tf('extensions.claudeTap.askBody', extId), [
					{ label: allow, run: () => done('allow') },
					{ label: denyLabel, run: () => done('deny') }
				], () => done('deny'));
			});
			if (answer !== 'allow') return { ok: false, reason: 'the user declined' };
			this.claudeTapGrants[extId] = true;
			state.save('ext.claudeTapGrants', this.claudeTapGrants);
			extLog('info', extId, 'granted access to the Claude conversations tap');
		}
		if (!this.claudeTaps.has(extId)) this.claudeTaps.set(extId, { extId, queue: [], dropped: false, flushing: false });
		return { ok: true };
	},

	claudeTapUnsubscribe(caller?: FrameHandle): { ok: boolean } {
		const extId = caller ? this.extIdForHandle(caller) : 'host';
		this.claudeTaps.delete(extId);
		return { ok: true };
	},

	noteClaudeTap(extId: string, panelId: number, dir: 'in' | 'out', message: unknown): void {
		try {
			const panelKey = this.webviewKey(extId, panelId);
			// Channel and remote-control learning happen whether or not anyone taps: the
			// remote-control bridge needs them.
			const channelId = (message as { channelId?: unknown } | null)?.channelId;
			if (typeof channelId === 'string' && channelId) this.webviewChannels.set(panelKey, channelId);
			const rcState = claudeRcStateOf(message);
			if (rcState) this.claudeRcStates.set(panelKey, rcState);
			const available = claudeRemoteControlScan(message, 'channelRemoteControlAvailable');
			if (typeof available === 'boolean') this.claudeRcAvailable.set(panelKey, available);
			const kind = claudeTapKind(message);
			const asked = message as { type?: unknown; requestId?: unknown; request?: { type?: unknown } | null } | null;
			if (kind === 'permission' && dir === 'out' && asked?.type === 'request' && asked.request?.type === 'tool_permission_request' && typeof asked.requestId === 'string') {
				this.claudePermissionPanels.set(asked.requestId, panelKey);
				while (this.claudePermissionPanels.size > 64) this.claudePermissionPanels.delete(this.claudePermissionPanels.keys().next().value!);
			}
			if (!kind || !this.claudeTaps.size) return;
			const event = { dir, kind, panelId, sessionId: this.webviewSessions.get(panelKey) ?? null, message };
			for (const sub of this.claudeTaps.values()) this.enqueueTapEvent(sub, event);
		} catch {
			/* never the original delivery's problem */ }
	},

	enqueueTapEvent(sub: ClaudeTapSub, event: { dir: 'in' | 'out'; kind: string; panelId: number; sessionId: string | null; message: unknown }): void {
		if (sub.queue.length >= TAP_QUEUE_MAX) {
			// The plan's overflow rule: drop the mirror side, mark the gap; the original
			// delivery is untouched and the plugin backfills from the session store. The
			// marker rides the head of the next flushed batch — waiting for a later
			// enqueue would lose it when nothing more arrives.
			sub.dropped = true;
			return;
		}
		sub.queue.push(event);
		this.flushClaudeTap(sub);
	},

	flushClaudeTap(sub: ClaudeTapSub): void {
		if (sub.flushing) return;
		sub.flushing = true;
		void (async () => {
			for (;;) {
				const batch = sub.queue.splice(0, TAP_BATCH);
				if (!batch.length) break;
				if (sub.dropped) {
					sub.dropped = false;
					const any = batch[0];
					batch.unshift({ dir: any.dir, kind: 'gap', panelId: any.panelId, sessionId: any.sessionId, message: null });
				}
				const handle = this.frames.get(sub.extId) ?? this.remoteHandle(sub.extId);
				if (!handle?.send) {
					this.claudeTaps.delete(sub.extId);
					break;
				}
				try {
					await handle.send({ type: '__studioExtEvent', event: 'claudeTap', tap: batch });
				} catch {
					this.claudeTaps.delete(sub.extId);
					extLog('warn', sub.extId, 'claude conversations tap: the subscriber went away');
					break;
				}
			}
			sub.flushing = false;
			if (sub.queue.length && this.claudeTaps.get(sub.extId) === sub) this.flushClaudeTap(sub);
		})();
	},

	consumeClaudeRcResponse(extId: string, panelId: number, message: unknown): boolean {
		const panelKey = this.webviewKey(extId, panelId);
		const waiter = this.claudeRcWaiters.get(panelKey);
		if (!waiter) return false;
		const envelope = message as { type?: unknown; channelId?: unknown; requestId?: unknown } | null;
		if (envelope?.type !== 'response') return false;
		if (typeof envelope.channelId === 'string' && envelope.channelId && envelope.channelId !== waiter.channelId) return false;
		// The answer names the request it answers: anything else is the page's own traffic.
		const asked = this.claudeRcRequestIds.get(panelKey);
		if (asked && typeof envelope.requestId === 'string' && envelope.requestId !== asked) return false;
		this.claudeRcRequestIds.delete(panelKey);
		this.claudeRcWaiters.delete(panelKey);
		waiter.resolve(message);
		return true;
	},
};
