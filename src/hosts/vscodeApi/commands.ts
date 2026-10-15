// The `commands` namespace: registration (batched across the bridge), local
// execution of the extension's own commands, and text-editor commands.

import { Disposable } from './types/events';
import { shimLog } from './shimLog';
import type { SerializableTextEdit } from './bridge';
import type { ShimState } from './state';

export function buildCommands(s: ShimState) {
	return {
			registerCommand: (id: string, handler: (...args: unknown[]) => unknown, thisArg?: unknown) => {
				const full = id.includes('.') ? id : `${s.ctx.extensionId}.${id}`;
				const wrapped = s.wrapHandler(full, handler, thisArg);
				s.ownCommands.set(full, wrapped);
				s.bridge.registerCommandHandler(full, wrapped);
				s.pendingCommandRegistrations.push(full);
				return new Disposable(() => {
					if (s.ownCommands.get(full) === wrapped) s.ownCommands.delete(full);
					// Not flushed yet: leave the queue (a registration the workbench never saw
					// needs no unregistering); flushed: tell the workbench it went away.
					const queued = s.pendingCommandRegistrations.indexOf(full);
					if (queued !== -1) s.pendingCommandRegistrations.splice(queued, 1);
					else s.send('commands.unregister', [full]);
				});
			},
			registerTextEditorCommand: (id: string, handler: (editor: unknown, edit: unknown, ...args: unknown[]) => unknown, thisArg?: unknown) => {
				const full = id.includes('.') ? id : `${s.ctx.extensionId}.${id}`;
				s.bridge.registerCommandHandler(full, s.wrapHandler(full, async (...args: unknown[]) => {
					if (!s.activeEditor) {
						shimLog('info', `text editor command ${full} ran with no active text editor`);
						return undefined;
					}
					const editor = s.makeTextEditorProxy();
					const edits: SerializableTextEdit[] = [];
					const result = await handler.call(thisArg, editor, s.editBuilder(edits), ...args);
					if (edits.length > 0) await s.bridge.request('editor.applyEdits', [null, edits]);
					return result;
				}));
				s.pendingCommandRegistrations.push(full);
				return new Disposable(() => {
					const queued = s.pendingCommandRegistrations.indexOf(full);
					if (queued !== -1) s.pendingCommandRegistrations.splice(queued, 1);
					else s.send('commands.unregister', [full]);
				});
			},
			// A command this extension registered runs right here, as in VS Code's own host:
			// through the workbench it would re-enter this host — which, under ggs-node, is
			// blocked waiting on that very request (Claude Code's "New session" executes its
			// own `claude-vscode.editor.open` and stalled for the 30-second timeout). Local
			// dispatch also keeps `undefined` arguments, which the wire turns into null.
			executeCommand: (id: string, ...args: unknown[]) => {
				const own = s.ownCommands.get(id);
				if (own) return Promise.resolve().then(() => own(...args));
				// A foreign command can only exist for the workbench once this activation's
				// queued registrations arrived — keep the ordering.
				s.flushCommandRegistrations();
				return s.bridge.request('commands.execute', [id, args]) as Promise<unknown>;
			},
			getCommands: async (_filterInternal?: boolean) => (await s.bridge.request('commands.list', [])) as string[]
	};
}
