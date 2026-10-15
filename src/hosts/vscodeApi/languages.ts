// The `languages` namespace: the diagnostics registry, the language-feature
// providers this host really serves (formatting, completions, hover, definition,
// file decorations) and the inert registrations for the rest, plus the selector
// matcher the provider routing shares.

import { Disposable } from './types/events';
import type { CancellationToken } from './types/events';
import { Position, Range } from './types/position';
import { Uri, rehydrateUris } from './types/uri';
import { plainSelector, serializeDiagnostic, watcherGlobMatches } from './util';
import { documentKey } from './documents';
import { inert, unsupported } from './inert';
import { shimLog } from './shimLog';
import type { ShimState } from './state';

/** A document selector's score for a document — VS Code's rules: a string matches the
 *  language (`*` everything); a filter's `language`, `scheme` and `pattern` must all match
 *  where declared; an array takes the best entry. */
export function selectorScore(selector: unknown, document: { languageId?: string; uri?: Uri; fileName?: string } | undefined): number {
	const scoreOne = (entry: unknown): number => {
		if (typeof entry === 'string') return entry === '*' ? 5 : entry === document?.languageId ? 10 : 0;
		if (entry === null || typeof entry !== 'object') return 0;
		const filter = entry as { language?: string; scheme?: string; pattern?: string | { pattern?: string; baseUri?: Uri; base?: string } };
		let score = 0;
		if (filter.language !== undefined) {
			if (filter.language === '*') score = Math.max(score, 5);
			else if (filter.language === document?.languageId) score = 10;
			else return 0;
		}
		if (filter.scheme !== undefined) {
			const scheme = document?.uri?.scheme ?? 'file';
			if (filter.scheme === '*') score = Math.max(score, 5);
			else if (filter.scheme === scheme) score = Math.max(score, 10);
			else return 0;
		}
		if (filter.pattern !== undefined) {
			const path = documentKey(document?.uri?.fsPath ?? document?.fileName ?? '');
			const pattern = typeof filter.pattern === 'string' ? filter.pattern : filter.pattern.pattern ?? '';
			const base = typeof filter.pattern === 'string' ? '' : documentKey(filter.pattern.baseUri?.fsPath ?? filter.pattern.base ?? '');
			const relative = base !== '' && path.toLowerCase().startsWith(base.toLowerCase() + '/') ? path.slice(base.length + 1) : path;
			const matches = watcherGlobMatches(pattern, relative) || watcherGlobMatches(pattern.startsWith('**/') ? pattern : `**/${pattern}`, relative.replace(/^\//, ''));
			if (!matches) return 0;
			score = Math.max(score, 10);
		}
		return score;
	};
	const selectors = Array.isArray(selector) ? selector : [selector];
	return Math.max(0, ...selectors.map(scoreOne));
}

export function buildLanguages(s: ShimState) {
	/** A language-feature provider registration this host has no consumer for. */
	const provider = (name: string) => (..._args: unknown[]) => inert(`languages.${name}`);

	/** One registered formatter (document or range) behind an id the host routes by. */
	function registerFormatter(selector: unknown, run: (document: Record<string, unknown>, options: unknown, token: CancellationToken) => unknown): Disposable {
		// VS Code selectors arrive as strings (`'python'`) or document filters
		// (`{ language, scheme, pattern }`) — normalized to filter objects for the host match.
		const selectors = (Array.isArray(selector) ? selector : [selector]).map((entry) => (typeof entry === 'string' ? { language: entry } : entry));
		const id = `fmt-${++s.formatterSeq}`;
		s.formattingProviders.set(id, { selectors, run });
		s.send('languages.registerFormatting', [{ id, selectors: selectors.map(plainSelector) }]);
		return new Disposable(() => {
			s.formattingProviders.delete(id);
			s.send('languages.unregisterFormatting', [{ id }]);
		});
	}

	return {
			getLanguages: async () => ['bat', 'c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript', 'json', 'jsonc', 'kotlin', 'lua', 'markdown', 'php', 'plaintext', 'powershell', 'python', 'ruby', 'rust', 'scss', 'shellscript', 'sql', 'swift', 'typescript', 'typescriptreact', 'javascriptreact', 'xml', 'yaml'],
			setTextDocumentLanguage: async (document: { uri?: Uri; fileName?: string }, languageId: string) => {
				const path = document.uri ? s.hostPathOf(document.uri) : String(document.fileName ?? '');
				const state = s.documents.get(documentKey(path));
				if (state) state.languageId = languageId;
				return s.makeTextDocument(path);
			},
			/** `createLanguageStatusItem`: a mutable value; no status surface renders it. */
			createLanguageStatusItem: (id: string, selector: unknown) => {
				unsupported('languages.createLanguageStatusItem', 'language status items are not rendered');
				return {
					id, name: undefined as string | undefined, selector, text: '', detail: undefined as string | undefined,
					kind: 1 as never, command: undefined as unknown, busy: false, severity: 0 as never,
					accessibilityInformation: undefined as unknown, dispose: () => undefined
				};
			},
			onDidChangeDiagnostics: s.diagnosticsChanged.event,
			/** With a Uri, that document's diagnostics across every collection (empty when
			 *  none); without, every `[Uri, diagnostics]` pair. */
			getDiagnostics: (uri?: Uri | string): unknown => {
				if (uri !== undefined) {
					const key = (typeof uri === 'string' ? Uri.file(uri) : uri).toString();
					return [...s.diagnosticCollections].flatMap((collection) => collection.get(key)?.diagnostics ?? []);
				}
				const byUri = new Map<string, [Uri, unknown[]]>();
				for (const collection of s.diagnosticCollections) {
					for (const [key, entry] of collection) {
						if (!byUri.has(key)) byUri.set(key, [entry.uri, []]);
						byUri.get(key)![1].push(...entry.diagnostics);
					}
				}
				return [...byUri.values()];
			},
			match: (selector: unknown, document: { languageId?: string; uri?: Uri; fileName?: string } | undefined) => selectorScore(selector, document),
			/** A diagnostic collection keyed by the document Uri; every change re-renders the
			 *  document's squiggles through the host's `diagnostics.set`. */
			createDiagnosticCollection: (name?: string) => {
				const entries = new Map<string, { uri: Uri; diagnostics: unknown[] }>();
				s.diagnosticCollections.add(entries);
				const toUri = (value: Uri | string) => (typeof value === 'string' ? Uri.file(value) : value instanceof Uri ? value : (rehydrateUris(value) as Uri));
				const push = (uri: Uri) => {
					const diagnostics = entries.get(uri.toString())?.diagnostics ?? [];
					s.send('diagnostics.set', [s.ctx.extensionId, s.hostPathOf(uri), diagnostics.map(serializeDiagnostic)]);
				};
				const changed = (uris: Uri[]) => s.diagnosticsChanged.fire({ uris });
				const collection = {
					name: name ?? 'collection',
					set: (uriOrEntries: Uri | string | readonly [Uri, readonly unknown[] | undefined][], diagnostics?: readonly unknown[] | null) => {
						const touched: Uri[] = [];
						if (Array.isArray(uriOrEntries)) {
							for (const [uri, list] of uriOrEntries as [Uri, readonly unknown[] | undefined][]) {
								const target = toUri(uri);
								if (list === undefined) entries.delete(target.toString());
								else entries.set(target.toString(), { uri: target, diagnostics: [...(entries.get(target.toString())?.diagnostics ?? []), ...list] });
								touched.push(target);
							}
						} else {
							const target = toUri(uriOrEntries as Uri | string);
							if (diagnostics === undefined || diagnostics === null) entries.delete(target.toString());
							else entries.set(target.toString(), { uri: target, diagnostics: [...diagnostics] });
							touched.push(target);
						}
						for (const uri of touched) push(uri);
						changed(touched);
					},
					delete: (uri: Uri | string) => {
						const target = toUri(uri);
						entries.delete(target.toString());
						push(target);
						changed([target]);
					},
					clear: () => {
						const uris = [...entries.values()].map((entry) => entry.uri);
						entries.clear();
						for (const uri of uris) push(uri);
						changed(uris);
					},
					/** VS Code's callback order: `(uri, diagnostics, collection)`. */
					forEach: (callback: (uri: Uri, diagnostics: readonly unknown[], collection: unknown) => unknown, thisArg?: unknown) => {
						for (const entry of [...entries.values()]) callback.call(thisArg, entry.uri, entry.diagnostics, collection);
					},
					// VS Code answers an empty list (never undefined) for a document with none.
					get: (uri: Uri | string) => [...(entries.get(toUri(uri).toString())?.diagnostics ?? [])],
					has: (uri: Uri | string) => entries.has(toUri(uri).toString()),
					dispose: () => {
						collection.clear();
						s.diagnosticCollections.delete(entries);
					},
					[Symbol.iterator]: function* () {
						for (const entry of entries.values()) yield [entry.uri, entry.diagnostics] as [Uri, unknown[]];
					}
				};
				return collection;
			},
			registerDocumentFormattingEditProvider: (selector: unknown, formatter: { provideDocumentFormattingEdits: (document: unknown, options: unknown, token: unknown) => unknown }) =>
				registerFormatter(selector, (document, options, token) => formatter.provideDocumentFormattingEdits(document, options, token)),
			/** A range formatter serves whole-document formatting over the full range (the
			 *  host's Format Document is the only formatting entry point). */
			registerDocumentRangeFormattingEditProvider: (selector: unknown, formatter: { provideDocumentRangeFormattingEdits: (document: unknown, range: Range, options: unknown, token: unknown) => unknown }) =>
				registerFormatter(selector, (document, options, token) => {
					const lineCount = Number(document.lineCount) || 1;
					const last = (document.lineAt as (line: number) => { text: string })(lineCount - 1);
					return formatter.provideDocumentRangeFormattingEdits(document, new Range(0, 0, lineCount - 1, last.text.length), options, token);
				}),
			registerCompletionItemProvider: (selector: unknown, provider: { provideCompletionItems?: (document: unknown, position: unknown, token: unknown, context: unknown) => unknown }, ...triggerCharacters: string[]) => {
				if (typeof provider?.provideCompletionItems !== 'function') {
					return inert('languages.registerCompletionItemProvider');
				}
				// GGS-patch: real completion providers. The workbench's completion UI calls
				// over at every trigger (see editorCompletions.ts); the frame answers with
				// serialized items. Trigger characters register with the declaration, as
				// VS Code's signature carries them.
				const selectors = (Array.isArray(selector) ? selector : [selector]).map((entry) => (typeof entry === 'string' ? { language: entry } : entry));
				const id = `cmp-${++s.formatterSeq}`;
				const triggers = triggerCharacters.filter((c) => typeof c === 'string');
				s.completionProviders.set(id, { selectors, triggerCharacters: triggers, run: provider.provideCompletionItems.bind(provider) });
				s.send('languages.registerCompletion', [{ id, selectors: selectors.map(plainSelector), triggerCharacters: triggers }]);
				return new Disposable(() => {
					s.completionProviders.delete(id);
					s.send('languages.unregisterCompletion', [{ id }]);
				});
			},
			registerInlineCompletionItemProvider: provider('registerInlineCompletionItemProvider'),
			registerHoverProvider: (selector: unknown, provider: { provideHover?: (document: unknown, position: unknown, token: unknown) => unknown }) => {
				// GGS-patch: real hover providers — the editor's hover tooltip calls over
				// (see editorHovers.ts), the frame answers with serialized hover contents.
				// A provider without the method degrades to an inert registration (the
				// Open VSX posture: a foreign extension's shape mistake never throws).
				if (typeof provider?.provideHover !== 'function') {
					return inert('languages.registerHoverProvider');
				}
				const selectors = (Array.isArray(selector) ? selector : [selector]).map((entry) => (typeof entry === 'string' ? { language: entry } : entry));
				const id = `hov-${++s.formatterSeq}`;
				s.hoverProviders.set(id, { selectors, run: provider.provideHover.bind(provider) });
				s.send('languages.registerHover', [{ id, selectors: selectors.map(plainSelector) }]);
				return new Disposable(() => {
					s.hoverProviders.delete(id);
					s.send('languages.unregisterHover', [{ id }]);
				});
			},
			registerDefinitionProvider: (selector: unknown, provider: { provideDefinition?: (document: unknown, position: unknown, token: unknown) => unknown }) => {
				if (typeof provider?.provideDefinition !== 'function') {
					return inert('languages.registerDefinitionProvider');
				}
				// GGS-patch: real definition providers — Go-to-Definition calls over (see
				// editorHovers.ts, which also drives the alt-click navigation), the frame
				// answers with serialized locations the workbench opens.
				const selectors = (Array.isArray(selector) ? selector : [selector]).map((entry) => (typeof entry === 'string' ? { language: entry } : entry));
				const id = `def-${++s.formatterSeq}`;
				s.definitionProviders.set(id, { selectors, run: provider.provideDefinition.bind(provider) });
				s.send('languages.registerDefinition', [{ id, selectors: selectors.map(plainSelector) }]);
				return new Disposable(() => {
					s.definitionProviders.delete(id);
					s.send('languages.unregisterDefinition', [{ id }]);
				});
			},
			registerDeclarationProvider: provider('registerDeclarationProvider'),
			registerTypeDefinitionProvider: provider('registerTypeDefinitionProvider'),
			registerImplementationProvider: provider('registerImplementationProvider'),
			registerReferenceProvider: provider('registerReferenceProvider'),
			registerDocumentSymbolProvider: provider('registerDocumentSymbolProvider'),
			registerWorkspaceSymbolProvider: provider('registerWorkspaceSymbolProvider'),
			registerCodeLensProvider: provider('registerCodeLensProvider'),
			registerCodeActionsProvider: provider('registerCodeActionsProvider'),
			registerOnTypeFormattingEditProvider: provider('registerOnTypeFormattingEditProvider'),
			registerRenameProvider: provider('registerRenameProvider'),
			registerSignatureHelpProvider: provider('registerSignatureHelpProvider'),
			registerDocumentLinkProvider: provider('registerDocumentLinkProvider'),
			registerDocumentHighlightProvider: provider('registerDocumentHighlightProvider'),
			registerMultiDocumentHighlightProvider: provider('registerMultiDocumentHighlightProvider'),
			registerDocumentSemanticTokensProvider: provider('registerDocumentSemanticTokensProvider'),
			registerDocumentRangeSemanticTokensProvider: provider('registerDocumentRangeSemanticTokensProvider'),
			registerFoldingRangeProvider: provider('registerFoldingRangeProvider'),
			registerSelectionRangeProvider: provider('registerSelectionRangeProvider'),
			registerCallHierarchyProvider: provider('registerCallHierarchyProvider'),
			registerTypeHierarchyProvider: provider('registerTypeHierarchyProvider'),
			registerLinkedEditingRangeProvider: provider('registerLinkedEditingRangeProvider'),
			registerInlayHintsProvider: provider('registerInlayHintsProvider'),
			registerColorProvider: provider('registerColorProvider'),
			registerInlineValuesProvider: provider('registerInlineValuesProvider'),
			registerDocumentDropEditProvider: provider('registerDocumentDropEditProvider'),
			registerDocumentPasteEditProvider: provider('registerDocumentPasteEditProvider'),
			registerEvaluatableExpressionProvider: provider('registerEvaluatableExpressionProvider'),
			setLanguageConfiguration: provider('setLanguageConfiguration')
	};
}
