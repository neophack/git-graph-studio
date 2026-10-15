// Command dispatch: enablement, execution (local frame, workbench-native, process backend), registerBatch bookkeeping and unregistration.

import { FrameHandle } from './sharedTypes';
import type { ExtensionHost } from './extensionHost';

import { extProcessRun } from '../../../platform/ipc/extProcess';
import { commands } from '../../../platform/commands';
import { declaredCommand, registerContextProvider } from '../contributions';
import { extLog, extLogOnce } from '../extLog';
import { t, tf } from '../../../platform/i18n';
import { notify } from '../../../platform/ui/index';


export const commandsRegistered = new Map<string, { extId: string; handle: FrameHandle }>();

/** The Claude Code extension's open-a-conversation command (the one its own session list runs). */
export const CLAUDE_OPEN_COMMAND = 'claude-vscode.editor.open';

/** One detached Claude Remote send/open (see `claudeChatStart`). */

export function unregisterCommand(id: string): void {
	// The registry has no remove(); re-registering a disabled command stands in until it grows
	// one. Palette entries filter on `enabled`, so the command disappears from the UI.
	commands.register({ id, title: id, enabled: () => false, run: () => undefined });
}

/** How long an editor's burst of keystrokes coalesces before its text reaches extensions. */

/** The dispatch concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const dispatchMethods: ThisType<ExtensionHost> = {
	canRunCommand(command: string): boolean {
		if (this.processCommandIds.has(command)) return true;
		if (declaredCommand(command)) return true;
		return commandsRegistered.has(command);
	},

	executeCommand(id: string, args: unknown[] = [], caller?: FrameHandle): Promise<unknown> {
		// VS Code's own built-in commands — the surfaces an extension reaches from inside a
		// frame the way it reaches any command, answered here before any registry lookup.
		if (id === 'vscode.diff' || id === 'vscode.open') {
			// Both resolve a provider-scheme side by asking the registering extension back
			// (`docProvider.provide`). A remote caller is parked waiting for THIS answer, and
			// the provide call would wait for that parked thread — a deadlock until the
			// 30 s bridge timeout, with the whole backend frozen behind it. The open runs
			// detached: the immediate response unblocks the very thread the provide call
			// needs. A frame caller has no such re-entry; its await keeps the old contract
			// (errors reach the extension, the result lands before the promise settles).
			const open = id === 'vscode.diff'
				? this.openVscodeDiff(args[0], args[1], args[2], args[3])
				: this.openVscodeDocument(args[0], args[1]);
			const done = open.then(() => undefined);
			if (caller?.remote === true) {
				void done.catch((error) => notify('error', `${t('extensions.openFailed')}: ${String(error)}`));
				return Promise.resolve(undefined);
			}
			return done;
		}
		if (id === 'setContext') {
			const [key, value] = args as [string, unknown];
			// The value is kept as given: a mode string compares in `==`, an array serves `in`.
			if (typeof key === 'string') {
				registerContextProvider(key, () => value);
				this.onContextChanged?.();
			}
			return Promise.resolve(undefined);
		}
		// The session tabs, by the session each webview panel reports hosting: which sessions
		// have a tab open, and closing the tab of one. Claude Remote reloads a conversation's
		// tab after a turn ran outside it — an open chat panel never re-reads its session
		// file, and its next turn would branch off the history it still holds. VS Code
		// answers the same through `window.tabGroups`, which this host cannot see.
		if (id === 'ggs.sessionTabs.list') return Promise.resolve([...new Set(this.webviewSessions.values())]);
		if (id === 'ggs.sessionTabs.close') return Promise.resolve(this.closeSessionTabs(String(args[0] ?? '')));
		// Claude Remote's prompts, typed into the Claude Code tab itself (claudeChatInject.ts).
		// Each answers at once: a process-backed caller's thread is parked inside this request,
		// and opening a tab and waiting for its page takes seconds — the work runs detached
		// under a ticket the caller polls (`ggs.claudeChat.state`).
		if (id === 'ggs.claudeChat.send') return Promise.resolve().then(() => this.claudeChatStart(args[0], true));
		if (id === 'ggs.claudeChat.open') return Promise.resolve().then(() => this.claudeChatStart(args[0], false));
		if (id === 'ggs.claudeChat.state') return Promise.resolve(this.claudeChatState(args[0]));
		if (id === 'ggs.claudeChat.stop') return Promise.resolve(this.claudeChatStop(args[0]));
		if (id === 'ggs.claudeChat.answer') return Promise.resolve().then(() => this.claudeChatAnswer(args[0]));
		// The remote-control bridge and the conversation tap (Claude Remote 2.0): the same
		// answer-at-once rule — a process caller's thread parks inside this request.
		if (id === 'ggs.claudeChat.remoteControl') return Promise.resolve().then(() => this.claudeChatRemoteControl(args[0]));
		if (id === 'ggs.claudeChat.remoteState') return Promise.resolve(this.claudeChatRemoteState(args[0]));
		if (id === 'ggs.claudeChat.permission') return Promise.resolve().then(() => this.claudeChatPermission(args[0]));
		if (id === 'ggs.claudeChat.respond') return Promise.resolve().then(() => this.claudeChatRespond(args[0]));
		if (id === 'ggs.claudeChat.mode') return Promise.resolve().then(() => this.claudeChatMode(args[0]));
		if (id === 'ggs.claudeTap.subscribe') return this.claudeTapSubscribe(caller);
		if (id === 'ggs.claudeTap.unsubscribe') return Promise.resolve(this.claudeTapUnsubscribe(caller));
		if (id === 'workbench.view.scm' || id === 'workbench.view.explorer' || id === 'workbench.view.search' || id === 'workbench.view.extensions') {
			this.onShowView?.(id.slice('workbench.view.'.length));
			return Promise.resolve(undefined);
		}
		if (id === 'workbench.action.openSettings' || id === 'workbench.action.openSettingsJson' || id === 'workbench.action.openGlobalSettings') {
			return commands.execute('workbench.openSettings');
		}
		const entry = commandsRegistered.get(id);
		if (entry) return this.callFrame(entry.handle, 'runCommand', [id, args]).catch((error) => {
			extLog('error', entry.extId, `command ${id} failed: ${String(error)}`, error instanceof Error ? error : undefined);
			throw error;
		});
		const extId = this.declaringExtension(id);
		if (!extId) {
			if (!commands.all().some((command) => command.id === id)) {
				extLogOnce(`unknown-command:${id}`, 'warn', caller ? this.extIdForHandle(caller) : 'host', `executeCommand(${id}): no such command in this workbench`);
			}
			return commands.execute(id);
		}
		// A backend-only package (no `main`, no frame) dispatches its declared commands
		// straight to the backend; it keeps the caller's arguments (VS Code passes the
		// menu's own — a right-clicked file, a repository) into its backend dispatch.
		// With a real-Node runtime there are no frame-less packages — the host process
		// activates and registers like a frame — so the normal wake path serves.
		if (this.nodeHostExe === null && this.processOnly.has(extId)) return this.runProcessCommand(extId, id, args);
		// A package WITH a `main` is a frame program even when it also declares a backend
		// (VS Code semantics): the declared command's first run wakes the frame, and the
		// handler its activation registers answers. Only when activation registered
		// nothing does the backend dispatch take it (the launcher/openPage convention) —
		// routing there first was failing every lazily-activated command of a
		// backend-and-main package with "no handler registered".
		return this.ensureActive(extId).then(() => {
			const late = commandsRegistered.get(id);
			if (late) return this.callFrame(late.handle, 'runCommand', [id, args]);
			if (this.processBacked.has(extId)) return this.runProcessCommand(extId, id, args);
			return commands.execute(id);
		});
	},

	async runRegistered(id: string, args: unknown[] = []): Promise<void> {
		try {
			await this.runRegisteredUnguarded(id, args);
		} catch (error) {
			// A palette / menu / keybinding run has no caller to hand the error to: the log
			// records it with the stack, the user sees which command failed.
			const owner = commandsRegistered.get(id)?.extId ?? this.declaringExtension(id) ?? 'host';
			// A run cut short by its extension's own deactivation (an uninstall, a reload)
			// is expected: logged, not surfaced.
			const deactivated = /was deactivated|was closed/.test(String(error));
			extLog(deactivated ? 'info' : 'error', owner, `command ${id} failed: ${String(error)}`, error instanceof Error ? error : String(error));
			if (!deactivated) notify('error', tf('extensions.commandFailed', id, String(error)), [{ label: t('extensions.showLog'), run: () => this.showLog() }]);
			throw error;
		}
	},

	async runRegisteredUnguarded(id: string, args: unknown[] = []): Promise<void> {
		const entry = commandsRegistered.get(id);
		if (entry) {
			await this.callFrame(entry.handle, 'runCommand', [id, args]);
			return;
		}
		const extId = this.declaringExtension(id);
		if (!extId) return;
		if (this.nodeHostExe === null && this.processOnly.has(extId)) {
			await this.runProcessCommand(extId, id, args);
			return;
		}
		// A frame program first, backend dispatch as the fallthrough — the same order
		// executeCommand runs in, so a declared command answers identically from either
		// caller (the workbench's menus or the palette).
		await this.ensureActive(extId);
		const late = commandsRegistered.get(id);
		if (late) await this.callFrame(late.handle, 'runCommand', [id, args]);
		else if (this.processBacked.has(extId)) await this.runProcessCommand(extId, id, args);
	},

	declaringExtension(command: string): string | null {
		for (const [extId, ids] of this.declaredCommandIds) {
			if (ids.includes(command)) return extId;
		}
		return null;
	},

	async runProcessCommand(extId: string, command: string, args: unknown[] = []): Promise<void> {
		try {
			const result = await extProcessRun(extId, command, args);
			if (result && typeof result === 'object') {
				const { notify: toast } = result as {
					notify?: { kind: 'info' | 'warning' | 'error'; message: string };
				};
				if (toast && typeof toast.message === 'string') notify(toast.kind ?? 'info', toast.message);
			}
		} catch (error) {
			notify('error', `${t('extensions.processFailed')}: ${String(error)}`);
		}
	},
};
