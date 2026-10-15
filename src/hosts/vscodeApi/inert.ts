// The degradation vocabulary: inert() registrations, unsupported() notices, the
// Test API's local shapes, and the whole namespaces this host accepts but cannot
// serve (lm, chat, tasks, tests, debug, scm, notebooks, authentication, l10n,
// comments) — each accepted, logged once, and never throwing.

import { CancellationTokenNone, Disposable, Event, silentEvent } from './types/events';
import { LanguageModelError } from './types/values';
import { Location, Range } from './types/position';
import { Uri } from './types/uri';
import { shimLog, shimLogOnce } from './shimLog';

/** An unsupported surface was used (not just registered): one warning per name. */
export function unsupported(name: string, what = 'is not supported by this host'): void {
	shimLogOnce(`unsupported:${name}`, 'warn', `unsupported API ${name}: ${what}`);
}

/* ---------- The API ---------- */

/** A registration this host accepts but cannot serve: noted once on the console, inert from
 *  there — VS Code ignores what it does not know, and an activation that reaches for a
 *  surface this host lacks must survive to run everything else it registered. */
export function inert(name: string): Disposable {
	shimLogOnce(`inert:${name}`, 'warn', `unsupported API ${name}: the registration is accepted but this host does not serve it`);
	return new Disposable(() => undefined);
}

/** The Test API's item and collection shapes: a package's tree stores real items (VS Code's
 *  TestItem is a plain mutable value), the collection iterates like Node's maps. */
export class TestTag {
	constructor(public id: string) {}
}
export class TestMessage {
	output?: string;
	expectedOutput?: string;
	actualOutput?: string;
	location?: Location;
	static output(value: string): TestMessage {
		const message = new TestMessage(value);
		message.output = value;
		return message;
	}
	constructor(public message?: string | unknown) {}
}
export class TestRunRequest {
	constructor(public include?: unknown[] | undefined, public exclude?: unknown[] | undefined, public profile?: unknown, public continuous?: boolean) {}
}
function makeTestItem(id: string, label: string, uri?: Uri, parent?: unknown): Record<string, unknown> {
	const children = new Map<string, unknown>();
	const item: Record<string, unknown> = {
		id,
		label,
		uri,
		parent,
		tags: [] as unknown[],
		sortText: undefined,
		description: undefined,
		detail: undefined,
		error: undefined,
		busy: false,
		range: undefined,
		canResolveChildren: false,
		invalidateResults: () => undefined
	};
	item.children = makeTestItemCollection(children);
	return item;
}
function makeTestItemCollection(items: Map<string, unknown>): Record<string, unknown> {
	const collection: Record<string, unknown> = {
		add: (item: { id: string }) => {
			items.set(item.id, item);
			return item;
		},
		delete: (id: string) => {
			items.delete(id);
		},
		get: (id: string) => items.get(id),
		replace: (descriptions: unknown[]) => {
			items.clear();
			for (const description of descriptions) {
				const item = description as { id: string };
				items.set(item.id, item);
			}
		},
		forEach: (callback: (item: unknown, collection: unknown) => void) => {
			for (const item of [...items.values()]) callback(item, collection);
		},
		get size() {
			return items.size;
		},
		toJSON: () => [...items.values()]
	};
	(collection as unknown as { [Symbol.iterator]: () => IterableIterator<unknown> })[Symbol.iterator] = function* () {
		yield* items.values();
	};
	return collection;
}


		/** The Language Model + Chat namespaces (VS Code 1.90+): registrations survive; no
		 *  chat surface exists to call them from, so `selectChatModels` answers empty. */
export function buildLm(): Record<string, unknown> {
	return {
			registerTool: (name: string, _tool: unknown) => inert(`lm.registerTool(${name})`),
			registerChatModelProvider: (id: string, _provider: unknown) => inert(`lm.registerChatModelProvider(${id})`),
			invokeTool: async (name: string) => {
				unsupported(`lm.invokeTool(${name})`, 'there is no language model surface');
				throw new LanguageModelError(`tool ${name} is not available in this host`);
			},
			tools: [] as never[],
			selectChatModels: async () => [] as never[],
			onDidChangeChatModels: silentEvent() as never,
			fileCompression: undefined
	};
}

export function buildChat(): Record<string, unknown> {
	return {
			registerChatParticipant: () => inert('chat.registerChatParticipant'),
			registerChatVariableResolver: () => inert('chat.registerChatVariableResolver'),
			registerChatCommand: () => inert('chat.registerChatCommand'),
			createChatParticipant: (id: string, handler?: unknown) => {
				unsupported('chat.createChatParticipant', 'there is no chat surface');
				return {
					id, iconPath: undefined, followupProvider: undefined, participantName: id,
					onDidReceiveFeedback: silentEvent() as never, requestHandler: handler as unknown, dispose: () => undefined
				};
			}
	};
}

export function buildTasks(): Record<string, unknown> {
	return {
			registerTaskProvider: (type: string, _provider: unknown) => inert(`tasks.registerTaskProvider(${type})`),
			fetchTasks: async (_filter?: unknown) => [] as never[],
			/** A run the host cannot perform rejects (a fake TaskExecution would leave the
			 *  caller waiting for an end event that never comes). */
			executeTask: async (task: unknown) => {
				const name = String((task as { name?: string })?.name ?? '');
				unsupported('tasks.executeTask', 'tasks do not run in this host');
				shimLog('warn', `tasks.executeTask(${name}) refused: tasks are not supported`);
				throw new Error(`tasks are not supported by the Git Graph Studio extension host (${name})`);
			},
			get taskExecutions(): never[] {
				return [];
			},
			onDidStartTask: silentEvent() as never,
			onDidEndTask: silentEvent() as never,
			onDidStartTaskProcess: silentEvent() as never,
			onDidEndTaskProcess: silentEvent() as never
	};
}

		/** The Test Controller API (VS Code 1.59): the controller, its items and the run
		 *  handles are real objects over local state; no test UI renders them. */
export function buildTests(): Record<string, unknown> {
	return {
			createTestController: (id: string, label?: string) => {
				unsupported('tests.createTestController', 'test results are not rendered');
				const items = new Map<string, unknown>();
				const collection = makeTestItemCollection(items);
				const controller: Record<string, unknown> = {
					id,
					label,
					items: collection,
					refreshHandler: undefined,
					resolveHandler: undefined as unknown,
					invalidateTestResults: () => undefined,
					createTestItem: (itemId: string, itemLabel: string, uri?: Uri) => makeTestItem(itemId, itemLabel, uri),
					createRunProfile: (profileLabel: string, kind: unknown, runHandler: unknown, isDefault?: boolean, tag?: unknown) => ({ label: profileLabel, kind, runHandler, isDefault, tag, configureHandler: undefined, onDidChangeDefault: silentEvent(), dispose: () => undefined }),
					createTestRun: (_request: unknown, name?: string, _persist?: boolean) => ({
						name,
						token: CancellationTokenNone,
						isPersisted: false,
						onDidDispose: silentEvent(),
						started: () => undefined,
						passed: () => undefined,
						failed: () => undefined,
						skipped: () => undefined,
						errored: () => undefined,
						enqueued: () => undefined,
						appendOutput: () => undefined,
						addCoverage: () => undefined,
						end: () => undefined
					}),
					dispose: () => undefined
				};
				return controller;
			}
	};
}

export function buildDebug(): Record<string, unknown> {
	return {
			activeDebugSession: undefined,
			activeStackItem: undefined,
			activeDebugConsole: { append: () => undefined, appendLine: () => undefined },
			breakpoints: [] as never[],
			registerDebugConfigurationProvider: (type: string) => inert(`debug.registerDebugConfigurationProvider(${type})`),
			registerDebugAdapterDescriptorFactory: (type: string) => inert(`debug.registerDebugAdapterDescriptorFactory(${type})`),
			registerDebugAdapterTrackerFactory: (type: string) => inert(`debug.registerDebugAdapterTrackerFactory(${type})`),
			registerDebugVisualizationProvider: (id: string) => inert(`debug.registerDebugVisualizationProvider(${id})`),
			startDebugging: async () => {
				unsupported('debug.startDebugging', 'there is no debugger in this host');
				return false;
			},
			stopDebugging: async () => undefined,
			addBreakpoints: () => unsupported('debug.addBreakpoints'),
			removeBreakpoints: () => unsupported('debug.removeBreakpoints'),
			asDebugSourceUri: (source: { path?: string }) => Uri.file(String(source?.path ?? '')),
			onDidStartDebugSession: silentEvent() as never,
			onDidTerminateDebugSession: silentEvent() as never,
			onDidChangeActiveDebugSession: silentEvent() as never,
			onDidReceiveDebugSessionCustomEvent: silentEvent() as never,
			onDidChangeBreakpoints: silentEvent() as never,
			onDidChangeActiveStackItem: silentEvent() as never
	};
}

		/** The Source Control API: a provider's objects are real and mutable (extensions
		 *  write their resource states into them); the Source Control view is the app's own
		 *  git view and renders none of them. */
export function buildScm(): Record<string, unknown> {
	return {
			inputBox: { value: '', placeholder: '', enabled: true, visible: true },
			createSourceControl: (id: string, label: string, rootUri?: Uri) => {
				unsupported('scm.createSourceControl', 'the Source Control view shows the app\'s own git provider only');
				const groups: unknown[] = [];
				return {
					id, label, rootUri,
					inputBox: { value: '', placeholder: '', enabled: true, visible: true, validateInput: undefined },
					count: undefined, quickDiffProvider: undefined, commitTemplate: undefined,
					acceptInputCommand: undefined, statusBarCommands: undefined,
					createResourceGroup: (groupId: string, groupLabel: string) => {
						const group = { id: groupId, label: groupLabel, hideWhenEmpty: false, resourceStates: [] as unknown[], dispose: () => undefined };
						groups.push(group);
						return group;
					},
					dispose: () => undefined
				};
			}
	};
}

export function buildNotebooks(): Record<string, unknown> {
	return {
			createNotebookController: (id: string, notebookType: string, label: string) => {
				unsupported('notebooks.createNotebookController', 'there is no notebook editor');
				return {
					id, notebookType, label, supportedLanguages: [] as string[], supportsExecutionOrder: false,
					executeHandler: undefined as unknown, interruptHandler: undefined as unknown,
					onDidChangeSelectedNotebooks: silentEvent(),
					createNotebookCellExecution: () => { throw new Error('notebooks are not supported by the Git Graph Studio extension host'); },
					updateNotebookAffinity: () => undefined,
					dispose: () => undefined
				};
			},
			registerNotebookCellStatusBarItemProvider: (notebookType: string) => inert(`notebooks.registerNotebookCellStatusBarItemProvider(${notebookType})`),
			createRendererMessaging: (rendererId: string) => {
				unsupported(`notebooks.createRendererMessaging(${rendererId})`);
				return { onDidReceiveMessage: silentEvent(), postMessage: async () => false };
			}
	};
}

export function buildAuthentication(): Record<string, unknown> {
	return {
			registerAuthenticationProvider: (id: string) => inert(`authentication.registerAuthenticationProvider(${id})`),
			getSession: async (providerId: string, _scopes: readonly string[], options?: { createIfNone?: boolean; forceNewSession?: unknown }) => {
				unsupported(`authentication.getSession(${providerId})`, 'no authentication providers exist; resolved undefined');
				if (options?.createIfNone || options?.forceNewSession) throw new Error(`no authentication provider ${providerId} in this host`);
				return undefined;
			},
			getAccounts: async () => [] as never[],
			onDidChangeSessions: silentEvent() as never
	};
}

export function buildL10n(): Record<string, unknown> {
	return {
			/** `t(message, ...args)`, `t(message, { named })` and the `{ message, args }` form. */
			t: (message: string | { message: string; args?: unknown[] | Record<string, unknown>; comment?: string | string[] }, ...args: unknown[]): string => {
				let text = typeof message === 'string' ? message : message.message;
				const values = typeof message === 'string' ? (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : args) : message.args ?? [];
				if (Array.isArray(values)) return text.replace(/\{(\d+)\}/g, (all, index: string) => (values[Number(index)] === undefined ? all : String(values[Number(index)])));
				for (const [key, value] of Object.entries(values as Record<string, unknown>)) text = text.split(`{${key}}`).join(String(value));
				return text;
			},
			bundle: undefined,
			uri: undefined
	};
}

export function buildComments(): Record<string, unknown> {
	return {
			createCommentController: (id: string, label: string) => {
				unsupported('comments.createCommentController', 'comment threads are not rendered');
				return {
					id, label, commentingRangeProvider: undefined, options: {}, reactionHandler: undefined,
					createCommentThread: (uri: Uri, range: Range, comments: unknown[]) => ({ uri, range, comments, collapsibleState: 0, canReply: false, contextValue: undefined, label: undefined, state: undefined, dispose: () => undefined }),
					dispose: () => undefined
				};
			}
	};
}
