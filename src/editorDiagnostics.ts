// The editor's diagnostics surface (module 12): extensions push `vscode.languages.
// createDiagnosticCollection` entries through the host, and open CodeMirror editors render
// them as squiggles with hover titles — the same visual language VS Code uses.
//
// The store here is the meeting point: the extension host writes into it (`setFileDiagnostics`,
// from the frame's `diagnostics.set` RPC), and every registered editor view for that file
// re-renders immediately. Positions cross as VS Code's zero-based line/character pairs and
// convert to CodeMirror offsets against the live document at render time, so a diagnostics
// push never needs the document itself.

import { setDiagnostics } from '@codemirror/lint';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

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

/** One registered editor view plus the file it renders. */
interface ViewEntry {
    path: string;
    view: EditorView;
}

const views = new Set<ViewEntry>();
const byPath = new Map<string, SerializableDiagnostic[]>();

/** Diagnostics keys and editor paths agree on one spelling: forward slashes. */
export function normalizePathKey(path: string): string {
    return path.replace(/\\/g, '/');
}

/** Replace (or add) the diagnostics of one file and refresh every open editor for it. */
export function setFileDiagnostics(path: string, diagnostics: SerializableDiagnostic[]): void {
    const key = normalizePathKey(path);
    byPath.set(key, diagnostics ?? []);
    for (const entry of views) {
        if (sameFile(entry.path, key)) queuePush(entry.view, key);
    }
}

/** Drop one file's diagnostics (an editor closed the file, or the collection cleared). */
export function clearFileDiagnostics(path: string): void {
    const key = normalizePathKey(path);
    byPath.delete(key);
    for (const entry of views) {
        if (sameFile(entry.path, key)) queuePush(entry.view, key);
    }
}

export function diagnosticsFor(path: string): SerializableDiagnostic[] {
    return byPath.get(normalizePathKey(path)) ?? [];
}

/** The CodeMirror extension one file editor includes: it registers the view for pushes and
 *  keeps the marks in sync across document edits (offsets are recomputed per render). */
export function diagnosticsExtension(path: string): Extension {
    const key = normalizePathKey(path);
    const entry: ViewEntry = {
        path: key,
        view: null as unknown as EditorView
    };
    const plugin = ViewPlugin.fromClass(class {
        constructor(view: EditorView) {
            entry.view = view;
            views.add(entry);
            queuePush(view, key);
        }
        update(update: ViewUpdate): void {
            entry.view = update.view;
            if (update.docChanged || update.geometryChanged) queuePush(update.view, key);
        }
        destroy(): void {
            views.delete(entry);
        }
    });
    return plugin;
}

function sameFile(a: string, b: string): boolean {
    return normalizePathKey(a) === normalizePathKey(b);
}

function pushTo(view: EditorView, path: string): void {
    const diagnostics = byPath.get(normalizePathKey(path)) ?? [];
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(diagnostics, view.state.doc)));
}

/** Pushes scheduled past the current update: `view.dispatch` inside an update is forbidden. */
function queuePush(view: EditorView, path: string): void {
    setTimeout(() => pushTo(view, path), 0);
}

/** VS Code diagnostics → CodeMirror lint diagnostics against one document. */
function toCmDiagnostics(diagnostics: SerializableDiagnostic[], doc: { lines: number; lineAt(n: number): { from: number; to: number }; length: number }): CmDiagnostic[] {
    const out: CmDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
        try {
            const from = offsetOf(doc, diagnostic.range.start);
            const to = Math.max(from, offsetOf(doc, diagnostic.range.end));
            out.push({
                from,
                to,
                severity: severityOf(diagnostic.severity),
                message: diagnostic.message,
                ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {})
            });
        } catch {
            // A range past the document's end clips away: diagnostics are advisory.
        }
    }
    return out;
}

interface CmDiagnostic {
    from: number;
    to: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
    source?: string;
}

function offsetOf(doc: { lines: number; lineAt(n: number): { from: number; to: number }; length: number }, position: { line: number; character: number }): number {
    const lineNumber = Math.max(1, Math.min((position.line ?? 0) + 1, doc.lines));
    const line = doc.lineAt(lineNumber);
    return Math.min(line.from + Math.max(0, position.character ?? 0), line.to);
}

function severityOf(severity: number | undefined): 'error' | 'warning' | 'info' {
    // VS Code: 0 Error, 1 Warning, 2 Information, 3 Hint.
    if (severity === 0) return 'error';
    if (severity === 1) return 'warning';
    return 'info';
}
