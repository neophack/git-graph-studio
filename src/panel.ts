// The bottom panel: VS Code's panel header with its view tabs (TERMINAL, OUTPUT), the active
// view's actions, and the maximize / close controls. The Output view is channel-based like
// VS Code's: the "Git" channel (every git command the app ran, as VS Code's Git extension
// logs them) plus the channels installed extensions created (`createOutputChannel`), picked
// from a dropdown in the view's actions.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { ContextView } from './contextView';
import { TerminalView } from './terminal';
import { t } from './i18n';
import { SETTINGS_EVENT } from './settings';
import { actionButton, el, icon } from './ui';

export type PanelViewId = 'terminal' | 'output' | 'context';

/** The Output view's channels, in the picker: the built-in "Git" one first, then the
 *  extensions' (creation order; a name collisions gets the owning extension in brackets). */
const GIT_CHANNEL = 'Git';

export class OutputView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;
	private readonly log: HTMLElement;
	private loaded = false;
	/** Per-channel line buffers; the Git channel's backend history loads lazily on first show. */
	private readonly channels = new Map<string, string[]>([[GIT_CHANNEL, []]]);
	private readonly picker: HTMLSelectElement;

	constructor() {
		this.log = el('pre', 'output-log');
		this.log.setAttribute('aria-live', 'polite');
		this.picker = el('select', 'output-channel-picker') as HTMLSelectElement;
		this.picker.setAttribute('aria-label', 'Select Channel');
		this.picker.appendChild(new Option(GIT_CHANNEL, GIT_CHANNEL, true, true));
		this.picker.addEventListener('change', () => this.renderActive());
		this.element = el('div', 'panel-body', [this.log]);
		this.actions = el('div', 'actions', [
			this.picker,
			actionButton('clear-all', 'Clear Output', () => void this.clear())
		]);
		void listen<string>('studio://git-output', (event) => this.append(event.payload)).catch(() => undefined);
	}

	/** The log kept before the view was first shown is fetched once. */
	async shown(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const lines = await invoke<string[]>('git_output_log');
			this.channels.set(GIT_CHANNEL, lines);
			this.renderActive();
		} catch {
			// No backend (tests): the live events alone fill the view.
		}
	}

	append(line: string): void {
		this.appendLine(GIT_CHANNEL, line);
	}

	/** One line into a channel: buffered whether or not the view is visible, rendered when
	 *  the channel is the one on screen (and the log was at its bottom, as live tails are). */
	appendLine(channel: string, line: string): void {
		const buffer = this.channels.get(channel) ?? [];
		if (buffer.length > 5000) buffer.splice(0, buffer.length - 5000); // bounded, like the session log
		buffer.push(line);
		this.channels.set(channel, buffer);
		if (channel === this.activeChannel()) this.appendLive(line);
	}

	/** An extension channel list arrived (the extension host pushes the full set). */
	setExtensionChannels(channels: { extId: string; name: string }[]): void {
		// `known` seeds from the SURVIVING labels only (the git channel plus everything
		// the incoming set provides). Seeding it from the existing map keys — as it once
		// did — made the deletion loop below dead code: every existing buffer was its own
		// witness, a disposed channel's stale lines stayed forever, and a later channel
		// reusing the name resurrected them.
		const known = new Set<string>([GIT_CHANNEL]);
		const used = new Set<string>([GIT_CHANNEL]);
		this.picker.textContent = '';
		this.picker.appendChild(new Option(GIT_CHANNEL, GIT_CHANNEL, true, this.activeChannel() === GIT_CHANNEL));
		for (const { extId, name } of channels) {
			const label = used.has(name) ? `${name} (${extId})` : name;
			used.add(name);
			known.add(label);
			this.channels.set(label, this.channels.get(label) ?? []);
			this.picker.appendChild(new Option(label, label, false, this.activeChannel() === label));
		}
		// Channels that went away (dispose/uninstall) leave the picker; their buffers follow
		// unless still referenced by a same-named survivor.
		for (const name of [...this.channels.keys()]) {
			if (name !== GIT_CHANNEL && !known.has(name) && this.activeChannel() !== name) this.channels.delete(name);
		}
	}

	/** Switch the view to a channel (an extension's `outputChannel.show()`); the caller shows
	 *  the panel itself. */
	showChannel(channel: string): void {
		if (this.channels.has(channel) || [...this.picker.options].some((option) => option.value === channel)) {
			this.picker.value = channel;
			this.renderActive();
		}
	}

	/** Empty one channel (the Clear action works the active one; extensions clear their own). */
	clearChannel(channel: string): void {
		this.channels.set(channel, []);
		if (channel === this.activeChannel()) this.log.textContent = '';
		if (channel === GIT_CHANNEL) void invoke('git_output_clear').catch(() => undefined);
	}

	private activeChannel(): string {
		return this.picker.value || GIT_CHANNEL;
	}

	/** Render the active channel's whole buffer (a channel switch or a late history load). */
	private renderActive(): void {
		const lines = this.channels.get(this.activeChannel()) ?? [];
		this.log.textContent = lines.join('\n') + (lines.length > 0 ? '\n' : '');
		this.log.scrollTop = this.log.scrollHeight;
	}

	/** One live line onto the visible tail, keeping the stick-to-bottom behaviour. */
	private appendLive(line: string): void {
		const atBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 4;
		this.log.textContent += line + '\n';
		if (atBottom) this.log.scrollTop = this.log.scrollHeight;
	}

	text(): string {
		return (this.channels.get(GIT_CHANNEL) ?? []).join('\n');
	}

	async clear(): Promise<void> {
		this.clearChannel(this.activeChannel());
	}
}

export class Panel {
	readonly terminal: TerminalView;
	readonly output: OutputView;
	/** Source Insight's Context Window (M4 4.7): the symbol-under-the-cursor's definition. */
	readonly context: ContextView;
	private readonly element: HTMLElement;
	private readonly tabs: HTMLElement;
	private readonly actionsHost: HTMLElement;
	private readonly maximizeButton: HTMLButtonElement;
	private active: PanelViewId = 'terminal';
	private maximized = false;

	onVisibilityChange: ((visible: boolean) => void) | null = null;
	onMaximizeChange: ((maximized: boolean) => void) | null = null;

	constructor(element: HTMLElement) {
		this.element = element;
		this.terminal = new TerminalView();
		this.output = new OutputView();
		this.context = new ContextView();
		this.tabs = el('div', 'panel-tabs');
		this.tabs.setAttribute('role', 'tablist');
		for (const [id, view] of [['terminal', 'terminal'], ['output', 'output'], ['context', 'context']] as [PanelViewId, string][]) {
			const tab = el('span', 'panel-title', [t(`panel.${view}` as 'panel.terminal')]);
			tab.dataset['view'] = id;
			tab.setAttribute('role', 'tab');
			tab.addEventListener('click', () => this.show(id));
			this.tabs.appendChild(tab);
		}
		// A language switch relabels the tabs in place.
		document.addEventListener(SETTINGS_EVENT, () => this.renderTabLabels());
		this.actionsHost = el('div', 'panel-actions');
		this.maximizeButton = actionButton('chevron-up', 'Maximize Panel Size', () => this.toggleMaximized());
		const header = el('div', 'panel-header', [
			this.tabs,
			this.actionsHost,
			el('div', 'actions', [this.maximizeButton, actionButton('close', 'Hide Panel (Ctrl+J)', () => this.hide())])
		]);
		element.append(header, this.terminal.element, this.output.element, this.context.element);
		this.terminal.onEmpty = () => this.hide();
		this.render();
	}

	isVisible(): boolean {
		return !this.element.hidden;
	}

	activeView(): PanelViewId {
		return this.active;
	}

	show(view: PanelViewId = this.active): void {
		const wasHidden = this.element.hidden;
		this.element.hidden = false;
		this.active = view;
		this.render();
		if (wasHidden) this.onVisibilityChange?.(true);
		if (view === 'terminal') void this.terminal.shown();
		else if (view === 'output') {
			this.terminal.hidden();
			void this.output.shown();
		} else {
			this.terminal.hidden();
			this.context.shown();
		}
	}

	hide(): void {
		if (this.element.hidden) return;
		this.element.hidden = true;
		this.terminal.hidden();
		this.onVisibilityChange?.(false);
	}

	toggle(view: PanelViewId = this.active): void {
		if (this.isVisible() && this.active === view) this.hide();
		else this.show(view);
	}

	/** Reveal the terminal and type a command into it. */
	async runInTerminal(command: string): Promise<void> {
		this.show('terminal');
		await this.terminal.run(command);
	}

	private toggleMaximized(): void {
		this.maximized = !this.maximized;
		this.element.classList.toggle('maximized', this.maximized);
		this.maximizeButton.title = this.maximized ? 'Restore Panel Size' : 'Maximize Panel Size';
		this.maximizeButton.innerHTML = '';
		this.maximizeButton.appendChild(icon(this.maximized ? 'chevron-down' : 'chevron-up'));
		this.onMaximizeChange?.(this.maximized);
	}

	private render(): void {
		this.renderTabLabels();
		for (const tab of this.tabs.children) {
			const selected = (tab as HTMLElement).dataset['view'] === this.active;
			tab.classList.toggle('active', selected);
			// The tablist contract: the selected tab is labelled as such (M7 7.6).
			tab.setAttribute('aria-selected', selected ? 'true' : 'false');
		}
		this.terminal.element.hidden = this.active !== 'terminal';
		this.output.element.hidden = this.active !== 'output';
		this.context.element.hidden = this.active !== 'context';
		this.actionsHost.innerHTML = '';
		this.actionsHost.appendChild(this.active === 'terminal' ? this.terminal.actions : this.active === 'output' ? this.output.actions : this.context.actions);
	}

	private renderTabLabels(): void {
		const labels: Record<PanelViewId, string> = { terminal: t('panel.terminal'), output: t('panel.output'), context: t('panel.context') };
		for (const tab of this.tabs.children) {
			const view = (tab as HTMLElement).dataset['view'] as PanelViewId | undefined;
			if (view) tab.textContent = labels[view];
		}
	}
}
