// The `workspace` namespace: folders, configuration (the WorkspaceConfiguration
// class), the document table surface (openTextDocument, watchers, save), the
// provider registrations, applyEdit and the confined filesystem.

import { Disposable, EventEmitter, silentEvent, CancellationToken } from './types/events';
import { Uri, pathOf, rehydrateUris } from './types/uri';
import { RelativePattern, WorkspaceEdit, FileSystemError } from './types/values';
import { ConfigurationTarget } from './types/enums';
import { applyTextEditsToText } from './bridge';
import type { HostBridge, HostContext, SerializableTextEdit } from './bridge';
import { configurationChangeEvent } from './configuration';
import { documentKey, documentView, isInsideFolder } from './documents';
import { decodeBase64, encodeBase64, watcherGlobMatches } from './util';
import { inert, unsupported } from './inert';
import { shimLog, shimLogOnce } from './shimLog';
import type { ShimState } from './state';

class WorkspaceConfiguration {
	[key: string]: unknown;
	constructor(private readonly ctx: HostContext, private readonly bridge: HostBridge, private readonly section: string, private readonly onChanged?: (keys: string[]) => void) {
		// VS Code's configuration object carries the section's values as properties too.
		for (const leaf of this.leafKeys(this.section)) {
			const rest = this.section === '' ? leaf : leaf.slice(this.section.length + 1);
			const head = rest.split('.')[0]!;
			if (head === '' || head in this || ['get', 'has', 'update', 'inspect'].includes(head)) continue;
			Object.defineProperty(this, head, { enumerable: true, configurable: true, get: () => this.get(head) });
		}
	}

	private key(setting: string): string {
		return this.section === '' ? setting : setting === '' ? this.section : `${this.section}.${setting}`;
	}

	/** Every defined key under a prefix (defaults and overrides alike). */
	private leafKeys(prefix: string): string[] {
		const keys = new Set([...Object.keys(this.ctx.defaults ?? {}), ...Object.keys(this.ctx.settings)]);
		return [...keys].filter((key) => prefix === '' || key === prefix || key.startsWith(`${prefix}.`));
	}

	private valueOf(full: string): unknown {
		if (full in this.ctx.settings) return this.ctx.settings[full];
		if (this.ctx.defaults && full in this.ctx.defaults) return this.ctx.defaults[full];
		// A sub-section: assemble it from its leaves (deep copies — VS Code's are frozen).
		const leaves = this.leafKeys(full).filter((key) => key !== full);
		if (leaves.length === 0) return undefined;
		const out: Record<string, unknown> = {};
		for (const leaf of leaves) {
			const path = leaf.slice(full.length + 1).split('.');
			let node = out;
			for (const part of path.slice(0, -1)) node = (node[part] = typeof node[part] === 'object' && node[part] !== null ? node[part] : {}) as Record<string, unknown>;
			node[path[path.length - 1]!] = structuredCopy(this.valueOf(leaf));
		}
		return out;
	}

	get<T = unknown>(setting: string, defaultValue?: T): T {
		const value = this.valueOf(this.key(setting));
		return (value === undefined ? defaultValue : structuredCopy(value)) as T;
	}

	has(setting: string): boolean {
		return this.valueOf(this.key(setting)) !== undefined;
	}

	async update(setting: string, value: unknown, _target?: ConfigurationTarget | boolean | null, _overrideInLanguage?: boolean): Promise<void> {
		const key = this.key(setting);
		const changed = JSON.stringify(this.ctx.settings[key]) !== JSON.stringify(value);
		if (value === undefined) delete this.ctx.settings[key];
		else this.ctx.settings[key] = value;
		await this.bridge.request('settings.update', [this.ctx.extensionId, key, value]);
		// VS Code fires `onDidChangeConfiguration` for the extension's own update too. The
		// host's `configChanged` push that follows diffs against the value written above and
		// finds nothing, so the event fires here or never (git-graph-rs's `enableLog`
		// toggle never reached its logger before).
		if (changed) this.onChanged?.([key]);
	}

	/** Where a value comes from: its default and the (single, global-scope) override. */
	inspect<T = unknown>(setting: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T; defaultLanguageValue?: T; globalLanguageValue?: T; workspaceLanguageValue?: T; workspaceFolderLanguageValue?: T; languageIds?: string[] } | undefined {
		// Always an object: a package reads `inspect(key).globalValue` for keys it declared
		// (ms-python migrates settings that way), and a key this host has no default for yet
		// must read as "unset", not crash the activation.
		const key = this.key(setting);
		const defaultValue = this.ctx.defaults?.[key] as T | undefined;
		const globalValue = this.ctx.settings[key] as T | undefined;
		return { key, defaultValue: structuredCopy(defaultValue), globalValue: structuredCopy(globalValue), workspaceValue: undefined, workspaceFolderValue: undefined };
	}
}

/** A deep copy of a JSON-shaped value (a configuration object an extension may mutate). */
function structuredCopy<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		return value;
	}
}

export function buildWorkspace(s: ShimState) {
	/** Map a host fs failure onto VS Code's `FileSystemError` codes (extensions test
	 *  `error.code === 'FileNotFound'`). */
	function fsError(error: unknown, uri: Uri | string): FileSystemError {
		const text = String(error);
		const target = typeof uri === 'string' ? uri : uri.toString();
		if (/not found|cannot find|no such file|os error 2\b|os error 3\b/i.test(text)) return FileSystemError.FileNotFound(target);
		if (/already exists|os error 80\b|os error 183\b/i.test(text)) return FileSystemError.FileExists(target);
		if (/is a directory|os error 21\b/i.test(text)) return FileSystemError.FileIsADirectory(target);
		if (/not a directory|os error 20\b|os error 267\b/i.test(text)) return FileSystemError.FileNotADirectory(target);
		if (/denied|permission|outside the workspace|os error 5\b|os error 13\b/i.test(text)) return FileSystemError.NoPermissions(`${target}: ${text}`);
		return FileSystemError.Unavailable(`${target}: ${text}`);
	}

	const fsOp = async (name: string, uri: Uri | string, to?: Uri | string, data?: string): Promise<unknown> => {
		try {
			return await s.bridge.request('fs.op', [name, s.hostPathOf(uri), to === undefined ? undefined : s.hostPathOf(to), data]);
		} catch (error) {
			const mapped = fsError(error, uri);
			// A missing file is an ordinary answer (extensions probe for configs); anything
			// else is an anomaly worth the log.
			if (mapped.code !== 'FileNotFound') shimLog('warn', `workspace.fs.${name}(${s.hostPathOf(uri)}) failed: ${String(error)}`);
			throw mapped;
		}
	};

	const fileSystem = {
		readFile: async (uri: Uri | string) => decodeBase64(((await fsOp('read', uri)) as { data: string }).data),
		writeFile: async (uri: Uri | string, content: Uint8Array) => {
			await fsOp('write', uri, undefined, encodeBase64(content instanceof Uint8Array ? content : new Uint8Array(content ?? [])));
		},
		// `access`: F_OK semantics — a readable stat answers, a missing path rejects.
		access: async (uri: Uri | string) => {
			await fsOp('stat', uri);
			return undefined;
		},
		readDirectory: async (uri: Uri | string) => (((await fsOp('list', uri)) as { name: string; kind: number }[]).map((entry) => [entry.name, entry.kind])) as [string, number][],
		createDirectory: (uri: Uri | string) => fsOp('mkdir', uri).then(() => undefined),
		delete: (uri: Uri | string, _options?: { recursive?: boolean; useTrash?: boolean }) => fsOp('delete', uri).then(() => undefined),
		rename: (uri: Uri | string, to: Uri | string, _options?: { overwrite?: boolean }) => fsOp('rename', uri, to).then(() => undefined),
		copy: async (uri: Uri | string, to: Uri | string, _options?: { overwrite?: boolean }) => {
			const data = (await fsOp('read', uri)) as { data: string };
			await fsOp('write', to, undefined, data.data);
		},
		isWritableFileSystem: (scheme: string) => scheme === 'file',
		stat: async (uri: Uri | string) => {
			const stat = (await fsOp('stat', uri)) as { type: number; size: number; mtime: number; ctime?: number };
			return { type: stat.type, ctime: stat.ctime ?? stat.mtime, mtime: stat.mtime, size: stat.size, permissions: undefined };
		}
	};

	/** One WorkspaceEdit (the class, or the plain `{ changes }` / LSP `documentChanges`
	 *  shapes a converted edit arrives in) as an ordered operation list. */
	function workspaceEditOperations(edit: unknown): ({ kind: 'text'; path: string; edits: SerializableTextEdit[] } | { kind: 'create' | 'delete'; path: string; options?: Record<string, unknown> } | { kind: 'rename'; path: string; to: string; options?: Record<string, unknown> })[] {
		const out: ReturnType<typeof workspaceEditOperations> = [];
		const pushText = (path: string, edits: SerializableTextEdit[]) => {
			const last = out[out.length - 1];
			if (last?.kind === 'text' && last.path === path) last.edits.push(...edits);
			else if (edits.length > 0) out.push({ kind: 'text', path, edits });
		};
		const uriPath = (value: unknown): string => {
			if (typeof value === 'string') return s.hostPathOf(Uri.parse(value));
			return s.hostPathOf(value instanceof Uri ? value : (rehydrateUris(value) as Uri));
		};
		if (edit instanceof WorkspaceEdit) {
			for (const operation of edit._operations) {
				if (operation.kind === 'text') pushText(s.hostPathOf(operation.uri), s.serializeEdits([operation.edit]));
				else if (operation.kind === 'rename') out.push({ kind: 'rename', path: s.hostPathOf(operation.uri), to: s.hostPathOf(operation.newUri), options: operation.options });
				else out.push({ kind: operation.kind, path: s.hostPathOf(operation.uri), options: operation.options as Record<string, unknown> | undefined });
			}
			return out;
		}
		const plain = (edit ?? {}) as { changes?: Record<string, unknown[]>; documentChanges?: unknown[] };
		for (const change of plain.documentChanges ?? []) {
			const entry = change as { textDocument?: { uri?: unknown }; edits?: unknown[]; kind?: string; uri?: unknown; oldUri?: unknown; newUri?: unknown; options?: Record<string, unknown> };
			if (entry.textDocument) pushText(uriPath(entry.textDocument.uri), s.serializeEdits(entry.edits ?? []));
			else if (entry.kind === 'rename') out.push({ kind: 'rename', path: uriPath(entry.oldUri), to: uriPath(entry.newUri), options: entry.options });
			else if (entry.kind === 'create' || entry.kind === 'delete') out.push({ kind: entry.kind, path: uriPath(entry.uri), options: entry.options });
		}
		for (const [uri, edits] of Object.entries(plain.changes ?? {})) pushText(uriPath(uri), s.serializeEdits(edits ?? []));
		return out;
	}

	/** `workspace.applyEdit`: every operation in order — open editors take their text edits
	 *  through CodeMirror; closed files are read, spliced and written back through
	 *  `workspace.fs`; file operations run through the same confined filesystem. The answer
	 *  is whether every operation applied (a failure is logged with its cause). */
	async function applyWorkspaceEdit(edit: unknown): Promise<boolean> {
		try {
			for (const operation of workspaceEditOperations(edit)) {
				if (operation.kind === 'text') {
					const applied = await s.bridge.request('editor.applyEdits', [operation.path, operation.edits]);
					if (applied === true) continue;
					const read = (await fsOp('read', operation.path)) as { data: string };
					const after = applyTextEditsToText(new TextDecoder().decode(decodeBase64(read.data)), operation.edits);
					await fsOp('write', operation.path, undefined, encodeBase64(new TextEncoder().encode(after)));
					const known = s.documents.get(documentKey(operation.path));
					if (known) s.rememberDocument(operation.path, after, known.languageId);
				} else if (operation.kind === 'create') {
					const exists = await fsOp('stat', operation.path).then(() => true, () => false);
					if (exists && operation.options?.ignoreIfExists) continue;
					if (exists && !operation.options?.overwrite) throw FileSystemError.FileExists(operation.path);
					const contents = operation.options?.contents instanceof Uint8Array ? operation.options.contents : new Uint8Array();
					await fsOp('write', operation.path, undefined, encodeBase64(contents));
				} else if (operation.kind === 'delete') {
					const exists = await fsOp('stat', operation.path).then(() => true, () => false);
					if (!exists && operation.options?.ignoreIfNotExists) continue;
					await fsOp('delete', operation.path);
				} else if ('to' in operation) {
					await fsOp('rename', operation.path, operation.to);
				}
			}
			return true;
		} catch (error) {
			shimLog('error', `workspace.applyEdit failed: ${String(error)}`, error);
			return false;
		}
	}

	/** The folder list as a WorkspaceFolder array (VS Code answers undefined for none). */
	const foldersOrUndefined = () => (s.workspaceFolders.length > 0 ? s.workspaceFolders : undefined);
	const folderFor = (uriOrPath?: Uri | string) => {
		const path = uriOrPath === undefined ? undefined : pathOf(uriOrPath as Uri | string);
		if (path === undefined || path === '') return undefined;
		// The deepest containing folder wins (nested folders in a multi-root workspace).
		return [...s.workspaceFolders].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length).find((folder) => isInsideFolder(path, folder.uri.fsPath));
	};

	return {
			get workspaceFolders() {
				return foldersOrUndefined();
			},
			onDidChangeWorkspaceFolders: s.workspaceFoldersChanged.event,
			/** Workspace trust: everything the frame runs is the user's own installed package. */
			isTrusted: true,
			onDidGrantWorkspaceTrust: silentEvent() as never,
			workspaceFile: undefined,
			getWorkspaceFolder: (uriOrPath?: Uri | string) => folderFor(uriOrPath),
			get rootPath(): string | undefined {
				return s.workspaceFolders[0]?.uri.fsPath;
			},
			get name(): string | undefined {
				return s.workspaceFolders.length === 0 ? undefined : s.workspaceFolders.length > 1 ? `${s.workspaceFolders[0]!.name} (Workspace)` : s.workspaceFolders[0]!.name;
			},
			updateWorkspaceFolders: (_start: number, _deleteCount: number | undefined | null, ..._folders: unknown[]) => {
				unsupported('workspace.updateWorkspaceFolders', 'open folders from the File menu');
				return false;
			},
			getConfiguration: (section = '', _scope?: unknown) => new WorkspaceConfiguration(s.ctx, s.bridge, section ?? '', (keys) => s.configurationChanged.fire(configurationChangeEvent(keys))),
			onDidChangeConfiguration: s.configurationChanged.event,
			/** The provider object stays in the frame; the host remembers which frame answers the
			 *  scheme, and its `vscode.open` / `vscode.diff` call back here for the text. */
			registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
				s.bridge.registerDocProvider?.(scheme, provider as { provideTextDocumentContent?: (uri: unknown) => unknown });
				s.send('docProvider.register', [scheme]);
				return new Disposable(() => {
					s.bridge.unregisterDocProvider?.(scheme);
					s.send('docProvider.unregister', [scheme]);
				});
			},
			/** The read half is served: the provider parks in this frame and the host
			 *  remembers the scheme, its `vscode.open` / `vscode.diff` asking the text back
			 *  through `fsProvider.read` (claude-code's change-review diffs stage both sides
			 *  in its in-memory `_claude_*_fs_*` schemes). watch and the directory members
			 *  stay the extension's own — the host never enumerates a package's VFS. */
			registerFileSystemProvider: (scheme: string, provider: unknown, _options?: unknown) => {
				const readable = (provider ?? {}) as { readFile?: (uri: unknown) => unknown };
				s.bridge.registerFsProvider?.(scheme, readable);
				s.send('fsProvider.register', [scheme]);
				return new Disposable(() => {
					s.bridge.unregisterFsProvider?.(scheme);
					s.send('fsProvider.unregister', [scheme]);
				});
			},
			registerNotebookSerializer: (notebookType: string, _serializer: unknown) => inert(`workspace.registerNotebookSerializer(${notebookType})`),
			registerTaskProvider: (type: string, _provider: unknown) => inert(`workspace.registerTaskProvider(${type})`),
			onDidSaveTextDocument: s.documentSaved.event,
			onDidChangeTextDocument: s.documentChanged.event,
			/** No pre-save interception point exists: the registration is accepted and never
			 *  fires (firing after the save would let a formatter-on-save dirty the file
			 *  again), and the first registration says so in the log. */
			onWillSaveTextDocument: (listener: unknown, thisArgs?: unknown, disposables?: { dispose(): unknown }[]) => {
				unsupported('workspace.onWillSaveTextDocument', 'there is no pre-save hook; edits-on-save do not run');
				return silentEvent()(listener as never, thisArgs, disposables);
			},
			onDidOpenTextDocument: s.documentOpened.event,
			onDidCloseTextDocument: s.documentClosed.event,
			onDidCreateFiles: silentEvent() as never,
			onDidDeleteFiles: silentEvent() as never,
			onDidRenameFiles: silentEvent() as never,
			onWillCreateFiles: silentEvent() as never,
			onWillDeleteFiles: silentEvent() as never,
			onWillRenameFiles: silentEvent() as never,
			onDidOpenNotebookDocument: silentEvent() as never,
			onDidCloseNotebookDocument: silentEvent() as never,
			onDidSaveNotebookDocument: silentEvent() as never,
			onDidChangeNotebookDocument: silentEvent() as never,
			/** The document for a Uri / path — read without opening an editor (VS Code's
			 *  contract: `showTextDocument` opens one). The in-memory `{ content }` form
			 *  answers an untitled document. */
			openTextDocument: async (uriPathOrOptions?: Uri | string | { content?: string; language?: string }) => {
				if (uriPathOrOptions === undefined || (uriPathOrOptions !== null && typeof uriPathOrOptions === 'object' && !(uriPathOrOptions instanceof Uri) && !Uri.isUri(uriPathOrOptions) && typeof (uriPathOrOptions as { fsPath?: unknown }).fsPath !== 'string')) {
					const options = (uriPathOrOptions ?? {}) as { content?: string; language?: string };
					const name = `Untitled-${++s.untitledSeq}`;
					const { state } = s.rememberDocument(name, options.content ?? '', options.language ?? 'plaintext', Uri.from({ scheme: 'untitled', path: name }));
					s.documentOpened.fire(documentView(state, async () => false));
					return documentView(state, async () => false);
				}
				const uri = typeof uriPathOrOptions === 'string' ? Uri.file(uriPathOrOptions) : (rehydrateUris(uriPathOrOptions) as Uri);
				if (uri.scheme !== 'file') {
					// A provider scheme. This side's own registration answers first — a
					// ggs-node package's blocking s.bridge must not take the host round-trip,
					// whose answer calls back into this same parked JS thread (the
					// `vscode.diff` reentry deadlock class). Another extension's scheme
					// falls to the host's global provider lookup, as before.
					const own = s.bridge.readDocProvider?.(uri) ?? null;
					let text: unknown;
					try {
						text = own !== null ? await own : await s.bridge.request('docProvider.read', [uri]);
					} catch (error) {
						shimLog('warn', `openTextDocument(${uri.toString()}) failed: ${String(error)}`, error);
						throw error;
					}
					const { state } = s.rememberDocument(uri.toString(), String(text ?? ''), 'plaintext', uri);
					return documentView(state, async () => false);
				}
				const path = s.hostPathOf(uri);
				const known = s.documents.get(documentKey(path));
				if (known) return s.makeTextDocument(path);
				let read: { text?: string; languageId?: string } | null = null;
				try {
					read = (await s.bridge.request('workspace.readText', [path])) as { text?: string; languageId?: string } | null;
				} catch (error) {
					shimLog('warn', `openTextDocument(${path}) failed: ${String(error)}`, error);
					throw fsError(error, uri);
				}
				const { state, opened } = s.rememberDocument(path, read?.text ?? '', read?.languageId ?? '');
				if (opened) s.documentOpened.fire(documentView(state, () => s.saveDocument(path)));
				return s.makeTextDocument(path);
			},
			applyEdit: (edit: unknown, _metadata?: unknown) => applyWorkspaceEdit(edit),
			asRelativePath: (pathOrUri: string | Uri, includeWorkspaceFolder?: boolean) => {
				const path = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
				const folder = folderFor(path);
				if (!folder) return path;
				const relative = documentKey(path).slice(documentKey(folder.uri.fsPath).replace(/\/+$/, '').length).replace(/^\//, '');
				const withFolder = includeWorkspaceFolder ?? s.workspaceFolders.length > 1;
				return withFolder && s.workspaceFolders.length > 1 ? `${folder.name}/${relative}` : relative;
			},
			createFileSystemWatcher: (pattern: unknown, ignoreCreate = false, ignoreChange = false, ignoreDelete = false) => {
				// A string pattern watches the first workspace folder (an absolute one carries
				// its own base); a RelativePattern carries its base (a repository, typically).
				const asObject = pattern !== null && typeof pattern === 'object' ? pattern as { baseUri?: Uri; base?: unknown; pattern?: unknown } : null;
				let baseRaw = asObject !== null
					? (asObject.baseUri ? asObject.baseUri.fsPath : typeof asObject.base === 'string' ? asObject.base : pathOf(asObject.base as Uri))
					: (s.workspaceFolders[0]?.uri.fsPath ?? '');
				let glob = String((asObject !== null ? asObject.pattern : pattern) ?? '**');
				if (asObject === null && /^([A-Za-z]:)?[\\/]/.test(glob)) {
					// An absolute string pattern: split at the first wildcard segment.
					const segments = glob.replace(/\\/g, '/').split('/');
					const firstWild = segments.findIndex((segment) => /[*?{[]/.test(segment));
					const cut = firstWild === -1 ? segments.length - 1 : firstWild;
					baseRaw = segments.slice(0, cut).join('/');
					glob = segments.slice(cut).join('/') || '**';
				}
				const base = documentKey(baseRaw).replace(/\/+$/, '').toLowerCase();
				const changed = new EventEmitter<Uri>();
				const created = new EventEmitter<Uri>();
				const deleted = new EventEmitter<Uri>();
				const fire = (emitter: EventEmitter<Uri>, absolute: string) => emitter.fire(Uri.file(absolute));
				// The frame's own saves count too (VS Code's watcher sees them).
				const saveSub = s.documentSaved.event((document) => {
					if (ignoreChange) return;
					const fileName = String((document as { fileName?: string }).fileName ?? '');
					const normalized = documentKey(fileName).toLowerCase();
					if (normalized.startsWith(base + '/') && watcherGlobMatches(glob, normalized.slice(base.length + 1))) fire(changed, fileName);
				});
				// The host's watcher batches: every changed working-tree path under the base
				// fires; a `.git/` change fires the pattern-matched HEAD event. A batch cannot
				// tell create or delete from change, so those fire as changes.
				const fsSub = s.fsChanged.event((batch) => {
					if (ignoreChange) return;
					const root = documentKey(batch.root).replace(/\/+$/, '').toLowerCase();
					if (!base.startsWith(root) && !root.startsWith(base)) return;
					for (const relative of batch.paths) {
						const full = `${root}/${relative}`;
						if (base !== '' && !full.startsWith(base + '/')) continue;
						const rest = full.slice(base === '' ? root.length + 1 : base.length + 1);
						if (watcherGlobMatches(glob, rest)) fire(changed, `${batch.root.replace(/[\\/]+$/, '')}/${relative}`);
					}
					if (batch.gitChanged && watcherGlobMatches(glob, '.git/HEAD')) fire(changed, `${batch.root.replace(/[\\/]+$/, '')}/.git/HEAD`);
				});
				if (!ignoreCreate || !ignoreDelete) shimLogOnce(`watcher-kinds:${s.ctx.extensionId}`, 'debug', 'file watchers report creations and deletions as changes (the host batches do not tell them apart)');
				return {
					ignoreCreateEvents: ignoreCreate,
					ignoreChangeEvents: ignoreChange,
					ignoreDeleteEvents: ignoreDelete,
					onDidChange: changed.event,
					onDidCreate: created.event,
					onDidDelete: deleted.event,
					dispose: () => {
						saveSub.dispose();
						fsSub.dispose();
						changed.dispose();
						created.dispose();
						deleted.dispose();
					}
				};
			},
			/** `findFiles(include, exclude?, maxResults?)`: a glob or a RelativePattern, over
			 *  every open folder (or the pattern's base), the exclude glob applied here. */
			findFiles: async (include: string | RelativePattern | { baseUri?: Uri; base?: unknown; pattern?: string }, exclude?: string | RelativePattern | null, maxResults?: number, _token?: CancellationToken) => {
				const relative = include !== null && typeof include === 'object';
				const glob = relative ? String((include as { pattern?: string }).pattern ?? '**') : String(include ?? '**');
				const base = relative ? ((include as { baseUri?: Uri }).baseUri?.fsPath ?? pathOf((include as { base?: Uri }).base)) : undefined;
				const found = (await s.bridge.request('fs.op', ['find', glob, base])) as (string | { root: string; path: string })[];
				const excludeGlob = exclude === null || exclude === undefined ? undefined : typeof exclude === 'string' ? exclude : exclude.pattern;
				const firstRoot = s.workspaceFolders[0]?.uri.fsPath ?? '';
				const out: Uri[] = [];
				for (const entry of found ?? []) {
					const root = typeof entry === 'string' ? firstRoot : entry.root;
					const rel = typeof entry === 'string' ? entry : entry.path;
					if (excludeGlob && watcherGlobMatches(excludeGlob.replace(/^\*\*\//, '**/'), rel)) continue;
					out.push(Uri.file(root === '' ? rel : `${root.replace(/[\\/]+$/, '')}/${rel}`));
					if (maxResults !== undefined && out.length >= maxResults) break;
				}
				return out;
			},
			save: async (uri: Uri) => ((await s.saveDocument(s.hostPathOf(uri))) ? uri : undefined),
			saveAs: async (_uri: Uri) => {
				unsupported('workspace.saveAs');
				return undefined;
			},
			saveAll: async (_includeUntitled?: boolean) => {
				let all = true;
				for (const state of s.documents.values()) if (state.uri.scheme === 'file') all = (await s.saveDocument(state.path)) && all;
				return all;
			},
			get textDocuments(): Record<string, unknown>[] {
				return [...s.documents.values()].map((state) => documentView(state, () => s.saveDocument(state.path)));
			},
			notebookDocuments: [] as never[],
			decode: async (content: Uint8Array) => new TextDecoder().decode(content),
			encode: async (content: string) => new TextEncoder().encode(content),
			/** The file services over the host's `ext_fs` command (bytes cross as base64;
			 *  every path is confined to the open folders, the extension's own directory and
			 *  its storage there). */
			fs: fileSystem
	};
}
