// The MCP Server page (module 16): how to point an AI client at this repository's
// `ggs --mcp` bridge — the command line and the stdio configuration snippet with copy
// buttons, the tool catalogue the bridge answers `tools/list` with, and its recent
// calls read back from the JSONL log under ~/.ggs/logs/mcp.log.

import { claudeMcpStatus, type ClaudeMcpStatus, type McpLogEntry, mcpLog, type McpToolInfo, mcpTools } from '../../platform/ipc/mcp';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import { t, tf } from '../../platform/i18n';
import { actionButton, el, icon } from '../../platform/ui/index';
import type { AnalysisPageView } from '../analysis/types';

function commandSnippet(folder: string): string {
	const quoted = /\s/.test(folder) ? `"${folder}"` : folder;
	return `ggs --mcp ${quoted}`;
}

function configSnippet(folder: string): string {
	return JSON.stringify(
		{
			mcpServers: {
				ggs: {
					command: 'ggs',
					args: ['--mcp', folder]
				}
			}
		},
		null,
		2
	);
}

export class McpPage implements AnalysisPageView {
	private tools: McpToolInfo[] = [];
	private log: McpLogEntry[] = [];
	private claude: ClaudeMcpStatus | null = null;
	private error: string | null = null;
	private loading = true;
	private readonly body: HTMLElement;

	onOpen: ((path: string, line: number) => void) | null = null;

	constructor(container: HTMLElement) {
		container.classList.add('an-page');
		this.body = el('div', 'an-list');
		container.append(
			el('div', 'an-header', [
				icon('plug'),
				el('span', 'an-title', [t('mcp.tool')]),
				el('div', 'actions', [
					actionButton('refresh', t('mcp.refresh'), () => void this.load())
				])
			]),
			this.body
		);
		this.render();
		void this.load();
	}

	private async load(): Promise<void> {
		this.loading = true;
		this.error = null;
		this.render();
		try {
			const [tools, log, claude] = await Promise.all([
				mcpTools(),
				mcpLog(),
				claudeMcpStatus()
			]);
			this.tools = tools ?? [];
			this.log = log ?? [];
			this.claude = claude;
		} catch (error) {
			this.error = String(error);
		}
		this.loading = false;
		this.render();
	}

	/** A copy button with crisp temporary checkmark feedback on success. */
	private copyButton(text: string, label: string): HTMLElement {
		let resetTimer: ReturnType<typeof setTimeout> | null = null;
		const button = actionButton('copy', label, () => {
			void writeText(text).then(
				() => {
					button.title = t('mcp.copied');
					const ic = button.querySelector('.codicon');
					if (ic) ic.className = 'codicon codicon-check';
					button.classList.add('active');
					if (resetTimer !== null) clearTimeout(resetTimer);
					resetTimer = setTimeout(() => {
						resetTimer = null;
						button.title = label;
						const iconEl = button.querySelector('.codicon');
						if (iconEl) iconEl.className = 'codicon codicon-copy';
						button.classList.remove('active');
					}, 1600);
				},
				() => { /* clipboard unavailable */ }
			);
		});
		return button;
	}

	private static when(time: number): string {
		const date = new Date(time);
		return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(time);
	}

	render(): void {
		this.body.textContent = '';
		if (this.loading) {
			this.body.appendChild(el('div', 'an-empty', [`${t('analysis.page.loading')}…`]));
			return;
		}
		if (this.error) {
			this.body.appendChild(el('div', 'an-empty', [this.error]));
			return;
		}

		const targetFolder = this.claude?.folder || '/path/to/your/project';
		const cmdText = commandSnippet(targetFolder);
		const cfgText = configSnippet(targetFolder);

		this.body.appendChild(el('div', 'an-section', [t('mcp.setup')]));
		const command = el('div', 'an-codebar', [
			el('span', 'an-codebar-label', [t('mcp.setup.command')]),
			el('div', 'actions', [this.copyButton(cmdText, t('mcp.copy'))])
		]);
		command.title = t('mcp.copy');
		this.body.append(
			command,
			el('code', 'an-code', [cmdText])
		);
		const config = el('div', 'an-codebar', [
			el('span', 'an-codebar-label', [t('mcp.setup.config')]),
			el('div', 'actions', [this.copyButton(cfgText, t('mcp.copy'))])
		]);
		this.body.append(
			config,
			el('code', 'an-code', [cfgText]),
			el('div', 'an-empty an-note', [t('mcp.setup.hint')])
		);

		this.body.appendChild(el('div', 'an-section', [t('mcp.claude.title')]));
		const claude = this.claude;
		if (claude === null) {
			this.body.appendChild(el('div', 'an-empty', [t('mcp.claude.unknown')]));
		} else if (claude.registered && claude.folder) {
			const row = el('div', 'an-row');
			row.title = t('mcp.claude.registered.hint');
			row.append(
				icon('check'),
				el('span', 'label', [t('mcp.claude.registered')]),
				el('span', 'description', [claude.folder]),
				el('span', 'tail', [t('mcp.claude.serverName')])
			);
			this.body.appendChild(row);
			this.body.appendChild(el('div', 'an-empty an-note', [t('mcp.claude.registered.note')]));
		} else {
			const row = el('div', 'an-empty');
			row.append(icon('info'), el('span', '', [' ', t('mcp.claude.notRegistered')]));
			this.body.appendChild(row);
		}

		this.body.appendChild(el('div', 'an-section', [tf('mcp.tools', this.tools.length)]));
		for (const tool of this.tools) {
			const row = el('div', 'an-row');
			row.title = tool.description;
			row.append(
				icon('tools'),
				el('span', 'label', [tool.name]),
				el('span', 'description', [tool.description])
			);
			this.body.appendChild(row);
		}

		this.body.appendChild(el('div', 'an-section', [tf('mcp.log', this.log.length)]));
		if (this.log.length === 0) {
			this.body.appendChild(el('div', 'an-empty', [t('mcp.log.empty')]));
			return;
		}
		for (const entry of this.log) {
			const row = el('div', `an-row ${entry.ok ? '' : 'an-sev-error'}`);
			row.title = entry.args;
			row.append(
				icon(entry.ok ? 'check' : 'error'),
				el('span', 'label', [entry.tool]),
				el('span', 'description', [McpPage.when(entry.time)]),
				el('span', 'tail', [tf('mcp.ms', entry.ms)])
			);
			this.body.appendChild(row);
		}
	}
}
