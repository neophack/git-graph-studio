// The bridge between the workbench's completion UI and the extensions' registered
// `vscode.languages.registerCompletionItemProvider` providers: a module-level provider
// slot the workbench fills at assembly (it owns the ExtensionHost), and the completion
// sources read. Like editorDecorations.ts, the module keeps CodeMirror out of it — the
// source half lives in autocomplete.ts.

export interface ExtensionCompletion {
	label: string;
	kind?: number;
	detail?: string;
	documentation?: string;
	insertText?: string;
	sortText?: string;
	filterText?: string;
	range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export type ExtensionCompletionProvider = (path: string, languageId: string, text: string, line: number, character: number, triggerCharacter?: string) => Promise<ExtensionCompletion[]>;

let provider: ExtensionCompletionProvider | null = null;

/** The workbench installs the ExtensionHost-backed provider here at assembly. */
export function setExtensionCompletionProvider(fill: ExtensionCompletionProvider | null): void {
	provider = fill;
}

/** Whether any extension registered a completion provider (the source stays inert
 *  without one — no host round trip on a file nothing serves). */
export function hasExtensionCompletions(): boolean {
	return provider !== null;
}

export async function extensionCompletionsFor(path: string, languageId: string, text: string, line: number, character: number, triggerCharacter?: string): Promise<ExtensionCompletion[]> {
	if (!provider) return [];
	try {
		return await provider(path, languageId, text, line, character, triggerCharacter);
	} catch {
		return [];
	}
}
