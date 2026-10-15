// The `window` namespace: messages and picks over the host's quick input,
// progress, terminals, output channels, status bar items, webview panels and
// views, tree views, dialogs, the active-editor surface and the theme. The
// StatusBarItem class lives here with the surface it serves.

import { CancellationToken, CancellationTokenSource, Disposable, EventEmitter, silentEvent } from './types/events';
import { Range } from './types/position';
import { Uri, pathOf } from './types/uri';
import { InputBoxValidationSeverity, QuickPickItemKind, StatusBarAlignment, ViewColumn } from './types/enums';
import type { MessageItem, QuickPickItem } from './types/values';
import type { ThemeColor } from './types/values';
import type { HostBridge } from './bridge';
import { plainDecorationOptions } from './util';
import { documentKey } from './documents';
import { WebviewPanel } from './webviews';
import type { TreeDataProvider } from './treeViews';
import { inert, unsupported } from './inert';
import { guarded, shimLog, shimLogOnce } from './shimLog';
import type { ShimState } from './state';

/** A status bar item the extension owns: field writes post to the host, which renders. */
class StatusBarItem {
	private textValue = '';
	private tooltipValue: string | { value?: string } | undefined;
	private commandValue: string | { command: string; title?: string; arguments?: unknown[] } | undefined;
	private visible = false;
	private nameValue: string | undefined;
	private colorValue: string | ThemeColor | undefined;
	private backgroundValue: ThemeColor | undefined;
	accessibilityInformation: { label: string; role?: string } | undefined;

	constructor(private readonly bridge: HostBridge, readonly id: string, readonly alignment: StatusBarAlignment, readonly priority?: number) {}

	get color(): string | ThemeColor | undefined {
		return this.colorValue;
	}

	set color(value: string | ThemeColor | undefined) {
		this.colorValue = value;
		this.push();
	}

	get backgroundColor(): ThemeColor | undefined {
		return this.backgroundValue;
	}

	set backgroundColor(value: ThemeColor | undefined) {
		this.backgroundValue = value;
		this.push();
	}

	get text(): string {
		return this.textValue;
	}

	set text(value: string) {
		this.textValue = value;
		this.push();
	}

	get tooltip(): string | { value?: string } | undefined {
		return this.tooltipValue;
	}

	set tooltip(value: string | { value?: string } | undefined) {
		this.tooltipValue = value;
		this.push();
	}

	/** A command id or VS Code's `Command` object (`{ command, arguments }`). */
	get command(): string | { command: string; title?: string; arguments?: unknown[] } | undefined {
		return this.commandValue;
	}

	set command(value: string | { command: string; title?: string; arguments?: unknown[] } | undefined) {
		this.commandValue = value;
		this.push();
	}

	get name(): string | undefined {
		return this.nameValue;
	}

	set name(value: string | undefined) {
		this.nameValue = value;
		this.push();
	}

	show(): void {
		this.visible = true;
		this.push();
	}

	hide(): void {
		this.visible = false;
		this.push();
	}

	dispose(): void {
		void this.bridge.request('statusbar.dispose', [this.id]);
	}

	private push(): void {
		const tooltip = typeof this.tooltipValue === 'string' ? this.tooltipValue : this.tooltipValue?.value ?? '';
		const command = typeof this.commandValue === 'string' ? this.commandValue : this.commandValue?.command;
		const commandArgs = typeof this.commandValue === 'object' ? (this.commandValue.arguments ?? []) : undefined;
		const color = typeof this.colorValue === 'string' ? this.colorValue : this.colorValue?.id;
		void this.bridge.request('statusbar.set', [this.id, { alignment: this.alignment, priority: this.priority, text: this.textValue, tooltip, command, commandArgs, color, backgroundColor: this.backgroundValue?.id, visible: this.visible }]);
	}
}

export function buildWindow(s: ShimState) {
	/** `showXMessage(message, ...items)` accepts strings or `{title}` items, with an optional
	 *  leading MessageOptions object; the picked entry comes back in the shape it was given. */
	function showMessage(kind: 'info' | 'warning' | 'error', message: string, ...rest: unknown[]): Promise<string | MessageItem | undefined> {
		const items = rest.filter((item): item is string | MessageItem => item !== undefined && item !== null && (typeof item === 'string' || typeof (item as MessageItem).title === 'string'));
		const options = rest[0] !== null && typeof rest[0] === 'object' && typeof (rest[0] as MessageItem).title !== 'string' ? rest[0] as { modal?: boolean; detail?: string } : undefined;
		const text = options?.detail ? `${message} — ${options.detail}` : message;
		return Promise.resolve(s.bridge.request('notify', [kind, text, items.map((item) => (typeof item === 'string' ? item : item.title))])).then((picked) => {
			const title = picked as string | undefined;
			if (title === undefined || title === null) return undefined;
			return items.find((candidate) => (typeof candidate === 'string' ? candidate === title : candidate.title === title)) ?? undefined;
		}) as Promise<string | MessageItem | undefined>;
	}

	type PickEntry = { id: string; label: string; description?: string; detail?: string; picked?: boolean; item: unknown };

	/** The picker entries for a quick pick's items (separators dropped: the host list has
	 *  no separator rows), each with a stable id so duplicate labels stay distinct. */
	function pickEntries(items: unknown[]): PickEntry[] {
		return items
			.filter((item) => typeof item === 'string' || (item !== null && typeof item === 'object' && (item as { kind?: number }).kind !== QuickPickItemKind.Separator))
			.map((item, index) => typeof item === 'string'
				? { id: String(index), label: item, item }
				: { id: String(index), label: String((item as QuickPickItem).label ?? ''), description: (item as QuickPickItem).description, detail: (item as QuickPickItem).detail, picked: (item as QuickPickItem).picked, item });
	}

	/** The picked entry of one host pick (by id; an older host answers the label). */
	function entryFor(entries: PickEntry[], answer: unknown): PickEntry | undefined {
		if (answer === undefined || answer === null) return undefined;
		return entries.find((entry) => entry.id === answer) ?? entries.find((entry) => entry.label === answer);
	}

	/** One single-choice pick through the host's quick input. */
	async function pickOne(entries: PickEntry[], placeholder: string): Promise<PickEntry | undefined> {
		const answer = await s.bridge.request('showQuickPick', [entries.map(({ id, label, description, detail }) => ({ id, label, description, detail })), placeholder]);
		return entryFor(entries, answer);
	}

	/** A multi-select pick: the host's quick input has no checkboxes, so each round toggles
	 *  one item (the list shows ☑/☐) until the user takes the OK row or dismisses. */
	async function pickMany(entries: PickEntry[], placeholder: string): Promise<PickEntry[] | undefined> {
		const chosen = new Set(entries.filter((entry) => entry.picked).map((entry) => entry.id));
		const done = { id: '__ggs_done', label: s.isZh ? '✔ 确定' : '✔ OK' };
		for (;;) {
			const rows = [done, ...entries.map((entry) => ({ id: entry.id, label: `${chosen.has(entry.id) ? '☑' : '☐'} ${entry.label}`, description: entry.description, detail: entry.detail }))];
			const answer = await s.bridge.request('showQuickPick', [rows, placeholder]);
			if (answer === undefined || answer === null) return undefined;
			if (answer === done.id || answer === done.label) return entries.filter((entry) => chosen.has(entry.id));
			const row = rows.find((candidate) => candidate.id === answer || candidate.label === answer);
			if (!row) return undefined;
			if (chosen.has(row.id)) chosen.delete(row.id);
			else chosen.add(row.id);
		}
	}

	/** `window.showQuickPick`: string or object items (or a promise of them); single or
	 *  multi-select; `onDidSelectItem` fires for the pick. */
	async function showQuickPick(items: unknown, options?: { placeHolder?: string; title?: string; canPickMany?: boolean; onDidSelectItem?: (item: unknown) => unknown }, _token?: CancellationToken): Promise<unknown> {
		const list = await Promise.resolve(items as unknown[] | PromiseLike<unknown[]>);
		const entries = pickEntries(Array.isArray(list) ? list : [list]);
		const placeholder = options?.placeHolder ?? options?.title ?? '';
		if (options?.canPickMany) {
			const picked = await pickMany(entries, placeholder);
			return picked?.map((entry) => entry.item);
		}
		const picked = await pickOne(entries, placeholder);
		if (picked && options?.onDidSelectItem) guarded('showQuickPick onDidSelectItem', () => options.onDidSelectItem!(picked.item));
		return picked?.item;
	}

	/** `window.showInputBox`: the host prompt, re-asked with the message while
	 *  `validateInput` (sync or async) rejects the value. */
	async function showInputBox(options: { prompt?: string; value?: string; placeHolder?: string; password?: boolean; title?: string; validateInput?: (value: string) => unknown } = {}): Promise<string | undefined> {
		let value = options.value ?? '';
		let prompt = options.prompt ?? options.title ?? '';
		for (;;) {
			const answer = await s.bridge.request('showInputBox', [prompt, value, { placeHolder: options.placeHolder, password: options.password === true }]);
			if (answer === undefined || answer === null) return undefined;
			const text = String(answer);
			if (!options.validateInput) return text;
			const verdict = await Promise.resolve(guarded('showInputBox validateInput', () => options.validateInput!(text)));
			const message = typeof verdict === 'string' ? verdict : (verdict as { message?: string; severity?: number } | null | undefined)?.message;
			const severity = typeof verdict === 'object' && verdict !== null ? (verdict as { severity?: number }).severity : InputBoxValidationSeverity.Error;
			if (!message || severity === InputBoxValidationSeverity.Info || severity === InputBoxValidationSeverity.Warning) return text;
			value = text;
			prompt = `${options.prompt ?? options.title ?? ''}${options.prompt || options.title ? ' — ' : ''}${message}`;
		}
	}

	/** The hide / dispose halves both object-form modal prompts (createQuickPick,
	 *  createInputBox) share: hide closes an open prompt, dispose tears its emitters down
	 *  whatever state the prompt is in. `state.open` is the prompt's own flag. */
	function promptTeardown(state: { open: boolean }, hide: EventEmitter<void>, emitters: { dispose(): void }[]): { hide(): void; dispose(): void } {
		return {
			hide: () => {
				if (!state.open) return;
				state.open = false;
				hide.fire(undefined);
			},
			dispose: () => {
				state.open = false;
				for (const emitter of emitters) emitter.dispose();
			}
		};
	}

	/** `window.createQuickPick()`: the object form — items (often filled after `show()`,
	 *  with `busy` set meanwhile), selection and the accept / hide events. The host's
	 *  quick input is modal, so `show()` opens it once the items are in hand. */
	function createQuickPick(): Record<string, unknown> {
		const accept = new EventEmitter<void>();
		const hide = new EventEmitter<void>();
		const selection = new EventEmitter<unknown[]>();
		const active = new EventEmitter<unknown[]>();
		const valueChanged = new EventEmitter<string>();
		let items: unknown[] = [];
		let itemsArrived: (() => void) | null = null;
		const state = { open: false };
		const pick: Record<string, unknown> = {
			title: undefined, step: undefined, totalSteps: undefined, enabled: true, busy: false,
			ignoreFocusOut: false, placeholder: undefined, canSelectMany: false, matchOnDescription: false,
			matchOnDetail: false, keepScrollPosition: false, value: '', buttons: [], selectedItems: [], activeItems: [],
			get items() {
				return items;
			},
			set items(value: unknown[]) {
				items = value ?? [];
				itemsArrived?.();
				itemsArrived = null;
			},
			onDidAccept: accept.event,
			onDidHide: hide.event,
			onDidChangeSelection: selection.event,
			onDidChangeActive: active.event,
			onDidChangeValue: valueChanged.event,
			onDidTriggerButton: silentEvent(),
			onDidTriggerItemButton: silentEvent(),
			show: () => {
				if (state.open) return;
				state.open = true;
				setTimeout(async () => {
					// Wait (bounded) for the items a busy pick is still loading.
					if (items.length === 0) await new Promise<void>((resolve) => {
						itemsArrived = resolve;
						setTimeout(resolve, 15000);
					});
					if (!state.open) return;
					const entries = pickEntries(items);
					const placeholder = String(pick.placeholder ?? pick.title ?? '');
					const picked = pick.canSelectMany ? await pickMany(entries, placeholder) : await pickOne(entries, placeholder).then((entry) => (entry ? [entry] : undefined));
					if (!state.open) return;
					if (picked === undefined) {
						state.open = false;
						hide.fire(undefined);
						return;
					}
					pick.selectedItems = picked.map((entry) => entry.item);
					pick.activeItems = pick.selectedItems;
					active.fire(pick.activeItems as unknown[]);
					selection.fire(pick.selectedItems as unknown[]);
					accept.fire(undefined);
				}, 0);
			},
			...promptTeardown(state, hide, [accept, hide, selection, active, valueChanged])
		};
		return pick;
	}

	/** `window.createInputBox()`: the object form over the same host prompt. */
	function createInputBox(): Record<string, unknown> {
		const accept = new EventEmitter<void>();
		const hide = new EventEmitter<void>();
		const valueChanged = new EventEmitter<string>();
		const state = { open: false };
		const box: Record<string, unknown> = {
			title: undefined, step: undefined, totalSteps: undefined, enabled: true, busy: false, ignoreFocusOut: false,
			value: '', valueSelection: undefined, placeholder: undefined, password: false, prompt: undefined,
			validationMessage: undefined, buttons: [],
			onDidAccept: accept.event,
			onDidHide: hide.event,
			onDidChangeValue: valueChanged.event,
			onDidTriggerButton: silentEvent(),
			show: () => {
				if (state.open) return;
				state.open = true;
				setTimeout(async () => {
					const answer = await s.bridge.request('showInputBox', [String(box.prompt ?? box.title ?? ''), String(box.value ?? ''), { placeHolder: box.placeholder, password: box.password === true }]);
					if (!state.open) return;
					if (answer === undefined || answer === null) {
						state.open = false;
						hide.fire(undefined);
						return;
					}
					box.value = String(answer);
					valueChanged.fire(box.value as string);
					accept.fire(undefined);
				}, 0);
			},
			...promptTeardown(state, hide, [accept, hide, valueChanged])
		};
		return box;
	}

	return {
			showInformationMessage: (message: string, ...rest: unknown[]) => showMessage('info', message, ...rest),
			showWarningMessage: (message: string, ...rest: unknown[]) => showMessage('warning', message, ...rest),
			showErrorMessage: (message: string, ...rest: unknown[]) => showMessage('error', message, ...rest),
			showInputBox,
			showQuickPick,
			createQuickPick,
			createInputBox,
			showWorkspaceFolderPick: async (options?: { placeHolder?: string }) => {
				const picked = await pickOne(pickEntries(s.workspaceFolders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder }))), options?.placeHolder ?? '');
				return (picked?.item as { folder?: unknown } | undefined)?.folder;
			},
			withProgress: async <T>(options: { title?: string; location?: unknown; cancellable?: boolean }, task: (progress: { report: (value: { message?: string; increment?: number }) => void }, token: CancellationToken) => T | Promise<T>) => {
				const id = (await s.bridge.request('progress.begin', [options?.title ?? s.ctx.extensionId])) as number;
				let fraction = 0;
				// The toast has no cancel button: the token exists (tasks read it) and never
				// cancels.
				const source = new CancellationTokenSource();
				try {
					return await task({
						report: (value) => {
							fraction = Math.min(1, fraction + (value?.increment ?? 0) / 100);
							s.send('progress.report', [id, Math.round(fraction * 100), value?.message ?? '']);
						}
					}, source.token);
				} catch (error) {
					shimLog('warn', `withProgress task "${options?.title ?? ''}" failed: ${String(error)}`, error);
					throw error;
				} finally {
					source.dispose();
					s.send('progress.end', [id]);
				}
			},
			/** `window.createTerminal`: the integrated terminal serves the text — the run-in-
			 *  terminal actions extensions open. The panel's own session policy applies (its
			 *  shell, its cwd); a Pseudoterminal (`pty`) has no renderer here. */
			createTerminal: (nameOrOptions?: string | { name?: string; cwd?: string | Uri; env?: Record<string, string | null> | null; shellPath?: string; shellArgs?: string[] | string; pty?: unknown }, _shellPath?: string, _shellArgs?: string[]) => {
				const options = typeof nameOrOptions === 'object' && nameOrOptions !== null ? nameOrOptions : undefined;
				const name = typeof nameOrOptions === 'string' ? nameOrOptions : options?.name ?? '';
				if (options?.pty !== undefined) unsupported('window.createTerminal({ pty })', 'extension pseudoterminals have no renderer; the terminal stays empty');
				if (options?.cwd !== undefined || options?.env || options?.shellPath) shimLogOnce(`terminal-options:${s.ctx.extensionId}`, 'info', 'createTerminal options (cwd/env/shellPath) are advisory: the integrated terminal uses its own session');
				return {
					name,
					creationOptions: options ?? {},
					processId: Promise.resolve(undefined),
					exitStatus: undefined as { code: number } | undefined,
					state: { isInteractedWith: false },
					shellIntegration: undefined,
					sendText: (text: string, addNewLine = true) => {
						s.send('terminal.send', [addNewLine === false ? text : text]);
					},
					show: (_preserveFocus?: boolean) => s.send('terminal.show', []),
					hide: () => undefined,
					dispose: () => undefined
				};
			},
			get terminals(): unknown[] {
				return [];
			},
			activeTerminal: undefined,
			/** The Tabs API (`window.tabGroups`, VS Code 1.68): one group whose tab list the
			 *  frame cannot see — the shape a tab-aware feature reads is complete, and the
			 *  events register and never fire. */
			tabGroups: {
				all: [{ isActive: true, viewColumn: 1, activeTab: undefined, tabs: [] as unknown[] }],
				get activeTabGroup() {
					return this.all[0];
				},
				onDidChangeTabs: silentEvent(),
				onDidChangeTabGroups: silentEvent(),
				close: async (_tabOrGroup: unknown, _preserveFocus?: boolean) => {
					unsupported('window.tabGroups.close');
					return false;
				}
			},
			createOutputChannel: (name: string, options?: string | { log?: boolean }) => {
				// The `{ log: true }` form (LogOutputChannel): the level-named methods a logging
				// extension binds at activation (`channel.info.bind(channel)`, cspell's logger
				// wrapper above all); every level lands in the channel with its prefix.
				const isLog = typeof options === 'object' && options?.log === true;
				const format = (message: unknown, args: unknown[]) => `${message instanceof Error ? (message.stack ?? message.message) : String(message)}${args.length > 0 ? ' ' + args.map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? (arg.stack ?? arg.message) : JSON.stringify(arg))).join(' ') : ''}`;
				const logLine = (level: string, message: unknown, ...args: unknown[]) => s.pendingOutputLines.push([name, `${isLog ? `${new Date().toISOString()} ` : ''}[${level}] ${format(message, args)}\n`]);
				return {
					name,
					logLevel: 3 as never,
					onDidChangeLogLevel: silentEvent() as never,
					trace: (message: unknown, ...args: unknown[]) => logLine('trace', message, ...args),
					debug: (message: unknown, ...args: unknown[]) => logLine('debug', message, ...args),
					info: (message: unknown, ...args: unknown[]) => logLine('info', message, ...args),
					warn: (message: unknown, ...args: unknown[]) => logLine('warning', message, ...args),
					error: (message: unknown, ...args: unknown[]) => logLine('error', message, ...args),
					append: (value: string) => {
					s.pendingOutputLines.push([name, String(value)]);
					s.scheduleOutputFlush();
				},
				appendLine: (value: string) => {
					s.pendingOutputLines.push([name, String(value) + '\n']);
					s.scheduleOutputFlush();
				},
				clear: () => { s.flushOutputLines(); s.send('output.clear', [name]); },
				show: (_columnOrPreserveFocus?: unknown, _preserveFocus?: boolean) => { s.flushOutputLines(); s.send('output.show', [name]); },
				hide: () => undefined,
				replace: (value: string) => {
					s.flushOutputLines();
					s.send('output.clear', [name]);
					s.pendingOutputLines.push([name, String(value)]);
					s.scheduleOutputFlush();
				},
					dispose: () => s.send('output.dispose', [name])
				};
			},
			/** `(alignment?, priority?)` or VS Code 1.57's `(id, alignment?, priority?)`. */
			createStatusBarItem: (arg1?: number | string, arg2?: number, arg3?: number) => {
				const alignment = (typeof arg1 === 'number' ? arg1 : arg2) ?? StatusBarAlignment.Left;
				const priority = typeof arg1 === 'number' ? arg2 : arg3;
				const item = new StatusBarItem(s.bridge, `${s.ctx.extensionId}:${++s.statusSeq}`, alignment, priority);
				s.send('statusbar.create', [item.id, alignment]);
				return item;
			},
			/** A transient message: until the timeout, until the thenable settles, or — with
			 *  neither — until the returned Disposable runs (VS Code's three forms). */
			setStatusBarMessage: (text: string, hideAfter?: number | PromiseLike<unknown>) => {
				const item = new StatusBarItem(s.bridge, `${s.ctx.extensionId}:${++s.statusSeq}:msg`, StatusBarAlignment.Left);
				s.send('statusbar.create', [item.id, StatusBarAlignment.Left]);
				item.text = text;
				item.show();
				let gone = false;
				const dispose = () => {
					if (gone) return;
					gone = true;
					item.dispose();
				};
				if (typeof hideAfter === 'number') setTimeout(dispose, Math.max(0, hideAfter));
				else if (hideAfter && typeof (hideAfter as PromiseLike<unknown>).then === 'function') (hideAfter as PromiseLike<unknown>).then(dispose, dispose);
				return new Disposable(dispose);
			},
			createWebviewPanel: (viewType: string, title: string, showOptions?: unknown, options?: Record<string, unknown>) => {
				const panelId = ++s.webviewSeq;
				const panel = new WebviewPanel(s.bridge, s.ctx, viewType, title, options ?? {}, panelId);
				s.webviewPanels.set(panelId, panel);
				// VS Code's showOptions: a bare ViewColumn or `{ viewColumn, preserveFocus }`. Both
				// ride the create — the host turns the column into a placement (Beside is what an
				// extension's chat panel opens in; claude-code locks the group it lands a new
				// column in right after, exactly as in VS Code) and skips focusing it while
				// preserveFocus holds.
				const column = typeof showOptions === 'number' ? showOptions : (showOptions as { viewColumn?: unknown } | null | undefined)?.viewColumn;
				const preserveFocus = typeof showOptions === 'object' && showOptions !== null && (showOptions as { preserveFocus?: unknown }).preserveFocus === true;
				s.send('webview.create', [panelId, viewType, title, column, preserveFocus]);
				return panel;
			},
			registerWebviewViewProvider: (viewId: string, provider: { resolveWebviewView: (view: unknown, context: unknown, token: unknown) => unknown }, _options?: unknown) => {
				s.webviewViewProviders.set(viewId, provider);
				s.send('webviewView.register', [viewId]);
				return new Disposable(() => {
					s.webviewViewProviders.delete(viewId);
					s.send('webviewView.dispose', [viewId]);
				});
			},
			registerWebviewPanelSerializer: (viewType: string, _serializer: unknown) => inert(`window.registerWebviewPanelSerializer(${viewType})`),
			registerCustomEditorProvider: (viewType: string, _provider: unknown) => inert(`window.registerCustomEditorProvider(${viewType})`),
			registerUriHandler: (_handler: unknown) => inert('window.registerUriHandler'),
			registerFileDecorationProvider: (provider: { provideFileDecoration: (uri: unknown, token: unknown) => unknown }, options?: { label?: string }) => {
				// GGS-patch: real file decorations — the explorer's badges/colours ask the
				// providers (see explorerDecorations.ts, the store half; the extension's
				// decoration crosses as its serializable subset: badge letter + colour name).
				const id = `filedeco-${++s.formatterSeq}`;
				s.fileDecorationProviders.set(id, { label: options?.label ?? '', run: provider.provideFileDecoration.bind(provider) });
				s.send('fileDecorations.register', [{ id, label: options?.label ?? '' }]);
				return new Disposable(() => {
					s.fileDecorationProviders.delete(id);
					s.send('fileDecorations.unregister', [{ id }]);
				});
			},
			registerTerminalLinkProvider: (_provider: unknown) => inert('window.registerTerminalLinkProvider'),
			registerTerminalProfileProvider: (_id: string, _provider: unknown) => inert('window.registerTerminalProfileProvider'),
			registerTreeDataProvider: (viewId: string, treeDataProvider: TreeDataProvider<unknown>) => {
				s.registerTree(viewId, treeDataProvider);
				return new Disposable(() => s.send('treeView.dispose', [viewId]));
			},
			createTextEditorDecorationType: (options?: Record<string, unknown>) => {
				// GGS-patch: real decoration types. The renderable subset of the options
				// crosses to the workbench at creation (see editorDecorations.ts); the rest
				// of the options object is accepted and ignored, as the API shape promises.
				const key = `${s.ctx.extensionId}/${++s.statusSeq}/deco`;
				void s.bridge.request('decoration.type', [{ key, options: plainDecorationOptions(options) }]).catch(() => undefined);
				return {
					key,
					dispose: () => {
						void s.bridge.request('decoration.dispose', [{ key }]).catch(() => undefined);
					}
				} as { key: string; dispose(): void };
			},
			showOpenDialog: async (options?: { canSelectMany?: boolean; defaultUri?: Uri; filters?: Record<string, string[]>; title?: string; canSelectFolders?: boolean }) => {
				const picked = await s.bridge.request('dialog.open', [options ?? {}]) as (string | { fsPath?: string })[] | string | null | undefined;
				const paths = picked === null || picked === undefined ? [] : Array.isArray(picked) ? picked : [picked];
				return paths.length > 0 ? paths.map((entry) => Uri.file(pathOf(entry))) : undefined;
			},
			showSaveDialog: async (options?: { defaultUri?: Uri; filters?: Record<string, string[]>; title?: string }) => {
				const picked = await s.bridge.request('dialog.save', [options ?? {}]) as string | { fsPath?: string } | null | undefined;
				return picked ? Uri.file(pathOf(picked)) : undefined;
			},
			get activeTextEditor(): Record<string, unknown> | undefined {
				return s.activeEditor ? s.makeTextEditorProxy() : undefined;
			},
			get visibleTextEditors(): Record<string, unknown>[] {
				return s.activeEditor ? [s.makeTextEditorProxy()] : [];
			},
			onDidChangeActiveTextEditor: s.activeEditorChangedEmitter.event,
			onDidChangeVisibleTextEditors: s.visibleEditorsChanged.event,
			onDidChangeTextEditorSelection: s.selectionChanged.event,
			onDidChangeTextEditorVisibleRanges: silentEvent(),
			onDidChangeTextEditorOptions: silentEvent(),
			onDidChangeTextEditorViewColumn: silentEvent(),
			get activeColorTheme(): { kind: number } {
				return { kind: s.themeKind };
			},
			onDidChangeActiveColorTheme: s.themeChangedEmitter.event,
			showTextDocument: async (documentOrUri: Record<string, unknown> | Uri | string, columnOrOptions?: number | { selection?: Range; preview?: boolean; preserveFocus?: boolean; viewColumn?: number }) => {
				const options = typeof columnOrOptions === 'object' && columnOrOptions !== null ? columnOrOptions : {};
				const column = typeof columnOrOptions === 'number' ? columnOrOptions : options.viewColumn;
				// A ViewColumn as a placement the host understands: Beside (-2) and the
				// 1-based columns; Active (-1) and the default stay undefined (the active group).
				const placement = column === ViewColumn.Beside ? 'beside' : typeof column === 'number' && column >= 1 ? column : undefined;
				const target = documentOrUri as { uri?: Uri; fileName?: string };
				const uri = documentOrUri instanceof Uri ? documentOrUri : target.uri instanceof Uri ? target.uri : Uri.isUri(target.uri) ? target.uri : undefined;
				if (uri !== undefined && uri.scheme !== 'file' && uri.scheme !== 'untitled') {
					// A provider-scheme document — a package's virtual text (a chat view
					// opening its tool outputs and code blocks this way): the read-only
					// content tab. The shim holds the provider's text from `openTextDocument`;
					// the tab defaults to beside, so the view the link was clicked in (the
					// chat panel) keeps its half of the editor area.
					const remembered = s.documents.get(documentKey(uri.toString()));
					let text: string;
					if (remembered !== undefined) {
						text = remembered.text;
					} else {
						// The same local-first read `openTextDocument` takes — the host
						// round-trip's answer would call back into a ggs-node process
						// parked on this very call.
						const own = s.bridge.readDocProvider?.(uri) ?? null;
						text = own !== null
							? String((await own) ?? '')
							: String(await s.bridge.request('docProvider.read', [uri]).catch((error) => {
								shimLog('warn', `showTextDocument(${uri.toString()}) provider read failed: ${String(error)}`, error);
								return '';
							}) ?? '');
					}
					const title = uri.path.split(/[\\/]/).filter((part) => part !== '').pop() || uri.toString();
					await s.bridge.request('workspace.openContentTab', [title, uri.path, text, placement ?? 'beside']);
					return s.makeTextEditorProxy(uri.toString());
				}
				const path = typeof documentOrUri === 'string' ? documentOrUri : uri !== undefined ? s.hostPathOf(uri) : String(target.fileName ?? '');
				const selection = options.selection;
				await s.bridge.request('workspace.openFile', selection ? [path, selection.start.line + 1, selection.start.character + 1, placement] : [path, undefined, undefined, placement]);
				return s.makeTextEditorProxy(path);
			},
			createTreeView: (viewId: string, options: { treeDataProvider: TreeDataProvider<unknown>; showCollapseAll?: boolean; canSelectMany?: boolean }) => {
				const registration = s.registerTree(viewId, options.treeDataProvider);
				const meta: { title?: string; description?: string; message?: string; badge?: { value: number; tooltip?: string } } = {};
				const pushMeta = () => s.send('treeView.meta', [viewId, meta]);
				return {
					get visible(): boolean {
						return registration.visible;
					},
					get selection(): unknown[] {
						return registration.selection;
					},
					get title(): string | undefined {
						return meta.title;
					},
					set title(value: string | undefined) {
						meta.title = value;
						pushMeta();
					},
					get description(): string | undefined {
						return meta.description;
					},
					set description(value: string | undefined) {
						meta.description = value;
						pushMeta();
					},
					get message(): string | undefined {
						return meta.message;
					},
					set message(value: string | undefined) {
						meta.message = value;
						pushMeta();
					},
					get badge(): { value: number; tooltip?: string } | undefined {
						return meta.badge;
					},
					set badge(value: { value: number; tooltip?: string } | undefined) {
						meta.badge = value;
						pushMeta();
					},
					onDidChangeVisibility: registration.visibilityChanged.event,
					onDidChangeSelection: registration.selectionChanged.event,
					onDidExpandElement: registration.expanded.event,
					onDidCollapseElement: registration.collapsed.event,
					onDidChangeCheckboxState: registration.checkboxChanged.event,
					/** The view shows itself (its section is revealed); the element is not
					 *  scrolled to or selected — the tree has no reveal-by-element yet. */
					reveal: async (_element: unknown, _options?: unknown) => {
						s.send('treeView.reveal', [viewId]);
					},
					dispose: () => {
						s.send('treeView.dispose', [viewId]);
						s.treeRegistrations.delete(viewId);
						registration.visibilityChanged.dispose();
						registration.selectionChanged.dispose();
					}
				};
			},
			get state(): { focused: boolean; active: boolean } {
				// The shim also runs in the real-Node extension host (nodeHost.ts), where no
				// `document` exists — the window simply reports focused there.
				const focused = typeof document === 'undefined' ? true : document.hasFocus();
				return { focused, active: focused };
			},
			onDidChangeWindowState: silentEvent() as never,
			/** The notebook events: no notebook UI exists here, so the registrations attach and
			 *  never fire — the honest degradation that lets an activation finish. */
			onDidChangeActiveNotebookEditor: silentEvent() as never,
			onDidChangeNotebookEditorSelection: silentEvent() as never,
			onDidChangeNotebookEditorVisibleRanges: silentEvent() as never,
			onDidChangeVisibleNotebookEditors: silentEvent() as never,
			/** The terminal events: terminals `createTerminal` makes open in the integrated
			 *  panel, but the open/close pushes are not wired back — they never fire. */
			onDidOpenTerminal: silentEvent() as never,
			onDidCloseTerminal: silentEvent() as never,
			onDidChangeActiveTerminal: silentEvent() as never,
			onDidChangeTerminalState: silentEvent() as never,
			onDidStartTerminalShellExecution: silentEvent() as never,
			onDidEndTerminalShellExecution: silentEvent() as never,
			onDidChangeTerminalShellIntegration: silentEvent() as never,
			get activeNotebookEditor(): undefined {
				return undefined;
			},
			get visibleNotebookEditors(): unknown[] {
				return [];
			},
			get notebookEditors(): unknown[] {
				return [];
			},
			showNotebookDocument: async () => {
				unsupported('window.showNotebookDocument', 'there is no notebook editor');
				throw new Error('notebooks are not supported by the Git Graph Studio extension host');
			}
	};
}
