// The MCP UI bridge's workbench half (`src/workbench/mcpBridge.ts`): the queued
// `ui_*` commands drain once each and execute against the workbench's own open
// surfaces, and the active editor's context publishes into the state file the
// `ggs://ui/active-editor` resource serves.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { startMcpBridge } from '../src/workbench/mcpBridge';
import { backend } from './tauriMock';
import { flush } from './helpers';

type ScriptedHandler = (args: Record<string, unknown>) => unknown;

type WorkbenchStub = Parameters<typeof startMcpBridge>[0];

function stubWorkbench(): { workbench: WorkbenchStub; calls: Record<string, unknown[]> } {
	const calls: Record<string, unknown[]> = { openFile: [], openDiff: [], showView: [], graphRoot: [], relationKind: [] };
	const workbench = {
		repoPath: 'C:\\repo',
		editors: {
			openFile: (...args: unknown[]) => {
				calls.openFile.push(args);
				return Promise.resolve();
			},
			openDiff: (input: unknown) => {
				calls.openDiff.push(input);
				return Promise.resolve();
			},
			activeInput: null as unknown,
			activeView: null as unknown,
			onActiveChange: null as ((editor: unknown) => void) | null
		},
		symbolWindow: {
			applyRelationKind: (kind: string) => {
				calls.relationKind.push(kind);
			},
			openGraphRoot: (sym: unknown) => {
				calls.graphRoot.push(sym);
			}
		},
		showView: (id: string) => {
			calls.showView.push(id);
		},
		trackUnlisten: () => undefined
	} as unknown as WorkbenchStub;
	return { workbench, calls };
}

function setHidden(hidden: boolean): void {
	Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

describe('the MCP UI bridge (the workbench half)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setHidden(false);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('drains the queue once per command: openLocation joins the root and reveals the line', async () => {
		const queue: unknown[] = [
			{ action: 'openLocation', root: 'C:\\repo', path: 'src/a.c', line: 5, column: 3, ts: 1 }
		];
		backend.handlers.set('mcp_drain_ui_commands', (() => Promise.resolve(queue.splice(0))) as ScriptedHandler);
		backend.handlers.set('symbol_lookup', (() => []) as ScriptedHandler);
		const { workbench, calls } = stubWorkbench();
		startMcpBridge(workbench);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.openFile).toEqual([['C:\\repo\\src\\a.c', { line: 5, column: 3 }]]);
		// The next tick drains the (now empty) queue and executes nothing more.
		await vi.advanceTimersByTimeAsync(1500);
		expect(calls.openFile).toHaveLength(1);
	});

	it('showRelationGraph roots the graph on the looked-up symbol with the asked direction', async () => {
		const queue: unknown[] = [
			{ action: 'showRelationGraph', root: 'C:\\repo', symbol: 'alpha', direction: 'callers', ts: 2 }
		];
		backend.handlers.set('mcp_drain_ui_commands', (() => Promise.resolve(queue.splice(0))) as ScriptedHandler);
		backend.handlers.set('symbol_lookup', (() => [{ kind: 'function', name: 'alpha', path: 'src/a.c', line: 3 }]) as ScriptedHandler);
		const { workbench, calls } = stubWorkbench();
		startMcpBridge(workbench);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.showView).toEqual(['symbolWindow']);
		expect(calls.relationKind).toEqual(['callers']);
		expect(calls.graphRoot).toEqual([{ kind: 'function', name: 'alpha', path: 'src/a.c', line: 3 }]);
	});

	it('openDiff opens a two-file local compare, or the HEAD vs working tree git diff', async () => {
		const queue: unknown[] = [
			{ action: 'openDiff', root: 'C:\\repo', leftPath: 'src/a.c', rightPath: 'src/b.c', ts: 3 },
			{ action: 'openDiff', root: 'C:\\repo', leftPath: 'src/a.c', rightPath: null, ts: 4 }
		];
		backend.handlers.set('mcp_drain_ui_commands', (() => Promise.resolve(queue.splice(0))) as ScriptedHandler);
		const { workbench, calls } = stubWorkbench();
		startMcpBridge(workbench);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.openDiff).toHaveLength(2);
		const [two, git] = calls.openDiff as [{ left: { revision: string; local?: boolean; path: string }; right: { revision: string; local?: boolean } }, { left: { revision: string }; right: { revision: string }; title: string }];
		expect(two.left.local).toBe(true);
		expect(two.right.path).toBe('C:\\repo\\src\\b.c');
		expect(git.left.revision).toBe('HEAD');
		expect(git.right.revision).toBe('*');
		expect(git.title).toContain('a.c');
	});

	it('a hidden window skips its drain ticks; the queued commands wait for it to show', async () => {
		let drainCalls = 0;
		backend.handlers.set('mcp_drain_ui_commands', (() => {
			drainCalls++;
			return Promise.resolve([] as unknown[]);
		}) as ScriptedHandler);
		setHidden(true);
		const { workbench } = stubWorkbench();
		startMcpBridge(workbench);
		await vi.advanceTimersByTimeAsync(3000);
		expect(drainCalls).toBe(0);
		setHidden(false);
		await vi.advanceTimersByTimeAsync(1500);
		expect(drainCalls).toBeGreaterThan(0);
	});

	it('publishes the active editor state, selection included, through the status-bar feed', async () => {
		backend.handlers.set('mcp_drain_ui_commands', (() => Promise.resolve([])) as ScriptedHandler);
		const { workbench } = stubWorkbench();
		startMcpBridge(workbench);
		await vi.advanceTimersByTimeAsync(0);
		const publish = backend.callsTo('mcp_publish_ui_state');
		expect(publish).toHaveLength(0);
		const wb = workbench as unknown as { editors: { activeInput: unknown; activeView: unknown; onActiveChange: ((editor: unknown) => void) | null } };
		wb.editors.activeInput = { kind: 'file', path: 'C:\\repo\\src\\a.c' };
		wb.editors.activeView = {
			state: {
				selection: { main: { from: 0, to: 3 } },
				sliceDoc: (from: number, to: number) => 'abc'.slice(from, to)
			}
		};
		wb.editors.onActiveChange?.({ kind: 'file', path: 'C:\\repo\\src\\a.c', line: 7, column: 9 });
		await vi.advanceTimersByTimeAsync(0);
		expect(backend.callsTo('mcp_publish_ui_state')).toHaveLength(1);
		const state = backend.callsTo('mcp_publish_ui_state')[0] as { state: { path: string; line: number; column: number; selection: string; workspace: string } };
		expect(state.state).toMatchObject({ path: 'C:\\repo\\src\\a.c', line: 7, column: 9, selection: 'abc', workspace: 'C:\\repo' });
		// A non-file input publishes nothing.
		wb.editors.onActiveChange?.({ kind: 'help', line: 1, column: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(backend.callsTo('mcp_publish_ui_state')).toHaveLength(1);
	});
});
