// The `vscode` module Studio's extension host serves to installed extensions. It implements
// the commonly used subset of the VS Code extension API; a surface this host cannot serve
// degrades instead of throwing - VS Code's own compatibility posture (unknown
// contributions are ignored, an unsupported capability registration is inert), because a
// throw at activation time kills every other feature of the extension with it. Each
// degraded surface notes itself on the console, so a silent no-op is never mysterious.
//
// The shim runs inside the extension host frame, so extension callbacks (command handlers,
// event listeners) stay in the frame; everything that touches the workbench - the command
// registry, notifications, settings persistence, webview panels, status bar items, output
// channels - crosses the `HostBridge` to the main window. Events the host pushes back
// (configuration changes, webview messages, disposals) arrive through `handleHostEvent`.
//
// The directory holds the shim by concern: the value types under types/, the bridge
// contract and log vocabulary, the pure serializers, the frame-side object halves
// (mementos, webviews, tree views, the document table), the shared ShimState, one
// builder per namespace (commands/window/workspace/languages/env/extensions), the
// degraded namespaces under inert/, and this index — the assembly and the public
// surface every host imports (a directory import resolves here).

import type { HostBridge, HostContext, HostEvent } from './bridge';
import { readLocalDocProvider } from './bridge';

import { LOG_RANK, resetShimLoggedOnce, setShimLogSink, setShimLogThreshold, shimLog } from './shimLog';
import { rehydrateUris, setUriPlatform } from './types/uri';
import { CancellationTokenCancelled, CancellationTokenNone, silentEvent } from './types/events';
import { createShimState } from './state';
import { installFlushHook } from './registrations';
import { buildCommands } from './commands';
import { buildWindow } from './window';
import { buildWorkspace } from './workspace';
import { buildLanguages } from './languages';
import { buildEnv } from './env';
import { buildExtensions, extensionEntry } from './extensions';
import { buildAuthentication, buildChat, buildComments, buildDebug, buildL10n, buildLm, buildNotebooks, buildScm, buildTasks, buildTests } from './inert';
import { EnvironmentVariableCollection, SecretStorage } from './mementos';
import { WebviewView } from './webviews';
import { documentView } from './documents';
import { TestMessage, TestRunRequest, TestTag } from './inert';
import { CodeActionTriggerKind, ColorFormat, CommentMode, CommentThreadCollapsibleState, CompletionItemKind, CompletionItemTag, CompletionTriggerKind, ConfigurationTarget, DebugConsoleMode, DecorationRangeBehavior, DiagnosticSeverity, DocumentHighlightKind, EndOfLine, EnvironmentVariableMutatorType, ExtensionKind, ExtensionMode, FileChangeType, FileType, FoldingRangeKind, InlineCompletionTriggerKind, InputBoxValidationSeverity, LanguageStatusSeverity, NotebookCellKind, OverviewRulerLane, ProgressLocation, QuickPickItemKind, SignatureHelpTriggerKind, StatusBarAlignment, SymbolKind, SymbolTag, TerminalExitReason, TerminalLocation, TextDocumentChangeReason, TextDocumentSaveReason, TextEditorCursorStyle, TextEditorLineNumbersStyle, TextEditorRevealType, TextEditorSelectionChangeKind, TreeItemCheckboxState, TreeItemCollapsibleState, UIKind, ViewColumn } from './types/enums';
import { CancellationTokenSource, Disposable, EventEmitter } from './types/events';
import { Location, Position, Range, Selection } from './types/position';
import { Uri } from './types/uri';
import { Breakpoint, CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall, CancellationError, CodeAction, CodeActionKind, CodeLens, Color, ColorInformation, ColorPresentation, CompletionItem, CompletionList, CustomExecution, DataTransfer, DataTransferItem, DebugAdapterExecutable, DebugAdapterInlineImplementation, DebugAdapterNamedPipeServer, DebugAdapterServer, Diagnostic, DiagnosticRelatedInformation, DiagnosticTag, DocumentDropEdit, DocumentHighlight, DocumentLink, DocumentSymbol, EvaluatableExpression, FileDecoration, FileSystemError, FoldingRange, FunctionBreakpoint, Hover, InlayHint, InlayHintKind, InlayHintLabelPart, InlineCompletionItem, InlineCompletionList, InlineValueEvaluatableExpression, InlineValueText, InlineValueVariableLookup, LanguageModelError, LinkedEditingRanges, MarkdownString, NotebookCellData, NotebookCellOutputItem, NotebookData, NotebookEdit, NotebookRange, ParameterInformation, ProcessExecution, RelativePattern, SelectionRange, SemanticTokens, SemanticTokensBuilder, SemanticTokensEdit, SemanticTokensEdits, SemanticTokensLegend, ShellExecution, SignatureHelp, SignatureInformation, SnippetString, SnippetTextEdit, SourceBreakpoint, SymbolInformation, TabInputCustom, TabInputTerminal, TabInputText, TabInputTextDiff, TabInputWebview, Task, TaskGroup, TaskPanelKind, TaskRevealKind, TaskScope, TerminalLink, TerminalProfile, TextEdit, ThemeColor, ThemeIcon, TreeItem, TypeHierarchyItem, WorkspaceEdit } from './types/values';

// The public surface — exactly what the single-file shim exported before the split.
export { readLocalDocProvider, applyTextEditsToText } from './bridge';
export type { HostBridge, HostContext, HostEvent, SerializableTextEdit } from './bridge';
export { shimLog, shimLogOnce } from './shimLog';
export type { ShimLogLevel } from './shimLog';
export { watcherGlobMatches } from './util';
export { Position, Range, Location, Selection } from './types/position';
export { setUriPlatform, Uri, rehydrateUris } from './types/uri';
export { Disposable, EventEmitter, CancellationTokenSource } from './types/events';
export type { Event, CancellationToken } from './types/events';
export { ViewColumn, StatusBarAlignment, ConfigurationTarget, TreeItemCollapsibleState, ProgressLocation, UIKind, TextEditorSelectionChangeKind, TextDocumentSaveReason, TextDocumentChangeReason, FileChangeType, TreeItemCheckboxState, DocumentHighlightKind, FoldingRangeKind, SignatureHelpTriggerKind, CompletionTriggerKind, CodeActionTriggerKind, InlineCompletionTriggerKind, CompletionItemTag, SymbolTag, TextEditorCursorStyle, TextEditorLineNumbersStyle, EnvironmentVariableMutatorType, NotebookCellKind, CommentMode, TerminalLocation, TerminalExitReason, InputBoxValidationSeverity, DebugConsoleMode, ColorFormat, ExtensionMode, ExtensionKind, FileType, EndOfLine, OverviewRulerLane, DecorationRangeBehavior, LanguageStatusSeverity, TextEditorRevealType, QuickPickItemKind, DiagnosticSeverity, CompletionItemKind, SymbolKind, CommentThreadCollapsibleState } from './types/enums';
export { CodeActionKind, MarkdownString, ThemeIcon, ThemeColor, TreeItem, SnippetString, TextEdit, SnippetTextEdit, RelativePattern, WorkspaceEdit, DiagnosticTag, DiagnosticRelatedInformation, Diagnostic, CompletionItem, CodeLens, DocumentLink, CodeAction, SymbolInformation, CallHierarchyItem, TypeHierarchyItem, InlayHintKind, InlayHint, InlayHintLabelPart, CancellationError, FileSystemError, Hover, ParameterInformation, SignatureInformation, SignatureHelp, FoldingRange, DocumentSymbol, DocumentHighlight, SelectionRange, CompletionList, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, LinkedEditingRanges, EvaluatableExpression, InlineValueText, InlineValueVariableLookup, InlineValueEvaluatableExpression, InlineCompletionItem, InlineCompletionList, Color, ColorInformation, ColorPresentation, SemanticTokensLegend, SemanticTokens, SemanticTokensEdit, SemanticTokensEdits, SemanticTokensBuilder, DocumentDropEdit, FileDecoration, TerminalLink, TerminalProfile, DataTransferItem, DataTransfer, TabInputText, TabInputTextDiff, TabInputWebview, TabInputCustom, TabInputTerminal, NotebookCellData, NotebookData, NotebookCellOutputItem, NotebookEdit, NotebookRange, Breakpoint, SourceBreakpoint, FunctionBreakpoint, DebugAdapterExecutable, DebugAdapterServer, DebugAdapterNamedPipeServer, DebugAdapterInlineImplementation, CommentThreadState, LanguageModelError, ShellExecution, ProcessExecution, CustomExecution, TaskGroup, Task, TaskScope, TaskRevealKind, TaskPanelKind, snippetPlainText } from './types/values';
export type { MessageItem, QuickPickItem, WorkspaceEditOperation } from './types/values';
export { changedSettingKeys, configurationChangeEvent } from './configuration';
export type { ConfigurationChangeEvent } from './configuration';
export type { TreeDataProvider } from './treeViews';
export { selectorScore } from './languages';
export { extensionEntry } from './extensions';
export { TestTag, TestMessage, TestRunRequest } from './inert';

export function createVscodeApi(ctx: HostContext, bridge: HostBridge) {
	// The host's platform spells `Uri.fsPath`; the log threshold filters here, before a
	// line costs a bridge crossing; anomalies go to the host's extension-host log.
	setUriPlatform(ctx.platform);
	if (ctx.logLevel !== undefined && ctx.logLevel in LOG_RANK) setShimLogThreshold(ctx.logLevel);
	// One API per extension context: its "logged once" notices start fresh.
	resetShimLoggedOnce();
	setShimLogSink((level, message, detail) => {
		try {
			void Promise.resolve(bridge.request('log', [level, message, detail ?? null])).catch(() => console.warn(`[ggs-ext] ${message}`));
		} catch {
			console.warn(`[ggs-ext] ${message}`);
		}
	});
	const s = createShimState(ctx, bridge);
	installFlushHook(s);
	const api = {
		// The API surface this shim targets, spelled the way `vscode.version` spells it:
		// packages version-gate on it (vscode-languageclient refuses a host below its
		// `engines.vscode` floor), so a studio-local suffix would wrongly read as an old host.
		// 1.106 is the release whose layout packages now assume: Claude Code below it pins its
		// chat into the primary sidebar (`doesNotSupportSecondarySidebar`); at it, the sidebar
		// keeps the sessions list and every conversation opens as an editor tab.
		version: '1.106.0',

		commands: buildCommands(s),
		window: buildWindow(s),
		workspace: buildWorkspace(s),
		languages: buildLanguages(s),
		lm: buildLm(),
		chat: buildChat(),
		tasks: buildTasks(),
		tests: buildTests(),
		debug: buildDebug(),
		scm: buildScm(),
		notebooks: buildNotebooks(),
		authentication: buildAuthentication(),
		l10n: buildL10n(),
		comments: buildComments(),
		env: buildEnv(s),
		extensions: buildExtensions(s),

		/** The log-level enum VS Code 1.74 added with LogOutputChannel. */
		LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
		/** `IndentAction`: the onEnter auto-indent rules (ms-python constructs them at eval). */
		IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
		ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
		TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
		TestResultState: { Queued: 1, Running: 2, Passed: 3, Failed: 4, Skipped: 5, Errored: 6 },
		QuickInputButtons: { Back: { iconPath: new ThemeIcon('arrow-left') } },
		CancellationToken: { None: CancellationTokenNone, Cancelled: CancellationTokenCancelled },
		ExtensionRuntime: { Node: 1, Webworker: 2 },
		LanguageModelChatMessageRole: { User: 1, Assistant: 2 },

		Uri, Position, Range, Selection, Location, Disposable, EventEmitter, CancellationTokenSource,
		ViewColumn, StatusBarAlignment, ConfigurationTarget, TreeItemCollapsibleState, ProgressLocation,
		UIKind, ExtensionMode, ExtensionKind, FileType, EndOfLine, OverviewRulerLane, DecorationRangeBehavior,
		LanguageStatusSeverity, TextEditorRevealType, QuickPickItemKind, DiagnosticSeverity, CompletionItemKind,
		SymbolKind, CommentThreadCollapsibleState, CodeActionKind, MarkdownString, ThemeIcon, ThemeColor,
		TreeItem, SnippetString, TextEdit, SnippetTextEdit, RelativePattern, FileSystemError, WorkspaceEdit,
		Diagnostic, DiagnosticTag, DiagnosticRelatedInformation, CompletionItem, CompletionList, CodeLens,
		DocumentLink, CodeAction, SymbolInformation, DocumentSymbol, CallHierarchyItem, CallHierarchyIncomingCall,
		CallHierarchyOutgoingCall, TypeHierarchyItem, InlayHint, InlayHintKind, InlayHintLabelPart, CancellationError,
		Hover, SignatureHelp, SignatureInformation, ParameterInformation, FoldingRange, FoldingRangeKind,
		DocumentHighlight, DocumentHighlightKind, SelectionRange, LinkedEditingRanges, EvaluatableExpression,
		InlineValueText, InlineValueVariableLookup, InlineValueEvaluatableExpression, InlineCompletionItem,
		InlineCompletionList, InlineCompletionTriggerKind, Color, ColorInformation, ColorPresentation,
		SemanticTokensLegend, SemanticTokens, SemanticTokensEdit, SemanticTokensEdits, SemanticTokensBuilder,
		DocumentDropEdit, FileDecoration, TerminalLink, TerminalProfile, DataTransfer, DataTransferItem,
		TabInputText, TabInputTextDiff, TabInputWebview, TabInputCustom, TabInputTerminal,
		NotebookCellData, NotebookData, NotebookRange, NotebookCellKind, NotebookCellOutputItem, NotebookEdit, Breakpoint, SourceBreakpoint,
		FunctionBreakpoint, DebugAdapterExecutable, DebugAdapterServer, DebugAdapterNamedPipeServer,
		DebugAdapterInlineImplementation, DebugConsoleMode, TextEditorSelectionChangeKind, TextDocumentSaveReason,
		TextDocumentChangeReason, FileChangeType, TreeItemCheckboxState, SignatureHelpTriggerKind,
		CompletionTriggerKind, CodeActionTriggerKind, CompletionItemTag, SymbolTag, TextEditorCursorStyle,
		TextEditorLineNumbersStyle, EnvironmentVariableMutatorType, CommentMode, TerminalLocation,
		TerminalExitReason, InputBoxValidationSeverity, ColorFormat, LanguageModelError,
		Task, ShellExecution, ProcessExecution, CustomExecution, TaskGroup, TaskScope, TaskRevealKind, TaskPanelKind,
		TestTag, TestMessage, TestRunRequest,

		/** Not part of VS Code's `vscode` module: the mementos and secrets the
		 *  ExtensionContext is built from (extHostBoot / nodeHost wire them in). */
		__mementos: { global: s.globalState, workspace: s.workspaceState },
		__secrets: new SecretStorage(s.bridge),
		__environment: new EnvironmentVariableCollection(s.ctx.extensionId),

		/** Not part of VS Code's `vscode` module either: the host's tree plumbing — the
		 *  frame's answer to the host calls `tree.getChildren` / `treeView.setVisible` /
		 *  `treeView.select` / `treeView.expand` / `treeView.checkbox`. */
		__serveTree: {
			children: async (viewId: string, handle: string | null): Promise<unknown[]> => {
				const registration = s.treeRegistrations.get(viewId);
				if (!registration) return [];
				try {
					return await registration.children(handle);
				} catch (error) {
					shimLog('error', `tree view ${viewId}: getChildren/getTreeItem failed: ${String(error)}`, error);
					return [];
				}
			},
			setVisible: (viewId: string, visible: boolean): void => s.treeRegistrations.get(viewId)?.setVisible(visible),
			select: (viewId: string, handles: string[]): void => s.treeRegistrations.get(viewId)?.select(handles),
			expand: (viewId: string, handle: string, expanded: boolean): void => s.treeRegistrations.get(viewId)?.expand(handle, expanded),
			checkbox: (viewId: string, handle: string, state: number): void => s.treeRegistrations.get(viewId)?.check(handle, state)
		},

		/** Not part of VS Code's `vscode` module either: the host's answer to
		 *  `editor.formatDocument` runs the registered provider over the host's text. */
		__runFormatter: async (id: string, document: { path: string; languageId: string; text: string }, options: { tabSize: number; insertSpaces: boolean }): Promise<unknown[]> => {
			const entry = s.formattingProviders.get(id);
			if (!entry) throw new Error(`no formatting provider ${id}`);
			const { state } = s.rememberDocument(document.path, document.text, document.languageId);
			const view = documentView(state, () => s.saveDocument(document.path));
			try {
				const edits = await Promise.resolve(entry.run(view, options, CancellationTokenNone));
				return (Array.isArray(edits) ? edits : []).map((edit) => {
					const value = edit as { range?: Range; newText?: string };
					return { range: value.range ? { start: { line: value.range.start.line, character: value.range.start.character }, end: { line: value.range.end.line, character: value.range.end.character } } : undefined, newText: value.newText ?? '' };
				});
			} catch (error) {
				shimLog('error', `formatting provider ${id} failed on ${document.path}: ${String(error)}`, error);
				throw error;
			}
		},

		/** GGS-patch: not part of VS Code's `vscode` module either — the completion
		 *  answer side (the host's completion UI calls this at every trigger, ranked to
		 *  the best provider for the document). Items cross serialized: the label,
		 *  kind, texts and the (optional) replacement range. */
		__serveCompletions: async (id: string, document: { path: string; languageId: string; text: string }, position: { line: number; character: number }, context: { triggerCharacter?: string }): Promise<unknown[]> => {
			const entry = s.completionProviders.get(id);
			if (!entry) throw new Error(`no completion provider ${id}`);
			const { state } = s.rememberDocument(document.path, document.text, document.languageId);
			const view = documentView(state, () => s.saveDocument(document.path));
			try {
				const items = await Promise.resolve(entry.run(view, new Position(position.line, position.character), CancellationTokenNone, { triggerCharacter: context.triggerCharacter, triggerKind: context.triggerCharacter !== undefined ? 1 : 0 }));
				return (Array.isArray(items) ? items : (items as { items?: unknown[] })?.items ?? []).map((item) => {
					const value = item as { label?: unknown; kind?: unknown; detail?: unknown; documentation?: unknown; insertText?: unknown; sortText?: unknown; filterText?: unknown; range?: Range };
					return {
						label: typeof value.label === 'object' && value.label !== null ? (value.label as { label: string }).label : value.label,
						kind: typeof value.kind === 'number' ? value.kind : undefined,
						detail: typeof value.detail === 'string' ? value.detail : undefined,
						documentation: typeof value.documentation === 'string' ? value.documentation : undefined,
						insertText: typeof value.insertText === 'string' ? value.insertText : undefined,
						sortText: typeof value.sortText === 'string' ? value.sortText : undefined,
						filterText: typeof value.filterText === 'string' ? value.filterText : undefined,
						range: value.range ? { start: { line: value.range.start.line, character: value.range.start.character }, end: { line: value.range.end.line, character: value.range.end.character } } : undefined
					};
				});
			} catch (error) {
				shimLog('error', `completion provider ${id} failed on ${document.path}: ${String(error)}`, error);
				return [];
			}
		},

		/** GGS-patch: not part of VS Code's module — the file-decoration ask side: the
		 *  host's explorer batches its paths, this answers the serializable decoration
		 *  per path (badge letter + one of VS Code's decoration colour names). */
		__serveFileDecorationsAsk: async (providerId: string, paths: string[]): Promise<Record<string, { badge: string; color?: string; tooltip?: string } | null>> => {
			const entry = s.fileDecorationProviders.get(providerId);
			if (!entry) return {};
			const answers: Record<string, { badge: string; color?: string; tooltip?: string } | null> = {};
			for (const path of paths) {
				try {
					const decoration = await Promise.resolve(entry.run(Uri.file(path), CancellationTokenNone));
					if (!decoration) {
						answers[path] = null;
						continue;
					}
					const value = decoration as { badge?: unknown; color?: unknown; tooltip?: unknown };
					const color = value.color;
					answers[path] = {
						badge: typeof value.badge === 'string' && value.badge.length > 0 ? value.badge.slice(0, 2) : '',
						color: typeof color === 'string'
							? color
							: color && typeof color === 'object' && 'id' in (color as Record<string, unknown>)
								? String((color as { id: unknown }).id)
								: undefined,
						tooltip: typeof value.tooltip === 'string' ? value.tooltip : undefined
					};
				} catch (error) {
					shimLog('error', `file decoration provider failed on ${path}: ${String(error)}`, error);
					answers[path] = null;
				}
			}
			return answers;
		},

		/** GGS-patch: the hover answer side (see editorHovers.ts): the serialized hover's
		 *  contents — a plain string or the markdown value's text — plus an optional
		 *  range. Everything exotic degrades to its string form; a null answer is no
		 *  hover. */
		__serveHover: async (id: string, document: { path: string; languageId: string; text: string }, position: { line: number; character: number }): Promise<{ contents: string[]; range?: { start: { line: number; character: number }; end: { line: number; character: number } } } | null> => {
			const entry = s.hoverProviders.get(id);
			if (!entry) return null;
			const { state } = s.rememberDocument(document.path, document.text, document.languageId);
			const view = documentView(state, () => s.saveDocument(document.path));
			try {
				const hover = await Promise.resolve(entry.run(view, new Position(position.line, position.character), CancellationTokenNone));
				if (!hover) return null;
				const value = hover as { contents?: unknown[]; range?: Range };
				const contents = (Array.isArray(value.contents) ? value.contents : []).map((entry2) => {
					if (typeof entry2 === 'string') return entry2;
					const markdown = entry2 as { value?: unknown };
					return typeof markdown?.value === 'string' ? markdown.value : String(entry2 ?? '');
				}).filter((text) => text.length > 0);
				if (contents.length === 0) return null;
				return {
					contents,
					range: value.range ? { start: { line: value.range.start.line, character: value.range.start.character }, end: { line: value.range.end.line, character: value.range.end.character } } : undefined
				};
			} catch (error) {
				shimLog('error', `hover provider ${id} failed on ${document.path}: ${String(error)}`, error);
				return null;
			}
		},

		/** GGS-patch: the definition answer side: the symbol's locations as path+range
		 *  pairs — the workbench opens the first one, the rest land in a peek. */
		__serveDefinition: async (id: string, document: { path: string; languageId: string; text: string }, position: { line: number; character: number }): Promise<{ path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number }[]> => {
			const entry = s.definitionProviders.get(id);
			if (!entry) return [];
			const { state } = s.rememberDocument(document.path, document.text, document.languageId);
			const view = documentView(state, () => s.saveDocument(document.path));
			try {
				const locations = await Promise.resolve(entry.run(view, new Position(position.line, position.character), CancellationTokenNone));
				const list = Array.isArray(locations) ? locations : (locations as { uri?: Uri; target?: Uri; range?: Range } | null ? [locations] : []);
				return (list as { uri?: unknown; target?: unknown; range?: Range }[]).map((location) => {
					const uri = (location.target ?? location.uri) as { fsPath?: string; path?: string } | undefined;
					const range = location.range;
					return {
						path: String(uri?.fsPath ?? uri?.path ?? ''),
						startLine: range?.start.line ?? 0,
						startCharacter: range?.start.character ?? 0,
						endLine: range?.end.line ?? 0,
						endCharacter: range?.end.character ?? 0
					};
				}).filter((location) => location.path.length > 0);
			} catch (error) {
				shimLog('error', `definition provider ${id} failed on ${document.path}: ${String(error)}`, error);
				return [];
			}
		},

		/** Not part of VS Code's `vscode` module either: the webview view plumbing — the
		 *  frame's answer to the host calls `webviewView.resolve` (the view's first show)
		 *  and `webviewView.setVisible` (the sidebar's view switching). */
		__serveWebviewView: {
			resolve: async (viewId: string): Promise<void> => {
				const viewProvider = s.webviewViewProviders.get(viewId);
				if (viewProvider === undefined) {
					shimLog('warn', `webview view ${viewId} was shown but no provider is registered for it`);
					return;
				}
				let view = s.webviewViews.get(viewId);
				if (view === undefined) {
					view = new WebviewView(s.bridge, s.ctx, viewId, {});
					s.webviewViews.set(viewId, view);
				}
				// Resolved already — by another frontend of the same backend (the desktop
				// window, while a remote page shows the view now): the provider resolves a
				// view once, so the page it set is re-sent to the frontend asking.
				if (view.resolved) {
					view.republish();
					return;
				}
				view.resolved = true;
				try {
					await Promise.resolve(viewProvider.resolveWebviewView(view, { state: undefined }, CancellationTokenNone));
				} catch (error) {
					shimLog('error', `resolveWebviewView(${viewId}) failed: ${String(error)}`, error);
					throw error;
				}
			},
			setVisible: (viewId: string, visible: boolean): void => s.webviewViews.get(viewId)?.setVisible(visible)
		},

		/** Deliver an event the host pushed in (see `HostEvent`); the frame's single message
		 *  listener routes here — the shim needs no other channel into itself. */
		handleHostEvent: (event: HostEvent) => {
			try {
				s.dispatchHostEvent(event);
			} catch (error) {
				shimLog('error', `host event ${event?.event} failed: ${String(error)}`, error);
			}
		}
	};
	return api;
}

export type VscodeApi = ReturnType<typeof createVscodeApi>;

/** The answer `serveHostCall` gives for a method it does not serve. */
export const UNSERVED_HOST_CALL = Symbol('unserved host call');

/** The host → extension call vocabulary every extension host serves the same way (the
 *  sandboxed frame, the real-Node host and ggs-node): tree view walks and pushes, the
 *  formatter run and the webview view resolution. One table, so no host lags the others
 *  (ggs-node answered none of these before, and its tree views stayed empty). */
export function serveHostCall(api: VscodeApi | null, method: string, args: unknown[]): unknown {
	if (api === null) return UNSERVED_HOST_CALL;
	switch (method) {
		case 'tree.getChildren':
			return api.__serveTree.children(args[0] as string, (args[1] as string | null) ?? null);
		case 'treeView.setVisible':
			api.__serveTree.setVisible(args[0] as string, args[1] as boolean);
			return undefined;
		case 'treeView.select':
			api.__serveTree.select(args[0] as string, (args[1] as string[]) ?? []);
			return undefined;
		case 'treeView.expand':
			api.__serveTree.expand(args[0] as string, args[1] as string, args[2] as boolean);
			return undefined;
		case 'treeView.checkbox':
			api.__serveTree.checkbox(args[0] as string, args[1] as string, args[2] as number);
			return undefined;
		case 'formatDocument.run': {
			const [id, doc, options] = args as [string, { path: string; languageId: string; text: string }, { tabSize: number; insertSpaces: boolean }];
			return api.__runFormatter(id, doc, options);
		}
		// GGS-patch: the language-provider run methods the host's ranked callers use
		// (completions/hover/definition/fileDecorations — editorCompletions.ts and
		// editorHovers.ts).
		case 'completion.run': {
			const [id, doc, position, context] = args as [string, { path: string; languageId: string; text: string }, { line: number; character: number }, { triggerCharacter?: string }];
			return api.__serveCompletions(id, doc, position, context);
		}
		case 'hover.run': {
			const [id, doc, position] = args as [string, { path: string; languageId: string; text: string }, { line: number; character: number }];
			return api.__serveHover(id, doc, position);
		}
		case 'definition.run': {
			const [id, doc, position] = args as [string, { path: string; languageId: string; text: string }, { line: number; character: number }];
			return api.__serveDefinition(id, doc, position);
		}
		case 'fileDecorations.ask': {
			const [{ providerId, paths }] = args as [{ providerId: string; paths: string[] }];
			return api.__serveFileDecorationsAsk(providerId, paths);
		}
		case 'webviewView.resolve':
			return api.__serveWebviewView.resolve(args[0] as string);
		case 'webviewView.setVisible':
			api.__serveWebviewView.setVisible(args[0] as string, args[1] as boolean);
			return undefined;
		default:
			return UNSERVED_HOST_CALL;
	}
}

/** The registration tables a host's own prelude serves its calls from: the command
 *  handlers the extension's shim parked in its host, the two provider registries, and
 *  the loaded package's deactivate. */
export interface HostCallTables {
	commands: Map<string, (...args: unknown[]) => unknown>;
	docProviders: Map<string, { provideTextDocumentContent?: (uri: unknown) => unknown }>;
	fsProviders: Map<string, { readFile?: (uri: unknown) => unknown }>;
	deactivate(): void;
	api: VscodeApi | null;
}

/** The host → extension calls every host answers ahead of `serveHostCall` (running a
 *  registered command handler, the two provider reads, deactivate) and the fallback into
 *  the shared table — the whole of extHostBoot's and nodeHost's `handleCall`, one
 *  definition so the frame and the real-Node host cannot drift. */
export function serveExtensionHostCall(tables: HostCallTables, method: string, args: unknown[]): unknown {
	if (method === 'runCommand') {
		const handler = tables.commands.get(String(args[0]));
		if (!handler) throw new Error(`command ${String(args[0])} is no longer registered`);
		// A menu's context crosses the wire as Uri-shaped data (the methods cannot cross the
		// clone); the handler receives them as full Uris, as VS Code delivers.
		return handler(...(rehydrateUris((args[1] as unknown[] | undefined) ?? []) as unknown[]));
	}
	if (method === 'docProvider.provide') {
		const provider = tables.docProviders.get(String((args[0] as { scheme?: unknown } | undefined)?.scheme ?? ''));
		if (!provider) throw new Error('no content provider registered for the scheme');
		return provider.provideTextDocumentContent?.(args[0]);
	}
	if (method === 'fsProvider.read') {
		const uri = rehydrateUris(args[0]) as Uri;
		const text = readLocalDocProvider(new Map(), uri, tables.fsProviders);
		if (text === null) throw new Error('no file-system provider registered for the scheme');
		return text;
	}
	if (method === 'deactivate') {
		tables.deactivate();
		return undefined;
	}
	// Tree views, the formatter run and webview views: the shared host-call table.
	const served = serveHostCall(tables.api, method, args);
	if (served !== UNSERVED_HOST_CALL) return served;
	throw new Error(`unknown extension host call: ${method}`);
}


/** The ExtensionContext VS Code hands to activate(): the mementos are the shim's persisted
 *  ones, the storage directories live under `~/.ggs/` (never inside the install directory
 *  an upgrade replaces), `secrets` and `environmentVariableCollection` are real objects.
 *  Shared by both hosts that run extension code: the sandboxed frame (extHostBoot) and the
 *  real-Node extension host (nodeHost) — one definition, so the two cannot drift. */
export function activationContext(context: HostContext, api: VscodeApi): Record<string, unknown> {
	const globalPath = context.storage?.global ?? context.extensionPath;
	const workspacePath = context.storage ? context.storage.workspace ?? undefined : context.extensionPath;
	const logPath = context.storage?.log ?? context.extensionPath;
	const asAbsolutePath = (relative: string) => `${context.extensionPath.replace(/[\\/]+$/, '')}/${relative.replace(/^\.?[\\/]/, '')}`;
	return {
		subscriptions: [] as Disposable[],
		extensionPath: context.extensionPath,
		extensionUri: Uri.file(context.extensionPath),
		extension: extensionEntry(context),
		extensionMode: ExtensionMode.Production, // neither host has a dev mode
		extensionRuntime: 1,
		globalState: api.__mementos.global,
		workspaceState: api.__mementos.workspace,
		secrets: api.__secrets,
		environmentVariableCollection: api.__environment,
		storagePath: workspacePath,
		storageUri: workspacePath === undefined ? undefined : Uri.file(workspacePath),
		globalStoragePath: globalPath,
		globalStorageUri: Uri.file(globalPath),
		logPath,
		logUri: Uri.file(logPath),
		languageModelAccessInformation: { onDidChange: silentEvent(), canSendRequest: () => undefined },
		asAbsolutePath
	};
}
