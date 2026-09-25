// The editor's diagnostics store (module 12): extensions push `vscode.languages.
// createDiagnosticCollection` entries through the host, and open CodeMirror editors render
// them as squiggles with hover titles — the same visual language VS Code uses.
//
// This module is deliberately CodeMirror-free: it sits in the workbench's static import
// closure (the extension host writes into it at any moment), and pulling the editor
// library in here would put CodeMirror's ~430KB chunk back onto the first-paint path.
// The rendering half lives in `editorDiagnosticsView.ts` (loaded with the editor suite)
// and registers itself here with `setDiagnosticsRenderer`.

export interface SerializableDiagnostic {
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    severity?: number;
    message: string;
    source?: string;
    code?: string | number;
}

const byPath = new Map<string, SerializableDiagnostic[]>();

/** The renderer the editor chunk installed: refresh one file's open editors. Null until
 *  the editor library's first use — diagnostics pushed before any editor opens just sit
 *  in the store, exactly as in VS Code. */
let refreshEditors: ((key: string) => void) | null = null;

/** Diagnostics keys and editor paths agree on one spelling: forward slashes. */
export function normalizePathKey(path: string): string {
    return path.replace(/\\/g, '/');
}

/** Called once by the editor chunk: pushes for a file reach its open editors through
 *  this callback. */
export function setDiagnosticsRenderer(refresh: ((key: string) => void) | null): void {
    refreshEditors = refresh;
}

/** Replace (or add) the diagnostics of one file and refresh every open editor for it. */
export function setFileDiagnostics(path: string, diagnostics: SerializableDiagnostic[]): void {
    const key = normalizePathKey(path);
    byPath.set(key, diagnostics ?? []);
    refreshEditors?.(key);
}

/** Drop one file's diagnostics (an editor closed the file, or the collection cleared). */
export function clearFileDiagnostics(path: string): void {
    const key = normalizePathKey(path);
    byPath.delete(key);
    refreshEditors?.(key);
}

export function diagnosticsFor(path: string): SerializableDiagnostic[] {
    return byPath.get(normalizePathKey(path)) ?? [];
}
