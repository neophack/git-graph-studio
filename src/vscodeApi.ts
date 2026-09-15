// The `vscode` module Studio's extension host serves to installed extensions. It implements
// the commonly used subset of the VS Code extension API; anything outside it throws a clear
// "not supported by Git Graph Studio" error rather than failing mysteriously.
//
// The shim runs inside the extension host frame, so extension callbacks (command handlers,
// event listeners) stay in the frame; everything that touches the workbench - the command
// registry, notifications, settings persistence - crosses the `HostBridge` to the main window.

export interface HostBridge {
	/** Call a host service; resolves with its result, rejects with the host's error. */
	request(method: string, args: unknown[]): Promise<unknown>;
	/** Park a command handler in the frame (functions cannot cross the message boundary). */
	registerCommandHandler(id: string, handler: (...args: unknown[]) => unknown): void;
}

export interface HostContext {
	extensionId: string;
	extensionPath: string;
	/** The folders the workbench has open (VS Code's workspaceFolders, at activation time). */
	workspaceFolders: { uri: Uri; name: string; index: number }[];
	/** The settings section the extension wrote through `workspace.getConfiguration().update()`. */
	settings: Record<string, unknown>;
	language: string;
}

/* ---------- The small value types VS Code's API is built from ---------- */

export class Position {
	constructor(readonly line: number, readonly character: number) {}
	compareTo(other: Position): number {
		return this.line !== other.line ? this.line - other.line : this.character - other.character;
	}
}

export class Range {
	constructor(readonly start: Position, readonly end: Position) {}
	with(start = this.start, end = this.end): Range {
		return new Range(start, end);
	}
	get isEmpty(): boolean {
		return this.start.line === this.end.line && this.start.character === this.end.character;
	}
}

export class Location {
	constructor(readonly uri: Uri, readonly range: Range) {}
}

export interface Uri {
	scheme: string;
	path: string;
	fsPath: string;
	toString(): string;
	with(change: Partial<Uri>): Uri;
}

function makeUri(scheme: string, path: string): Uri {
	const fsPath = path;
	return {
		scheme,
		path,
		fsPath,
		toString: () => `${scheme}:${path}`,
		with: (change) => makeUri(change.scheme ?? scheme, change.path ?? path)
	};
}

export const Uri = {
	file: (path: string) => makeUri('file', path),
	joinPath: (base: Uri, ...segments: string[]) => makeUri(base.scheme, [base.path.replace(/\/$/, ''), ...segments].join('/')),
	parse: (value: string) => {
		const index = value.indexOf(':');
		return index === -1 ? makeUri('untitled', value) : makeUri(value.slice(0, index), value.slice(index + 1));
	}
} as const;

export class Disposable {
	constructor(readonly dispose: () => void) {}
	static from(...disposables: { dispose(): void }[]): Disposable {
		return new Disposable(() => disposables.forEach((d) => d.dispose()));
	}
}

export class EventEmitter<T> {
	private readonly listeners = new Set<(e: T) => any>();
	readonly event = (listener: (e: T) => any) => {
		this.listeners.add(listener);
		return new Disposable(() => this.listeners.delete(listener));
	};
	fire(event: T): void {
		for (const listener of this.listeners) listener(event);
	}
	dispose(): void {
		this.listeners.clear();
	}
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 } as const;
export type ViewColumn = (typeof ViewColumn)[keyof typeof ViewColumn];
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }

/* ---------- Configuration ---------- */

class WorkspaceConfiguration {
	constructor(private readonly ctx: HostContext, private readonly bridge: HostBridge, private readonly section: string) {}

	private key(setting: string): string {
		return this.section === '' ? setting : `${this.section}.${setting}`;
	}

	get<T = unknown>(setting: string, defaultValue?: T): T {
		const value = this.ctx.settings[this.key(setting)];
		return (value as T | undefined) ?? (defaultValue as T);
	}

	has(setting: string): boolean {
		return this.key(setting) in this.ctx.settings;
	}

	async update(setting: string, value: unknown, _target?: ConfigurationTarget): Promise<void> {
		this.ctx.settings[this.key(setting)] = value;
		await this.bridge.request('settings.update', [this.ctx.extensionId, this.key(setting), value]);
	}

	inspect(_setting: string): undefined {
		return undefined;
	}
}

/* ---------- The API ---------- */

function unsupported(name: string): never {
	throw new Error(`'${name}' is not supported by the Git Graph Studio extension host`);
}

export function createVscodeApi(ctx: HostContext, bridge: HostBridge) {
	const workspaceFoldersChanged = new EventEmitter<void>();

	return {
		version: '1.61.0-studio',

		commands: {
			registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
				const full = id.includes('.') ? id : `${ctx.extensionId}.${id}`;
				bridge.registerCommandHandler(full, handler);
				void bridge.request('commands.register', [full]);
				return new Disposable(() => void bridge.request('commands.unregister', [full]));
			},
			executeCommand: (id: string, ...args: unknown[]) => bridge.request('commands.execute', [id, args]) as Promise<unknown>,
			getCommands: async () => (await bridge.request('commands.list', [])) as string[]
		},

		window: {
			showInformationMessage: (message: string, ...items: string[]) =>
				bridge.request('notify', ['info', message, items]) as Promise<string | undefined>,
			showWarningMessage: (message: string, ...items: string[]) =>
				bridge.request('notify', ['warning', message, items]) as Promise<string | undefined>,
			showErrorMessage: (message: string, ...items: string[]) =>
				bridge.request('notify', ['error', message, items]) as Promise<string | undefined>,
			showInputBox: (options?: { prompt?: string; value?: string; placeholder?: string }) =>
				bridge.request('showInputBox', [options?.prompt ?? '', options?.value ?? '']) as Promise<string | undefined>,
			showQuickPick: (items: string[], placeholder = '') =>
				bridge.request('showQuickPick', [items, placeholder]) as Promise<string | undefined>,
			withProgress: async <T>(options: unknown, task: () => T | Promise<T>) => {
				void options; // no progress UI in Studio; the task simply runs
				return await task();
			},
			createOutputChannel: () => ({ append: () => undefined, appendLine: (line: string) => void bridge.request('log', [ctx.extensionId, line]), show: () => undefined, dispose: () => undefined }),
			createWebviewPanel: () => unsupported('window.createWebviewPanel'),
			createStatusBarItem: () => unsupported('window.createStatusBarItem'),
			createTreeView: () => unsupported('window.createTreeView'),
			registerTreeDataProvider: () => unsupported('window.registerTreeDataProvider')
		},

		workspace: {
			workspaceFolders: ctx.workspaceFolders,
			onDidChangeWorkspaceFolders: workspaceFoldersChanged.event,
			getWorkspaceFolder: () => ctx.workspaceFolders[0] ?? null,
			getConfiguration: (section = '') => new WorkspaceConfiguration(ctx, bridge, section),
			onDidSaveTextDocument: (() => new Disposable(() => undefined)) as never,
			onDidChangeConfiguration: (() => new Disposable(() => undefined)) as never,
			findFiles: () => unsupported('workspace.findFiles'),
			applyEdit: () => unsupported('workspace.applyEdit'),
			get fs(): never {
				return unsupported('workspace.fs');
			}
		},

		env: {
			language: ctx.language,
			appName: 'Git Graph Studio',
			openExternal: (uri: Uri) => bridge.request('openExternal', [uri.toString()]) as Promise<boolean>,
			clipboard: {
				writeText: (text: string) => bridge.request('clipboard.writeText', [text]) as Promise<void>
			}
		},

		extensions: {
			getExtension: () => undefined,
			all: [] as never[]
		},

		Uri,
		Position,
		Range,
		Location,
		Disposable,
		EventEmitter,
		ViewColumn,
		StatusBarAlignment,
		ConfigurationTarget,
		TreeItemCollapsibleState,
		ProgressLocation
	};
}

export type VscodeApi = ReturnType<typeof createVscodeApi>;
