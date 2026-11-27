// The desktop half of the MCP <-> Workbench UI bridge (module 16): a `ggs --mcp` AI
// session queues navigation commands into `~/.ggs/mcp-bridge/ui-commands.jsonl` (the
// `ui_open_location` / `ui_show_relation_graph` / `ui_open_diff` tools) and reads the
// running workbench's active-editor context from `ui-state.json` (the
// `ggs://ui/active-editor` resource). This side drains the queue on a timer — one JSONL
// line per queued command, and whoever drains it executes it, so a window that is not
// running simply leaves the commands queued until one is — and publishes the active
// editor's file, cursor and selection whenever they move. The drain skips a hidden
// window: queued commands run the moment the window shows again.

import type { EditorView } from '@codemirror/view';

import { basename, joinPath } from '../platform/ui/index';
import { mcpDrainUiCommands, mcpPublishUiState } from '../platform/ipc/mcp';
import { symbolLookup } from '../platform/ipc/symbols';
import { joinRepo } from './workbench';
import type { ActiveEditorInfo } from '../features/editor/editorArea';
import type { UiBridgeCommand } from '../platform/ipc/mcp';
import type { Workbench } from './workbench';

/** How often the command queue is polled. */
const DRAIN_INTERVAL_MS = 1500;
/** How often a cursor/selection move may publish the state file. */
const PUBLISH_THROTTLE_MS = 400;
/** A selection past this many characters rides as nothing, never its text. */
const SELECTION_TEXT_CAP = 4000;

export function startMcpBridge(workbench: Workbench): void {
	const toAbsolute = (root: string, path: string): string =>
		path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) ? path : joinRepo(root, path);

	const execute = async (cmd: UiBridgeCommand): Promise<void> => {
		switch (cmd.action) {
			case 'openLocation': {
				await workbench.editors.openFile(toAbsolute(cmd.root, cmd.path), { line: cmd.line, column: cmd.column || 1 });
				break;
			}
			case 'showRelationGraph': {
				workbench.showView('symbolWindow');
				let subject: { kind: string; name: string; path: string; line: number } | null = null;
				try {
					const defs = await symbolLookup(cmd.symbol);
					const def = defs[0];
					if (def) subject = { kind: def.kind, name: def.name, path: def.path, line: def.line };
				} catch {
					// No index answer: the graph still roots on the bare name.
				}
				workbench.symbolWindow.applyRelationKind(cmd.direction);
				workbench.symbolWindow.openGraphRoot(subject ?? { kind: '', name: cmd.symbol, path: '', line: 0 });
				break;
			}
			case 'openDiff': {
				const left = toAbsolute(cmd.root, cmd.leftPath);
				if (cmd.rightPath) {
					const right = toAbsolute(cmd.root, cmd.rightPath);
					await workbench.editors.openDiff({
						kind: 'diff',
						id: `mcp-paths:${left}::${right}`,
						title: `${basename(left)} ↔ ${basename(right)}`,
						left: { revision: '*', path: left, label: left, exists: true, local: true },
						right: { revision: '*', path: right, label: right, exists: true, local: true }
					});
				} else {
					const rel = workbench.repoPath ? joinPath(workbench.repoPath, cmd.leftPath) : left;
					await workbench.editors.openDiff({
						kind: 'diff',
						id: `mcp-wt:${rel}`,
						title: `${basename(rel)} (Working Tree)`,
						left: { revision: 'HEAD', path: rel, label: 'HEAD', exists: true },
						right: { revision: '*', path: rel, label: 'Working Tree', exists: true }
					});
				}
				break;
			}
		}
	};

	let draining = false;
	const drain = async (): Promise<void> => {
		if (draining || document.hidden) return;
		draining = true;
		try {
			const commands = await mcpDrainUiCommands();
			for (const cmd of commands) {
				try {
					await execute(cmd);
				} catch {
					// One unexecutable command (a path gone, no repo open) never holds the
					// queue's rest hostage.
				}
			}
		} catch {
			// No backend answer (the bridge commands absent): stay quiet and retry later.
		} finally {
			draining = false;
		}
	};
	void drain();
	const timer = window.setInterval(() => void drain(), DRAIN_INTERVAL_MS);
	workbench.trackUnlisten(() => window.clearInterval(timer));

	// The active-editor state rides the same feed the status bar uses — every cursor
	// move and focus change — throttled, so a burst of keystrokes writes the file once.
	let publishTimer: number | null = null;
	let lastPublish = 0;
	const publish = (editor: ActiveEditorInfo | null): void => {
		if (!editor || editor.kind !== 'file' || !editor.path) return;
		const info = editor;
		const path = editor.path;
		const now = Date.now();
		if (now - lastPublish < PUBLISH_THROTTLE_MS) {
			if (publishTimer === null) {
				publishTimer = window.setTimeout(() => {
					publishTimer = null;
					publish(info);
				}, PUBLISH_THROTTLE_MS);
			}
			return;
		}
		if (publishTimer !== null) {
			window.clearTimeout(publishTimer);
			publishTimer = null;
		}
		lastPublish = now;
		// The selected text rides along when there is one and it is small; the view cast
		// guards the non-CodeMirror inputs (viewers, diffs) that share the same feed.
		const view = workbench.editors.activeView as EditorView | null;
		const range = view?.state?.selection?.main;
		const selection =
			view && range && range.to > range.from && range.to - range.from <= SELECTION_TEXT_CAP
				? view.state.sliceDoc(range.from, range.to)
				: null;
		void mcpPublishUiState({
			workspace: workbench.repoPath ?? '',
			path,
			line: info.line,
			column: info.column,
			symbol: null,
			selection,
			updatedAtMs: now
		}).catch(() => {
			// The bridge file is best-effort: a failed write never bothers the editor.
		});
	};
	const previousActiveChange = workbench.editors.onActiveChange;
	workbench.editors.onActiveChange = (editor) => {
		previousActiveChange?.(editor);
		publish(editor);
	};
}
