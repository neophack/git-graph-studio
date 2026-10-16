// The PC half of the Claude session bridge (docs/remote-client-plan.md §8): a bridged chat
// stream's remote viewers type into their OWN native composer, and their operations — send,
// stop, permission, answer, model, mode — arrive here as `chat` up messages to be run
// against the chat page the way a user at the PC would (claudeChatInject.ts). Every
// operation answers with a `chatAck` receipt; the page's own state (busy, model, mode, the
// pending permission and question cards) is watched and pushed as `chatState` when it
// changes, merged within 100 ms. The composer's subtree is SKIPPED by the stream's recorder
// (§8.1, webviewShare.ts passes the rule): the PC user's draft never crosses, and neither
// does the remote send's own typing — the wire carries the operation once, the reply
// streams back as the transcript copy it always was.
//
// Loaded on the desktop only, with the first bridged chat stream a remote page watches.

import {
	answerChatPermission,
	chatBusy,
	chatComposerRoot,
	chatControls,
	chatModelPill,
	interruptChat,
	pendingChatPermission,
	pendingChatQuestion,
	pickChatQuestion,
	pickChatModel,
	sendChatText,
	setChatPermissionMode,
	submitChatQuestion,
	type ChatControls
} from '../../features/extensions/claudeChatInject';
import { providerList } from '../../platform/ipc/providers';
import { parseStream, webviewFrameSource } from './webviewFrames';
import type { DownMessage, UpMessage } from './protocol';

/** Changes to the page's state closer together than this merge into one push. */
const STATE_MERGE_MS = 100;
/** How long a `send` waits for the composer to render (a page still resolving its view). */
const COMPOSER_WAIT_MS = 8000;

/** The extension ids the provider bridge runs, cached per module: the set changes only
 *  with the provider store, and every ask rides the same session anyway. */
let bridgedIds: Promise<Set<string>> | null = null;

function bridgedExtIds(): Promise<Set<string>> {
	bridgedIds ??= providerList()
		.then((list) => new Set(list?.bridgedExtIds ?? []))
		.catch(() => new Set<string>());
	return bridgedIds;
}

/** Whether `stream` is a bridged extension's chat stream (§8.1): the stream's extension is
 *  among `provider_list`'s `bridgedExtIds` — the same condition `aiProviders.ts` mounts the
 *  provider chip under, so no extension id is named here either. */
export async function streamIsBridgedChat(stream: string): Promise<boolean> {
	const parsed = parseStream(stream);
	if (!parsed) return false;
	const extId = 'view' in parsed ? webviewFrameSource()?.extOf?.(stream) : parsed.extId;
	return !!extId && (await bridgedExtIds()).has(extId);
}

/** The recorder's skip rule for a bridged chat stream (§8.1): the composer's own subtree —
 *  found structurally every time it is asked, so a re-mounted composer (the page re-render)
 *  is caught by the next serialize, not by a stale element reference. */
export function chatComposerSkipRule(): (node: Node) => boolean {
	return (node) => {
		if (node.nodeType !== 1 || (node as Element).nodeName !== 'FORM') return false;
		const doc = node.ownerDocument;
		return !!doc && chatComposerRoot(doc) === node;
	};
}

export interface ChatBridgeDeps {
	send(message: DownMessage): void;
}

type ChatUp = Extract<UpMessage, { k: 'chat' }>;

/** One bridged chat stream's PC-side driver. Owned by the stream's share; its lifetime is
 *  the doc's — a frame that reloads re-attaches it. */
export class ChatBridge {
	private doc: Document | null = null;
	private observer: MutationObserver | null = null;
	private stateTimer: ReturnType<typeof setTimeout> | null = null;
	private lastState = '';
	/** Operation ids already run (§8.4): a reconnect resends what was never acked, by id —
	 *  a resent `send` must not send twice. */
	private seen = new Set<string>();

	constructor(
		readonly stream: string,
		private readonly deps: ChatBridgeDeps
	) {}

	/** Watch this page (a fresh document after a reload) and push its current state. */
	attach(doc: Document): void {
		this.detach();
		this.doc = doc;
		this.observer = new MutationObserver(() => this.scheduleState());
		this.observer.observe(doc.documentElement ?? doc, { childList: true, subtree: true, attributes: true, characterData: true });
		this.pushState();
	}

	detach(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.doc = null;
		if (this.stateTimer !== null) clearTimeout(this.stateTimer);
		this.stateTimer = null;
	}

	/** One remote operation: run it, receipt it, and re-read the state it likely changed.
	 *  A resent id (a reconnect's §8.4 retry) runs once — its duplicate only re-acks. */
	receive(message: ChatUp): void {
		if (this.seen.has(message.id)) {
			this.deps.send({ k: 'chatAck', to: message.from, w: this.stream, id: message.id, ok: true });
			return;
		}
		this.seen.add(message.id);
		if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value as string);
		void (async () => {
			let ok = false;
			let error: string | undefined;
			let detail: string | undefined;
			try {
				({ ok, error, detail } = await this.run(message));
			} catch (caught) {
				error = String(caught);
			}
			this.deps.send({ k: 'chatAck', to: message.from, w: this.stream, id: message.id, ok, error, detail });
			this.pushState();
		})();
	}

	private async run(message: ChatUp): Promise<{ ok: boolean; error?: string; detail?: string }> {
		switch (message.op) {
			case 'send': {
				const controls = await this.controls();
				if (!controls) return { ok: false, error: 'no composer' };
				// The PC user's draft is preserved inside (sendChatText, §8.2).
				const sent = await sendChatText(controls, message.text);
				return sent ? { ok: true } : { ok: false, error: 'the page would not take the send' };
			}
			case 'stop': {
				const controls = await this.controls();
				if (!controls) return { ok: false, error: 'no composer' };
				return interruptChat(controls) ? { ok: true } : { ok: false, error: 'no turn to stop' };
			}
			case 'permission': {
				const doc = await this.docWithPage();
				const settled = await answerChatPermission(doc, message.decision, message.message);
				return settled ? { ok: true } : { ok: false, error: 'no pending permission card took the answer' };
			}
			case 'answer': {
				const doc = await this.docWithPage();
				for (const answer of message.answers) {
					if (!(await pickChatQuestion(doc, { question: answer.question, header: answer.header, picks: answer.picks, other: answer.other }))) {
						return { ok: false, error: 'the question card did not take the picks' };
					}
				}
				if (message.submit === false) return { ok: true };
				return (await submitChatQuestion(doc)) ? { ok: true } : { ok: false, error: 'the question card did not submit' };
			}
			case 'model': {
				const doc = await this.docWithPage();
				const label = await pickChatModel(doc, message.model);
				return label ? { ok: true, detail: label } : { ok: false, error: 'no such model in the picker' };
			}
			case 'mode': {
				const doc = await this.docWithPage();
				return (await setChatPermissionMode(doc, message.mode)) ? { ok: true } : { ok: false, error: 'no such permission mode' };
			}
		}
	}

	/** The composer, waiting for a page that is still rendering it (§8.4): the view is
	 *  ensured once, then polled — a receipt only after the page had its chance. */
	private async controls(): Promise<ChatControls | null> {
		const doc = await this.docWithPage();
		if (!doc) return null;
		if (chatControls(doc)) return chatControls(doc);
		const found = await waitFor(() => chatControls(this.doc) !== null, COMPOSER_WAIT_MS);
		return found ? chatControls(this.doc) : null;
	}

	/** The doc, ensured to exist: the share only mounts this bridge on a live frame, but the
	 *  frame may swap under a reload while an operation is in flight. */
	private async docWithPage(): Promise<Document | null> {
		if (this.doc) return this.doc;
		webviewFrameSource()?.ensure?.(this.stream);
		await pauseChatBridge(200);
		return this.doc;
	}

	private scheduleState(): void {
		if (this.stateTimer !== null) return;
		this.stateTimer = setTimeout(() => {
			this.stateTimer = null;
			this.pushState();
		}, STATE_MERGE_MS);
	}

	/** Compute and push the state — only when it changed (§8.2: no periodic traffic). */
	private pushState(): void {
		const doc = this.doc;
		const controls = doc ? chatControls(doc) : null;
		const permission = doc ? pendingChatPermission(doc) : null;
		const question = doc ? pendingChatQuestion(doc) : null;
		const state = {
			k: 'chatState' as const,
			to: '*' as const,
			w: this.stream,
			busy: controls ? chatBusy(controls) : false,
			model: (doc ? (chatModelPill(doc)?.textContent ?? '') : '').replace(/\s+/g, ' ').trim().slice(0, 60),
			mode: controls?.send.getAttribute('data-permission-mode') ?? '',
			...(permission ? { permission } : {}),
			...(question ? { question } : {})
		};
		const key = JSON.stringify(state);
		if (key === this.lastState) return;
		this.lastState = key;
		this.deps.send(state);
	}
}

async function waitFor(probe: () => boolean, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	for (;;) {
		if (probe()) return true;
		if (Date.now() > until) return false;
		await pauseChatBridge(150);
	}
}

function pauseChatBridge(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
