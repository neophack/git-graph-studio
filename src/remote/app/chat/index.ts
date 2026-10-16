// The chat pane's mounting gate (docs/remote-client-plan.md §8): a webview stream's pane
// mounts its copy unconditionally (webviewCopy.ts), but the native composer and cards wait
// for the PC to say the stream IS a bridged chat — the first `chatState` that arrives for
// it. Nothing here names an extension: the PC's own bridged-ext knowledge decides, and a
// non-bridged webview never sees a composer. The composer module loads lazily on that
// first state, so the pane's ordinary cost stays the copy alone.

import { MIRROR_DOWN, type DownMessage, type UpPayload } from '../../mirror/protocol';
import type { ChatAckPayload, ChatComposerHandle, ChatStatePayload } from './composer';

export interface ChatPaneDeps {
	stream: string;
	send(message: UpPayload): void;
	listen(handler: (message: DownMessage) => void): () => void;
}

export function mountChatPane(container: HTMLElement, deps: ChatPaneDeps): () => void {
	let composer: ChatComposerHandle | null = null;
	let loading: Promise<void> | null = null;
	const unlisten = deps.listen((message) => {
		if (('w' in message ? message.w : undefined) !== deps.stream) return;
		if (message.k === 'chatState') {
			const state: ChatStatePayload = {
				busy: message.busy,
				model: message.model,
				mode: message.mode,
				...(message.permission ? { permission: message.permission } : {}),
				...(message.question ? { question: message.question } : {})
			};
			if (composer) {
				composer.state(state);
				return;
			}
			if (loading) return;
			loading = import('./composer')
				.then(({ mountChatComposer }) => {
					if (!loading) return; // disposed while loading
					composer = mountChatComposer(container, { stream: deps.stream, send: deps.send });
					container.classList.add('chat-native-pane');
					composer.state(state);
				})
				.catch(() => undefined);
			return;
		}
		if (message.k === 'chatAck' && composer) composer.ack(message as ChatAckPayload);
	});
	return () => {
		unlisten();
		loading = null;
		composer?.dispose();
		composer = null;
		container.classList.remove('chat-native-pane');
	};
}

/** The event the gate listens on, for the callers that wire it beside their own viewer. */
export const CHAT_EVENT = MIRROR_DOWN;
