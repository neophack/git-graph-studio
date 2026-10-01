// The host's Claude Code chat driver (Claude Remote's prompts typed into the desktop tab),
// against a stand-in for the chat page's composer: the same structure the real page
// renders (the form whose submit button carries data-permission-mode, the role=textbox
// contenteditable), and the same behaviour — the button reads "Stop" while a turn runs
// with an empty input, a click on it interrupts, a submit with text sends.

import { describe, expect, it } from 'vitest';
import { answerChatQuestion, chatBusy, chatControls, chatModelPill, interruptChat, pickChatModel, pressSend, setChatInput } from '../src/claudeChatInject';

function chatPage() {
	const doc = document.implementation.createHTMLDocument('chat');
	doc.body.innerHTML = `
		<div class="permissionRequest"><div role="textbox" contenteditable="true">rm -rf build</div></div>
		<form>
			<div role="textbox" contenteditable="plaintext-only" aria-label="Ask Claude to edit…"></div>
			<button type="submit" data-permission-mode="default" aria-label="Send message" disabled>send</button>
		</form>`;
	const form = doc.querySelector('form')!;
	const input = form.querySelector<HTMLElement>('[role="textbox"]')!;
	const button = form.querySelector('button')!;
	const sent: string[] = [];
	let busy = false;
	let interrupts = 0;
	const render = () => {
		const text = input.textContent ?? '';
		button.setAttribute('aria-label', busy && !text.trim() ? 'Stop' : 'Send message');
		button.disabled = !busy && !text.trim();
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
	return { doc, sent, setBusy: (value: boolean) => { busy = value; render(); }, interrupts: () => interrupts };
}

describe('the Claude Code chat driver', () => {
	it('finds the main composer, not the permission prompt’s textbox', () => {
		const { doc } = chatPage();
		const controls = chatControls(doc)!;
		expect(controls.input.getAttribute('contenteditable')).toBe('plaintext-only');
		expect(controls.send.getAttribute('data-permission-mode')).toBe('default');
		expect(chatControls(document.implementation.createHTMLDocument('empty'))).toBe(null);
		expect(chatControls(null)).toBe(null);
	});

	it('types the prompt through the page’s input handling and sends it', () => {
		const page = chatPage();
		const controls = chatControls(page.doc)!;
		expect(pressSend(controls)).toBe(false); // nothing typed: the page keeps send disabled
		setChatInput(controls, 'run the tests\nthen commit');
		expect(controls.send.disabled).toBe(false);
		expect(pressSend(controls)).toBe(true);
		expect(page.sent).toEqual(['run the tests\nthen commit']);
		expect(chatBusy(controls)).toBe(true);
	});

	it('a prompt typed while a turn runs is submitted (the page queues it), not an interrupt', () => {
		const page = chatPage();
		const controls = chatControls(page.doc)!;
		page.setBusy(true);
		setChatInput(controls, 'after this');
		expect(chatBusy(controls)).toBe(true); // the queueing placeholder
		expect(pressSend(controls)).toBe(true);
		expect(page.sent).toEqual(['after this']);
		expect(page.interrupts()).toBe(0);
	});

	it('interrupts through the Stop button, clearing a draft first; idle pages are left alone', () => {
		const page = chatPage();
		const controls = chatControls(page.doc)!;
		expect(interruptChat(controls)).toBe(false);
		page.setBusy(true);
		setChatInput(controls, 'a half-typed draft');
		expect(interruptChat(controls)).toBe(true);
		expect(page.interrupts()).toBe(1);
		expect(chatBusy(controls)).toBe(false);
		expect(page.sent).toEqual([]);
	});
});

// The model picker, against the page's own structure: the pill is the composer's combobox
// button, its menu a listbox of role=option rows (display name plus the model id in the
// description) — the phone's model pick is chosen there, the way a click does.
function modelPickerPage() {
	const doc = document.implementation.createHTMLDocument('chat');
	doc.body.innerHTML = `
		<form>
			<div role="textbox" contenteditable="plaintext-only" aria-label="Ask"></div>
			<button type="submit" data-permission-mode="default" aria-label="Send message" disabled>send</button>
			<button type="button" title="Switch model" role="combobox" aria-haspopup="listbox" aria-expanded="false">Sonnet 4.5</button>
		</form>`;
	const pill = doc.querySelector<HTMLButtonElement>('[role="combobox"]')!;
	const picked: string[] = [];
	let open = false;
	const close = () => { doc.querySelector('[role="listbox"]')?.remove(); open = false; pill.setAttribute('aria-expanded', 'false'); };
	pill.addEventListener('click', () => {
		if (open) { close(); return; }
		open = true;
		pill.setAttribute('aria-expanded', 'true');
		const box = doc.createElement('div');
		box.setAttribute('role', 'listbox');
		box.innerHTML = '<div role="option"><span>Opus 4.6</span> <span>claude-opus-4-6</span></div><div role="option"><span>Sonnet 4.5</span> <span>claude-sonnet-4-5</span></div><div role="option" aria-disabled="true"><span>Sonnet 4.5 [1m]</span> <span>context window</span></div>';
		box.addEventListener('click', (event) => {
			const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
			if (!option || option.getAttribute('aria-disabled') === 'true') return;
			picked.push((option.textContent ?? '').replace(/\s+/g, ' ').trim());
			pill.textContent = (option.firstElementChild?.textContent ?? '').trim();
			close();
		});
		doc.body.appendChild(box);
	});
	return { doc, pill, picked };
}

describe('the model picker driver', () => {
	it('finds the composer’s pill', () => {
		const page = modelPickerPage();
		expect(chatModelPill(page.doc)).toBe(page.pill);
		expect(chatModelPill(document.implementation.createHTMLDocument('empty'))).toBe(null);
		expect(chatModelPill(null)).toBe(null);
	});

	it('picks a tier by its display name and a full id by its description, closing the menu', async () => {
		const page = modelPickerPage();
		expect(await pickChatModel(page.doc, 'opus')).toBe('Opus 4.6 claude-opus-4-6');
		expect(page.picked).toEqual(['Opus 4.6 claude-opus-4-6']);
		expect(page.pill.textContent).toBe('Opus 4.6');
		expect(page.doc.querySelector('[role="listbox"]')).toBe(null); // the menu closed behind the pick
		expect(await pickChatModel(page.doc, 'claude-sonnet-4-5')).toBe('Sonnet 4.5 claude-sonnet-4-5');
		expect(page.pill.textContent).toBe('Sonnet 4.5');
	});

	it('a word match prefers the plain option over a disabled variant; an unknown name closes the menu and picks nothing', async () => {
		const page = modelPickerPage();
		expect(await pickChatModel(page.doc, 'sonnet')).toBe('Sonnet 4.5 claude-sonnet-4-5'); // not the disabled [1m] row
		expect(await pickChatModel(page.doc, 'gpt-99')).toBe(null);
		expect(page.picked).toHaveLength(1);
		expect(page.doc.querySelector('[role="listbox"]')).toBe(null);
		expect(await pickChatModel(modelPickerPage().doc, '')).toBe(null); // nothing asked: the pill is not even opened
	});
});

// The pending AskUserQuestion card, against the page's own structure and behaviour (read
// off the real webview bundle): one card root with a nav tab per question (the tab's
// whole text is the question's header) and a block rendering ONE question at a time — its
// options `role=radio` (single) or `role=checkbox` (multi). A radio click always selects
// (clear + add) and auto-advances to the next tab after 300ms; a checkbox click toggles.
// The card COLLECTS the answers but never submits by itself: the "Submit answers" button
// under it (the shortcut-number span makes its text "1 Submit answers") enables once
// every question holds a pick, and only its click resolves the question — then the card
// renders read-only (aria-disabled), the shape answered cards keep in the transcript.
function questionPage(questions: { header: string; multi?: boolean; opts: string[] }[]) {
	const doc = document.implementation.createHTMLDocument('chat');
	// the composer shares the page: the tab/button search must skip its controls
	const composer = doc.createElement('form');
	composer.innerHTML = '<div role="textbox" contenteditable="true"></div><button type="submit" data-permission-mode="default" aria-label="Send message" disabled>send</button><button type="button" role="combobox" aria-haspopup="listbox">Sonnet</button>';
	doc.body.appendChild(composer);
	const clicks: string[] = [];
	const others: string[] = [];
	const picks: (Set<string> | null)[] = questions.map(() => null);
	let submitted = false;
	let submits = 0;
	let active = 0;
	const card = doc.createElement('div');
	card.className = 'card question';
	const nav = doc.createElement('div');
	const holder = doc.createElement('div');
	const actions = doc.createElement('div');
	card.append(nav, holder, actions);
	doc.body.appendChild(card);
	let otherInput: HTMLInputElement | null = null;
	// a pick change: radios always select (clear + add, never deselect), checkboxes toggle
	const pick = (q: { header: string; multi?: boolean; opts: string[] }, label: string) => {
		const i = questions.indexOf(q);
		const set = picks[i] ?? (picks[i] = new Set());
		if (!q.multi) {
			set.clear();
			set.add(label);
		} else set.has(label) ? set.delete(label) : set.add(label);
		clicks.push(`q${i}:${label}`);
	};
	const render = () => {
		nav.innerHTML = '';
		holder.innerHTML = '';
		actions.innerHTML = '';
		questions.forEach((q, i) => {
			const tab = doc.createElement('button');
			tab.type = 'button';
			tab.innerHTML = `<span>${q.header}</span>`;
			tab.addEventListener('click', () => { if (!submitted) { active = i; render(); } });
			nav.appendChild(tab);
		});
		if (submitted) {
			questions.forEach((q, i) => {
				for (const label of [...q.opts, 'Other']) {
					const option = doc.createElement('div');
					option.setAttribute('role', q.multi ? 'checkbox' : 'radio');
					option.setAttribute('aria-checked', picks[i]?.has(label) ? 'true' : 'false');
					option.setAttribute('aria-disabled', 'true');
					option.innerHTML = `<div>${label}</div><div>desc of ${label}</div>`;
					holder.appendChild(option);
				}
			});
			return;
		}
		const q = questions[active];
		for (const label of q.opts) {
			const option = doc.createElement('div');
			option.setAttribute('role', q.multi ? 'checkbox' : 'radio');
			option.setAttribute('aria-checked', picks[active]?.has(label) ? 'true' : 'false');
			option.innerHTML = `<div>${label}</div><div>desc of ${label}</div>`;
			option.addEventListener('click', () => {
				pick(q, label);
				render();
				// the real card flashes a confirm tick, then lands on the next question's tab
				// (unconditionally — the tab it lands on is the click-time question's neighbour)
				if (!q.multi && label !== 'Other' && active < questions.length - 1) {
					const next = active + 1;
					setTimeout(() => { if (!submitted) { active = next; render(); } }, 300);
				}
			});
			holder.appendChild(option);
		}
		const other = doc.createElement('div');
		other.setAttribute('role', q.multi ? 'checkbox' : 'radio');
		other.setAttribute('aria-checked', picks[active]?.has('Other') ? 'true' : 'false');
		other.innerHTML = '<div>Other</div>';
		other.addEventListener('click', () => {
			pick(q, 'Other');
			render();
			// the input opens inside the re-rendered option; Enter keeps the typed text (the
			// value rides with the answers — it does not submit anything)
			otherInput = doc.createElement('input');
			otherInput.placeholder = 'Type your answer…';
			otherInput.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' || !otherInput) return;
				others.push(otherInput.value);
				otherInput.remove();
				otherInput = null;
			});
			holder.appendChild(otherInput);
		});
		holder.appendChild(other);
		const submit = doc.createElement('button');
		submit.innerHTML = '<span class="shortcut">1</span> Submit answers';
		submit.disabled = !picks.every((set) => set && set.size);
		submit.addEventListener('click', () => {
			if (submit.disabled) return;
			submits++;
			submitted = true;
			otherInput?.remove();
			otherInput = null;
			render();
		});
		actions.appendChild(submit);
	};
	render();
	return { doc, clicks, others, submitted: () => submitted, submits: () => submits, picks: () => picks.map((set) => [...(set ?? [])]) };
}

describe('the question card driver (AskUserQuestion)', () => {
	it('answers a single question by clicking its option; the settled card renders read-only', async () => {
		const page = questionPage([{ header: '验证', opts: ['自动化测试级验证', '自动化 + 实机安装验证'] }]);
		expect(await answerChatQuestion(page.doc, [{ question: '做到什么程度？', header: '验证', picks: ['自动化 + 实机安装验证'] }])).toBe(true);
		expect(page.clicks).toEqual(['q0:自动化 + 实机安装验证']);
		expect(page.submitted()).toBe(true);
		// the matched option was found by its label child, not the description
		expect(page.picks()).toEqual([['自动化 + 实机安装验证']]);
	});

	it('walks each question’s tab in order and handles multi-select toggles', async () => {
		const page = questionPage([
			{ header: 'One', opts: ['a1', 'a2'] },
			{ header: 'Two', multi: true, opts: ['b1', 'b2'] }
		]);
		expect(await answerChatQuestion(page.doc, [
			{ question: 'first', header: 'One', picks: ['a1'] },
			{ question: 'second', header: 'Two', picks: ['b2', 'b1'] }
		])).toBe(true);
		expect(page.clicks).toEqual(['q0:a1', 'q1:b2', 'q1:b1']);
		expect(page.picks()).toEqual([['a1'], ['b2', 'b1']]); // insertion order: b2 landed first
		expect(page.submits()).toBe(1); // one explicit "Submit answers" click — not per pick
	});

	it('an "Other" pick types its text into the box that opens and submits it', async () => {
		const page = questionPage([{ header: 'H', opts: ['x'] }]);
		expect(await answerChatQuestion(page.doc, [{ question: 'q', header: 'H', picks: ['Other'], other: '看情况' }])).toBe(true);
		expect(page.clicks).toEqual(['q0:Other']);
		expect(page.others).toEqual(['看情况']);
		expect(page.submitted()).toBe(true);
	});

	it('a card with nothing pending answers false, and so does a pick the card does not offer', async () => {
		const answered = questionPage([{ header: 'H', opts: ['x'] }]);
		(answered.doc.querySelector('.card.question [role="radio"]') as HTMLElement).click(); // a human at the desktop answers first…
		[...answered.doc.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').includes('Submit answers'))!.click(); // …and submits it
		expect(await answerChatQuestion(answered.doc, [{ question: 'q', header: 'H', picks: ['x'] }])).toBe(false);
		const page = questionPage([{ header: 'H', opts: ['x'] }]);
		expect(await answerChatQuestion(page.doc, [{ question: 'q', header: 'H', picks: ['no such option'] }])).toBe(false);
		expect(page.submitted()).toBe(false);
		expect(page.submits()).toBe(0); // the driver never reached the submit button
		expect(await answerChatQuestion(questionPage([{ header: 'H', opts: ['x'] }]).doc, [])).toBe(false);
	});
});
