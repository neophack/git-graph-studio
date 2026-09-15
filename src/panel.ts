// The bottom panel: VS Code's panel header with its view tabs (TERMINAL, OUTPUT), the active
// view's actions, and the maximize / close controls. The Output view is the "Git" channel -
// every git command the app ran, as VS Code's Git extension logs them.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { ContextView } from './contextView';
import { TerminalView } from './terminal';
import { t } from './i18n';
import { SETTINGS_EVENT } from './settings';
import { actionButton, el, icon } from './ui';

export type PanelViewId = 'terminal' | 'output' | 'context';

export class OutputView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;
	private readonly log: HTMLElement;
	private loaded = false;

	constructor() {
		this.log = el('pre', 'output-log');
		this.log.setAttribute('aria-live', 'polite');
		this.element = el('div', 'panel-body', [this.log]);
		this.actions = el('div', 'actions', [
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
			this.log.textContent = lines.join('\n') + (lines.length > 0 ? '\n' : '');
			this.log.scrollTop = this.log.scrollHeight;
		} catch {
			// No backend (tests): the live events alone fill the view.
		}
	}

	append(line: string): void {
		const atBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 4;
		this.log.textContent += line + '\n';
		if (atBottom) this.log.scrollTop = this.log.scrollHeight;
	}

	text(): string {
		return this.log.textContent ?? '';
	}

	async clear(): Promise<void> {
		this.log.textContent = '';
		await invoke('git_output_clear').catch(() => undefined);
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
		for (const tab of this.tabs.children) tab.classList.toggle('active', (tab as HTMLElement).dataset['view'] === this.active);
		this.terminal.element.hidden = this.active !== 'terminal';
		this.output.element.hidden = this.active !== 'output';
		this.actionsHost.innerHTML = '';
		this.actionsHost.appendChild(this.active === 'terminal' ? this.terminal.actions : this.output.actions);
	}

	private renderTabLabels(): void {
		const labels: Record<PanelViewId, string> = { terminal: t('panel.terminal'), output: t('panel.output'), context: t('panel.context') };
		for (const tab of this.tabs.children) {
			const view = (tab as HTMLElement).dataset['view'] as PanelViewId | undefined;
			if (view) tab.textContent = labels[view];
		}
	}
}
