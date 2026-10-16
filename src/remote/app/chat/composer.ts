// The remote chat pane's native composer (docs/remote-client-plan.md §6.4, §8): the copy
// above it streams the conversation, but the INPUT is this end's own — a textarea whose
// draft lives in this browser alone (K7), whose keystrokes never cross the wire, and whose
// sends travel as one `chat` operation the PC's session bridge runs against the page's own
// composer (the PC user's draft preserved there). While a turn runs the primary button
// becomes Stop and sends land in a local queue — bubbles above the input, retractable —
// drained when the turn ends. The composer also answers the pushed permission and question
// cards (chatCards.ts), and reminds a backgrounded page when a reply lands or a card waits.

import { t } from '../../../platform/i18n';
import { showBanner } from '../../banner';
import type { ChatCardAnswer, UpPayload } from '../../mirror/protocol';
import { renderChatCards, type ChatCardsState } from './chatCards';

/** The textarea's tallest grown height (about six lines). */
const MAX_INPUT_HEIGHT = 132;
/** An Enter earlier than this after a composition's end is the IME's own confirming key,
 *  not a send (§10.2 #8 — Safari fires one after compositionend). */
const IME_QUIET_MS = 50;

export interface ChatComposerDeps {
	stream: string;
	send(message: UpPayload): void;
	now?(): number;
}

export interface ChatComposerHandle {
	state(next: ChatStatePayload): void;
	ack(receipt: ChatAckPayload): void;
	dispose(): void;
}

export interface ChatStatePayload extends ChatCardsState {
	busy: boolean;
	model: string;
	mode: string;
}

export interface ChatAckPayload {
	id: string;
	ok: boolean;
	error?: string;
	detail?: string;
}

interface Queued {
	id: string;
	text: string;
	row: HTMLElement;
}

const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export function mountChatComposer(container: HTMLElement, deps: ChatComposerDeps): ChatComposerHandle {
	const now = deps.now ?? (() => Date.now());
	const root = document.createElement('div');
	root.className = 'chat-native';
	const cards = document.createElement('div');
	cards.className = 'chat-native-cards';
	cards.hidden = true;
	const queueBox = document.createElement('div');
	queueBox.className = 'chat-native-queue';
	const main = document.createElement('div');
	main.className = 'chat-native-main';
	const input = document.createElement('textarea');
	input.className = 'chat-native-input';
	input.rows = 1;
	input.placeholder = t('remote.chat.placeholder');
	input.setAttribute('aria-label', t('remote.chat.placeholder'));
	const stop = document.createElement('button');
	stop.type = 'button';
	stop.className = 'chat-native-stop';
	stop.hidden = true;
	stop.title = t('remote.chat.stop');
	stop.innerHTML = '<span class="codicon codicon-debug-stop" aria-hidden="true"></span>';
	const send = document.createElement('button');
	send.type = 'button';
	send.className = 'chat-native-send';
	send.title = t('remote.chat.send');
	send.innerHTML = '<span class="codicon codicon-send" aria-hidden="true"></span>';
	main.append(input, stop, send);
	const tools = document.createElement('div');
	tools.className = 'chat-native-tools';
	const model = document.createElement('button');
	model.type = 'button';
	model.className = 'chat-native-tool chat-native-model';
	const mode = document.createElement('button');
	mode.type = 'button';
	mode.className = 'chat-native-tool chat-native-mode';
	tools.append(model, mode);
	root.append(cards, queueBox, main, tools);
	container.appendChild(root);

	/* ---------- state ---------- */

	let busy = false;
	let currentModel = '';
	let currentMode = '';
	let hadCard = false;

	/* ---------- the draft (this browser's own, K7) ---------- */

	const draftKey = `remote.chat.draft:${deps.stream}`;
	let draftTimer: ReturnType<typeof setTimeout> | null = null;
	const saveDraft = () => {
		if (draftTimer !== null) return;
		draftTimer = setTimeout(() => {
			draftTimer = null;
			try {
				localStorage.setItem(draftKey, input.value);
			} catch {
				// A full or locked store: the draft just does not survive a reload.
			}
		}, 250);
	};
	try {
		input.value = localStorage.getItem(draftKey) ?? '';
	} catch {
		// ignore
	}

	/* ---------- ids, the queue and the wire ---------- */

	let opSeq = 0;
	const nextId = () => `chat-${now().toString(36)}-${(opSeq += 1)}`;
	let pendingDirect: { id: string; text: string } | null = null;
	let pendingQueued: Queued | null = null;
	const queue: Queued[] = [];

	const emit = (message: UpPayload) => deps.send(message);

	const grow = () => {
		input.style.height = 'auto';
		input.style.height = `${Math.min(MAX_INPUT_HEIGHT, input.scrollHeight)}px`;
	};

	const renderQueue = () => {
		queueBox.replaceChildren(...queue.map((item) => item.row));
	};

	const enqueue = (text: string): void => {
		const item: Queued = { id: nextId(), text, row: document.createElement('div') };
		item.row.className = 'chat-native-queued';
		const label = document.createElement('span');
		label.textContent = text;
		const retract = document.createElement('button');
		retract.type = 'button';
		retract.className = 'chat-native-retract';
		retract.title = t('remote.chat.retract');
		retract.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
		retract.addEventListener('click', () => {
			const at = queue.indexOf(item);
			if (at >= 0) queue.splice(at, 1);
			renderQueue();
			persistQueue();
		});
		item.row.append(label, retract);
		queue.push(item);
		renderQueue();
		persistQueue();
	};

	/** §8.4: the queue survives a reload in this tab, resent by id after a reconnect. */
	const queueKey = `remote.chat.queue:${deps.stream}`;
	const persistQueue = () => {
		try {
			sessionStorage.setItem(queueKey, JSON.stringify(queue.map((item) => ({ id: item.id, text: item.text }))));
		} catch {
			// ignore
		}
	};
	try {
		const saved = JSON.parse(sessionStorage.getItem(queueKey) ?? '[]') as { id: string; text: string }[];
		for (const item of saved) if (typeof item?.id === 'string' && typeof item?.text === 'string') enqueueSaved(item.id, item.text);
	} catch {
		// ignore
	}
	function enqueueSaved(id: string, text: string): void {
		const item: Queued = { id, text, row: document.createElement('div') };
		item.row.className = 'chat-native-queued';
		const label = document.createElement('span');
		label.textContent = text;
		item.row.append(label);
		queue.push(item);
		renderQueue();
	}

	const submit = (): void => {
		const text = input.value.replace(/\s+$/, '');
		if (!text.trim()) return;
		if (busy) {
			input.value = '';
			grow();
			saveDraft();
			enqueue(text);
			return;
		}
		const id = nextId();
		pendingDirect = { id, text };
		emit({ k: 'chat', id, op: 'send', text });
		input.value = '';
		grow();
		saveDraft();
	};

	const stopTurn = (): void => {
		emit({ k: 'chat', id: nextId(), op: 'stop' });
	};

	const drain = (): void => {
		if (busy || pendingQueued || !queue.length) return;
		pendingQueued = queue.shift()!;
		renderQueue();
		persistQueue();
		emit({ k: 'chat', id: pendingQueued.id, op: 'send', text: pendingQueued.text });
	};

	/* ---------- the input's keys: IME-aware, form-factor-aware (§5.7, §10.2 #8) ---------- */

	const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	let compositionEndedAt = -Infinity;
	input.addEventListener('compositionend', () => {
		compositionEndedAt = now();
	});
	input.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter') return;
		// A confirming Enter from the IME itself, or the one Safari fires right after
		// compositionend: never a send.
		if (event.isComposing || event.keyCode === 229 || now() - compositionEndedAt < IME_QUIET_MS) return;
		// The phone's Enter is a newline (§6.4); a hardware keyboard sends on its chord.
		if (coarse || !(event.ctrlKey || event.metaKey)) return;
		event.preventDefault();
		submit();
	});
	input.addEventListener('input', () => {
		grow();
		saveDraft();
	});
	send.addEventListener('click', submit);
	stop.addEventListener('click', stopTurn);
	// The first system-notification permission ask rides a real user gesture.
	input.addEventListener('focus', () => {
		if (typeof Notification === 'function' && Notification.permission === 'default') void Notification.requestPermission?.();
	}, { once: true });

	/* ---------- the model and mode pickers ---------- */

	const ask = document.createElement('div');
	ask.className = 'chat-native-ask';
	ask.hidden = true;
	const askInput = document.createElement('input');
	askInput.type = 'text';
	askInput.className = 'chat-native-ask-input';
	const askOk = document.createElement('button');
	askOk.type = 'button';
	askOk.className = 'chat-native-tool';
	askOk.textContent = t('remote.chat.apply');
	const askCancel = document.createElement('button');
	askCancel.type = 'button';
	askCancel.className = 'chat-native-tool';
	askCancel.textContent = t('remote.chat.cancel');
	ask.append(askInput, askOk, askCancel);
	root.appendChild(ask);
	model.addEventListener('click', () => {
		askInput.value = currentModel;
		askInput.placeholder = t('remote.chat.modelPrompt');
		ask.hidden = false;
		ask.dataset['for'] = 'model';
		askInput.focus();
	});
	mode.addEventListener('click', () => {
		askInput.value = '';
		askInput.placeholder = MODES.join(' / ');
		ask.hidden = false;
		ask.dataset['for'] = 'mode';
		askInput.focus();
	});
	const closeAsk = () => {
		ask.hidden = true;
		input.focus();
	};
	askOk.addEventListener('click', () => {
		const want = askInput.value.trim();
		if (want) emit(ask.dataset['for'] === 'mode' ? { k: 'chat', id: nextId(), op: 'mode', mode: want } : { k: 'chat', id: nextId(), op: 'model', model: want });
		closeAsk();
	});
	askCancel.addEventListener('click', closeAsk);
	askInput.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.isComposing) {
			event.preventDefault();
			askOk.click();
		}
		if (event.key === 'Escape') closeAsk();
	});

	/* ---------- the pushed state and receipts ---------- */

	let hinted = false;
	/** The first pushed state settles whether a restored queue may drain. */
	let firstState = true;
	const onVisible = () => {
		if (document.visibilityState === 'visible' && hinted) {
			hinted = false;
			document.title = document.title.replace(/^●\s*/, '');
		}
	};
	document.addEventListener('visibilitychange', onVisible);

	const hint = (key: string) => {
		if (document.visibilityState !== 'hidden') return;
		hinted = true;
		if (!document.title.startsWith('● ')) document.title = `● ${document.title}`;
		navigator.vibrate?.(10);
		if (typeof Notification === 'function' && Notification.permission === 'granted') {
			try {
				new Notification('Git Graph Studio', { body: t(key as never), tag: `ggs-chat:${deps.stream}` });
			} catch {
				// A notification the platform refuses: the title and the vibration stand.
			}
		}
	};

	const state = (next: ChatStatePayload): void => {
		const wasBusy = busy;
		busy = next.busy;
		currentModel = next.model;
		currentMode = next.mode;
		model.textContent = currentModel || t('remote.chat.model');
		mode.textContent = currentMode ? `${t('remote.chat.mode')}: ${currentMode}` : t('remote.chat.mode');
		stop.hidden = !busy;
		send.classList.toggle('queueing', busy);
		renderChatCards(cards, next, {
			sendPermission: (decision) => emit({ k: 'chat', id: nextId(), op: 'permission', decision }),
			sendAnswer: (answer: ChatCardAnswer, submitAnswers: boolean) =>
				emit({ k: 'chat', id: nextId(), op: 'answer', answers: [answer], submit: submitAnswers })
		});
		if (firstState) {
			// A queue this tab still owed (§8.4): its items cross now, by their original ids.
			firstState = false;
			if (!busy) drain();
		} else if (wasBusy && !busy) {
			drain();
			hint('remote.chat.replyDone');
		}
		if ((next.permission || next.question) && !hadCard) hint('remote.chat.needsYou');
		hadCard = !!(next.permission || next.question);
	};

	const ack = (receipt: ChatAckPayload): void => {
		if (pendingQueued && pendingQueued.id === receipt.id) {
			const item = pendingQueued;
			pendingQueued = null;
			if (!receipt.ok) {
				if (!input.value.trim()) input.value = item.text;
				showBanner('remote.chat.sendFailed', 4000);
				grow();
			} else if (!busy) {
				drain();
			}
			return;
		}
		if (pendingDirect && pendingDirect.id === receipt.id) {
			const sent = pendingDirect;
			pendingDirect = null;
			if (!receipt.ok && !input.value.trim()) {
				input.value = sent.text;
				grow();
				saveDraft();
			}
			if (!receipt.ok) showBanner('remote.chat.sendFailed', 4000);
			else if (receipt.detail) showBanner('remote.chat.modelSet', 2500);
			return;
		}
	};

	grow();
	return {
		state,
		ack,
		dispose(): void {
			document.removeEventListener('visibilitychange', onVisible);
			if (draftTimer !== null) clearTimeout(draftTimer);
			persistQueue();
			root.remove();
		}
	};
}
