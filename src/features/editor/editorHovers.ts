// The bridge between the editor's hover tooltip / Go-to-Definition and the extensions'
// registered `vscode.languages.registerHoverProvider` / `registerDefinitionProvider`:
// a module-level provider slot the workbench fills at assembly (it owns the
// ExtensionHost), and the editor reads. Like editorCompletions.ts, no CodeMirror here.

export interface ExtensionHover {
	contents: string[];
	range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface ExtensionLocation {
	path: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

export type ExtensionHoverProvider = (path: string, languageId: string, text: string, line: number, character: number) => Promise<ExtensionHover | null>;
export type ExtensionDefinitionProvider = (path: string, languageId: string, text: string, line: number, character: number) => Promise<ExtensionLocation[]>;

/** The host that opens a definition location: the workbench's editor placement. */
export interface ExtensionDefinitionOpener {
	open(path: string, line?: number, character?: number): void;
}

let hoverProvider: ExtensionHoverProvider | null = null;
let definitionProvider: ExtensionDefinitionProvider | null = null;
let definitionOpener: ExtensionDefinitionOpener | null = null;

/** The workbench installs the tab-opener here at assembly. */
export function setExtensionDefinitionOpener(opener: ExtensionDefinitionOpener | null): void {
	definitionOpener = opener;
}

export function extensionDefinitionOpener(): ExtensionDefinitionOpener | null {
	return definitionOpener;
}

/** The workbench installs the ExtensionHost-backed providers here at assembly. */
export function setExtensionHoverProvider(fill: ExtensionHoverProvider | null): void {
	hoverProvider = fill;
}

export function setExtensionDefinitionProvider(fill: ExtensionDefinitionProvider | null): void {
	definitionProvider = fill;
}

export function hasExtensionHovers(): boolean {
	return hoverProvider !== null;
}

export function hasExtensionDefinitions(): boolean {
	return definitionProvider !== null;
}

export async function extensionHoverFor(path: string, languageId: string, text: string, line: number, character: number): Promise<ExtensionHover | null> {
	if (!hoverProvider) return null;
	try {
		return await hoverProvider(path, languageId, text, line, character);
	} catch {
		return null;
	}
}

export async function extensionDefinitionFor(path: string, languageId: string, text: string, line: number, character: number): Promise<ExtensionLocation[]> {
	if (!definitionProvider) return [];
	try {
		return await definitionProvider(path, languageId, text, line, character);
	} catch {
		return [];
	}
}
