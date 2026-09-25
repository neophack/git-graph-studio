// The editor's diagnostics surface, CodeMirror half (loaded with the editor suite — see
// editorDiagnostics.ts for the store half this renders from): every registered view for a
// file re-renders on a push, marks stay in sync across document edits (offsets are
// recomputed per render), and positions cross as VS Code's zero-based line/character
// pairs converted to CodeMirror offsets against the live document.

import { setDiagnostics } from '@codemirror/lint';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { diagnosticsFor, normalizePathKey, setDiagnosticsRenderer, type SerializableDiagnostic } from './editorDiagnostics';

/** One registered editor view plus the file it renders. */
interface ViewEntry {
    path: string;
    view: EditorView;
}

const views = new Set<ViewEntry>();

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
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(diagnosticsFor(path), view.state.doc)));
}

/** Pushes scheduled past the current update: `view.dispatch` inside an update is forbidden. */
function queuePush(view: EditorView, path: string): void {
    setTimeout(() => pushTo(view, path), 0);
}

/** Refresh every open view of one file — the store's pushes land here. */
function refreshPath(key: string): void {
    for (const entry of views) {
        if (sameFile(entry.path, key)) queuePush(entry.view, key);
    }
}

/** The store (in the static closure) hands pushes here, so a diagnostics RPC reaches the
 *  open views without dragging CodeMirror into the first-paint bundle. */
setDiagnosticsRenderer(refreshPath);

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
