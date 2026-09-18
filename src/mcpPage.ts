// The MCP Server page (module 16): how to point an AI client at this repository's
// `ggs --mcp` bridge — the command line and the stdio configuration snippet with copy
// buttons, the tool catalogue the bridge answers `tools/list` with, and its recent
// calls read back from the JSONL log under ~/.ggs/logs/mcp.log. Module 17's Analysis
// sidebar lists it beside the five analysis tools and opens it as one of the editor
// pages, so it loads lazily with them.

import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import { t, tf } from './i18n';
import { actionButton, el, icon } from './ui';
import type { AnalysisPageView } from './analysisPages';

interface McpToolInfo { name: string; description: string }
interface McpLogEntry { time: number; tool: string; ok: boolean; ms: number; args: string }

/** The stdio snippet every MCP client understands (ZCode: the `mcp.servers` field of
 *  ~/.zcode/cli/config.json; Claude Desktop / Cursor: the same shape under
 *  `mcpServers`). */
const CONFIG_SNIPPET = [
	'{',
	'  "mcpServers": {',
	'    "ggs": {',
	'      "command": "ggs",',
	'      "args": ["--mcp", "D:\\\\your\\\\project"]',
	'    }',
	'  }',
	'}'
].join('\n');

const COMMAND_SNIPPET = 'ggs --mcp D:\\your\\project';

export class McpPage implements AnalysisPageView {
	private tools: McpToolInfo[] = [];
	private log: McpLogEntry[] = [];
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
			const [tools, log] = await Promise.all([
				invoke<McpToolInfo[]>('mcp_tools'),
				invoke<McpLogEntry[]>('mcp_log')
			]);
			// A defaulting test layer (or a degraded backend) answers null — an empty
			// catalogue and log, not a render crash.
			this.tools = tools ?? [];
			this.log = log ?? [];
		} catch (error) {
			this.error = String(error);
		}
		this.loading = false;
		this.render();
	}

	/** A copy button that confirms in place; the clipboard plugin's absence (a stripped
	 *  build) leaves the row as it was instead of throwing. */
	private copyButton(text: string, label: string): HTMLElement {
		const button = actionButton('copy', label, () => {
			void writeText(text).then(
				() => { button.title = t('mcp.copied'); },
				() => { /* the clipboard is unavailable — the click still happened */ }
			);
		});
		return button;
	}

	/** The bridge logs epoch milliseconds; the page shows the user's locale. */
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

		this.body.appendChild(el('div', 'an-section', [t('mcp.setup')]));
		const command = el('div', 'an-codebar', [
			el('span', 'an-codebar-label', [t('mcp.setup.command')]),
			el('div', 'actions', [this.copyButton(COMMAND_SNIPPET, t('mcp.copy'))])
		]);
		command.title = t('mcp.copy');
		this.body.append(
			command,
			el('code', 'an-code', [COMMAND_SNIPPET])
		);
		const config = el('div', 'an-codebar', [
			el('span', 'an-codebar-label', [t('mcp.setup.config')]),
			el('div', 'actions', [this.copyButton(CONFIG_SNIPPET, t('mcp.copy'))])
		]);
		this.body.append(
			config,
			el('code', 'an-code', [CONFIG_SNIPPET]),
			el('div', 'an-empty an-note', [t('mcp.setup.hint')])
		);

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
