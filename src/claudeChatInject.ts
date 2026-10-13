// Driving a Claude Code chat page from the host, the way a user at the keyboard would:
// type into its input and press its send button. Claude Remote's phone prompts go
// through here, so the desktop tab itself runs them — the desktop shows the turn as its
// own, and the session file the phone reads is the one that tab writes.
//
// A webview panel's document is a same-origin srcdoc frame (`allow-same-origin`), so the
// host reaches its DOM directly. The selectors are the page's stable structure, not its
// hashed class names: the main composer is the form whose submit button carries
// `data-permission-mode`; its input is the `role="textbox"` contenteditable inside it.
// While a turn runs, that button reads "Stop" (an empty input) and a click interrupts;
// with text in the input it submits, and the page queues the prompt behind the turn.

export interface ChatControls {
	input: HTMLElement;
	send: HTMLButtonElement;
}

/** The chat page's composer, once the page has rendered it. */
export function chatControls(doc: Document | null | undefined): ChatControls | null {
	const send = doc?.querySelector<HTMLButtonElement>('form button[type="submit"][data-permission-mode]') ?? null;
	const input = send?.closest('form')?.querySelector<HTMLElement>('[role="textbox"][contenteditable]') ?? null;
	return send && input ? { input, send } : null;
}

/** Whether the page shows a turn in flight: its send button became "Stop", or its
 *  input's placeholder became the queueing one ("Queue another message…"). */
export function chatBusy(controls: ChatControls): boolean {
	return controls.send.getAttribute('aria-label') === 'Stop' || /^queue/i.test(controls.input.getAttribute('aria-label') ?? '');
}

function inputText(input: HTMLElement): string {
	return (input.textContent ?? '').replace(/\r\n?/g, '\n');
}

/** Replace the input's content with `text` through the page's own input handling: the
 *  editing command first (what typing does), else the content and an `input` event. */
export function setChatInput(controls: ChatControls, text: string): void {
	const { input } = controls;
	const doc = input.ownerDocument;
	const win = doc.defaultView;
	input.focus();
	const selection = win?.getSelection();
	if (selection) {
		const range = doc.createRange();
		range.selectNodeContents(input);
		selection.removeAllRanges();
		selection.addRange(range);
	}
	let inserted = false;
	try {
		inserted = text === '' ? doc.execCommand('delete', false) : doc.execCommand('insertText', false, text);
	} catch {
		inserted = false;
	}
	if (!inserted || inputText(input).trim() !== text.trim()) {
		input.textContent = text;
		const InputEventCtor = (win as (Window & typeof globalThis) | null)?.InputEvent ?? InputEvent;
		input.dispatchEvent(new InputEventCtor('input', { bubbles: true, inputType: 'insertText', data: text }));
	}
}

/** Press send. False while the button is disabled (the page has not taken the text yet). */
export function pressSend(controls: ChatControls): boolean {
	if (controls.send.disabled) return false;
	controls.send.click();
	return true;
}

/** Interrupt the running turn (an empty input turns the send button into "Stop"). */
export function interruptChat(controls: ChatControls): boolean {
	if (!chatBusy(controls)) return false;
	if (inputText(controls.input).trim() !== '') setChatInput(controls, '');
	if (controls.send.getAttribute('aria-label') !== 'Stop' || controls.send.disabled) return false;
	controls.send.click();
	return true;
}

/** The composer's model pill — the page's own model picker (a combobox button). */
export function chatModelPill(doc: Document | null | undefined): HTMLButtonElement | null {
	if (!doc) return null;
	return (
		doc.querySelector<HTMLButtonElement>('button[title^="Switch model"][role="combobox"]') ??
		doc.querySelector<HTMLButtonElement>('form button[role="combobox"][aria-haspopup="listbox"]') ??
		null
	);
}

async function waitFor(probe: () => boolean, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	for (;;) {
		if (probe()) return true;
		if (Date.now() > until) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

function escapeRe(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Choose `want` in the page's model picker, the way a click does: open the pill's
 * listbox, click the option whose label or description names it (a tier like "sonnet"
 * matches "Sonnet 4.5" and the "claude-sonnet-…" of its description; a full model id
 * matches the description alone), wait for the menu to close. Answers the matched
 * option's label, or null when there is no pill, the listbox never opened, or nothing
 * matched — the caller then sends with the tab's current model.
 */
export async function pickChatModel(doc: Document | null | undefined, want: string): Promise<string | null> {
	const pill = chatModelPill(doc);
	if (!pill || !want.trim()) return null;
	const openListbox = () => {
		const id = pill.getAttribute('aria-controls');
		const box = (id ? doc?.getElementById(id) ?? null : null) ?? doc?.querySelector('[role="listbox"]') ?? null;
		return box && box.isConnected && box.querySelector('[role="option"]') ? box : null;
	};
	pill.click();
	const listbox = await waitFor(() => !!openListbox(), 4000) ? openListbox() : null;
	if (!listbox) return null; // the menu never opened; there is nothing to close
	const needle = want.trim().toLowerCase();
	const wordish = new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}`, 'i');
	let best: { label: string; score: number; option: HTMLElement } | null = null;
	for (const option of [...listbox.querySelectorAll<HTMLElement>('[role="option"]')]) {
		if (option.getAttribute('aria-disabled') === 'true') continue;
		const label = (option.textContent ?? '').replace(/\s+/g, ' ').trim();
		const at = label.toLowerCase().indexOf(needle);
		if (at < 0) continue;
		// the option that IS the want (its display name starts with it) beats one that
		// merely mentions it in a description; a word-edge match beats a substring inside
		// another token
		const score = at === 0 ? 3 : wordish.test(label) ? 2 : 1;
		if (!best || score > best.score) best = { label, score, option };
	}
	if (!best) {
		pill.click(); // nothing matched: close the menu
		return null;
	}
	best.option.click();
	await waitFor(() => !listbox.isConnected, 4000);
	return best.label;
}

/* ---------- the account & usage section ---------- */

/** The chat page's "Account & usage" section toggle — the collapse control its
 *  sessions panel carries. Structural, like every selector here: the button holds
 *  `aria-expanded` and a title naming the section ("Expand account & usage" /
 *  "Collapse account & usage"). */
export function chatAccountUsageToggle(doc: Document | null | undefined): HTMLButtonElement | null {
	if (!doc) return null;
	for (const button of [...doc.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]) {
		if (!button.isConnected) continue;
		if (/account & usage$/i.test((button.getAttribute('title') ?? '').trim())) return button;
	}
	return null;
}

/** Collapse the section when it renders expanded — one click on its own toggle, the
 *  way a user collapses it. Answers whether the click landed (false when the section
 *  is absent or already collapsed: nothing to do). */
export function collapseChatAccountUsage(doc: Document | null | undefined): boolean {
	const toggle = chatAccountUsageToggle(doc);
	if (toggle === null || toggle.getAttribute('aria-expanded') !== 'true') return false;
	toggle.click();
	return true;
}

/* ---------- the permission card and the permission mode ---------- */

/** The one-word labels a permission card offers, normalized as the page shows them. A
 *  card is claude-code's own UI for a `tool_permission_request`: its buttons are the
 *  whole vocabulary, so an exact-text match (after whitespace) is precise — a loose
 *  substring match would catch every "Allow" in any other widget on the page. */
const PERMISSION_BUTTONS = {
	allow: ['allow once', 'allow', 'yes, allow', 'yes', 'proceed'],
	allowAlways: ['always allow', 'allow always', 'always', 'don\u2019t ask again', "don't ask again", 'dont ask again'],
	deny: ['deny', 'no, deny', 'no', 'reject', 'decline']
};

function normalizedText(element: HTMLElement): string {
	return (element.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function permissionButtons(doc: Document | null | undefined): { allow: HTMLButtonElement[]; allowAlways: HTMLButtonElement[]; deny: HTMLButtonElement[] } {
	const out = { allow: [] as HTMLButtonElement[], allowAlways: [] as HTMLButtonElement[], deny: [] as HTMLButtonElement[] };
	if (!doc) return out;
	for (const button of [...doc.querySelectorAll<HTMLButtonElement>('button')]) {
		if (!button.isConnected || button.getAttribute('aria-disabled') === 'true' || button.disabled) continue;
		const label = normalizedText(button);
		if (PERMISSION_BUTTONS.allow.includes(label)) out.allow.push(button);
		else if (PERMISSION_BUTTONS.allowAlways.includes(label)) out.allowAlways.push(button);
		else if (PERMISSION_BUTTONS.deny.includes(label)) out.deny.push(button);
	}
	return out;
}

/**
 * The page's pending permission card, answered the way a click does: the decision's own
 * button ("Always allow" beats "Allow" for allowAlways; a deny may first type its reason
 * into the card's message box, when the card offers one). Answers whether a button was
 * clicked and the card settled (its permission buttons gone). False when no card is
 * pending, its button never matched, or the card did not take the click in time — the
 * phone is told, and the desktop user can still answer it by hand.
 */
export async function answerChatPermission(doc: Document | null | undefined, decision: 'allow' | 'allowAlways' | 'deny', message?: string): Promise<boolean> {
	if (!doc) return false;
	const before = permissionButtons(doc);
	const buttons = decision === 'deny' ? before.deny : decision === 'allowAlways' ? before.allowAlways.length ? before.allowAlways : before.allow : before.allow;
	if (!buttons.length) return false; // no pending card (or a shape this host does not know)
	if (decision === 'deny' && message) {
		// A deny-with-reason card carries a free-text box beside its buttons; the page's
		// own value setter is what its handler sees (the AskUserQuestion "Other" rule).
		const input = doc.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea, input[type="text"]');
		if (input) {
			const win = doc.defaultView as (Window & typeof globalThis) | null;
			const proto = input.tagName === 'TEXTAREA' ? win?.HTMLTextAreaElement?.prototype : win?.HTMLInputElement?.prototype;
			const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
			input.focus();
			if (setter) setter.call(input, message);
			else input.value = message;
			input.dispatchEvent(new (win?.Event ?? Event)('input', { bubbles: true }));
		}
	}
	buttons[buttons.length - 1].click(); // the card's own button, not a stray match elsewhere
	const settled = await waitFor(() => {
		const after = permissionButtons(doc);
		return after.allow.length + after.allowAlways.length + after.deny.length === 0;
	}, 6000);
	return settled;
}

/** The permission-mode selector: the control near the composer that names the mode (the
 *  submit button carries `data-permission-mode`, and the mode's own control is the
 *  button/combobox that names a mode in its title or label). */
function permissionModeControl(doc: Document | null | undefined): HTMLButtonElement | null {
	if (!doc) return null;
	const send = doc.querySelector<HTMLButtonElement>('form button[type="submit"][data-permission-mode]');
	const scope = send?.closest('form') ?? doc.body;
	for (const button of [...scope.querySelectorAll<HTMLButtonElement>('button')]) {
		if (!button.isConnected) continue;
		const described = `${button.getAttribute('title') ?? ''} ${button.getAttribute('aria-label') ?? ''} ${normalizedText(button)}`.toLowerCase();
		if (/permission mode|approval mode|mode:/.test(described) || button.getAttribute('aria-haspopup') === 'menu') {
			if (/default|accept edits|acceptEdits|plan|bypass|auto|manual|dont ask|don\u2019t ask/i.test(described)) return button;
		}
	}
	return null;
}

/**
 * Switch the chat's permission mode through its own selector: open the control, click
 * the option that names `mode`, wait for the menu to close. Best effort by design — the
 * page's structure is claude-code's, and a mode it does not offer answers false without
 * touching anything.
 */
export async function setChatPermissionMode(doc: Document | null | undefined, mode: string): Promise<boolean> {
	if (!doc || !mode.trim()) return false;
	const control = permissionModeControl(doc);
	if (!control) return false;
	control.click();
	const menuOf = () => {
		const id = control.getAttribute('aria-controls');
		const box = (id ? doc.getElementById(id) : null) ?? doc.querySelector('[role="menu"], [role="listbox"]');
		return box && box.isConnected ? box : null;
	};
	const menu = await waitFor(() => menuOf() !== null, 3000) ? menuOf() : null;
	if (!menu) return false;
	// acceptEdits, accept-edits and accept edits all name the same mode: split the camel
	// humps and the separators, then compare word-wise.
	const wanted = mode.trim().replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
	const options = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="option"], button')];
	let best: { score: number; option: HTMLElement } | null = null;
	for (const option of options) {
		if (option.getAttribute('aria-disabled') === 'true') continue;
		const label = normalizedText(option);
		if (!label) continue;
		const score = label === wanted ? 3 : label.includes(wanted) ? 2 : 0;
		if (score && (!best || score > best.score)) best = { score, option };
	}
	if (!best) {
		control.click(); // close the menu
		return false;
	}
	best.option.click();
	await waitFor(() => !menu.isConnected, 3000);
	return true;
}

/* ---------- AskUserQuestion: the pending option card ---------- */

/** One answer the phone gave: the question text and header the card showed, the option
 *  labels picked ("Other" among them), and the typed text of an Other pick. */
export interface ChatAnswer {
	question: string;
	header: string;
	picks: string[];
	other?: string;
}

/** The card's still-live options. The card is the page's own — its options are
 *  `role="radio"` (single) or `role="checkbox"` (multi), and an answered card renders
 *  them `aria-disabled` — so "no live option" also means "no pending card". */
function liveQuestionOptions(doc: Document | null | undefined): HTMLElement[] {
	if (!doc) return [];
	return [...doc.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]')]
		.filter((option) => option.isConnected && option.getAttribute('aria-disabled') !== 'true');
}

/** The option that offers `want`: an exact text child first (the label above the
 *  description), else a textContent prefix — what the card's own click handler sees. */
function optionFor(options: HTMLElement[], want: string): HTMLElement | null {
	const label = want.trim();
	if (!label) return null;
	for (const option of options) {
		for (const child of [option, ...option.children]) {
			if ((child.textContent ?? '').replace(/\s+/g, ' ').trim() === label) return option;
		}
	}
	return options.find((option) => (option.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith(label)) ?? null;
}

/** The nav tab of the question with this header: a plain button whose whole text is the
 *  header (the card renders one tab per question; a one-question card has none). */
function questionTab(doc: Document, header: string): HTMLButtonElement | null {
	const label = header.trim();
	if (!label) return null;
	for (const button of [...doc.querySelectorAll<HTMLButtonElement>('button')]) {
		if (button.type === 'submit' || button.getAttribute('role') === 'combobox' || !button.isConnected) continue;
		if ((button.textContent ?? '').replace(/\s+/g, ' ').trim() === label) return button;
	}
	return null;
}

/** Type into the Other option's answer box and press Enter. It is a controlled input of
 *  the page's realm: the frame's own value setter plus an `input` event is what its
 *  handler sees (a plain `.value` write would not reach its state). */
function typeOtherAnswer(doc: Document, text: string): boolean {
	const input = doc.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		'input[placeholder^="Type your answer"], textarea[placeholder^="Type your answer"]'
	);
	if (!input) return false;
	const win = doc.defaultView as (Window & typeof globalThis) | null;
	const proto = input.tagName === 'TEXTAREA' ? win?.HTMLTextAreaElement?.prototype : win?.HTMLInputElement?.prototype;
	const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
	input.focus();
	if (setter) setter.call(input, text);
	else input.value = text;
	input.dispatchEvent(new (win?.Event ?? Event)('input', { bubbles: true }));
	input.dispatchEvent(new (win?.KeyboardEvent ?? KeyboardEvent)('keydown', { key: 'Enter', bubbles: true }));
	return true;
}

/** The card's "Submit answers" button — the one act that answers the question. The card
 *  accumulates every click into its answers but never submits by itself; the primary
 *  button under it ("1 Submit answers", keyboard shortcut 1) enables once every question
 *  holds a pick, and its click is what resolves the tool call. */
function submitAnswersButton(doc: Document | null | undefined): HTMLButtonElement | null {
	if (!doc) return null;
	for (const button of [...doc.querySelectorAll<HTMLButtonElement>('button')]) {
		if (!button.isConnected) continue;
		if ((button.textContent ?? '').replace(/\s+/g, ' ').trim().endsWith('Submit answers')) return button;
	}
	return null;
}

/**
 * Answer the page's pending AskUserQuestion card the way clicks do: per question, open
 * its nav tab, click the picked options ("Other" last — it types its text into the box
 * that opens), then click the card's own "Submit answers" button — the card collects the
 * picks but only that click resolves the question (a multi-select keeps toggling until
 * then). Answers whether the card settled: its options render disabled (or the card is
 * gone). False when there is no pending card, a picked option never matched, or the card
 * did not take the answers in time — the caller reports that to the phone.
 */
export async function answerChatQuestion(doc: Document | null | undefined, answers: ChatAnswer[]): Promise<boolean> {
	if (!doc || !answers.length || !liveQuestionOptions(doc).length) return false;
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	for (const answer of answers) {
		const tab = questionTab(doc, answer.header);
		if (tab) {
			tab.click();
			await sleep(150); // the card swaps to that question's block
		}
		const picks = [...answer.picks.filter((pick) => pick !== 'Other'), ...answer.picks.filter((pick) => pick === 'Other')];
		for (const pick of picks) {
			const option = await waitFor(() => optionFor(liveQuestionOptions(doc), pick) !== null, 3000)
				? optionFor(liveQuestionOptions(doc), pick)
				: null;
			if (!option) return false;
			option.click();
			await sleep(180); // a render cycle: the card checks it, or advances to the next tab
			if (pick === 'Other' && answer.other && !typeOtherAnswer(doc, answer.other)) return false;
		}
	}
	const submit = await waitFor(() => {
		const button = submitAnswersButton(doc);
		return !!button && !button.disabled;
	}, 3000)
		? submitAnswersButton(doc)
		: null;
	if (!submit) return false;
	submit.click();
	return waitFor(() => liveQuestionOptions(doc).length === 0, 8000);
}
