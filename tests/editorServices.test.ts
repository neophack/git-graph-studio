// The editor services the two marketplace-polish features run on: the diagnostics store
// (extension pushes land as editor squiggles) and the document-formatting registry
// (a frame's formatting provider runs over the host's text, the edits land back in the
// open editor). The frame half is exercised for real: the extension's code is booted
// through the same __studioExtInit the host sends, then format requests cross the bridge.

import { describe, expect, it } from 'vitest';
import { ExtensionHost, type ExtInfo } from '../src/extHost';
import { clearFileDiagnostics, diagnosticsFor, setFileDiagnostics } from '../src/editorDiagnostics';
import { backend } from './tauriMock';
import '../src/extHostBoot';
import { flush } from './helpers';

const INFO: ExtInfo = {
	id: 'acme.formatter', name: 'formatter', displayName: 'Formatter', publisher: 'acme', version: '1.0.0', description: '',
	builtin: false, icon: null, path: '/ext/acme.formatter-1.0.0', categories: [], keywords: [], repository: null,
	license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null,
	format: 'vsix', capabilities: null
};

const FORMATTER_SOURCE = "const vscode = require('vscode'); exports.activate = () => { vscode.languages.registerDocumentFormattingEditProvider('python', { provideDocumentFormattingEdits: (document) => [{ range: { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } }, newText: document.getText().toUpperCase() }] }); };";

describe('the diagnostics store', () => {
	it('keeps per-file diagnostics and answers them for the editor', () => {
		setFileDiagnostics('C:/ws/a.py', [
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, severity: 0, message: 'bad' },
			{ range: { start: { line: 2, character: 1 }, end: { line: 2, character: 6 } }, severity: 1, message: 'meh' }
		]);
		const diags = diagnosticsFor('C:/ws/a.py');
		expect(diags).toHaveLength(2);
		expect(diags[0]!.severity).toBe(0);
		clearFileDiagnostics('C:/ws/a.py');
		expect(diagnosticsFor('C:/ws/a.py')).toHaveLength(0);
	});
});

describe('document formatting through the frame', () => {
	it('boots a real formatting extension and routes editor.formatDocument to it', async () => {
		withExtensions(INFO);
		backend.on('ext_read_file', ({ relPath }) => {
			if (relPath === 'package.json') return JSON.stringify({ main: './formatter.js' });
			if (relPath === 'formatter.js') return FORMATTER_SOURCE;
			throw new Error('no such file');
		});
		const host = new ExtensionHost();
		await host.activateInstalled();
		// jsdom never executes the sandboxed iframe; host the frame on the test window so
		// the boot module (imported here) receives the init and the host's frameFor
		// resolves every message the frame posts (its source is this window).
		// jsdom never executes the sandboxed iframe: point the handle's frame at the test
		// window, so the boot module (imported here) receives the init and boots the real
		// extension code in-process.
		const handle = {
			frame: { contentWindow: window } as unknown as HTMLIFrameElement,
			commandIds: new Set<string>(),
			pendingCalls: new Set<(error: Error) => void>(),
			send: (message: unknown) => {
				window.dispatchEvent(new MessageEvent('message', { data: message }));
			}
		};
		host['frames'].set('acme.formatter', handle);
		// The vitest jsdom window is a proxy: postMessage's event.source never equals it,
		// so route the host's frame lookups to the fake handle explicitly.
		host['frameFor'] = () => handle;
		// Boot the frame code through the same init the host sends: the real formatter
		// source registers its provider through the bridge (the host stores it).
		window.dispatchEvent(new MessageEvent('message', {
			source: window,
			data: {
				type: '__studioExtInit',
				context: { extensionId: INFO.id, extensionPath: INFO.path, workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/acme.formatter-1.0.0/', state: { global: {}, workspace: {} } },
				files: { 'package.json': JSON.stringify({ main: './formatter.js' }), 'formatter.js': FORMATTER_SOURCE }
			}
		}));
		await flush();
		// The registration RPC is a macrotask (postMessage): let it land.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(host['formattingProviders'].has('acme.formatter')).toBe(true);

		const applied: { startLine: number; newText: string }[] = [];
		host.onApplyEdits = (_path, edits) => {
			for (const edit of edits) applied.push({ startLine: edit.startLine, newText: edit.newText });
			return true;
		};
		const formatted = await host.formatDocument('C:/ws/a.py', 'python', 'print("hi")\n', 4, true);
		expect(formatted).toBe(true);
		expect(applied).toHaveLength(1);
		expect(applied[0]!.startLine).toBe(1);
		expect(applied[0]!.newText).toBe('PRINT("HI")\n');
	});

	it('answers false when no provider matches the language', async () => {
		withExtensions(INFO);
		const host = new ExtensionHost();
		await host.activateInstalled();
		const formatted = await host.formatDocument('C:/ws/a.md', 'markdown', '# hi', 4, true);
		expect(formatted).toBe(false);
	});
});

function withExtensions(...extensions: ExtInfo[]): void {
	backend.on('ext_list', () => extensions);
}
