// Remote Access, the Claude session bridge (module 19, docs/remote-client-plan.md §8, S2):
// a bridged chat stream's remote viewers type into their OWN composer — the stream's
// recorder SKIPS the PC composer's subtree (§8.1: one empty placeholder, nothing inside it
// crosses), the remote's operations cross as `chat` messages the PC-side bridge runs
// against the page (§8.2), every one answers with a receipt, and the page's own state —
// busy, model, mode, the pending permission and question cards — is pushed as `chatState`
// when it changes. Tested here: the recorder's skip rule against a stand-in chat page, the
// PC bridge's dispatch and receipts, the remote composer's send/queue/stop/cards and its
// IME-aware Enter, the pane gate that waits for the PC to say a stream is a chat, and the
// share wiring the whole path — plus the traffic promise the design makes: typing in the
// native composer crosses nothing at all.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomRecorder } from '../src/remote/mirror/recorder';
import { MirrorViewer } from '../src/remote/mirror/viewer';
import { ChatBridge, chatComposerSkipRule } from '../src/remote/mirror/chatBridge';
import { WebviewShare } from '../src/remote/mirror/webviewShare';
import { setWebviewFrameSource } from '../src/remote/mirror/webviewFrames';
import type { DownMessage, SNode, UpMessage } from '../src/remote/mirror/protocol';
import { mountChatPane } from '../src/remote/app/chat';
import { mountChatComposer } from '../src/remote/app/chat/composer';
import type { ChatAckPayload, ChatComposerHandle, ChatStatePayload } from '../src/remote/app/chat/composer';
import { flush, until } from './helpers';

vi.mock('../src/platform/ipc/providers', () => ({
	providerList: () => Promise.resolve({ activeId: null, profiles: [], presets: [], bridgedExtIds: ['vendor.chat'] })
}));

type ChatUpMessage = Extract<UpMessage, { k: 'chat' }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ChatStateMessage = Extract<DownMessage, { k: 'chatState' }>;
type ChatAckMessage = Extract<DownMessage, { k: 'chatAck' }>;
const statesOf = (down: DownMessage[]) => down.filter((message): message is ChatStateMessage => message.k === 'chatState');
const acksOf = (down: DownMessage[]) => down.filter((message): message is ChatAckMessage => message.k === 'chatAck');

afterEach(() => {
	document.body.innerHTML = '';
	localStorage.clear();
	sessionStorage.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/* ---------- the stand-in chat page (the same structure claudeChatInject drives) ---------- */

function chatPage() {
	const doc = document.implementation.createHTMLDocument('chat');
	doc.body.innerHTML = `
		<div class="transcript"><p>previous turn</p></div>
		<div class="cards"></div>
		<form>
			<div role="textbox" contenteditable="plaintext-only" aria-label="Ask Claude to edit…"></div>
			<button type="submit" data-permission-mode="default" aria-label="Send message" disabled>send</button>
			<button type="button" title="Switch model" role="combobox" aria-haspopup="listbox" aria-expanded="false">Sonnet 4.5</button>
		</form>`;
	const form = doc.querySelector('form')!;
	const input = form.querySelector<HTMLElement>('[role="textbox"]')!;
	const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
	const pill = form.querySelector<HTMLButtonElement>('[role="combobox"]')!;
	const sent: string[] = [];
	let busy = false;
	let interrupts = 0;
	const render = () => {
		const text = input.textContent ?? '';
		button.setAttribute('aria-label', busy && !text.trim() ? 'Stop' : 'Send message');
		button.disabled = busy ? false : !text.trim();
		input.setAttribute('aria-label', busy ? 'Queue another message…' : 'Ask Claude to edit…');
	};
	input.addEventListener('input', render);
	button.addEventListener('click', (event) => {
		if (busy && !(input.textContent ?? '').trim()) {
			event.preventDefault();
			interrupts++;
			busy = false;
			render();
		}
	});
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		sent.push(input.textContent ?? '');
		input.textContent = '';
		busy = true;
		render();
	});
	pill.addEventListener('click', () => {
		const open = pill.getAttribute('aria-expanded') === 'true';
		pill.setAttribute('aria-expanded', open ? 'false' : 'true');
		if (open) {
			doc.querySelector('[role="listbox"]')?.remove();
			return;
		}
		const box = doc.createElement('div');
		box.setAttribute('role', 'listbox');
		box.innerHTML = '<div role="option"><span>Opus 4.6</span> <span>claude-opus-4-6</span></div><div role="option"><span>Sonnet 4.5</span> <span>claude-sonnet-4-5</span></div>';
		box.addEventListener('click', (event) => {
			const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
			if (!option) return;
			pill.textContent = (option.firstElementChild?.textContent ?? '').trim();
			pill.setAttribute('aria-expanded', 'false');
			box.remove();
		});
		doc.body.appendChild(box);
	});
	/** A pending permission card whose buttons settle on a click. */
	const showPermission = () => {
		const card = doc.createElement('div');
		card.className = 'permission-card';
		card.innerHTML = `<p>Bash wants to run <code>rm -rf build</code></p>
			<div class="row"><button type="button">Allow</button><button type="button">Always allow</button><button type="button">Deny</button></div>`;
		for (const b of [...card.querySelectorAll('button')]) {
			b.addEventListener('click', () => card.querySelectorAll('button').forEach((other) => other.setAttribute('aria-disabled', 'true')));
		}
		doc.querySelector('.cards')!.appendChild(card);
	};
	/** A pending single-question card (one radio option plus Other, and its Submit). */
	const showQuestion = () => {
		const card = doc.createElement('div');
		card.className = 'question-card';
		const option = doc.createElement('div');
		option.setAttribute('role', 'radio');
		option.innerHTML = '<div>自动化测试级验证</div><div>the cheap lane</div>';
		const other = doc.createElement('div');
		other.setAttribute('role', 'radio');
		other.innerHTML = '<div>Other</div>';
		const submit = doc.createElement('button');
		submit.innerHTML = '<span class="shortcut">1</span> Submit answers';
		submit.disabled = true;
		const picks = new Set<string>();
		for (const opt of [option, other]) {
			opt.addEventListener('click', () => {
				picks.clear();
				picks.add((opt.firstElementChild?.textContent ?? '').trim());
				submit.disabled = false;
			});
		}
		submit.addEventListener('click', () => {
			card.querySelectorAll('[role="radio"]').forEach((el) => el.setAttribute('aria-disabled', 'true'));
		});
		card.append(option, other, submit);
		doc.querySelector('.cards')!.appendChild(card);
	};
	return { doc, sent, pill, showPermission, showQuestion, setBusy: (value: boolean) => { busy = value; render(); }, interrupts: () => interrupts };
}

/* ---------- §8.1: the recorder skips the composer ---------- */

function skipRig() {
	const page = chatPage();
	const host = document.createElement('div');
	document.body.appendChild(host);
	const sent: DownMessage[] = [];
	let viewer: MirrorViewer;
	const recorder = new DomRecorder(
		page.doc,
		(ops, seq) => {
			const message: DownMessage = { k: 'ops', to: '*', w: 'view:chat', seq, ops };
			sent.push(message);
			viewer.receive(message);
		},
		{ skip: chatComposerSkipRule() }
	);
	viewer = new MirrorViewer(host, 'remote/1', {
		appBase: 'https://phone.example/main/',
		ggsBase: 'https://phone.example/ggs/',
		stream: 'view:chat',
		fluid: true,
		resnap: () => undefined
	});
	const snap = recorder.snapshot();
	viewer.receive({ k: 'snap', to: 'remote/1', w: 'view:chat', ...snap });
	return { page, recorder, viewer, sent, copy: () => viewer.root! };
}

describe('the composer-skip rule (§8.1)', () => {
	it('crosses the composer as one empty placeholder — its content never serializes', () => {
		const { page, copy } = skipRig();
		const placeholder = copy().querySelector('form[data-mirror-skip]');
		expect(placeholder).not.toBe(null);
		expect(placeholder!.childElementCount).toBe(0);
		expect(copy().body.textContent).toContain('previous turn');
		// The transcript (outside the subtree) is there; the composer's own structure is not.
		expect(copy().querySelector('[role="textbox"]')).toBe(null);
		expect(copy().querySelector('[data-permission-mode]')).toBe(null);
		// The rule is structural: it names the composer's form, not a stale element.
		expect(chatComposerSkipRule()(page.doc.querySelector('form')!)).toBe(true);
		expect(chatComposerSkipRule()(page.doc.querySelector('.transcript')!)).toBe(false);
	});

	it('types nothing onto the wire: composer mutations, focus and caret stay local', () => {
		const { page, recorder, sent } = skipRig();
		const baseline = sent.length;
		const input = page.doc.querySelector('[role="textbox"]')!;
		input.focus();
		input.textContent = 'a draft the PC user is typing, one hundred characters of it, all local, all free';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		recorder.flush();
		const fresh = sent.slice(baseline);
		expect(fresh.length).toBe(0);
		// A change OUTSIDE the subtree still crosses — the skip is surgical.
		const line = page.doc.createElement('p');
		line.textContent = 'a reply streams in';
		page.doc.querySelector('.transcript')!.appendChild(line);
		recorder.flush();
		expect(sent.length).toBeGreaterThan(baseline);
	});

	it('catches a re-mounted composer by structure, not identity', () => {
		const { page, recorder, copy } = skipRig();
		const fresh = page.doc.createElement('form');
		fresh.innerHTML = '<div role="textbox" contenteditable="plaintext-only"></div><button type="submit" data-permission-mode="default">send</button>';
		const old = page.doc.querySelector('form')!;
		old.replaceWith(fresh);
		recorder.flush();
		const placeholders = copy().querySelectorAll('form[data-mirror-skip]');
		expect(placeholders.length).toBe(1);
		expect(copy().querySelector('form:not([data-mirror-skip])')).toBe(null);
	});

	it('the fluid copy hides the placeholder — the native composer takes the space', () => {
		const { copy } = skipRig();
		const placeholder = copy().querySelector('form[data-mirror-skip]')!;
		expect(copy().defaultView!.getComputedStyle(placeholder).display).toBe('none');
	});
});

/* ---------- §8.2: the PC-side bridge ---------- */

function bridgeRig() {
	const page = chatPage();
	const down: DownMessage[] = [];
	const bridge = new ChatBridge('view:chat', { send: (message) => down.push(message) });
	bridge.attach(page.doc);
	const up = (message: DistributiveOmit<ChatUpMessage, 'k' | 'from' | 'w'>) =>
		bridge.receive({ ...message, k: 'chat', from: 'remote/1', w: 'view:chat' } as ChatUpMessage);
	return { page, bridge, down, states: () => statesOf(down), acks: () => acksOf(down), up };
}

describe('the PC-side chat bridge (§8.2)', () => {
	it('pushes the initial state on attach, and only pushes on change', async () => {
		const rig = bridgeRig();
		expect(rig.states()).toHaveLength(1);
		expect(rig.states()[0]).toMatchObject({ busy: false, model: 'Sonnet 4.5', mode: 'default' });
		const baseline = rig.states().length;
		rig.page.setBusy(true);
		await until(() => rig.states().length > baseline);
		expect(rig.states().at(-1)).toMatchObject({ busy: true });
		// An idle page with nothing changed pushes nothing more (100 ms merge or not).
		await flush(3);
		expect(rig.states().length).toBe(baseline + 1);
		rig.bridge.detach();
	});

	it('runs a send through the page and preserves the PC user’s draft (§8.3)', async () => {
		const rig = bridgeRig();
		const input = rig.page.doc.querySelector('[role="textbox"]')!;
		input.textContent = 'the draft the PC user had';
		rig.up({ id: 'op1', op: 'send', text: 'run the tests' });
		await until(() => rig.acks().some((ack) => ack.id === 'op1'));
		expect(rig.page.sent).toEqual(['run the tests']);
		const receipt = rig.acks().find((ack) => ack.id === 'op1')!;
		expect(receipt.ok).toBe(true);
		await flush(2);
		expect((input.textContent ?? '').trim()).toBe('the draft the PC user had');
	});

	it('answers stop, permission, answer and model operations, each with a receipt', async () => {
		const rig = bridgeRig();
		rig.up({ id: 'stop1', op: 'stop' });
		await until(() => rig.acks().some((ack) => ack.id === 'stop1'));
		expect(rig.acks().find((ack) => ack.id === 'stop1')!.ok).toBe(false); // no turn to stop

		rig.page.showPermission();
		await until(() => rig.states().some((state) => !!state.permission));
		const withCard = rig.states().find((state) => !!state.permission)!;
		expect(withCard.permission!.title).toContain('Bash wants to run');
		expect(withCard.permission!.detail).toBe('rm -rf build');
		rig.up({ id: 'perm1', op: 'permission', decision: 'allowAlways' });
		await until(() => rig.acks().some((ack) => ack.id === 'perm1'));
		expect(rig.acks().find((ack) => ack.id === 'perm1')!.ok).toBe(true);

		rig.page.showQuestion();
		await until(() => rig.states().some((state) => !!state.question));
		const asked = rig.states().find((state) => !!state.question)!;
		expect(asked.question!.options.map((option) => option.label)).toEqual(['自动化测试级验证', 'Other']);
		rig.up({ id: 'ans1', op: 'answer', answers: [{ question: asked.question!.header, header: asked.question!.header, picks: ['自动化测试级验证'] }] });
		await until(() => rig.acks().some((ack) => ack.id === 'ans1'));
		expect(rig.acks().find((ack) => ack.id === 'ans1')!.ok).toBe(true);

		rig.up({ id: 'model1', op: 'model', model: 'opus' });
		await until(() => rig.acks().some((ack) => ack.id === 'model1'));
		const modelAck = rig.acks().find((ack) => ack.id === 'model1')!;
		expect(modelAck.ok).toBe(true);
		expect(modelAck.detail).toContain('Opus 4.6');
		expect(rig.page.pill.textContent).toBe('Opus 4.6');
	});

	it('a resent operation id runs once (§8.4 dedup)', async () => {
		const rig = bridgeRig();
		rig.up({ id: 'again', op: 'send', text: 'only once' });
		await until(() => rig.page.sent.length === 1);
		rig.up({ id: 'again', op: 'send', text: 'only once' });
		await until(() => rig.acks().filter((ack) => ack.id === 'again').length === 2);
		expect(rig.page.sent).toEqual(['only once']);
	});
});

/* ---------- the remote composer ---------- */

function composerRig(stream = 'view:chat', now: () => number = () => Date.now()) {
	// A fine pointer by default: Ctrl+Enter sends, plain Enter is a newline (§6.4).
	vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
	const container = document.createElement('div');
	document.body.appendChild(container);
	const ups: UpMessage[] = [];
	const composer: ChatComposerHandle = mountChatComposer(container, {
		stream,
		send: (message) => ups.push({ ...message, from: 'remote/1', w: stream } as UpMessage),
		now
	});
	const input = container.querySelector<HTMLTextAreaElement>('.chat-native-input')!;
	const sendButton = () => container.querySelector<HTMLButtonElement>('.chat-native-send')!;
	const stopButton = () => container.querySelector<HTMLButtonElement>('.chat-native-stop')!;
	const state = (next: Partial<ChatStatePayload>) => composer.state({ busy: false, model: '', mode: '', ...next });
	const enter = (init: KeyboardEventInit & { isComposing?: boolean; keyCode?: number } = {}) => {
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
		if (init.isComposing !== undefined) Object.defineProperty(event, 'isComposing', { get: () => init.isComposing });
		if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { get: () => init.keyCode });
		input.dispatchEvent(event);
	};
	const sentOps = () => ups.filter((message): message is ChatUpMessage => message.k === 'chat');
	return { container, composer, input, sendButton, stopButton, state, enter, sentOps, ack: (receipt: ChatAckPayload) => composer.ack(receipt) };
}

describe('the remote composer (§6.4, §8.2)', () => {
	it('types one hundred characters and crosses NOTHING — the input is this end’s own (§7.4: 0 B)', async () => {
		const rig = composerRig();
		rig.state({ busy: false });
		for (let i = 0; i < 100; i += 1) {
			rig.input.value += '字';
			rig.input.dispatchEvent(new Event('input', { bubbles: true }));
		}
		await flush(6); // past the draft's own debounce — still nothing on the wire
		expect(rig.sentOps()).toHaveLength(0);
	});

	it('sends on the button and on Ctrl+Enter (a fine pointer); plain Enter is a newline', async () => {
		const rig = composerRig();
		rig.state({ busy: false, model: 'Sonnet 4.5', mode: 'default' });
		rig.input.value = 'hello from the phone';
		rig.enter();
		expect(rig.sentOps()).toHaveLength(0);
		rig.enter({ ctrlKey: true });
		expect(rig.sentOps()).toHaveLength(1);
		expect(rig.sentOps()[0]).toMatchObject({ k: 'chat', op: 'send', text: 'hello from the phone' });
		expect(rig.input.value).toBe('');
		rig.input.value = 'by button';
		rig.sendButton().click();
		expect(rig.sentOps()).toHaveLength(2);
	});

	it('never sends through the IME’s own Enter (§10.2 #8)', () => {
		let clock = 1_000;
		const rig = composerRig('view:chat', () => clock);
		rig.state({ busy: false });
		rig.input.value = '组字中';
		rig.enter({ isComposing: true, keyCode: 229 });
		rig.enter({ keyCode: 229 });
		expect(rig.sentOps()).toHaveLength(0);
		// The Enter Safari fires right after compositionend is still the IME's.
		rig.input.dispatchEvent(new CompositionEvent('compositionend'));
		rig.enter({ ctrlKey: true });
		expect(rig.sentOps()).toHaveLength(0);
		// ...and a later one is the user's own.
		clock += 100;
		rig.enter({ ctrlKey: true });
		expect(rig.sentOps()).toHaveLength(1);
	});

	it('queues while a turn runs, drains when it ends, and a bubble can be retracted', async () => {
		const rig = composerRig();
		rig.state({ busy: true });
		expect(rig.stopButton().hidden).toBe(false);
		rig.input.value = 'queued thought';
		rig.sendButton().click();
		expect(rig.sentOps()).toHaveLength(0); // nothing leaves while the turn runs
		const bubble = rig.container.querySelector('.chat-native-queued')!;
		expect(bubble.textContent).toContain('queued thought');
		rig.state({ busy: false });
		await flush(1);
		expect(rig.sentOps()).toHaveLength(1);
		expect(rig.sentOps()[0]).toMatchObject({ op: 'send', text: 'queued thought' });
		// The queued send started its own turn: the queue waits for that one too.
		rig.state({ busy: true });
		rig.input.value = 'second';
		rig.sendButton().click();
		rig.container.querySelector<HTMLButtonElement>('.chat-native-retract')!.click();
		rig.state({ busy: false });
		await flush(1);
		expect(rig.sentOps()).toHaveLength(1);
		rig.stopButton().click();
		expect(rig.sentOps().at(-1)).toMatchObject({ op: 'stop' });
	});

	it('a failed receipt puts the text back and says so; a direct send keeps its id', async () => {
		const rig = composerRig();
		rig.state({ busy: false });
		rig.input.value = 'try me';
		rig.sendButton().click();
		const id = rig.sentOps()[0].id;
		rig.ack({ id, ok: false, error: 'no composer' });
		expect(rig.input.value).toBe('try me');
		expect(document.querySelector('.remote-banner')).not.toBe(null);
	});

	it('renders the pushed cards and answers them as operations', async () => {
		const rig = composerRig();
		rig.state({ busy: false, permission: { title: 'Bash wants to run rm -rf build', detail: 'rm -rf build' } });
		const buttons = [...rig.container.querySelectorAll('.chat-card-permission .chat-card-button')];
		expect(buttons.map((b) => b.textContent)).toEqual(['Deny', 'Always allow', 'Allow']);
		buttons[2].click();
		expect(rig.sentOps().at(-1)).toMatchObject({ op: 'permission', decision: 'allow' });
		rig.state({ busy: false, permission: undefined, question: { header: '验证', multi: false, options: [{ label: 'lanes', description: 'two lanes' }, { label: 'Other' }] } });
		const options = [...rig.container.querySelectorAll('.chat-card-option')];
		expect(rig.container.querySelector('.chat-card-question .chat-card-title')!.textContent).toContain('验证');
		options[0].click();
		const submit = [...rig.container.querySelectorAll('.chat-card-button')].find((b) => b.textContent.includes('Submit')) as HTMLButtonElement;
		expect(submit.disabled).toBe(false);
		submit.click();
		expect(rig.sentOps().at(-1)).toMatchObject({ op: 'answer', answers: [{ header: '验证', picks: ['lanes'] }], submit: true });
	});

	it('keeps the draft per stream and the queue per tab across a remount (§8.4)', async () => {
		const first = composerRig('view:chat');
		first.state({ busy: true });
		first.input.value = 'held in the queue';
		first.sendButton().click();
		first.composer.dispose();
		const second = composerRig('view:chat');
		second.state({ busy: false });
		await until(() => second.sentOps().length === 1);
		expect(second.sentOps()[0]).toMatchObject({ op: 'send', text: 'held in the queue' });
		// A draft survives its own debounce and comes back on the next mount.
		second.input.value = 'the draft';
		second.input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 300));
		second.composer.dispose();
		const third = composerRig('view:chat');
		expect(third.input.value).toBe('the draft');
	});
});

/* ---------- the pane gate (app/chat/index.ts) ---------- */

describe('the chat pane gate', () => {
	it('mounts the composer on the PC’s first chatState for THIS stream, and only then', async () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const ups: UpMessage[] = [];
		const handlers = new Set<(message: DownMessage) => void>();
		const stop = mountChatPane(container, {
			stream: 'view:chat',
			send: (message) => ups.push({ ...message, from: 'remote/1', w: 'view:chat' } as UpMessage),
			listen: (handler) => {
				handlers.add(handler);
				return () => handlers.delete(handler);
			}
		});
		const push = (message: DownMessage) => {
			for (const handler of [...handlers]) handler(message);
		};
		// Another stream's state mounts nothing; the PC's own ops are ignored by the gate.
		push({ k: 'ops', to: '*', w: 'view:other', seq: 1, ops: [] });
		push({ k: 'chatState', to: '*', w: 'view:other', busy: false, model: '', mode: '' });
		await flush(2);
		expect(container.querySelector('.chat-native')).toBe(null);
		push({ k: 'chatState', to: '*', w: 'view:chat', busy: false, model: '', mode: '' });
		await until(() => container.querySelector('.chat-native') !== null);
		expect(container.classList.contains('chat-native-pane')).toBe(true);
		// A receipt for the mounted composer reaches it (a failed stop id is simply ignored).
		push({ k: 'chatAck', to: 'remote/1', w: 'view:chat', id: 'unknown', ok: false });
		stop();
		expect(container.querySelector('.chat-native')).toBe(null);
		expect(container.classList.contains('chat-native-pane')).toBe(false);
	});
});

/* ---------- the share wiring (the full PC path) ---------- */

describe('the share wiring (webviewShare + bridge)', () => {
	function shareRig() {
		const frame = document.createElement('iframe');
		document.body.appendChild(frame);
		const page = chatPage();
		frame.contentDocument!.body.innerHTML = page.doc.body.innerHTML;
		// The stand-in's behaviour is re-bound onto the live frame document: the same
		// composer contract as chatPage(), on the frame's own document.
		const form = frame.contentDocument!.querySelector('form')!;
		const input = form.querySelector<HTMLElement>('[role="textbox"]')!;
		const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
		const sent: string[] = [];
		const render = () => {
			const text = input.textContent ?? '';
			button.setAttribute('aria-label', text.trim() || !button.dataset['busy'] ? 'Send message' : 'Stop');
			button.disabled = !button.dataset['busy'] && !text.trim();
		};
		input.addEventListener('input', render);
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			sent.push(input.textContent ?? '');
			input.textContent = '';
			button.dataset['busy'] = '1';
			render();
		});
		setWebviewFrameSource({
			frameFor: (stream) => (stream === 'view:chat' ? frame : null),
			ensure: () => undefined,
			extOf: (stream) => (stream === 'view:chat' ? 'vendor.chat' : null)
		});
		const down: DownMessage[] = [];
		const share = new WebviewShare('view:chat', { send: (message) => down.push(message), now: () => Date.now() });
		return {
			share,
			down,
			frame,
			sent,
			stop: () => {
				share.stop();
				setWebviewFrameSource(null);
			}
		};
	}

	it('a bridged chat stream: the hello snapshots, the bridge lands, and the resnap carries the placeholder', async () => {
		const rig = shareRig();
		try {
			rig.share.receive({ k: 'hello', from: 'remote/1', vw: 400, vh: 700, touch: true });
			await until(() => statesOf(rig.down).length > 0);
			// The latest snapshot for this viewer replaced the composer with its placeholder.
			const snaps = rig.down.filter((message): message is Extract<DownMessage, { k: 'snap' }> => message.k === 'snap' && message.to === 'remote/1');
			const last = snaps.at(-1)!;
			const formNode = findNode(last.doc.html, (node) => node.t === 'e' && node.n === 'form');
			expect(formNode).toMatchObject({ a: expect.objectContaining({ 'data-mirror-skip': '' }) });
			expect(formNode!.k).toBeUndefined();
			// The remote's chat op runs against the frame's page and receipts.
			rig.share.receive({ k: 'chat', from: 'remote/1', w: 'view:chat', id: 'op9', op: 'send', text: 'over the wire' });
			await until(() => acksOf(rig.down).some((ack) => ack.id === 'op9' && ack.ok));
			expect(rig.sent).toEqual(['over the wire']);
			// Typing in the frame's composer crosses nothing after the skip landed.
			const opsBefore = rig.down.filter((message) => message.k === 'ops').length;
			const input = rig.frame.contentDocument!.querySelector('[role="textbox"]')!;
			input.textContent = 'PC-side draft typing crosses zero bytes';
			rig.share.receive({ k: 'resnap', from: 'remote/1' }); // forces a flush cycle through the share
			rig.share.receive({ k: 'ptr', from: 'remote/1', ev: 'hover', b: 0, m: 0, d: 0, i: 1, fx: 0.5, fy: 0.5 });
			await flush(3);
			expect(rig.down.filter((message) => message.k === 'ops').length).toBe(opsBefore);
		} finally {
			rig.stop();
		}
	});

	it('a share that stopped with its last viewer re-bridges on the next hello', async () => {
		const rig = shareRig();
		try {
			rig.share.receive({ k: 'hello', from: 'remote/1', vw: 400, vh: 700, touch: true });
			await until(() => statesOf(rig.down).length === 1);
			rig.share.receive({ k: 'bye', from: 'remote/1' });
			expect(rig.share.viewerCount).toBe(0);
			rig.share.receive({ k: 'hello', from: 'remote/2', vw: 400, vh: 700, touch: true });
			await until(() => statesOf(rig.down).length === 2);
			// The fresh viewer's ops run against the page through the re-attached bridge.
			rig.share.receive({ k: 'chat', from: 'remote/2', w: 'view:chat', id: 'op10', op: 'send', text: 'again' });
			await until(() => acksOf(rig.down).some((ack) => ack.id === 'op10' && ack.ok));
			expect(rig.sent).toEqual(['again']);
		} finally {
			rig.stop();
		}
	});
});

function findNode(node: SNode, test: (node: SNode) => boolean): SNode | null {
	if (test(node)) return node;
	for (const child of node.k ?? []) {
		const found = findNode(child, test);
		if (found) return found;
	}
	return null;
}
