// The Analysis sidebar (module 17): the activity bar's fifth view — the five analysis
// tools as rows that open their result pages in the editor area, plus the analysis
// index's state and its rebuild action. Kept light on purpose: it is part of the
// first-paint bundle, so the pages themselves live in the lazy analysisPages chunk.

import { invoke, Channel } from '@tauri-apps/api/core';

import { onLocaleChange, t, tf } from './platform/i18n';
import { ANALYSIS_TOOLS, type AnalysisToolId } from './analysisTools';
import { actionButton, el, icon } from './platform/ui';

/** The `analysis_status` answer (cmd_analysis). */
export interface AnalysisStatus {
	state: 'empty' | 'building' | 'ready';
	done: number;
	total: number;
	files: number;
	symbols: number;
	calls: number;
}

export class AnalysisView {
	private readonly titleLabel: HTMLElement;
	private readonly toolsLabel: HTMLElement;
	private readonly indexLabel: HTMLElement;
	private readonly rebuildButton: HTMLButtonElement;
	private readonly toolsBody: HTMLElement;
	private readonly statusLine: HTMLElement;
	private status: AnalysisStatus | null = null;

	/** A tool row was clicked: the workbench opens the page in the editor area. */
	onOpenTool: ((tool: AnalysisToolId) => void) | null = null;

	constructor(container: HTMLElement) {
		// Every label is kept by reference: a display-language switch relabels the whole
		// view at once instead of waiting for the next remount.
		this.titleLabel = el('span', 'label', [t('analysis.title')]);
		this.toolsLabel = el('span', 'label', [t('analysis.tools')]);
		this.indexLabel = el('span', 'label', [t('analysis.index')]);
		this.rebuildButton = actionButton('refresh', t('analysis.rebuild'), () => void this.rebuild());
		container.append(
			el('div', 'sidebar-title', [this.titleLabel]),
			el('div', 'view-pane', [
				el('div', 'pane-header', [this.toolsLabel]),
				this.toolsBody = el('div', 'pane-body list')
			]),
			el('div', 'view-pane', [
				el('div', 'pane-header', [this.indexLabel, el('div', 'actions', [this.rebuildButton])]),
				el('div', 'pane-body', [this.statusLine = el('div', 'an-status')])
			])
		);
		this.renderTools();
		onLocaleChange(() => this.relabel());
	}

	/** The display language switched: relabel everything built once. */
	private relabel(): void {
		this.titleLabel.textContent = t('analysis.title');
		this.toolsLabel.textContent = t('analysis.tools');
		this.indexLabel.textContent = t('analysis.index');
		this.rebuildButton.title = t('analysis.rebuild');
		this.rebuildButton.setAttribute('aria-label', t('analysis.rebuild'));
		this.renderTools();
		this.renderStatus();
	}

	private renderTools(): void {
		this.toolsBody.replaceChildren();
		for (const tool of ANALYSIS_TOOLS) {
			const row = el('div', 'row an-tool');
			row.tabIndex = 0;
			row.setAttribute('role', 'button');
			// The full text on hover: the two-line row may still clip in a narrow sidebar.
			row.title = `${t(tool.titleKey)} — ${t(tool.descriptionKey)}`;
			row.append(
				icon(tool.icon),
				el('div', 'text', [
					el('span', 'label', [t(tool.titleKey)]),
					el('span', 'description', [t(tool.descriptionKey)])
				])
			);
			const open = () => this.onOpenTool?.(tool.id);
			row.addEventListener('click', open);
			row.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') open();
			});
			this.toolsBody.appendChild(row);
		}
	}

	/** Refresh the index state (the view's reveal and every studio://analysis-index). */
	async refresh(): Promise<void> {
		try {
			this.status = await invoke<AnalysisStatus>('analysis_status');
		} catch {
			this.status = null;
		}
		this.renderStatus();
	}

	/** The studio://analysis-index payload lands here between refreshes. */
	noteStatus(status: AnalysisStatus): void {
		this.status = status;
		this.renderStatus();
	}

	private renderStatus(): void {
		const status = this.status;
		if (!status) {
			this.statusLine.textContent = t('analysis.index.state.empty');
			return;
		}
		if (status.state === 'building') {
			this.statusLine.textContent = `${t('analysis.index.state.building')} ${status.done}/${status.total}`;
			return;
		}
		if (status.state === 'ready') {
			this.statusLine.textContent = tf('analysis.index.summary', status.files, status.symbols, status.calls);
			return;
		}
		this.statusLine.textContent = t('analysis.index.state.empty');
	}

	private async rebuild(): Promise<void> {
		const onEvent = new Channel<{ kind: string; done?: number; total?: number; state?: string }>();
		onEvent.onmessage = () => void this.refresh();
		try {
			await invoke('analysis_rebuild', { onEvent });
		} catch {
			// A cancelled rebuild: the state line stands as it is.
		}
		await this.refresh();
	}
}
