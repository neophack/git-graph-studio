// The API's value classes: every type extension code constructs at load time
// (a destructure followed by `new`), each a real class with VS Code's own shape.

import { Location, Position, Range } from './position';
import { Uri } from './uri';
import { CompletionItemKind, DiagnosticSeverity, DocumentHighlightKind, EndOfLine, FoldingRangeKind, NotebookCellKind, SymbolKind, SymbolTag, TreeItemCheckboxState, TreeItemCollapsibleState } from './enums';

/** `CodeActionKind` is a string holder with a static hierarchy (`CodeActionKind.Refactor.Append('Inline')`). */
export class CodeActionKind {
	constructor(readonly value: string) {}
	static readonly QuickFix = new CodeActionKind('quickfix');
	static readonly Refactor = new CodeActionKind('refactor');
	static readonly RefactorExtract = new CodeActionKind('refactor.extract');
	static readonly RefactorInline = new CodeActionKind('refactor.inline');
	static readonly RefactorRewrite = new CodeActionKind('refactor.rewrite');
	static readonly Source = new CodeActionKind('source');
	static readonly SourceOrganizeImports = new CodeActionKind('source.organizeImports');
	static readonly SourceFixAll = new CodeActionKind('source.fixAll');
	static readonly Notebook = new CodeActionKind('notebook');
	append(parts: string): CodeActionKind {
		return new CodeActionKind(`${this.value}.${parts}`);
	}
	intersects(other: CodeActionKind): boolean {
		return this.value.startsWith(other.value) || other.value.startsWith(this.value);
	}
	contains(other: CodeActionKind): boolean {
		return other.value.startsWith(this.value + '.') || other.value === this.value;
	}
}
/** `MarkdownString`: appendable markdown with the trust/theme flags VS Code's renderers read. */
export class MarkdownString {
	isTrusted: boolean | { enabledCommands: string[] } | undefined;
	supportThemeIcons: boolean | undefined;
	supportHtml: boolean | undefined;
	baseUri: Uri | undefined;
	constructor(public value = '') {}
	appendText(text: string): MarkdownString {
		this.value += text;
		return this;
	}
	appendMarkdown(md: string): MarkdownString {
		this.value += md;
		return this;
	}
	appendCodeblock(code: string, language = ''): MarkdownString {
		this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
		return this;
	}
}
/** `ThemeIcon` / `ThemeColor`: references into the theme's icon set and colour table. */
export class ThemeIcon {
	static readonly File = new ThemeIcon('file');
	static readonly Folder = new ThemeIcon('folder');
	constructor(readonly id: string, readonly color?: ThemeColor) {}
}
export class ThemeColor {
	constructor(readonly id: string) {}
}
/** `TreeItem`: what a tree view provider's `getTreeItem` returns — `new TreeItem(label,
 *  state)` or `new TreeItem(resourceUri, state)`, VS Code's two constructors (the
 *  serializer, `TreeViewRegistration.children`, reads every field below). */
export class TreeItem {
	label?: string | { label: string; highlights?: [number, number][] };
	resourceUri?: Uri;
	id?: string;
	description?: string | boolean;
	tooltip?: string | MarkdownString | undefined;
	iconPath?: string | Uri | { light: string | Uri; dark: string | Uri } | ThemeIcon;
	contextValue?: string;
	command?: { command: string; title: string; arguments?: unknown[] };
	checkboxState?: TreeItemCheckboxState | { state: TreeItemCheckboxState; tooltip?: string };
	accessibilityInformation?: { label: string; role?: string };
	collapsibleState?: TreeItemCollapsibleState;
	constructor(labelOrUri?: string | { label: string; highlights?: [number, number][] } | Uri, collapsibleState?: TreeItemCollapsibleState) {
		if (labelOrUri instanceof Uri) this.resourceUri = labelOrUri;
		else if (typeof labelOrUri === 'number') this.collapsibleState = labelOrUri; // the old one-argument misuse
		else if (labelOrUri !== undefined) this.label = labelOrUri;
		if (collapsibleState !== undefined) this.collapsibleState = collapsibleState;
	}
}
/** `SnippetString`: the snippet builder's value object. */
export class SnippetString {
	constructor(public value = '') {}
	appendText(text: string): SnippetString {
		this.value += text;
		return this;
	}
	appendTabstop(number = 1): SnippetString {
		this.value += `$${number}`;
		return this;
	}
	appendPlaceholder(value: string | ((snippet: SnippetString) => unknown), number = 1): SnippetString {
		if (typeof value === 'string') this.value += `\${${number}:${value}}`;
		else {
			const inner = new SnippetString();
			value(inner);
			this.value += `\${${number}:${inner.value}}`;
		}
		return this;
	}
	appendChoice(values: string[], number = 1): SnippetString {
		this.value += `\${${number}|${values.join(',')}|}`;
		return this;
	}
	appendVariable(name: string, defaultValue?: string): SnippetString {
		this.value += defaultValue === undefined ? `\${${name}}` : `\${${name}:${defaultValue}}`;
		return this;
	}
}
/** `TextEdit`: the single-document edit (a range and its replacement text). */
export class TextEdit {
	range: Range;
	constructor(range: Range, public newText: string) {
		this.range = range;
	}
	static replace(range: Range, newText: string): TextEdit {
		return new TextEdit(range, newText);
	}
	static insert(position: Position, newText: string): TextEdit {
		return new TextEdit(new Range(position, position), newText);
	}
	static delete(range: Range): TextEdit {
		return new TextEdit(range, '');
	}
	static setEndOfLine(eol: EndOfLine): TextEdit {
		const edit = new TextEdit(new Range(new Position(0, 0), new Position(0, 0)), '');
		edit.newEol = eol;
		return edit;
	}
	newEol?: EndOfLine;
	replace(range: Range, newText: string): TextEdit {
		this.range = range;
		this.newText = newText;
		return this;
	}
}
/** `SnippetTextEdit`: an edit whose text is a snippet — applied here as its plain text
 *  (placeholders keep their default text, tab stops vanish; no snippet session). */
export class SnippetTextEdit {
	constructor(public range: Range, public snippet: SnippetString) {}
	static replace(range: Range, snippet: SnippetString): SnippetTextEdit {
		return new SnippetTextEdit(range, snippet);
	}
	static insert(position: Position, snippet: SnippetString): SnippetTextEdit {
		return new SnippetTextEdit(new Range(position, position), snippet);
	}
}
/** A snippet's plain text: `${1:default}` keeps `default`, `$1` / `${1}` vanish. */
export function snippetPlainText(snippet: string): string {
	return snippet
		.replace(/\$\{\d+:([^}]*)\}/g, '$1')
		.replace(/\$\{\d+\|([^,|]*)[^}]*\}/g, '$1')
		.replace(/\$\{?\d+\}?/g, '')
		.replace(/\\([$}\\])/g, '$1');
}
/** `RelativePattern`: a base (folder path, Uri or WorkspaceFolder) and a glob. */
export class RelativePattern {
	base: string;
	baseUri: Uri;
	constructor(base: string | Uri | { uri: Uri }, public pattern: string) {
		this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof Uri || Uri.isUri(base) ? (base as Uri) : (base as { uri: Uri }).uri;
		this.base = this.baseUri.fsPath;
	}
}
/** One operation of a WorkspaceEdit, in the order the package recorded it. */
export type WorkspaceEditOperation =
	| { kind: 'text'; uri: Uri; edit: TextEdit | SnippetTextEdit }
	| { kind: 'create'; uri: Uri; options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array } }
	| { kind: 'delete'; uri: Uri; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } }
	| { kind: 'rename'; uri: Uri; newUri: Uri; options?: { overwrite?: boolean; ignoreIfExists?: boolean } };

/** `WorkspaceEdit`: text edits and file operations across documents, applied in the order
 *  they were recorded by `workspace.applyEdit` (or carried by a CodeAction). */
export class WorkspaceEdit {
	readonly _operations: WorkspaceEditOperation[] = [];
	replace(uri: Uri, range: Range, newText: string, _metadata?: unknown): void {
		this._operations.push({ kind: 'text', uri, edit: new TextEdit(range, newText) });
	}
	insert(uri: Uri, position: Position, newText: string, _metadata?: unknown): void {
		this.replace(uri, new Range(position, position), newText);
	}
	delete(uri: Uri, range: Range, _metadata?: unknown): void {
		this.replace(uri, range, '');
	}
	has(uri: Uri): boolean {
		return this._operations.some((operation) => operation.kind === 'text' && operation.uri.toString() === uri.toString());
	}
	/** Replace every text edit of one document (`null` / `[]` clears them). The entries may
	 *  be edits or `[edit, metadata]` pairs, both VS Code spellings. */
	set(uri: Uri, edits: readonly (TextEdit | SnippetTextEdit | [TextEdit | SnippetTextEdit, unknown])[] | null | undefined): void {
		const key = uri.toString();
		for (let at = this._operations.length - 1; at >= 0; at--) {
			const operation = this._operations[at]!;
			if (operation.kind === 'text' && operation.uri.toString() === key) this._operations.splice(at, 1);
		}
		for (const entry of edits ?? []) this._operations.push({ kind: 'text', uri, edit: Array.isArray(entry) ? entry[0] : entry });
	}
	get(uri: Uri): TextEdit[] {
		const key = uri.toString();
		return this._operations.flatMap((operation) => (operation.kind === 'text' && operation.uri.toString() === key && operation.edit instanceof TextEdit ? [operation.edit] : []));
	}
	createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array }): void {
		this._operations.push({ kind: 'create', uri, options });
	}
	deleteFile(uri: Uri, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
		this._operations.push({ kind: 'delete', uri, options });
	}
	renameFile(oldUri: Uri, newUri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
		this._operations.push({ kind: 'rename', uri: oldUri, newUri, options });
	}
	/** How many resources the edit touches. */
	get size(): number {
		return new Set(this._operations.map((operation) => operation.uri.toString())).size;
	}
	entries(): [Uri, TextEdit[]][] {
		const byUri = new Map<string, [Uri, TextEdit[]]>();
		for (const operation of this._operations) {
			if (operation.kind !== 'text' || !(operation.edit instanceof TextEdit)) continue;
			const key = operation.uri.toString();
			if (!byUri.has(key)) byUri.set(key, [operation.uri, []]);
			byUri.get(key)![1].push(operation.edit);
		}
		return [...byUri.values()];
	}
}
/** `Diagnostic`: a squiggle — the shape `languages.createDiagnosticCollection` entries
 *  carry and editorDiagnostics renders. */
export enum DiagnosticTag { Unnecessary = 1, Deprecated = 2 }
export class DiagnosticRelatedInformation {
	constructor(public location: Location, public message: string) {}
}
export class Diagnostic {
	severity!: DiagnosticSeverity;
	source?: string;
	code?: string | number;
	relatedInformation?: DiagnosticRelatedInformation[];
	tags?: DiagnosticTag[];
	constructor(public range: Range, public message: string, severity?: DiagnosticSeverity) {
		this.severity = severity ?? DiagnosticSeverity.Error;
	}
}
/** `CompletionItem` and the rest of the language-feature value types: packages extend
 *  these at module-eval time (vscode-languageclient's converters do `class extends
 *  CompletionItem`), so each must be a real class, not a factory. */
export class CompletionItem {
	label: string | { label: string; detail?: string; description?: string };
	kind?: CompletionItemKind;
	tags?: readonly unknown[];
	detail?: string;
	documentation?: string | MarkdownString;
	deprecated?: boolean;
	preselect?: boolean;
	sortText?: string;
	filterText?: string;
	insertText?: string | SnippetString;
	range?: Range | { inserting: Range; replacing: Range };
	command?: unknown;
	textEdit?: TextEdit;
	additionalTextEdits?: TextEdit[];
	commitCharacters?: string[];
	keepWhitespace?: boolean;
	constructor(label: string | { label: string; detail?: string; description?: string }, kind?: CompletionItemKind) {
		this.label = label;
		this.kind = kind;
	}
}
export class CodeLens {
	command?: unknown;
	data?: unknown;
	constructor(public range: Range, command?: unknown) {
		this.command = command;
	}
}
export class DocumentLink {
	tooltip?: string;
	constructor(public range: Range, public target?: Uri) {}
}
export class CodeAction {
	edit?: WorkspaceEdit;
	diagnostics?: Diagnostic[];
	command?: unknown;
	isPreferred?: boolean;
	disabled?: { reason: string };
	constructor(public title: string, public kind?: CodeActionKind) {}
}
export class SymbolInformation {
	tags?: readonly unknown[];
	containerName?: string;
	/** `(name, kind, containerName, location)` or `(name, kind, range, uri?, containerName?)`. */
	constructor(public name: string, public kind: SymbolKind, rangeOrContainer?: Range | string, locationOrUri?: Location | Uri, containerName?: string) {
		if (rangeOrContainer instanceof Range) {
			this.location = new Location(locationOrUri instanceof Uri ? locationOrUri : Uri.parse('untitled:'), rangeOrContainer);
			this.containerName = containerName;
		} else if (typeof rangeOrContainer === 'string' && locationOrUri instanceof Location) {
			this.containerName = rangeOrContainer;
			this.location = locationOrUri;
		}
	}
	location!: Location;
}
export class CallHierarchyItem {
	tags?: readonly unknown[];
	constructor(public kind: SymbolKind, public name: string, public detail: string, public uri: Uri, public range: Range, public selectionRange: Range) {}
}
export class TypeHierarchyItem {
	tags?: readonly unknown[];
	constructor(public kind: SymbolKind, public name: string, public detail: string, public uri: Uri, public range: Range, public selectionRange: Range) {}
}
export enum InlayHintKind { Type = 1, Parameter = 2 }
export class InlayHint {
	kind?: InlayHintKind;
	tooltip?: string | MarkdownString;
	paddingLeft?: boolean;
	paddingRight?: boolean;
	textEdits?: TextEdit[];
	constructor(public position: Position, public label: string | InlayHintLabelPart[], kind?: InlayHintKind) {
		this.kind = kind;
	}
}
export class InlayHintLabelPart {
	tooltip?: string | MarkdownString;
	location?: Location;
	command?: unknown;
	constructor(public value: string) {}
	get label(): string {
		return this.value;
	}
}
/** `CancellationError`: the token's `throwIfCancellationRequested` answer. */
export class CancellationError extends Error {
	constructor() {
		super('Canceled');
		this.name = 'Canceled';
	}
}
/** `Selection`: a Range whose ends are also anchor/active. */

export class FileSystemError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
	}
	static FileNotFound(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'FileNotFound');
	}
	static FileExists(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'FileExists');
	}
	static FileNotADirectory(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'FileNotADirectory');
	}
	static FileIsADirectory(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'FileIsADirectory');
	}
	static NoPermissions(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'NoPermissions');
	}
	static Unavailable(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'Unavailable');
	}
}

/* ---------- Language-feature value classes ----------
 * Providers construct these (and language clients `extends` them at module load), so each
 * is a real class with VS Code's constructor shape — the provider hosts that would consume
 * them are not in this host, which logs the registration as unsupported. */

export class Hover {
	contents: (MarkdownString | string | { language: string; value: string })[];
	constructor(contents: MarkdownString | string | { language: string; value: string } | (MarkdownString | string | { language: string; value: string })[], public range?: Range) {
		this.contents = Array.isArray(contents) ? contents : [contents];
	}
}
export class ParameterInformation {
	constructor(public label: string | [number, number], public documentation?: string | MarkdownString) {}
}
export class SignatureInformation {
	parameters: ParameterInformation[] = [];
	activeParameter?: number;
	constructor(public label: string, public documentation?: string | MarkdownString) {}
}
export class SignatureHelp {
	signatures: SignatureInformation[] = [];
	activeSignature = 0;
	activeParameter = 0;
}
export class FoldingRange {
	constructor(public start: number, public end: number, public kind?: FoldingRangeKind) {}
}
export class DocumentSymbol {
	children: DocumentSymbol[] = [];
	tags?: readonly SymbolTag[];
	constructor(public name: string, public detail: string, public kind: SymbolKind, public range: Range, public selectionRange: Range) {}
}
export class DocumentHighlight {
	constructor(public range: Range, public kind: DocumentHighlightKind = DocumentHighlightKind.Text) {}
}
export class SelectionRange {
	constructor(public range: Range, public parent?: SelectionRange) {}
}
export class CompletionList {
	constructor(public items: CompletionItem[] = [], public isIncomplete = false) {}
}
export class CallHierarchyIncomingCall {
	constructor(public from: CallHierarchyItem, public fromRanges: Range[]) {}
}
export class CallHierarchyOutgoingCall {
	constructor(public to: CallHierarchyItem, public fromRanges: Range[]) {}
}
export class LinkedEditingRanges {
	constructor(public ranges: Range[], public wordPattern?: RegExp) {}
}
export class EvaluatableExpression {
	constructor(public range: Range, public expression?: string) {}
}
export class InlineValueText {
	constructor(public range: Range, public text: string) {}
}
export class InlineValueVariableLookup {
	constructor(public range: Range, public variableName?: string, public caseSensitiveLookup = true) {}
}
export class InlineValueEvaluatableExpression {
	constructor(public range: Range, public expression?: string) {}
}
export class InlineCompletionItem {
	constructor(public insertText: string | SnippetString, public range?: Range, public command?: unknown) {}
}
export class InlineCompletionList {
	constructor(public items: InlineCompletionItem[]) {}
}
export class Color {
	constructor(readonly red: number, readonly green: number, readonly blue: number, readonly alpha: number) {}
}
export class ColorInformation {
	constructor(public range: Range, public color: Color) {}
}
export class ColorPresentation {
	textEdit?: TextEdit;
	additionalTextEdits?: TextEdit[];
	constructor(public label: string) {}
}
export class SemanticTokensLegend {
	constructor(readonly tokenTypes: string[], readonly tokenModifiers: string[] = []) {}
}
export class SemanticTokens {
	constructor(readonly data: Uint32Array, readonly resultId?: string) {}
}
export class SemanticTokensEdit {
	constructor(readonly start: number, readonly deleteCount: number, readonly data?: Uint32Array) {}
}
export class SemanticTokensEdits {
	constructor(readonly edits: SemanticTokensEdit[], readonly resultId?: string) {}
}
/** `SemanticTokensBuilder`: the relative-encoding builder VS Code ships (tokens pushed in
 *  document order become the delta-encoded `Uint32Array`). */
export class SemanticTokensBuilder {
	private readonly data: number[] = [];
	private previousLine = 0;
	private previousCharacter = 0;
	constructor(private readonly legend?: SemanticTokensLegend) {}
	push(lineOrRange: number | Range, characterOrType: number | string, lengthOrModifiers?: number | string[], tokenType?: number, tokenModifiers = 0): void {
		let line: number;
		let character: number;
		let length: number;
		let type: number;
		let modifiers: number;
		if (typeof lineOrRange === 'number') {
			line = lineOrRange;
			character = characterOrType as number;
			length = lengthOrModifiers as number;
			type = tokenType ?? 0;
			modifiers = tokenModifiers;
		} else {
			line = lineOrRange.start.line;
			character = lineOrRange.start.character;
			length = lineOrRange.end.character - lineOrRange.start.character;
			type = Math.max(0, this.legend?.tokenTypes.indexOf(String(characterOrType)) ?? 0);
			modifiers = 0;
			for (const modifier of (lengthOrModifiers as string[] | undefined) ?? []) {
				const bit = this.legend?.tokenModifiers.indexOf(modifier) ?? -1;
				if (bit >= 0) modifiers |= 1 << bit;
			}
		}
		const deltaLine = line - this.previousLine;
		const deltaCharacter = deltaLine === 0 ? character - this.previousCharacter : character;
		this.data.push(deltaLine, deltaCharacter, length, type, modifiers);
		this.previousLine = line;
		this.previousCharacter = character;
	}
	build(resultId?: string): SemanticTokens {
		return new SemanticTokens(new Uint32Array(this.data), resultId);
	}
}
export class DocumentDropEdit {
	constructor(public insertText: string | SnippetString) {}
}
export class FileDecoration {
	constructor(public badge?: string, public tooltip?: string, public color?: ThemeColor) {}
	propagate?: boolean;
}
export class TerminalLink {
	constructor(public startIndex: number, public length: number, public tooltip?: string) {}
}
export class TerminalProfile {
	constructor(public options: unknown) {}
}
export class DataTransferItem {
	constructor(readonly value: unknown) {}
	async asString(): Promise<string> {
		return typeof this.value === 'string' ? this.value : JSON.stringify(this.value);
	}
	asFile(): undefined {
		return undefined;
	}
}
export class DataTransfer {
	private readonly items = new Map<string, DataTransferItem>();
	get(mimeType: string): DataTransferItem | undefined {
		return this.items.get(mimeType.toLowerCase());
	}
	set(mimeType: string, value: DataTransferItem): void {
		this.items.set(mimeType.toLowerCase(), value);
	}
	forEach(callback: (item: DataTransferItem, mimeType: string, transfer: DataTransfer) => void): void {
		for (const [mime, item] of this.items) callback(item, mime, this);
	}
	*[Symbol.iterator](): IterableIterator<[string, DataTransferItem]> {
		yield* this.items;
	}
}
/** The Tabs API's input shapes (`tab.input instanceof TabInputText`). */
export class TabInputText {
	constructor(readonly uri: Uri) {}
}
export class TabInputTextDiff {
	constructor(readonly original: Uri, readonly modified: Uri) {}
}
export class TabInputWebview {
	constructor(readonly viewType: string) {}
}
export class TabInputCustom {
	constructor(readonly uri: Uri, readonly viewType: string) {}
}
export class TabInputTerminal {}
export class NotebookCellData {
	outputs?: unknown[];
	metadata?: Record<string, unknown>;
	constructor(public kind: NotebookCellKind, public value: string, public languageId: string) {}
}
export class NotebookData {
	metadata?: Record<string, unknown>;
	constructor(public cells: NotebookCellData[]) {}
}
/** An output item of a notebook cell. Value types are inert here — the notebooks the
 *  host does not render natively still let packages construct and pass them. */
export class NotebookCellOutputItem {
	constructor(public data: Uint8Array, public mime: string) {}
	static bytes(data: Uint8Array, mime: string): NotebookCellOutputItem {
		return new NotebookCellOutputItem(data, mime);
	}
	static stdout(text: string): NotebookCellOutputItem {
		return NotebookCellOutputItem.bytes(new TextEncoder().encode(text), 'application/vnd.code.notebook.stdout');
	}
	static stderr(text: string): NotebookCellOutputItem {
		return NotebookCellOutputItem.bytes(new TextEncoder().encode(text), 'application/vnd.code.notebook.stderr');
	}
	static error(err: Error): NotebookCellOutputItem {
		return NotebookCellOutputItem.bytes(
			new TextEncoder().encode(JSON.stringify({ name: err.name, message: err.message, stack: err.stack ?? '' })),
			'application/vnd.code.notebook.error',
		);
	}
	static json(value: unknown, mime2?: string): NotebookCellOutputItem {
		return NotebookCellOutputItem.bytes(
			Buffer.from(JSON.stringify(value, undefined, '\t')),
			mime2 ?? 'text/x-json',
		);
	}
	static text(text: string, mime2: string): NotebookCellOutputItem {
		return NotebookCellOutputItem.bytes(new TextEncoder().encode(text), mime2);
	}
}
export class NotebookEdit {
	constructor(public index: number, public cells: NotebookCellData[]) {}
	static replaceCells(index: number, cells: NotebookCellData[]): NotebookEdit {
		return new NotebookEdit(index, cells);
	}
	static insertCells(index: number, cells: NotebookCellData[]): NotebookEdit {
		return new NotebookEdit(index, cells);
	}
	static deleteCells(index: number, count: number): NotebookEdit {
		void count;
		return new NotebookEdit(index, []);
	}
	static updateCellMetadata(index: number, newCellMetadata: Record<string, unknown>): NotebookEdit {
		const edit = new NotebookEdit(index, []);
		edit.newCellMetadata = newCellMetadata;
		return edit;
	}
	newCellMetadata?: Record<string, unknown>;
}
export class NotebookRange {
	constructor(readonly start: number, readonly end: number) {}
	get isEmpty(): boolean {
		return this.start === this.end;
	}
}
export class Breakpoint {
	readonly id = `bp-${Math.random().toString(36).slice(2)}`;
	constructor(readonly enabled = true, readonly condition?: string, readonly hitCondition?: string, readonly logMessage?: string) {}
}
export class SourceBreakpoint extends Breakpoint {
	constructor(readonly location: Location, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string) {
		super(enabled, condition, hitCondition, logMessage);
	}
}
export class FunctionBreakpoint extends Breakpoint {
	constructor(readonly functionName: string, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string) {
		super(enabled, condition, hitCondition, logMessage);
	}
}
export class DebugAdapterExecutable {
	constructor(readonly command: string, readonly args: string[] = [], readonly options?: unknown) {}
}
export class DebugAdapterServer {
	constructor(readonly port: number, readonly host?: string) {}
}
export class DebugAdapterNamedPipeServer {
	constructor(readonly path: string) {}
}
export class DebugAdapterInlineImplementation {
	constructor(readonly implementation: unknown) {}
}
export class CommentThreadState {}
export class LanguageModelError extends Error {}

/* ---------- The tasks value classes (the `tasks` namespace serves them inertly) ---------- */

export class ShellExecution {
	constructor(readonly commandLine: string | { command: string; args: string[] }, readonly options?: unknown) {}
}
export class ProcessExecution {
	constructor(readonly process: string, readonly args?: string[], readonly options?: unknown) {}
}
export class CustomExecution {
	constructor(readonly callback: unknown) {}
}
export class TaskGroup {
	static readonly Clean = new TaskGroup('clean');
	static readonly Build = new TaskGroup('build');
	static readonly Rebuild = new TaskGroup('rebuild');
	static readonly Test = new TaskGroup('test');
	static readonly None = new TaskGroup('none');
	constructor(readonly id: string) {}
	isDefault = false;
}
export const TaskScope = { Global: 1, Workspace: 2 } as const;
export type TaskScope = (typeof TaskScope)[keyof typeof TaskScope];
export const TaskRevealKind = { Always: 0, Silent: 1, Never: 2 } as const;
export const TaskPanelKind = { Shared: 1, Dedicated: 2, New: 3 } as const;
export class Task {
	constructor(readonly definition: { type: string; [key: string]: unknown }, readonly scope: TaskScope | unknown, readonly name: string, readonly source: string, readonly execution?: unknown, readonly problemMatchers?: string[]) {}
	isBackground = false;
	detail: string | undefined;
	group: TaskGroup | undefined;
}

/* ---------- Shared shapes the API below is typed against ---------- */

/** VS Code's MessageItem: an object-shaped message button (`{ title, isCloseAffordance }`). */
export interface MessageItem {
	title: string;
	isCloseAffordance?: boolean;
}

/** The object shape of a quick pick entry (`label` plus optional `description` / `detail`). */
export interface QuickPickItem {
	label: string;
	description?: string;
	detail?: string;
	picked?: boolean;
	alwaysShow?: boolean;
}

/* ---------- Configuration ---------- */


/** `vscode.ConfigurationChangeEvent`: which settings a change touched. */
