// The remote chat pane's native cards (docs/remote-client-plan.md §6.4, §8.2): when the
// bridged chat asks something — a permission request, an AskUserQuestion — the PC pushes
// its shape as `chatState`, and these cards render it with buttons sized for fingers,
// beside the copy that still shows the original card in the transcript (tapping THAT one
// replays into the PC as it always did). Answers cross as `chat` operations.

import { t } from '../../../platform/i18n';
import type { ChatCardAnswer, ChatQuestionPayload } from '../../mirror/protocol';

export interface ChatCardsState {
	permission?: { title: string; detail: string };
	question?: ChatQuestionPayload;
}

export interface ChatCardOps {
	sendPermission(decision: 'allow' | 'allowAlways' | 'deny'): void;
	sendAnswer(answer: ChatCardAnswer, submit: boolean): void;
}

/** Render the pending cards into `root` (cleared when nothing is pending). */
export function renderChatCards(root: HTMLElement, state: ChatCardsState, ops: ChatCardOps): void {
	root.replaceChildren();
	if (state.permission) root.appendChild(permissionCard(state.permission, ops));
	if (state.question) root.appendChild(questionCard(state.question, ops));
	root.hidden = root.childElementCount === 0;
}

function permissionCard(permission: { title: string; detail: string }, ops: ChatCardOps): HTMLElement {
	const card = document.createElement('div');
	card.className = 'chat-card chat-card-permission';
	const heading = document.createElement('div');
	heading.className = 'chat-card-title';
	heading.textContent = t('remote.chat.permission.title');
	card.appendChild(heading);
	if (permission.title) {
		const text = document.createElement('div');
		text.className = 'chat-card-text';
		text.textContent = permission.title;
		card.appendChild(text);
	}
	if (permission.detail) {
		const code = document.createElement('code');
		code.className = 'chat-card-detail';
		code.textContent = permission.detail;
		card.appendChild(code);
	}
	const row = document.createElement('div');
	row.className = 'chat-card-row';
	for (const [decision, key, kind] of [
		['deny', 'remote.chat.permission.deny', 'danger'],
		['allowAlways', 'remote.chat.permission.allowAlways', ''],
		['allow', 'remote.chat.permission.allow', 'primary']
	] as const) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `chat-card-button ${kind}`.trim();
		button.textContent = t(key);
		button.addEventListener('click', () => ops.sendPermission(decision));
		row.appendChild(button);
	}
	card.appendChild(row);
	return card;
}

function questionCard(question: ChatQuestionPayload, ops: ChatCardOps): HTMLElement {
	const card = document.createElement('div');
	card.className = 'chat-card chat-card-question';
	const heading = document.createElement('div');
	heading.className = 'chat-card-title';
	heading.textContent = question.header || t('remote.chat.question.title');
	card.appendChild(heading);
	const picks = new Set<string>();
	const other = document.createElement('input');
	other.type = 'text';
	other.className = 'chat-card-other';
	other.placeholder = t('remote.chat.question.otherPlaceholder');
	other.hidden = true;
	const submit = document.createElement('button');
	submit.type = 'button';
	submit.className = 'chat-card-button primary';
	submit.textContent = t('remote.chat.question.submit');
	submit.disabled = true;
	const refresh = () => {
		submit.disabled = picks.size === 0 || (picks.has('Other') && other.value.trim() === '');
		other.hidden = !picks.has('Other');
		for (const option of [...card.querySelectorAll<HTMLElement>('.chat-card-option')]) {
			option.setAttribute('aria-pressed', picks.has(option.dataset['label'] ?? '') ? 'true' : 'false');
		}
	};
	const toggle = (label: string) => {
		if (!question.multi) picks.clear();
		if (picks.has(label) && question.multi) picks.delete(label);
		else picks.add(label);
		refresh();
	};
	for (const option of question.options) {
		card.appendChild(optionButton(option.label, option.description, option.label, () => toggle(option.label)));
	}
	if (!question.options.some((option) => option.label === 'Other')) {
		// The answer vocabulary is the page's own ("Other"); only the button's face is ours.
		card.appendChild(optionButton('Other', undefined, t('remote.chat.question.other'), () => toggle('Other')));
	}
	other.addEventListener('input', refresh);
	card.appendChild(other);
	submit.addEventListener('click', () => {
		const header = question.header;
		const answer: ChatCardAnswer = { question: header, header, picks: [...picks] };
		const typed = other.value.trim();
		if (typed) answer.other = typed;
		ops.sendAnswer(answer, true);
	});
	card.appendChild(submit);
	return card;
}

/** One option button: `label` is the answer the page expects, `display` what it shows. */
function optionButton(label: string, description: string | undefined, display: string, onToggle: () => void): HTMLElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'chat-card-option';
	button.dataset['label'] = label;
	const text = document.createElement('span');
	text.className = 'chat-card-option-label';
	text.textContent = display;
	button.appendChild(text);
	if (description) {
		const note = document.createElement('span');
		note.className = 'chat-card-option-note';
		note.textContent = description;
		button.appendChild(note);
	}
	button.addEventListener('click', onToggle);
	return button;
}
