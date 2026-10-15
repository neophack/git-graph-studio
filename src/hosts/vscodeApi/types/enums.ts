// The enums and const objects extension code destructures off `require('vscode')`.

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 } as const;
export type ViewColumn = (typeof ViewColumn)[keyof typeof ViewColumn];
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum UIKind { Desktop = 1, Web = 2 }
export enum TextEditorSelectionChangeKind { Keyboard = 1, Mouse = 2, Command = 3 }
export enum TextDocumentSaveReason { Manual = 1, AfterDelay = 2, FocusOut = 3 }
export enum TextDocumentChangeReason { Undo = 1, Redo = 2 }
export enum FileChangeType { Changed = 1, Created = 2, Deleted = 3 }
export enum TreeItemCheckboxState { Unchecked = 0, Checked = 1 }
export enum DocumentHighlightKind { Text = 0, Read = 1, Write = 2 }
export enum FoldingRangeKind { Comment = 1, Imports = 2, Region = 3 }
export enum SignatureHelpTriggerKind { Invoke = 1, TriggerCharacter = 2, ContentChange = 3 }
export enum CompletionTriggerKind { Invoke = 0, TriggerCharacter = 1, TriggerForIncompleteCompletions = 2 }
export enum CodeActionTriggerKind { Invoke = 1, Automatic = 2 }
export enum InlineCompletionTriggerKind { Invoke = 0, Automatic = 1 }
export enum CompletionItemTag { Deprecated = 1 }
export enum SymbolTag { Deprecated = 1 }
export enum TextEditorCursorStyle { Line = 1, Block = 2, Underline = 3, LineThin = 4, BlockOutline = 5, UnderlineThin = 6 }
export enum TextEditorLineNumbersStyle { Off = 0, On = 1, Relative = 2, Interval = 3 }
export enum EnvironmentVariableMutatorType { Replace = 1, Append = 2, Prepend = 3 }
export enum NotebookCellKind { Markup = 1, Code = 2 }
export enum CommentMode { Editing = 0, Preview = 1 }
export enum TerminalLocation { Panel = 1, Editor = 2 }
export enum TerminalExitReason { Unknown = 0, Shutdown = 1, Process = 2, User = 3, Extension = 4 }
export enum InputBoxValidationSeverity { Info = 1, Warning = 2, Error = 3 }
export enum DebugConsoleMode { Separate = 0, MergeWithParent = 1 }
export enum ColorFormat { RGB = 0, HEX = 1, HSL = 2 }
/** The enums and value classes extension code constructs at load time (a destructure off
 *  `require('vscode')` followed by `new`), each with VS Code's own shape — absent exports
 *  would be `undefined` and the `new` would kill the activation. */
export enum ExtensionMode { Development = 1, Test = 2, Production = 3 }
export enum ExtensionKind { UI = 1, Workspace = 2 }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum EndOfLine { LF = 1, CRLF = 2 }
export enum OverviewRulerLane { Left = 1, Center = 2, Right = 4, Full = 7 }
/** `DecorationRangeBehavior`: how a decoration's ranges grow as the document is edited
 *  (cspell's spell-issue decorations construct with `ClosedClosed`). */
export enum DecorationRangeBehavior { OpenOpen = 0, ClosedClosed = 1, OpenClosed = 2, ClosedOpen = 3 }
/** `LanguageStatusSeverity`: the `LanguageStatusItem.severity` values. */
export enum LanguageStatusSeverity { Information = 0, Warning = 1, Error = 2 }
export enum TextEditorRevealType { Default = 0, InCenter = 1, InCenterIfOutsideViewport = 2, AtTop = 3, InCenterIfOutsideViewportPreserveScroll = 4 }
export enum QuickPickItemKind { Separator = -1, Default = 0 }
export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }
export enum CompletionItemKind { Text = 0, Method = 1, Function = 2, Constructor = 3, Field = 4, Variable = 5, Class = 6, Interface = 7, Module = 8, Property = 9, Unit = 10, Value = 11, Enum = 12, Keyword = 13, Snippet = 14, Color = 15, File = 16, Reference = 17, Folder = 18, EnumMember = 19, Constant = 20, Struct = 21, Event = 22, Operator = 23, TypeParameter = 24, User = 25, Issue = 26 }
export enum SymbolKind { File = 0, Module = 1, Namespace = 2, Package = 3, Class = 4, Method = 5, Property = 6, Field = 7, Constructor = 8, Enum = 9, Interface = 10, Function = 11, Variable = 12, Constant = 13, String = 14, Number = 15, Boolean = 16, Array = 17, Object = 18, Key = 19, Null = 20, EnumMember = 21, Struct = 22, Event = 23, Operator = 24, TypeParameter = 25 }
export enum CommentThreadCollapsibleState { Collapsed = 0, Expanded = 1 }
