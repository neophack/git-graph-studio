// Hosts the Git Graph webview (static/gitgraph/view.html) in an iframe and plays the extension
// host's part for it: composes `initialState` from the extension's own config code plus the
// stored view/repo state, forwards read and write requests to the Rust backend, and serves
// the requests that belong to the shell itself - opening files and diffs in the editor, the
// terminal, dialogs, view state, code reviews, settings - so the unmodified webview has every
// action it has inside VS Code.
//
// This is deliberately the app's ONLY module that consumes the extension's TypeScript
// artifacts at runtime: the webview bundle (loaded by the view page), the config bundle
// (gitgraph/config.js = the extension's compiled src/config.ts, exposed as
// window.GitGraphStudioConfig by scripts/prepare.mjs), the Commit Comparison page generator
// with its binary-area host machinery (gitgraph/compare.js, built from the extension's own
// compiled src/comparisonView.ts + src/binaryCompare.ts + src/hexDiff.ts - see CompareHost
// below) and the standalone Binary Compare page generator (gitgraph/binarycompare.js, from
// src/binaryCompareView.ts - see BinaryCompareHost). The pages and the hex/image session
// machinery are the extension's own compiled code; only their I/O - blob bytes and
// working-tree reads - is adapted to the app's backend commands here. The Rust counterpart of
// this seam is src-tauri/src/cmd_graph.rs, the one module that talks to git-graph-core.

import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';

import type { DiffRequest } from './scm';
import { claimGraphPreload } from './graphPreload';
import { t, tf } from './i18n';
import { THEME_EVENT, themeById } from './settings';
import * as state from './state';
import { basename, el, joinPath, notify, toPosix } from './ui';

declare global {
	interface Window {
		GitGraphStudioConfig?: (settings: Record<string, unknown>) => Record<string, unknown>;
	}
}

/* ---------- The Commit Comparison page (the extension's own view, hosted) ---------- */

/** One file entry of the comparison the page renders. */
interface CompareFileChange {
	oldFilePath: string;
	newFilePath: string;
	type: string;
	additions: number | null;
	deletions: number | null;
}

/** The extension's compiled page generator (scripts/compare-bundle.mjs, driven by
 *  scripts/prepare.mjs, builds it from out/comparisonView.js — its `getHtml` template over a
 *  stubbed panel). The same bundle also exposes the binary-area responders (out/binaryCompare.js
 *  + out/hexDiff.js) the pages' hex/picture comparison is driven through; the standalone Binary
 *  Compare page generator (out/binaryCompareView.js) ships as the separate
 *  GitGraphBinaryCompare below. */
declare global {
	interface Window {
		GitGraphCompare?: {
			buildComparePage(options: Record<string, unknown>): string;
			createHexSession?(dataSource: { spawnGitStream(args: string[], repo: string): unknown }, repo: string, fromHash: string, toHash: string, file: CompareFileChange): HexSession;
			wireHexSession?(session: HexSession, index: number, post: (message: Record<string, unknown>) => void): void;
			respondHexInfo?(session: HexSession, index: number, bytesPerRow: number, post: (message: Record<string, unknown>) => void): Promise<void>;
			respondHexRows?(session: HexSession, index: number, start: number, count: number, post: (message: Record<string, unknown>) => void): Promise<void>;
			respondImageData?(session: HexSession, index: number, file: CompareFileChange, post: (message: Record<string, unknown>) => void): Promise<void>;
			respondCopyToClipboard?(post: (message: Record<string, unknown>) => void, type: string, data: string): Promise<void>;
		};
		GitGraphBinaryCompare?: { buildBinaryComparePage(options: Record<string, unknown>): string };
		__ggsHexFs?: HexFileSystem;
		__ggsWriteClipboard?: (text: string) => Promise<void>;
	}
}

/** One hex-diff session as the hosts drive it — the extension's compiled HexDiffSession
 *  (src/hexDiff.ts) served out of compare.js; only the surface the responders call is named. */
interface HexSession {
	onSections: ((sections: unknown, error: string | null) => void) | null;
	dispose(): void;
}

/* ---------- Where the graph's assets come from ---------- */

/** The id of the theme-token stylesheet the host injects into a hosted page. */
const HOST_THEME_LINK_ID = 'ggs-host-theme';

function hostThemeLink(css: string): string {
	return `<link id="${HOST_THEME_LINK_ID}" rel="stylesheet" href="${css}" />`;
}

/** The host's contract with a hosted page, as VS Code's with a webview: the `--vscode-*` token
 *  sheet of the current theme and the `vscode-dark` / `vscode-light` classes, injected into the
 *  page's document - never a stylesheet of the plugin's own. Both hosted pages (the graph view,
 *  the comparison page) get it on load and on every theme switch. */
function applyFrameTheme(frame: HTMLIFrameElement): void {
	try {
		const doc = frame.contentDocument;
		if (!doc) return;
		const theme = themeById();
		let link = doc.getElementById(HOST_THEME_LINK_ID) as HTMLLinkElement | null;
		if (!link && doc.head) {
			doc.head.insertAdjacentHTML('afterbegin', hostThemeLink(theme.css));
			link = doc.getElementById(HOST_THEME_LINK_ID) as HTMLLinkElement | null;
		}
		for (const element of [doc.documentElement, doc.body]) {
			if (!element) continue;
			element.classList.remove('vscode-dark', 'vscode-light');
			element.classList.add(theme.kind);
			element.dataset['vscodeThemeKind'] = theme.kind;
			element.dataset['vscodeThemeName'] = theme.label;
		}
		if (link && link.getAttribute('href') !== theme.css) {
			// A live switch while the page is already running (no reload): once the new
			// stylesheet has loaded, tell the page to re-mirror the --vscode-* colour tokens
			// it copied into inline style at boot (see static/gitgraph/view.html), so the
			// scroll-to-commit flash and Find highlight follow the new theme too. The
			// comparison page mirrors no tokens; the message is simply not for it.
			const frameWindow = frame.contentWindow;
			link.addEventListener('load', () => frameWindow?.postMessage({ __studioThemeReady: true }, '*'), { once: true });
			link.href = theme.css;
		}
	} catch {
		// A cross-origin or not-yet-created document: the page keeps its loaded theme.
	}
}

let compareGenerator: Promise<void> | null = null;
let binaryCompareGenerator: Promise<void> | null = null;

/** Load the extension's comparison page generator once per document. A generator that is
 *  already present (tests pre-set it) resolves at once. */
function loadCompareGenerator(): Promise<void> {
	if (window.GitGraphCompare) return Promise.resolve();
	compareGenerator ??= loadGitGraphScript('compare.js', 'The Git Graph comparison page generator (gitgraph/compare.js) did not load');
	return compareGenerator;
}

/** Load the extension's standalone Binary Compare page generator (gitgraph/binarycompare.js). */
function loadBinaryCompareGenerator(): Promise<void> {
	if (window.GitGraphBinaryCompare) return Promise.resolve();
	binaryCompareGenerator ??= loadGitGraphScript('binarycompare.js', 'The Git Graph binary comparison page generator (gitgraph/binarycompare.js) did not load');
	return binaryCompareGenerator;
}

/** Run one of the app's /gitgraph/ script assets (config.js is on the page already via
 *  index.html; compare.js and binarycompare.js load here) in the document. */
function loadGitGraphScript(name: string, failure: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const script = document.createElement('script');
		script.src = '/gitgraph/' + name;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error(failure));
		document.head.appendChild(script);
	});
}

/* ---------- The binary comparison's host machinery (the extension's own, adapted) ---------- */

/** The byte carrier for the bytes this host hands the machinery: the Node Buffer surface its
 *  compiled code actually uses — indexing, `subarray` (results stay this class, so they encode
 *  and compare the same way), base64/latin1 `toString`, `equals`, `copy`. The bundle carries
 *  its own polyfill for the buffers it allocates internally; these are the ones the host
 *  produces, shaped so the two interoperate. */
class HexBuffer extends Uint8Array {
	static fromBytes(bytes: Uint8Array): HexBuffer {
		const copy = new HexBuffer(bytes.length);
		copy.set(bytes);
		return copy;
	}
	toString(encoding?: string): string {
		if (encoding === 'base64') {
			let binary = '';
			for (let i = 0; i < this.length; i += 0x8000) {
				binary += String.fromCharCode.apply(null, this.subarray(i, Math.min(this.length, i + 0x8000)) as unknown as number[]);
			}
			return btoa(binary);
		}
		if (encoding === 'latin1') {
			let text = '';
			for (let i = 0; i < this.length; i++) text += String.fromCharCode(this[i]!);
			return text;
		}
		return new TextDecoder().decode(this);
	}
	equals(other: Uint8Array): boolean {
		if (other.length !== this.length) return false;
		for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
		return true;
	}
	copy(target: Uint8Array, targetStart: number, sourceStart: number, sourceEnd: number): void {
		target.set(this.subarray(sourceStart, sourceEnd), targetStart);
	}
}

function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

type FakeListener = (...args: unknown[]) => void;

/** The slice of Node's stream surface the machinery consumes: `on('data'|'end'|'error')`,
 *  `resume` (its stderr drains) and `destroy`. Data is pulled eagerly from the backend, so a
 *  `resume` is a no-op and `destroy` just stops the feed. */
class FakeStream {
	private readonly listeners = new Map<string, Set<FakeListener>>();
	private destroyed = false;
	on(event: string, listener: FakeListener): this {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}
	emit(event: string, ...args: unknown[]): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
	}
	resume(): void { /* the adapter pushes eagerly; nothing to kick */ }
	destroy(): void {
		this.destroyed = true;
	}
	get isDestroyed(): boolean {
		return this.destroyed;
	}
}

/** The slice of cp.ChildProcess the machinery consumes: stdout/stderr streams, `on('close')`
 *  and `kill()`. */
class FakeChild {
	readonly stdout = new FakeStream();
	readonly stderr = new FakeStream();
	private readonly listeners = new Map<string, Set<FakeListener>>();
	private killed = false;
	on(event: string, listener: FakeListener): this {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}
	emitClose(code: number): void {
		for (const listener of [...(this.listeners.get('close') ?? [])]) listener(code);
	}
	kill(): void {
		this.killed = true;
		this.stdout.destroy();
	}
	get isKilled(): boolean {
		return this.killed;
	}
}

/** The callback-style fs surface the compare.js bundle's shim (scripts/hex-fs-stub.cjs) calls
 *  into: the machinery's working-tree sides read through it. Every call reaches the backend —
 *  no file byte ever crosses through this window's own runtime. */
interface HexFileSystem {
	stat(path: string, callback: (error: { code: string; message?: string } | null, stats?: { size: number }) => void): void;
	open(path: string, callback: (error: Error | null, fd?: number) => void): void;
	read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number, callback: (error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void): void;
	createReadStream(path: string): FakeStream;
	readFile(path: string, callback: (error: Error | null, data?: HexBuffer) => void): void;
	closeSync(fd: number): void;
}

/** The transport size of one backend range read: the machinery works in 64 KiB blocks, and a
 *  4×-bigger transport window keeps a multi-megabyte scan to a bounded number of IPC calls. */
const HEX_RANGE_CHUNK = 256 * 1024;

/** The file descriptors the fs shim's `open`/`read`/`closeSync` trade in: reads are addressed
 *  absolutely (`read_file_chunk` reopens by path), so the table only maps fd → path. */
const hexOpenFiles = new Map<number, string>();
let hexNextFd = 1;

const hexFileSystem: HexFileSystem = {
	stat(path, callback) {
		void invoke<{ size: number }>('file_probe', { path }).then(
			(probe) => callback(null, { size: probe.size }),
			// An unreadable side reads as absent, exactly how the machinery's statSize treats
			// ENOENT — the missing side of an added or deleted file.
			(error) => callback({ code: 'ENOENT', message: String(error) })
		);
	},
	open(path, callback) {
		const fd = hexNextFd++;
		hexOpenFiles.set(fd, path);
		callback(null, fd);
	},
	read(fd, buffer, offset, length, position, callback) {
		const path = hexOpenFiles.get(fd);
		if (path === undefined) {
			callback(new Error('bad file descriptor'));
			return;
		}
		void invoke<{ base64: string }>('read_file_chunk', { path, offset: position, len: length }).then(
			(chunk) => {
				const bytes = decodeBase64(chunk.base64);
				buffer.set(bytes.subarray(0, length), offset);
				callback(null, bytes.length, buffer);
			},
			(error) => callback(error instanceof Error ? error : new Error(String(error)))
		);
	},
	createReadStream(path) {
		const stream = new FakeStream();
		void (async () => {
			try {
				const head = await invoke<{ size: number; base64: string }>('read_file_chunk', { path, offset: 0, len: HEX_RANGE_CHUNK });
				let offset = 0;
				while (offset < head.size && !stream.isDestroyed) {
					const chunk = offset === 0 ? head : await invoke<{ size: number; base64: string }>('read_file_chunk', { path, offset, len: HEX_RANGE_CHUNK });
					const bytes = decodeBase64(chunk.base64);
					if (bytes.length === 0) break;
					stream.emit('data', HexBuffer.fromBytes(bytes));
					offset += bytes.length;
				}
				if (!stream.isDestroyed) stream.emit('end');
			} catch (error) {
				stream.emit('error', error instanceof Error ? error : new Error(String(error)));
			}
		})();
		return stream;
	},
	readFile(path, callback) {
		// Whole-file reads happen for the picture view's data URLs, which the responder already
		// caps at the same 32 MiB the backend enforces.
		void invoke<string>('read_file_base64', { path }).then(
			(base64) => callback(null, HexBuffer.fromBytes(decodeBase64(base64))),
			(error) => callback(error instanceof Error ? error : new Error(String(error)))
		);
	},
	closeSync(fd) {
		hexOpenFiles.delete(fd);
	}
};

// Install the adapters where the bundles look for them (scripts/hex-fs-stub.cjs and
// scripts/vscode-stub.cjs): before any machinery call can happen, at module scope.
window.__ggsHexFs = hexFileSystem;
window.__ggsWriteClipboard = (text) => writeClipboardText(text);

/** The blob temp files one host's sessions materialized — each side's revision content exists
 *  only as a blob until `materialize_revision_file` writes it out — released together when the
 *  host goes away. Every acquire materializes its own file (the command never reuses one), so
 *  no cross-host refcounting is needed. */
class TempBlobScope {
	private readonly temps = new Map<string, Promise<string>>();
	acquire(repo: string, revision: string, path: string): Promise<string> {
		const key = repo + '\0' + revision + '\0' + path;
		let pending = this.temps.get(key);
		if (pending === undefined) {
			pending = invoke<string>('materialize_revision_file', { repo, revision, path }).catch((error) => {
				this.temps.delete(key);
				throw error;
			});
			this.temps.set(key, pending);
		}
		return pending;
	}
	release(): void {
		for (const pending of this.temps.values()) {
			void pending.then(
				(path) => invoke('discard_temp_blob', { path }).catch(() => undefined),
				() => undefined
			);
		}
		this.temps.clear();
	}
}

/** `spawnGitStream` as the machinery expects it — the only DataSource surface its hex sessions
 *  use — over the app's backend. The two argument shapes it is issued with (`cat-file -s` for
 *  a size, `cat-file blob` for the bytes) both resolve to a materialized temp file read through
 *  `file_probe` / `read_file_chunk`; the blob is read by the linked engine on the way there, so
 *  this path never spawns git. */
class HexIo {
	constructor(private readonly temps: TempBlobScope) {}

	spawnGitStream(args: string[], repo: string): FakeChild {
		const spec = String(args[2] ?? '');
		const separator = spec.indexOf(':');
		const revision = separator > 0 ? spec.slice(0, separator) : spec;
		const path = separator > 0 ? spec.slice(separator + 1) : '';
		const child = new FakeChild();
		const read = (): Promise<string> => this.temps.acquire(repo, revision, path);
		if (args[1] === '-s') {
			void (async () => {
				try {
					const probe = await read().then((temp) => invoke<{ size: number }>('file_probe', { path: temp }));
					child.stdout.emit('data', String(probe.size));
					child.stdout.emit('end');
					child.emitClose(0);
				} catch (error) {
					// The machinery's measureSize reads "does not exist" as "the side is absent".
					child.stderr.emit('data', `${spec}: does not exist (${String(error)})`);
					child.emitClose(128);
				}
			})();
			return child;
		}
		void (async () => {
			try {
				const temp = await read();
				const head = await invoke<{ size: number; base64: string }>('read_file_chunk', { path: temp, offset: 0, len: HEX_RANGE_CHUNK });
				let offset = 0;
				while (offset < head.size && !child.isKilled) {
					const chunk = offset === 0 ? head : await invoke<{ size: number; base64: string }>('read_file_chunk', { path: temp, offset, len: HEX_RANGE_CHUNK });
					const bytes = decodeBase64(chunk.base64);
					if (bytes.length === 0) break;
					child.stdout.emit('data', HexBuffer.fromBytes(bytes));
					offset += bytes.length;
				}
				if (!child.isKilled) child.stdout.emit('end');
				child.emitClose(0);
			} catch (error) {
				child.stderr.emit('data', String(error));
				child.emitClose(1);
			}
		})();
		return child;
	}
}

/** The comparison view is not part of the webview bundle: the extension generates its whole
 *  page (styles and script inline) from extension-host code. This host does what the extension
 *  host does with it - the loading page first, the page with the fetched data once it lands,
 *  and the page's requests answered over the same graph_request channel - so Studio shows the
 *  extension's real comparison UI: the file list and textual diffs, and the binary files' own
 *  hex / picture comparison area (the extension's HexDiffSession machinery, served out of the
 *  same compare.js bundle and driven over the backend adapters above). */
export interface BinaryCompareInput {
	repo?: string;
	fromHash: string;
	toHash: string;
	file: { oldFilePath: string; newFilePath: string; type: string };
}

/** The tab title of a Binary Compare — the extension's own binaryCompareTitle shape,
 *  localised. */
export function binaryCompareTitle(compare: BinaryCompareInput): string {
	const filePath = compare.file.newFilePath !== '' ? compare.file.newFilePath : compare.file.oldFilePath;
	const abbrev = (hash: string) => (hash === '' || hash === UNCOMMITTED ? t('graph.binaryCompare.present') : hash.length > 8 ? hash.slice(0, 8) : hash);
	return tf('graph.binaryCompare.title', filePath, abbrev(compare.fromHash), abbrev(compare.toHash));
}

export class CompareHost {
	readonly frame: HTMLIFrameElement;
	private changes: CompareFileChange[] = [];
	private disposed = false;
	private countsSettled = false;
	/** Hex sessions by file index; at most a few stay alive (each may hold chunk caches), the
	 *  least recently used is evicted - exactly the extension host's own bound. */
	private readonly hexSessions = new Map<number, HexSession>();
	private readonly temps = new TempBlobScope();
	private readonly io = new HexIo(this.temps);
	private readonly onMessage = (event: MessageEvent): void => this.handlePageMessage(event);

	constructor(
		private readonly container: HTMLElement,
		private readonly input: { fromHash: string; toHash: string; singleCommit: boolean; repo?: string },
		private readonly delegate: { openDiff(diff: DiffRequest): void; openBinaryCompare(compare: BinaryCompareInput): void }
	) {
		this.frame = document.createElement('iframe');
		this.frame.title = 'Commit Comparison';
		this.container.appendChild(this.frame);
		window.addEventListener('message', this.onMessage);
		// The page's own load applies the classes; a theme switch swaps the token sheet in place
		// (the page's CSS is all `var(--vscode-*)`, so no re-render is needed).
		this.frame.addEventListener('load', () => applyFrameTheme(this.frame));
		window.addEventListener(THEME_EVENT, this.onTheme);
		void this.load();
	}

	private readonly onTheme = (): void => applyFrameTheme(this.frame);

	dispose(): void {
		this.disposed = true;
		window.removeEventListener('message', this.onMessage);
		window.removeEventListener(THEME_EVENT, this.onTheme);
		for (const session of this.hexSessions.values()) session.dispose();
		this.hexSessions.clear();
		this.temps.release();
	}

	/** The extension host's own load: the comparison, the header's summary cards and the
	 *  commits-between count, fetched in parallel, the page swapped in when they land. */
	private async load(): Promise<void> {
		await this.setPage({ loading: true });
		const repo = this.input.repo;
		const [comparison, summaries, commitsBetween] = await Promise.all([
			graphRequest({ command: 'getCommitComparison', repo, fromHash: this.input.fromHash, toHash: this.input.toHash }),
			graphRequest({ command: 'getCommitSummaries', repo, commitHashes: (this.input.singleCommit ? [this.input.toHash] : [this.input.fromHash, this.input.toHash]).filter((hash) => hash !== '' && hash !== UNCOMMITTED) }),
			this.countBetween()
		]);
		if (this.disposed) return;
		const error = comparison && comparison['error'] === null
			? null
			: String(comparison?.['error'] ?? 'The changes could not be loaded.');
		this.changes = error === null ? ((comparison?.['fileChanges'] as CompareFileChange[] | undefined) ?? []) : [];
		await this.setPage({
			error,
			fileChanges: this.changes,
			summaries: (summaries?.['summaries'] as Record<string, unknown> | undefined) ?? {},
			commitsBetween
		});
	}

	private async countBetween(): Promise<number | null> {
		const { fromHash, toHash, singleCommit } = this.input;
		if (singleCommit || fromHash === '' || fromHash === UNCOMMITTED) return null;
		const tip = toHash === '' || toHash === UNCOMMITTED ? 'HEAD' : toHash;
		const response = await graphRequest({ command: 'countCommitsBefore', repo: this.input.repo, hash: fromHash, branches: [tip], showRemoteBranches: false, includeCommitsMentionedByReflogs: false });
		const count = response?.['count'];
		return typeof count === 'number' ? count : null;
	}

	/** Generate the page with the extension's own template and hand it to the frame, with the
	 *  acquireVsCodeApi shim (state in sessionStorage, requests posted to this host) injected
	 *  under the page's own nonce so its CSP lets it run. The theme's token sheet rides under the
	 *  page's head from the first paint - a srcdoc document inherits nothing from this one, and
	 *  the page's CSS is all `var(--vscode-*, fallback)` tokens - and the `vscode-*` class gates
	 *  its light-theme overrides onto the body. */
	private async setPage(page: Record<string, unknown>): Promise<void> {
		await loadCompareGenerator();
		const build = window.GitGraphCompare;
		if (!build) throw new Error('The Git Graph comparison page generator did not load');
		const html = build.buildComparePage({ ...this.input, ...page });
		const nonce = /nonce="([^"]+)"/.exec(html)?.[1] ?? '';
		const shim = '<script nonce="' + nonce + '">(function(){' +
			'window.acquireVsCodeApi=function(){return{' +
			"postMessage:function(m){window.parent.postMessage({__ggComparePage:m},'*');}," +
			"getState:function(){try{return JSON.parse(sessionStorage.getItem('ggstudio.compareState')||'null');}catch(e){return null;}}," +
			"setState:function(s){sessionStorage.setItem('ggstudio.compareState',JSON.stringify(s));}" +
			'}};' +
			'})();</script>';
		const theme = themeById();
		this.frame.srcdoc = html
			.replace('<head>', '<head>' + hostThemeLink(theme.css) + shim)
			.replace('<body>', `<body class="${theme.kind}">`);
	}

	private handlePageMessage(event: MessageEvent): void {
		if (this.disposed || event.source !== this.frame.contentWindow) return;
		const message = (event.data as { __ggComparePage?: Record<string, unknown> } | null)?.__ggComparePage;
		if (message === undefined) return;
		const command = String(message['command']);
		if (command === 'getFileDiff') {
			void this.answerFileDiff(Number(message['index']));
		} else if (command === 'requestCounts') {
			void this.answerCounts((message['paths'] as string[]) ?? []);
		} else if (command === 'viewDiff') {
			const file = this.changes[Number(message['index'])];
			if (file) this.delegate.openDiff(this.diffRequest(file));
		} else if (command === 'viewDiffBinary') {
			// The extension's own host opens the standalone Binary Compare tab for a binary
			// file, with the comparison's own two ends (comparisonView.ts); so does this one.
			const file = this.changes[Number(message['index'])];
			if (file) {
				this.delegate.openBinaryCompare({
					repo: this.input.repo,
					fromHash: this.input.fromHash,
					toHash: this.input.toHash,
					file: { oldFilePath: file.oldFilePath, newFilePath: file.newFilePath, type: file.type }
				});
			}
		} else if (command === 'getHexInfo') {
			const session = this.hexSession(Number(message['index']));
			if (session) void window.GitGraphCompare?.respondHexInfo?.(session, Number(message['index']), Number(message['bytesPerRow']), (reply) => this.post(reply));
		} else if (command === 'getHexRows') {
			const session = this.hexSessions.get(Number(message['index']));
			if (session) void window.GitGraphCompare?.respondHexRows?.(session, Number(message['index']), Number(message['start']), Number(message['count']), (reply) => this.post(reply));
		} else if (command === 'getImageData') {
			const index = Number(message['index']);
			const session = this.hexSession(index);
			const file = this.changes[index];
			if (session && file) void window.GitGraphCompare?.respondImageData?.(session, index, file, (reply) => this.post(reply));
		} else if (command === 'copyToClipboard') {
			void window.GitGraphCompare?.respondCopyToClipboard?.((reply) => this.post(reply), String(message['type']), String(message['data']));
		}
		this.settlePendingCounts();
	}

	/** The hex session of a file, creating it on first use — the extension host's own
	 *  `hexSession` (src/comparisonView.ts): re-selecting a file reuses its session, and at
	 *  most a few stay alive. */
	private hexSession(index: number): HexSession | null {
		const existing = this.hexSessions.get(index);
		if (existing !== undefined) {
			this.hexSessions.delete(index);
			this.hexSessions.set(index, existing);
			return existing;
		}
		const machinery = window.GitGraphCompare;
		const file = this.changes[index];
		if (machinery === undefined || machinery.createHexSession === undefined || file === undefined) return null;
		const session = machinery.createHexSession(
			{ spawnGitStream: (args, repo) => this.io.spawnGitStream(args, repo) },
			this.input.repo ?? '',
			this.input.fromHash,
			this.input.toHash,
			file
		);
		machinery.wireHexSession?.(session, index, (reply) => this.post(reply));
		this.hexSessions.set(index, session);
		while (this.hexSessions.size > 4) {
			const oldest = this.hexSessions.keys().next();
			if (oldest.done) break;
			const evicted = this.hexSessions.get(oldest.value);
			this.hexSessions.delete(oldest.value);
			evicted?.dispose();
		}
		return session;
	}

	/** The page requests the deferred "+/-" counts only when the right side is a commit
	 *  (`countsPossible` in the generated page); against the working tree its pending
	 *  placeholders would never settle. The engine reports no line counts for a working-tree
	 *  comparison (its counts come from tree diffs), so the rows settle as uncounted - posted
	 *  on the page's first message, when its listener is certainly up. */
	private settlePendingCounts(): void {
		if (this.countsSettled || (this.input.toHash !== UNCOMMITTED && this.input.toHash !== '')) return;
		this.countsSettled = true;
		const counts: Record<string, { additions: null; deletions: null }> = {};
		for (const file of this.changes) {
			if (file.additions === null && file.type !== 'U') {
				counts[file.newFilePath !== '' ? file.newFilePath : file.oldFilePath] = { additions: null, deletions: null };
			}
		}
		if (Object.keys(counts).length > 0) this.post({ command: 'lineCounts', counts });
	}

	private async answerFileDiff(index: number): Promise<void> {
		const file = this.changes[index];
		if (file === undefined) return;
		const response = await graphRequest({ command: 'getCommitFileDiff', repo: this.input.repo, fromHash: this.input.fromHash, toHash: this.input.toHash, oldFilePath: file.oldFilePath, newFilePath: file.newFilePath });
		this.post({ command: 'fileDiff', index, diff: (response?.['diff'] as string | null) ?? null, error: response && response['error'] === null ? null : String(response?.['error'] ?? 'The diff could not be loaded.') });
	}

	private async answerCounts(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		// Never leave the page's request unanswered: an uncommitted right side has no
		// engine-computable counts, so the asked paths settle as uncounted.
		if (this.input.toHash === UNCOMMITTED || this.input.toHash === '') {
			this.post({ command: 'lineCounts', counts: Object.fromEntries(paths.map((path) => [path, { additions: null, deletions: null }])) });
			return;
		}
		const response = await graphRequest({ command: 'commitFileCounts', repo: this.input.repo, from: this.input.fromHash, to: this.input.toHash, paths });
		this.post({ command: 'lineCounts', counts: (response?.['counts'] as Record<string, unknown>) ?? {} });
	}

	private post(message: Record<string, unknown>): void {
		this.frame.contentWindow?.postMessage(message, '*');
	}

	/** "Open Diff in Editor": the shell's own diff editor, titled as the extension's viewDiff
	 *  titles it. */
	private diffRequest(file: CompareFileChange): DiffRequest {
		const from = this.input.fromHash === '' || this.input.fromHash === UNCOMMITTED ? 'HEAD' : this.input.fromHash;
		const to = this.input.toHash;
		const oldPath = toPosix(file.oldFilePath), newPath = toPosix(file.newFilePath || file.oldFilePath);
		return {
			id: `compare:${from}:${oldPath}:${to}:${newPath}`,
			title: `${basename(newPath)} (${from === to ? `${abbrev(from)}^ ↔ ${abbrev(to)}` : `${abbrev(from)} ↔ ${abbrev(to)}`})`,
			repo: this.input.repo,
			left: { revision: from, path: oldPath, label: abbrev(from), exists: file.type !== 'A' },
			right: { revision: to, path: newPath, label: to === UNCOMMITTED ? 'Working Tree' : abbrev(to), exists: file.type !== 'D' }
		};
	}
}

/** The extension's standalone Binary Compare page (out/binaryCompareView.js, served as
 *  gitgraph/binarycompare.js), hosted the same way as the Commit Comparison page: the
 *  extension host's own tab for one binary file between two revisions — the hex view with its
 *  difference navigation, or the picture view with its pixel difference — generated by the
 *  extension's own template and driven by the extension's own HexDiffSession machinery over
 *  the backend adapters. The page always addresses its session as index 0. */
export class BinaryCompareHost {
	readonly frame: HTMLIFrameElement;
	private disposed = false;
	private session: HexSession | null = null;
	private readonly temps = new TempBlobScope();
	private readonly io = new HexIo(this.temps);
	private readonly onMessage = (event: MessageEvent): void => this.handlePageMessage(event);
	private readonly onTheme = (): void => applyFrameTheme(this.frame);

	constructor(private readonly container: HTMLElement, private readonly input: BinaryCompareInput) {
		this.frame = document.createElement('iframe');
		this.frame.title = 'Binary Compare';
		this.container.appendChild(this.frame);
		window.addEventListener('message', this.onMessage);
		this.frame.addEventListener('load', () => applyFrameTheme(this.frame));
		window.addEventListener(THEME_EVENT, this.onTheme);
		void this.setPage();
	}

	dispose(): void {
		this.disposed = true;
		window.removeEventListener('message', this.onMessage);
		window.removeEventListener(THEME_EVENT, this.onTheme);
		this.session?.dispose();
		this.session = null;
		this.temps.release();
	}

	/** Generate the page with the extension's own template and hand it to the frame, with the
	 *  acquireVsCodeApi shim (requests posted to this host) injected under the page's own nonce
	 *  and the theme's token sheet riding under the head from the first paint — the same
	 *  contract the Commit Comparison page is hosted under. */
	private async setPage(): Promise<void> {
		await Promise.all([loadBinaryCompareGenerator(), loadCompareGenerator()]);
		if (this.disposed) return;
		const build = window.GitGraphBinaryCompare;
		if (!build) throw new Error('The Git Graph binary comparison page generator did not load');
		const file = { ...this.input.file, additions: null, deletions: null };
		const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
		const html = build.buildBinaryComparePage({ fromHash: this.input.fromHash, toHash: this.input.toHash, filePath, file });
		const nonce = /nonce="([^"]+)"/.exec(html)?.[1] ?? '';
		const shim = '<script nonce="' + nonce + '">(function(){' +
			'window.acquireVsCodeApi=function(){return{' +
			"postMessage:function(m){window.parent.postMessage({__ggBinComparePage:m},'*');}," +
			"getState:function(){return null;},setState:function(){}" +
			'}};' +
			'})();</script>';
		const theme = themeById();
		this.frame.srcdoc = html
			.replace('<head>', '<head>' + hostThemeLink(theme.css) + shim)
			.replace('<body>', `<body class="${theme.kind}">`);
	}

	private handlePageMessage(event: MessageEvent): void {
		if (this.disposed || event.source !== this.frame.contentWindow) return;
		const message = (event.data as { __ggBinComparePage?: Record<string, unknown> } | null)?.__ggBinComparePage;
		if (message === undefined) return;
		const command = String(message['command']);
		const post = (reply: Record<string, unknown>): void => this.post(reply);
		if (command === 'getHexInfo') {
			const session = this.ensureSession();
			if (session) void window.GitGraphCompare?.respondHexInfo?.(session, 0, Number(message['bytesPerRow']), post);
		} else if (command === 'getHexRows') {
			if (this.session) void window.GitGraphCompare?.respondHexRows?.(this.session, 0, Number(message['start']), Number(message['count']), post);
		} else if (command === 'getImageData') {
			const session = this.ensureSession();
			if (session) void window.GitGraphCompare?.respondImageData?.(session, 0, { ...this.input.file, additions: null, deletions: null }, post);
		} else if (command === 'copyToClipboard') {
			void window.GitGraphCompare?.respondCopyToClipboard?.(post, String(message['type']), String(message['data']));
		}
	}

	/** The one session this page drives, created on its first message (the extension creates
	 *  it with the view; lazily here, which the page cannot tell apart). */
	private ensureSession(): HexSession | null {
		if (this.session !== null) return this.session;
		const machinery = window.GitGraphCompare;
		if (machinery === undefined || machinery.createHexSession === undefined) return null;
		this.session = machinery.createHexSession(
			{ spawnGitStream: (args, repo) => this.io.spawnGitStream(args, repo) },
			this.input.repo ?? '',
			this.input.fromHash,
			this.input.toHash,
			{ ...this.input.file, additions: null, deletions: null }
		);
		machinery.wireHexSession?.(this.session, 0, (reply) => this.post(reply));
		return this.session;
	}

	private post(message: Record<string, unknown>): void {
		this.frame.contentWindow?.postMessage(message, '*');
	}
}

/** The write-path settings the backend consults (cmd_graph.rs's `ActionSettings`): the view's
 *  Settings Widget can change them, so they ride along with every request. */
export interface GraphActionSettings {
	signCommits: boolean;
	signTags: boolean;
	squashMergeMessageFormat: number;
	squashPullMessageFormat: number;
}

/** One Git Graph view request over the app's single backend channel (`graph_request`). This is
 *  the only `invoke` of the protocol in the app — every module that talks to the view's
 *  backend goes through it (scripts/check-seams.mjs enforces that at build time). A transport
 *  failure normalises into the protocol's own `{ command, error, errors }` error response. */
export async function graphRequest(message: Record<string, unknown>, settings: GraphActionSettings | null = null): Promise<Record<string, unknown> | null> {
	const command = String(message['command']);
	try {
		return await invoke<Record<string, unknown> | null>('graph_request', { message, settings });
	} catch (error) {
		return { command, error: String(error), errors: [String(error)] };
	}
}

/** Run one of the view's write requests and settle its confirmation protocol: a data-loss
 *  warning asks `confirm` and retries with `confirmed: true`; any error the protocol reports
 *  (the single `error`, or the first non-null of `errors`) rejects. The workbench's git
 *  commands use this for the operations they share with the view. */
export async function runGraphAction(message: Record<string, unknown>, options: { settings: GraphActionSettings | null; confirm: (text: string) => Promise<boolean> }): Promise<void> {
	let request = message;
	for (;;) {
		const response = await graphRequest(request, options.settings);
		if (response !== null && response['command'] === 'lossWarning') {
			if (!(await options.confirm(String(response['message'])))) return;
			request = { ...request, confirmed: true };
			continue;
		}
		const error = response?.['error'] ?? (Array.isArray(response?.['errors']) ? (response['errors'] as unknown[]).find((e) => e !== null) ?? null : null);
		if (error !== null && error !== undefined) throw new Error(String(error));
		return;
	}
}

type Message = Record<string, unknown>;

/** The requests after which the repository (refs, HEAD, index or working tree) may have changed. */
const WRITE_COMMANDS = new Set([
	'abortOperation', 'addRemote', 'addTag', 'applyStash', 'branchFromStash', 'checkoutBranch', 'checkoutCommit',
	'cherrypickCommit', 'cleanUntrackedFiles', 'commitFixup', 'commitSquash', 'continueOperation', 'createBranch',
	'createPullRequest', 'deleteBranch', 'deleteRemote', 'deleteRemoteBranch', 'deleteTag', 'deleteUserDetails',
	'dropCommit', 'dropStash', 'editCommitMessage', 'editRemote', 'editUserDetails', 'fetch', 'fetchIntoLocalBranch',
	'gerritSetFetchRefs', 'merge', 'popStash', 'pruneRemote', 'pullBranch', 'pushBranch', 'pushStash', 'pushTag',
	'rebase', 'renameBranch', 'resetFileToRevision', 'resetToCommit', 'revertCommit', 'undoLastCommit',
	'worktreeAdd', 'worktreePrune', 'worktreeRemove'
]);

/** The settings the view's Settings Widget may write (src/gitGraphView.ts WRITABLE_GLOBAL_SETTINGS). */
const WRITABLE_SETTINGS: Record<string, (value: unknown) => boolean> = {
	'commitAuthors': (v) => Array.isArray(v) && v.length <= 50 && v.every((a) => typeof a === 'object' && a !== null && typeof a.name === 'string' && typeof a.email === 'string'),
	'graph.style': oneOf('rounded', 'angular'),
	'graph.rowHeight': integerInRange(16, 48),
	'graph.fontSize': integerInRange(8, 24),
	'date.type': oneOf('Author Date', 'Commit Date'),
	'date.format': oneOf('Date & Time', 'Date Only', 'ISO Date & Time', 'ISO Date Only', 'Relative'),
	'referenceLabels.combineLocalAndRemoteBranchLabels': isBoolean,
	'stickyHeader': isBoolean,
	'markdown': isBoolean,
	'repository.commits.initialLoad': integerInRange(1, 100000),
	'repository.commits.loadMore': integerInRange(1, 100000),
	'repository.commits.loadMoreAutomatically': isBoolean,
	'repository.commits.order': oneOf('date', 'author-date', 'topo'),
	'repository.commits.fetchAvatars': isBoolean,
	'repository.showUncommittedChanges': isBoolean,
	'repository.showUntrackedFiles': isBoolean,
	'repository.fetchAndPrune': isBoolean,
	'repository.fetchAndPruneTags': isBoolean,
	'repository.trackRemoteTags': isBoolean,
	'repository.showRemoteBranches': isBoolean,
	'repository.showRemoteHeads': isBoolean,
	'pullRequests.enabled': isBoolean,
	'enableLog': isBoolean
};
function isBoolean(value: unknown): boolean { return typeof value === 'boolean'; }
function oneOf(...allowed: string[]) { return (value: unknown) => typeof value === 'string' && allowed.includes(value); }
function integerInRange(min: number, max: number) { return (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max; }

const UNCOMMITTED = '*';

export interface GraphHostDelegate {
	openFile(path: string): void;
	openDiff(diff: DiffRequest): void;
	openFileAtRevision(revision: string, path: string, title: string, repo?: string): void;
	/** The graph asked for a Commit Comparison tab ("Open Changes", "Compare with..."). */
	openCompareTab(fromHash: string, toHash: string, singleCommit: boolean, repo?: string): void;
	/** The graph asked for a Binary Compare tab - a binary file clicked in the view, or the
	 *  comparison page's "Open Diff in Editor" on one. */
	openBinaryCompare(compare: BinaryCompareInput): void;
	showSourceControl(): void;
	revealTerminal(): void;
	runInTerminal(command: string): void;
	/** The repository changed through the view: the SCM view, the explorer, the status bar catch up. */
	repoChanged(): void;
	/** The "Initialize Repository" button of the not-a-repository placeholder was clicked. */
	initRepository(): void;
}

export class GraphHost {
	/** The element the editor group hosts: the view frame, with the not-a-repository
	 *  placeholder layered over it when the open folder is not a Git repository. */
	readonly element: HTMLDivElement;
	readonly frame: HTMLIFrameElement;
	private repoPath: string | null = null;
	/** Whether the open folder is a Git repository (the placeholder shows when it is not). */
	private isRepo = true;
	/** The repositories the view's dropdown offers: the open repository plus its initialised
	 *  submodules, refreshed from the backend on every load and loadRepos request. */
	private repos: string[] = [];
	/** The repository the view is currently showing (it switches locally in the dropdown);
	 *  `null` while none is loaded. */
	private currentRepo: string | null = null;
	private config: Record<string, unknown> = {};
	/** Serialises requests so responses can never overtake each other on a refresh. */
	private pending: Promise<unknown> = Promise.resolve();
	/** Whether the view frame has been loaded at least once (a locale switch only reloads it then). */
	loaded = false;
	/** The repository the preloaded page started with, if `preload` ran. */
	private preloadRepo: string | null = null;
	/** The preloaded page's boot report once it arrives (`null` while the bundle is still
	 *  coming up): stored on the host, not only handed to a waiting mount, so a signal that
	 *  lands before the mount asks is not lost. */
	private preloadBooted: boolean | null = null;
	/** Resolves once the preloaded page reports whether out.min.js executed. */
	private preloadSettled: ((booted: boolean) => void) | null = null;
	private preloadConsumed = false;

	/** The session log the view's "Open Session Log" action writes out (see `openLogFile`). */
	private sessionLog: string[] = [];
	private firstPageSeen = false;

	constructor(private readonly delegate: GraphHostDelegate) {
		this.element = el('div', 'graph-host');
		// The boot warmer (graphPreload.ts, part of this seam) may already have started the
		// view page in a hidden frame while the workbench was loading: claim that frame
		// instead of a fresh one, so the mount can feed the live page over loadRepos.
		const claimed = claimGraphPreload();
		this.frame = claimed?.frame ?? document.createElement('iframe');
		if (claimed) {
			this.preloadRepo = claimed.repo;
			this.frame.style.display = '';
			// The frame loaded before this host existed: its load event (which applies the
			// theme) has already fired, and the theme may have settled differently since.
			applyFrameTheme(this.frame);
		}
		this.frame.title = 'Git Graph';
		this.frame.setAttribute('aria-label', 'Git Graph');
		this.element.appendChild(this.frame);
		this.logLine('Session started');
		window.addEventListener('message', (event) => this.onMessage(event));
		// Script errors inside the view page (view.html forwards them) belong in the session log.
		window.addEventListener('message', (event) => {
			const data = event.data as { __studioGraphError?: string } | null;
			if (data && typeof data.__studioGraphError === 'string' && event.source === this.frame.contentWindow) {
				this.logLine(`VIEW ERROR: ${data.__studioGraphError}`);
			}
		});
		// The view page's own boot signal (see view.html): the frame's load event fires before
		// out.min.js has necessarily executed, so a preloaded page is only safe to talk to once
		// this arrives.
		window.addEventListener('message', (event) => {
			const data = event.data as { __studioGraphBooted?: boolean } | null;
			if (data && typeof data.__studioGraphBooted === 'boolean' && event.source === this.frame.contentWindow) {
				this.preloadBooted = data.__studioGraphBooted;
				this.preloadSettled?.(data.__studioGraphBooted);
			}
		});
		// The view is same-origin: after it (re)loads - and after a theme switch - its theme
		// stylesheet and vscode-* classes follow the shell's. The boot stage is reported for
		// the view page itself only: an iframe also fires `load` for its initial empty document,
		// which is not a page the user ever sees.
		this.frame.addEventListener('load', () => {
			applyFrameTheme(this.frame);
			const src = this.frame.getAttribute('src') ?? '';
			const isViewPage = this.frame.getAttribute('srcdoc') !== null || (src !== '' && src !== 'about:blank');
			if (isViewPage) void invoke('boot_stage', { stage: 'graph view page loaded', pageMs: performance.now() }).catch(() => undefined);
		});
		window.addEventListener(THEME_EVENT, () => applyFrameTheme(this.frame));
		// The editor group dispatches this on the shared element when the Git Graph tab becomes
		// the visible one (see EditorGroup.activate): the pane may have been `hidden` (zero-size)
		// while the view loaded or last rendered, so its column widths and virtual window are
		// stale. The view (web/observers.ts) already recomputes both, but only in response to a
		// 'resize' event on its own window - raise one now that the frame has its real size back.
		this.element.addEventListener('ggs-graph-shown', () => {
			requestAnimationFrame(() => this.frame.contentWindow?.dispatchEvent(new Event('resize')));
		});
	}

	private logLine(line: string): void {
		const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
		this.sessionLog.push(`[${time}] ${line}`);
		// One session's log stays bounded even in a long-running window.
		if (this.sessionLog.length > 2000) this.sessionLog.splice(0, this.sessionLog.length - 2000);
	}

	/** Build the view config from the extension's own config code plus the stored overrides. */
	private buildConfig(): Record<string, unknown> {
		const build = window.GitGraphStudioConfig;
		if (!build) throw new Error('The Git Graph config bundle (gitgraph/config.js) did not load');
		return build(state.graphSettings());
	}

	/** The git-side settings the backend's write path consults. */
	actionSettings(): GraphActionSettings {
		return {
			signCommits: this.config['signCommits'] === true,
			signTags: this.config['signTags'] === true,
			squashMergeMessageFormat: Number(this.config['squashMergeMessageFormat'] ?? 0),
			squashPullMessageFormat: Number(this.config['squashPullMessageFormat'] ?? 0)
		};
	}

	/** Start the view page in the background for the folder the boot is about to open, so its
	 *  bundle's fetch, parse and first data requests overlap the folder's own open sequence
	 *  instead of serialising after it. The page is started with the one repository known
	 *  synchronously (the boot's remembered folder); `mount` reconciles it with the real
	 *  repository set - feeding it `loadRepos` when it is already running, reloading otherwise
	 *  (the reload then hits warm HTTP and script caches). A page started for any other folder,
	 *  or that never reports its bundle ran, is always reloaded, so a preload that misfires
	 *  costs a little overlap work and nothing else. */
	preload(repoPath: string): void {
		if (this.preloadRepo !== null) return;
		let config: Record<string, unknown>;
		try {
			config = this.buildConfig();
		} catch {
			return; // no config bundle (tests): the preload has nothing to boot with
		}
		this.preloadRepo = repoPath;
		const theme = themeById();
		sessionStorage.setItem('ggstudio.initial', JSON.stringify({
			initialState: {
				config,
				repos: { [repoPath]: state.repoState(repoPath) },
				lastActiveRepo: repoPath,
				loadViewTo: null,
				loadRepoInfoRefreshId: 0,
				loadCommitsRefreshId: 0,
				backend: { platform: 'studio', engineAvailable: true, engineVersion: 'embedded', gitCliAvailable: true, capabilities: [] }
			},
			globalState: state.globalViewState(),
			workspaceState: state.workspaceViewState(),
			theme: { css: theme.css, kind: theme.kind, label: theme.label }
		}));
		this.frame.src = '/gitgraph/view.html';
	}

	/** The preloaded page's boot report: resolves `true` once out.min.js has executed there,
	 *  `false` when its load failed, or `null` after a short grace (never answered - the mount
	 *  then falls back to the plain reload). A page that finished booting before this host
	 *  attached left its mark on its own window (view.html), which is read first - the boot
	 *  message alone would have been missed. */
	private whenPreloadSettled(generation: number): Promise<boolean | null> {
		if (this.preloadBooted !== null) {
			return Promise.resolve(generation === this.loadGeneration ? this.preloadBooted : null);
		}
		if (this.viewPageBooted()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = window.setTimeout(() => {
				this.preloadSettled = null;
				resolve(this.viewPageBooted() ? true : null);
			}, 1500);
			this.preloadSettled = (booted) => {
				window.clearTimeout(timer);
				this.preloadSettled = null;
				resolve(generation === this.loadGeneration ? booted : null);
			};
		});
	}

	/** Whether the frame's page booted fully (the bundle executed, and it found an initial
	 *  state - a page that showed the no-repository placeholder never ran the bundle). */
	private viewPageBooted(): boolean {
		try {
			const viewWindow = this.frame.contentWindow as (Window & { __ggViewBooted?: boolean; __ggViewNoRepo?: boolean }) | null;
			return viewWindow?.__ggViewBooted === true && viewWindow.__ggViewNoRepo !== true;
		} catch {
			return false;
		}
	}

	/** Load (or reload) the view for a repository. The page is the app's own
	 *  /gitgraph/view.html (the extension is integrated: its assets ship with the app), and the
	 *  mount runs asynchronously so the frame shows the page as soon as it is ready. A folder
	 *  that is not a Git repository gets the placeholder with the Initialize button instead. */
	load(repoPath: string | null, isRepo = true): void {
		const switched = this.repoPath !== repoPath;
		this.repoPath = repoPath;
		this.isRepo = isRepo;
		if (!isRepo || repoPath === null) {
			this.currentRepo = null;
			this.loadGeneration++;
			this.uncommittedStabiliser.reset();
			this.showPlaceholder(repoPath !== null);
			this.loaded = false;
			return;
		}
		// A reload of the same folder keeps the repository the view had selected (a submodule,
		// perhaps); switching folders starts from the newly opened one.
		if (switched) {
			this.currentRepo = null;
			// The uncommitted count of the previous repository says nothing about this one
			this.uncommittedStabiliser.reset();
			// The view's persisted state (written by the page's shim, see view.html) names the
			// repository it last showed. Offered back to a freshly mounted page it becomes a
			// loadViewTo into a repository set that does not contain it, and the view greets the
			// switch with its "not currently included in Git Graph" error naming the previous
			// repository. A switch starts from a clean slate; a reload of the same folder keeps
			// the state, so the reader's place survives it.
			sessionStorage.removeItem('ggstudio.viewState');
		}
		this.hidePlaceholder();
		this.loaded = true;
		const generation = ++this.loadGeneration;
		void this.mount(repoPath, generation).catch((error) => this.logLine(`VIEW LOAD FAILED: ${String(error)}`));
	}

	private loadGeneration = 0;

	/** The uncommitted-row follow-up's flicker guard; reset when the rendered repository changes
	 *  (the previous repository's count says nothing about the next one). */
	private readonly uncommittedStabiliser = new UncommittedCountStabiliser(UNCOMMITTED_ZERO_CONFIRM_MS, UNCOMMITTED_RECHECK_MS);

	/** The repository set for the view: the open repository plus its initialised submodules,
	 *  each with its saved view state. */
	private repoStates(): Record<string, unknown> {
		const repos: Record<string, unknown> = {};
		for (const repo of this.repos) repos[repo] = state.repoState(repo);
		return repos;
	}

	/** Re-read the submodule roots from the backend (a `git submodule update` may have
	 *  initialised some since the last look). */
	private async refreshRepos(): Promise<void> {
		const repoPath = this.repoPath;
		if (repoPath === null) {
			this.repos = [];
			return;
		}
		const submodules = await invoke<string[]>('repo_submodules', { repo: repoPath }).catch(() => []);
		// The folder may have switched while the submodules were being read: the old repo's
		// list must not end up in the new view's repository picker.
		if (repoPath !== this.repoPath) return;
		this.repos = [repoPath, ...submodules];
	}

	private async mount(repoPath: string, generation: number): Promise<void> {
		await this.refreshRepos();
		if (generation !== this.loadGeneration) return; // superseded by a newer load / unload
		// A repository switch asked for while the load was still running (a submodule's graph
		// icon in the Source Control view clicked right after the folder opened) lands directly
		// on the freshly loaded view.
		const pendingRepo = this.pendingRepo;
		this.pendingRepo = null;
		if (pendingRepo !== null && this.repos.includes(pendingRepo)) this.currentRepo = pendingRepo;
		this.currentRepo ??= repoPath;
		this.config = this.buildConfig();
		const initialState = {
			config: this.config,
			lastActiveRepo: this.currentRepo,
			loadViewTo: this.pendingFilterPath !== null ? { repo: repoPath, filterPath: this.pendingFilterPath } : null,
			loadRepoInfoRefreshId: 0,
			loadCommitsRefreshId: 0,
			backend: { platform: 'studio', engineAvailable: true, engineVersion: 'embedded', gitCliAvailable: true, capabilities: [] }
		};
		// sessionStorage: per-window, so a second instance of the app (another window,
		// another repository) cannot have its own mount overwrite this one's initial state.
		// The view page reads it back on boot (static/gitgraph/view.html) - `theme` included so
		// the page can link its own theme stylesheet up front and wait for it, instead of relying
		// on this host inserting one later once the frame's `load` fires (too late for the
		// view's first, synchronous read of the --vscode-* colour tokens: see applyFrameTheme).
		const theme = themeById();
		sessionStorage.setItem('ggstudio.initial', JSON.stringify({
			initialState: { ...initialState, repos: this.repoStates() },
			globalState: state.globalViewState(),
			workspaceState: state.workspaceViewState(),
			theme: { css: theme.css, kind: theme.kind, label: theme.label }
		}));
		// A (re)load re-reads the init state; the fresh page drops every cache. No
		// cache-busting query: the page's freshness comes from the init state it reads on boot,
		// and letting the webview cache the (multi-hundred-kilobyte) bundle makes every reload
		// after the first one cheaper.
		this.frame.removeAttribute('srcdoc');
		if (!this.firstPageSeen) void invoke('boot_stage', { stage: 'graph view load started', pageMs: performance.now() }).catch(() => undefined);
		// The preloaded page is already running this very repository: hand it the full
		// repository set instead of paying the bundle's fetch and parse a second time.
		if (!this.preloadConsumed && this.preloadRepo === repoPath) {
			this.preloadConsumed = true;
			const settled = await this.whenPreloadSettled(generation);
			if (generation !== this.loadGeneration) return;
			if (settled === true) {
				const loadViewTo = this.pendingFilterPath !== null ? { repo: repoPath, filterPath: this.pendingFilterPath } : null;
				this.post({ command: 'loadRepos', repos: this.repoStates(), lastActiveRepo: this.currentRepo, loadViewTo });
				this.pendingFilterPath = null;
				return;
			}
			// Never answered (or the bundle failed): the plain reload below recovers.
		}
		this.preloadConsumed = true;
		this.frame.src = '/gitgraph/view.html';
		this.pendingFilterPath = null;
	}

	unload(): void {
		this.repoPath = null;
		this.currentRepo = null;
		this.loadGeneration++;
		this.uncommittedStabiliser.reset();
		this.showPlaceholder(false);
		this.frame.removeAttribute('srcdoc');
		this.frame.src = 'about:blank';
		this.loaded = false;
		// The warm preloaded page is gone with the folder; the next mount reloads.
		this.preloadRepo = null;
		this.preloadConsumed = false;
	}

	/* ---------- The not-a-repository placeholder ---------- */

	private placeholder: HTMLElement | null = null;

	/** Cover the (blank) frame with the placeholder. `overFolder` says whether a folder is
	 *  open (the Initialize button only makes sense then). */
	private showPlaceholder(overFolder: boolean): void {
		this.hidePlaceholder();
		this.frame.removeAttribute('src');
		this.frame.removeAttribute('srcdoc');
		this.frame.src = 'about:blank';
		// The preloaded view page (if any) is replaced by the blank document.
		this.preloadRepo = null;
		this.preloadConsumed = false;
		if (!overFolder) return;
		const button = el('button', 'button', ['Initialize Repository']);
		button.addEventListener('click', () => this.delegate.initRepository());
		this.placeholder = el('div', 'graph-placeholder', [
			el('div', '', [
				el('h2', '', ['Not a Git repository']),
				el('p', '', ['The folder that is open does not contain a Git repository. Initialize one to see its graph, changes and branches here.']),
				button
			])
		]);
		this.element.appendChild(this.placeholder);
	}

	private hidePlaceholder(): void {
		this.placeholder?.remove();
		this.placeholder = null;
	}

	/** Ask the view to refresh (what the extension's file watcher triggers). */
	refresh(): void {
		if (this.loaded) this.post({ command: 'refresh' });
	}

	/** A path filter asked for before the view finished a load; applied by `mount`. */
	private pendingFilterPath: string | null = null;
	/** A repository switch asked for before the view finished a load; applied by `mount`. */
	private pendingRepo: string | null = null;

	/** Switch the view to another repository of its dropdown's set (the open repository or one
	 *  of its submodules) - the Source Control view's per-repository graph icon. The view
	 *  re-renders its repository dropdown and loads that repository, exactly what its own
	 *  dropdown switch produces; a switch asked for before the load settles is applied by
	 *  `mount` instead. */
	switchRepo(repo: string): void {
		if (!this.loaded || !this.currentRepo) {
			this.pendingRepo = repo;
			return;
		}
		if (this.currentRepo === repo) return;
		const postSwitch = () => {
			if (this.currentRepo === repo || !this.repos.includes(repo)) return;
			this.currentRepo = repo;
			// The uncommitted count of the previous repository says nothing about this one
			this.uncommittedStabiliser.reset();
			this.post({ command: 'loadRepos', repos: this.repoStates(), lastActiveRepo: repo, loadViewTo: { repo } });
		};
		// The Source Control view may know a submodule this host has not re-read since its load
		// (it was initialised in between): refresh the repository set before switching.
		if (this.repos.includes(repo)) postSwitch();
		else void this.refreshRepos().then(postSwitch);
	}

	/** Filter the view's commits to one or more files (Git Graph RS: Show File History in Git
	 *  Graph, `git-graph-rs.filterByFile`). `relativePath` is repo-relative, posix; multiple
	 *  paths join with commas - the filter syntax the view's own dataSource splits on. */
	filterByFile(relativePath: string): void {
		if (!this.repoPath) return;
		if (!this.loaded || !this.currentRepo) {
			this.pendingFilterPath = relativePath;
			return;
		}
		this.post({ command: 'loadRepos', repos: this.repoStates(), lastActiveRepo: this.currentRepo, loadViewTo: { repo: this.currentRepo, filterPath: relativePath } });
	}

	private post(message: Message): void {
		this.frame.contentWindow?.postMessage({ __studioGraphResponse: message }, '*');
	}

	/* ---------- Requests ---------- */

	private onMessage(event: MessageEvent): void {
		const data = event.data as { __studioGraphRequest?: Message } | null;
		if (!data || data.__studioGraphRequest === undefined) return;
		if (event.source !== this.frame.contentWindow) return;
		const request = data.__studioGraphRequest;
		const command = String(request['command']);
		if (typeof request['repo'] === 'string' && request['repo'] !== '') this.currentRepo = request['repo'];
		const failed = (error: unknown) => {
			this.logLine(`ERROR handling ${command}: ${String(error)}`);
			this.post({ command, error: String(error), errors: [String(error)] });
		};
		// Reads run concurrently - the view's opening burst (repo info, config, the first page)
		// then costs one backend round trip, not their sum; writes chain behind everything
		// before them, as they did in the extension host, so a refresh never overtakes the
		// operation it reports on.
		if (WRITE_COMMANDS.has(command)) {
			this.pending = this.pending.then(() => this.handle(request)).catch(failed);
			return;
		}
		const read = this.handle(request).catch(failed);
		this.pending = Promise.all([this.pending, read]).then(() => undefined);
	}

	private async handle(request: Message): Promise<void> {
		const command = String(request['command']);
		const handled = await this.handleLocally(command, request);
		if (handled) return;

		// The Gerrit remote and the resolved fetch limit ride along with the requests the
		// backend's Gerrit pipeline reads (the view's own message names neither).
		if (command === 'loadCommits' && request['gerritFetchRefs'] === true) {
			request = { ...request, gerritRemote: this.gerritRemote(), gerritFetchLimit: this.gerritFetchLimitOf(request) };
		} else if (command === 'gerritSetFetchRefs') {
			request = { ...request, gerritRemote: this.gerritRemote() };
		}
		// The "Uncommitted Changes" row is deferred off every load, as the extension host deferred
		// it: the row's count is a whole-working-tree status scan - seconds on a large tree - and
		// the page must never wait for it. The backend answers without the row and flags the
		// response `uncommittedPending`; the count is delivered by the follow-up below.
		if (command === 'loadCommits') {
			request = { ...request, deferUncommittedChanges: true };
		}

		const started = performance.now();
		// Until the first page is up, every request is a boot stage too (sent and answered),
		// so the boot log shows what the graph waited on before it became visible.
		const booting = !this.firstPageSeen;
		if (booting) void invoke('boot_stage', { stage: `graph ${command} sent`, pageMs: started }).catch(() => undefined);
		const response = await graphRequest(request, this.actionSettings());
		// Every backend round trip is timed into the session log; the first page of commits is
		// also a boot stage, so the boot log shows when the graph became visible.
		this.logLine(`${command}: ${(performance.now() - started).toFixed(0)} ms`);
		if (booting) void invoke('boot_stage', { stage: `graph ${command} answered`, pageMs: performance.now() }).catch(() => undefined);
		if (command === 'loadCommits' && !this.firstPageSeen) {
			this.firstPageSeen = true;
			void invoke('boot_stage', { stage: 'graph first page', pageMs: performance.now() }).catch(() => undefined);
		}
		if (response === null) return;
		if (response['error'] !== null && response['error'] !== undefined) {
			this.logLine(`ERROR ${command}: ${String(response['error'])}`);
		} else if (WRITE_COMMANDS.has(command)) {
			this.logLine(`${command} completed`);
		}
		this.decorate(command, request, response);
		this.post(response);
		if (command === 'loadCommits' && response['error'] === null) {
			// The completion pipeline runs behind the first paint, the stages of the extension
			// host's own load: the Gerrit refresh first (its staged responses arrive as further
			// `loadCommits` responses under the same refresh id), then the "Uncommitted Changes"
			// count on top of the commit data the pipeline actually rendered.
			// The pipeline captures the load generation: a folder switch or unload remounts the
			// frame, and the fresh page restarts its refresh-id counter at 0, so the id alone can
			// no longer reject a completion the old page's load scheduled - without this guard a
			// stale follow-up could paint the previous repository's commits into the new page.
			const generation = this.loadGeneration;
			const gerrit = response['gerritPending'] === true
				? this.gerritFollowUp(request, generation)
				: Promise.resolve<Message | null>(null);
			void gerrit.then((stage) => this.uncommittedFollowUp(request, stage ?? response, generation));
		}
		if (WRITE_COMMANDS.has(command) && response['command'] !== 'lossWarning') {
			this.delegate.repoChanged();
			if (command === 'cherrypickCommit' && request['noCommit'] === true && (response['errors'] as unknown[])?.[0] === null) {
				this.delegate.showSourceControl();
			}
			if (command === 'createPullRequest' && (response['errors'] as unknown[])?.[0] === null) {
				await this.openPullRequestUrl(request);
			}
		}
	}

	/** Fields the extension host adds from its own state: code reviews. */
	private decorate(command: string, request: Message, response: Message): void {
		// Reviews are keyed by the repository the request names (a submodule's review lives
		// under the submodule), exactly as handleLocally's start/update/end store them.
		const repo = typeof request['repo'] === 'string' && request['repo'] !== '' ? request['repo'] : this.repoPath;
		if (!repo) return;
		if (command === 'commitDetails' && request['commitHash'] !== UNCOMMITTED) {
			response['codeReview'] = touchCodeReview(repo, String(request['commitHash']));
		} else if (command === 'compareCommits' && request['toHash'] !== UNCOMMITTED) {
			response['codeReview'] = touchCodeReview(repo, `${request['fromHash']}-${request['toHash']}`);
		}
	}

	/* ---------- Gerrit change states (the review badges) ---------- */

	/** The Gerrit remote of the extension's configuration (gitgraph/config.js defaults it to
	 *  "origin"); the backend's pipeline lists and fetches `refs/changes/*` from it. */
	private gerritRemote(): string {
		const gerrit = this.config['gerrit'] as { remote?: unknown } | undefined;
		return typeof gerrit?.['remote'] === 'string' && gerrit['remote'] !== '' ? gerrit['remote'] : 'origin';
	}

	/** The fetch limit a request's Gerrit states are selected under: the repository's own limit,
	 *  or the configuration's when it carries none (gitGraphView.ts `gerritFetchLimitOf`). */
	private gerritFetchLimitOf(request: Message): number {
		const limit = request['gerritFetchLimit'];
		if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 10000) return limit;
		const gerrit = this.config['gerrit'] as { fetchLimit?: unknown } | undefined;
		return typeof gerrit?.['fetchLimit'] === 'number' && gerrit['fetchLimit'] >= 1 ? gerrit['fetchLimit'] : 20;
	}

	/** One follow-up pipeline per repository: concurrent loads chain onto the one running, so a
	 * refresh is never run twice over the same remote. Resolves to the final `loadCommits`
	 * response the pipeline posted (the Gerrit stages' last), or `null` when it delivered
	 * nothing - a failed refresh leaves the page as it rendered it. */
	private readonly gerritFollowUps = new Map<string, Promise<Message | null>>();

	private gerritFollowUp(request: Message, generation: number): Promise<Message | null> {
		const repo = typeof request['repo'] === 'string' && request['repo'] !== '' ? request['repo'] : this.repoPath;
		if (!repo) return Promise.resolve(null);
		const chained = (this.gerritFollowUps.get(repo) ?? Promise.resolve<Message | null>(null)).then(() => this.runGerritFollowUp(request, repo, generation));
		this.gerritFollowUps.set(repo, chained);
		chained.then(() => {
			if (this.gerritFollowUps.get(repo) === chained) this.gerritFollowUps.delete(repo);
		}, () => undefined);
		return chained;
	}

	/** Complete a load the backend answered `gerritPending` (gitGraphView.ts
	 * `loadCommitsGerritFollowUp`): run the refresh pipeline, then deliver the fresh states as
	 * two further `loadCommits` responses under the same refresh id - first the light part the
	 * badges render (no event timelines), then the full states, which only the review dialog a
	 * badge click opens reads. A failed refresh still delivers the reloaded page with the
	 * previously cached states, exactly as the extension degrades; a still-pending cache leaves
	 * the retry to the next load, so the follow-up never loops. Returns the full stage it
	 * posted, or `null` when the pipeline failed before delivering one. */
	private async runGerritFollowUp(request: Message, repo: string, generation: number): Promise<Message | null> {
		const settings = this.actionSettings();
		const started = performance.now();
		const refresh = await graphRequest({
			command: 'gerritRefresh',
			repo,
			gerritRemote: this.gerritRemote(),
			gerritFetchLimit: this.gerritFetchLimitOf(request),
			gerritStatusFilter: request['gerritStatusFilter']
		}, settings);
		if (generation !== this.loadGeneration) return null; // remounted onto another page: the staged responses would paint the old one
		if (refresh !== null && refresh['error'] !== null && refresh['error'] !== undefined) {
			this.logLine(`gerritRefresh failed: ${String(refresh['error'])}`);
		}
		const stage = await graphRequest({ ...request, gerritRemote: this.gerritRemote(), gerritFetchLimit: this.gerritFetchLimitOf(request) }, settings);
		if (generation !== this.loadGeneration) return null;
		this.logLine(`gerritRefresh + stage: ${(performance.now() - started).toFixed(0)} ms`);
		if (stage === null || (stage['error'] !== null && stage['error'] !== undefined)) {
			if (stage !== null) this.logLine(`ERROR gerrit stage: ${String(stage['error'])}`);
			return null;
		}
		delete stage['gerritPending'];
		const states = stage['gerritStates'];
		if (Array.isArray(states)) {
			this.post({ ...stage, gerritStates: (states as Message[]).map((state) => ({ ...state, events: [], eventsPending: true })) });
		}
		this.post(stage);
		return stage;
	}

	/** Deliver the deferred "Uncommitted Changes" row (gitGraphView.ts
	 * `sendUncommittedChangesFollowUp`): count the working tree - the scan the load deferred -
	 * and repeat the page's response with the exact count, under the same refresh id. The view
	 * synthesises the row from the count itself (its own locale strings), keeps an already
	 * rendered row in place while the count is `pending`, and drops the row on a count of zero;
	 * a row whose HEAD is not on the page would have no parent to hang off, so such pages ask
	 * for no count at all. One pipeline per repository, so refreshes cannot stack scans. */
	private readonly uncommittedFollowUps = new Map<string, Promise<void>>();

	private uncommittedFollowUp(request: Message, page: Message, generation: number): Promise<void> {
		const repo = typeof request['repo'] === 'string' && request['repo'] !== '' ? request['repo'] : this.repoPath;
		if (!repo) return Promise.resolve();
		const run = () => this.runUncommittedFollowUp(request, page, repo, generation);
		const chained = (this.uncommittedFollowUps.get(repo) ?? Promise.resolve()).then(run, run);
		this.uncommittedFollowUps.set(repo, chained);
		chained.then(() => {
			if (this.uncommittedFollowUps.get(repo) === chained) this.uncommittedFollowUps.delete(repo);
		}, () => undefined);
		return chained;
	}

	private async runUncommittedFollowUp(request: Message, page: Message, repo: string, generation: number): Promise<void> {
		if (this.config['showUncommittedChanges'] === false) return;
		const head = page['head'];
		const commits = page['commits'];
		// Exactly the guard the extension's follow-up applies: the row is a child of HEAD, so it
		// only exists when HEAD is among the loaded commits.
		if (typeof head !== 'string' || head === '' || !Array.isArray(commits)
			|| !commits.some((commit) => (commit as Message)['hash'] === head)) return;
		const started = performance.now();
		let count = await this.readUncommittedCount(repo);
		this.logLine(`countUncommittedChanges: ${(performance.now() - started).toFixed(0)} ms`);
		// The confirm loop is bounded: a status read that keeps failing (or zeros that keep racing
		// new reads) gives up after twice the confirm window, leaving the row at its last delivered
		// state for the next refresh to settle.
		let attemptsLeft = Math.ceil((2 * UNCOMMITTED_ZERO_CONFIRM_MS) / UNCOMMITTED_RECHECK_MS);
		while (true) {
			// Remounted onto another page (folder switch, unload): the row this count completes is
			// gone, and the stale completion must not reach the fresh page.
			if (generation !== this.loadGeneration) return;
			if (request['hard'] === true) {
				// A hard refresh wiped the view (the row included) before this pipeline started, so
				// there is no rendered row whose disappearance needs stabilising: deliver the
				// reading directly, and give up on a read that fails.
				if (count === null) return;
				this.postUncommittedCompletion(page, count);
				this.uncommittedStabiliser.delivered(count);
				return;
			}
			const outcome = this.uncommittedStabiliser.observe(count, Date.now());
			if ('recheckAfterMs' in outcome) {
				if (--attemptsLeft < 0) return;
				await new Promise((resolve) => setTimeout(resolve, outcome.recheckAfterMs));
				count = await this.readUncommittedCount(repo);
				continue;
			}
			this.postUncommittedCompletion(page, outcome.send);
			this.uncommittedStabiliser.delivered(outcome.send);
			return;
		}
	}

	/** Read the deferred row's count on its own backend round trip. A failed scan reads as null -
	 *  "unknown", never 0: a momentarily failing status scan is exactly how the row used to
	 *  vanish and come back. */
	private async readUncommittedCount(repo: string): Promise<number | null> {
		const counted = await graphRequest({
			command: 'countUncommittedChanges',
			repo,
			includeUntracked: this.config['showUntrackedFiles'] !== false
		}, this.actionSettings());
		if (counted === null || counted['error'] !== null && counted['error'] !== undefined) {
			if (counted !== null) this.logLine(`ERROR countUncommittedChanges: ${String(counted['error'])}`);
			return null;
		}
		return typeof counted['count'] === 'number' ? counted['count'] : null;
	}

	/** Repeat the page with the confirmed count under the same refresh id. `gerritPending` is
	 *  stripped from the repeat: this response completes the uncommitted row, and on the
	 *  Gerrit-failure fallback the flag would promise states no pipeline is coming to deliver. */
	private postUncommittedCompletion(page: Message, count: number): void {
		const completion: Message = { ...page, uncommittedCount: count };
		delete completion['gerritPending'];
		this.post(completion);
	}

	/** `viewDiff` opens the shell's own diff editor, titled as the extension's viewDiff titles
	 *  it (the VS Code-side analog: the extension opens the native diff editor). Untracked
	 *  (`U`) has no revision to diff against, so it just opens the working file. */
	private viewDiffRequest(repo: string, request: Message): void {
		const from = String(request['fromHash']), to = String(request['toHash']);
		const type = String(request['type']);
		const oldPath = toPosix(String(request['oldFilePath'])), newPath = toPosix(String(request['newFilePath']));
		if (type === 'U') {
			this.delegate.openFile(joinPath(repo, newPath));
			return;
		}
		const leftRevision = resolveDiffFromHash(from, to);
		const toLabel = to === UNCOMMITTED ? 'Present' : abbrev(to);
		const description = from === to
			? (from === UNCOMMITTED ? 'Uncommitted Changes' : type === 'A' ? `Added in ${toLabel}` : type === 'D' ? `Deleted in ${toLabel}` : `${abbrev(leftRevision)} ↔ ${toLabel}`)
			: (type === 'A' ? `Added between ${abbrev(from)} & ${toLabel}` : type === 'D' ? `Deleted between ${abbrev(from)} & ${toLabel}` : `${abbrev(from)} ↔ ${toLabel}`);
		this.delegate.openDiff({
			id: `graph:${leftRevision}:${oldPath}:${to}:${newPath}`,
			title: `${basename(newPath)} (${description})`,
			repo,
			left: { revision: leftRevision, path: oldPath, label: abbrev(leftRevision), exists: type !== 'A' },
			right: { revision: to, path: newPath, label: to === UNCOMMITTED ? 'Working Tree' : abbrev(to), exists: type !== 'D' }
		});
	}

	/** The requests the shell serves itself. Returns true when handled. */
	private async handleLocally(command: string, request: Message): Promise<boolean> {
		// The repository the request names - a submodule's graph sends its own path, and every
		// file/diff/revision it opens must read that submodule, not the open repository.
		const repo = typeof request['repo'] === 'string' && request['repo'] !== '' ? request['repo'] : (this.repoPath ?? '');
		const ok = (extra: Message = {}) => this.post({ command, error: null, ...extra });
		switch (command) {
			case 'loadRepos': {
				// The view re-checks on focus and after a rescan: submodules may have been
				// initialised since the load, so the set is re-read before answering.
				void this.refreshRepos().then(() => {
					this.post({ command, repos: this.repoStates(), lastActiveRepo: this.currentRepo ?? this.repoPath, loadViewTo: null });
				});
				return true;
			}
			case 'setRepoState':
				state.saveRepoState(String(request['repo']), request['state'] as Record<string, unknown>);
				return true;
			case 'setGlobalViewState':
				state.save('globalViewState', request['state']);
				ok();
				return true;
			case 'setWorkspaceViewState':
				state.save('workspaceViewState', request['state']);
				ok();
				return true;
			case 'setGlobalSetting': {
				const key = String(request['setting']);
				const validate = Object.prototype.hasOwnProperty.call(WRITABLE_SETTINGS, key) ? WRITABLE_SETTINGS[key]! : null;
				if (validate === null) {
					this.post({ command, setting: key, authorConfigTouched: false, error: `The setting "${key}" cannot be written from the Git Graph View.` });
				} else if (!validate(request['value'])) {
					this.post({ command, setting: key, authorConfigTouched: false, error: `The value provided for "${key}" is not valid.` });
				} else {
					state.saveGraphSetting(key, request['value']);
					this.post({ command, setting: key, authorConfigTouched: key === 'commitAuthors', error: null });
					// Apply live, as the extension does on a configuration change.
					this.config = this.buildConfig();
					this.post({ command: 'configChanged', config: this.config });
				}
				return true;
			}
			case 'showErrorMessage':
				notify('error', String(request['message']));
				return true;
			case 'openFile':
				this.delegate.openFile(joinPath(repo, String(request['filePath'])));
				ok();
				return true;
			case 'viewFileAtRevision': {
				const hash = String(request['hash']);
				const path = String(request['filePath']);
				this.delegate.openFileAtRevision(hash, path, `${abbrev(hash)}: ${basename(path)}`, repo);
				ok();
				return true;
			}
			case 'viewDiff':
				this.viewDiffRequest(repo, request);
				ok();
				return true;
			case 'viewDiffWithWorkingFile': {
				const hash = String(request['hash']);
				const path = toPosix(String(request['filePath']));
				this.delegate.openDiff({
					id: `graph:${hash}:${path}:*:${path}`,
					title: `${basename(path)} (${abbrev(hash)} ↔ Present)`,
					repo,
					left: { revision: hash, path, label: abbrev(hash), exists: true },
					right: { revision: UNCOMMITTED, path, label: 'Working Tree', exists: true }
				});
				ok();
				return true;
			}
			case 'viewDiffBinary':
				// The extension's own handler (src/gitGraphView.ts) opens the standalone Binary
				// Compare tab - the extension's page, hosted by BinaryCompareHost - with the
				// left side resolved exactly as its viewDiff resolves it, and sends no response;
				// the shell keeps both halves of that contract.
				this.delegate.openBinaryCompare({
					repo,
					fromHash: resolveDiffFromHash(String(request['fromHash']), String(request['toHash'])),
					toHash: String(request['toHash']),
					file: {
						oldFilePath: String(request['oldFilePath']),
						newFilePath: String(request['newFilePath']),
						type: String(request['type'])
					}
				});
				return true;
			case 'openCompareTab':
				this.delegate.openCompareTab(String(request['fromHash']), String(request['toHash']), request['singleCommit'] === true, repo);
				return true;
			case 'viewScm':
				this.delegate.showSourceControl();
				ok();
				return true;
			case 'openTerminal':
				this.delegate.revealTerminal();
				ok();
				return true;
			case 'rebase':
				if (request['interactive'] === true) {
					// The extension types an interactive rebase into the integrated terminal.
					const obj = String(request['obj']);
					const onBranch = request['actionOn'] === 'Branch';
					const parts = ['git', 'rebase', '--interactive'];
					if (request['autosquash'] === true) parts.push('--autosquash');
					if (this.config['signCommits'] === true) parts.push('-S');
					parts.push(onBranch ? quoteShellArg(obj) : obj);
					this.delegate.runInTerminal(parts.join(' '));
					this.post({ command, actionOn: request['actionOn'], interactive: true, error: null });
					return true;
				}
				return false;
			case 'openExternalDirDiff':
				if (request['isGui'] !== true) {
					const from = String(request['fromHash']), to = String(request['toHash']);
					const range = from === to ? (to === UNCOMMITTED ? 'HEAD' : `${to}^..${to}`) : to === UNCOMMITTED ? from : `${from}..${to}`;
					this.delegate.runInTerminal(`git difftool --dir-diff ${range}`);
					ok();
					return true;
				}
				return false;
			case 'createArchive': {
				const ref = String(request['ref']);
				const safeName = ref.replace(/[\\/:*?"<>|]/g, '-');
				let target: string | null = null;
				try {
					target = await saveDialog({
						title: 'Create Archive',
						defaultPath: joinPath(repo, `${safeName}.zip`),
						filters: [{ name: 'ZIP Archive', extensions: ['zip'] }, { name: 'TAR Archive', extensions: ['tar'] }]
					});
				} catch (error) {
					this.post({ command, error: String(error) });
					return true;
				}
				if (!target) {
					ok();
					return true;
				}
				const response = await graphRequest({ ...request, outputFilePath: target }, this.actionSettings());
				if (response === null) return true;
				this.post(response);
				if (response['error'] === null) notify('info', `Archive created: ${target}`);
				return true;
			}
			case 'exportRepoConfig': {
				try {
					const file = exportableRepoConfig(state.repoState(repo));
					const dir = joinPath(repo, '.vscode');
					await invoke('create_folder', { path: dir }).catch(() => undefined);
					const target = joinPath(dir, 'git-graph-rs.json');
					await invoke('write_file', { path: target, contents: JSON.stringify(file, null, 4) });
					const current = state.repoState(repo);
					current['lastImportAt'] = file.exportedAt;
					state.saveRepoState(repo, current);
					notify('info', `The repository configuration was exported to ${target}`);
					ok();
				} catch (error) {
					this.post({ command, error: String(error) });
				}
				return true;
			}
			case 'setInterfaceLanguage': {
				const language = request['language'];
				if (language === 'auto' || language === 'en' || language === 'zh-cn') {
					state.saveGraphSetting('interfaceLanguage', language);
					this.logLine(`Interface language set to "${language}"`);
					this.post({ command, error: null });
					// The extension's configuration listener reloads the view to re-render it in
					// the new language (the Settings Widget is restored from the view state).
					this.load(this.repoPath);
				} else {
					this.post({ command, error: 'The value provided for "interfaceLanguage" is not valid.' });
				}
				return true;
			}
			case 'openExtensionSettings':
				notify('info', 'Git Graph Studio has no separate settings page: every setting the app supports is in this Settings widget.');
				ok();
				return true;
			case 'openLogFile': {
				try {
					const path = await invoke<string>('session_log_file');
					await invoke('write_file', { path, contents: this.sessionLog.join('\n') + '\n' });
					this.delegate.openFile(path);
					ok();
				} catch (error) {
					this.post({ command, error: String(error) });
				}
				return true;
			}
			case 'startCodeReview': {
				const review: state.CodeReview = { id: String(request['id']), lastActive: Date.now(), lastViewedFile: (request['lastViewedFile'] as string | null) ?? null, remainingFiles: request['files'] as string[] };
				state.saveCodeReview(repo, review);
				this.post({ command, commitHash: request['commitHash'], compareWithHash: request['compareWithHash'], codeReview: review, error: null });
				return true;
			}
			case 'updateCodeReview': {
				const id = String(request['id']);
				const review = state.codeReview(repo, id);
				if (!review) {
					this.post({ command, error: 'The Code Review could not be found.' });
					return true;
				}
				const remaining = request['remainingFiles'] as string[];
				if (remaining.length > 0) {
					review.remainingFiles = remaining;
					review.lastActive = Date.now();
					if (request['lastViewedFile'] !== null) review.lastViewedFile = request['lastViewedFile'] as string;
					state.saveCodeReview(repo, review);
				} else {
					state.saveCodeReview(repo, null, id);
				}
				ok();
				return true;
			}
			case 'endCodeReview':
				state.saveCodeReview(repo, null, String(request['id']));
				return true;
			case 'fetchAvatar':
			case 'fetchPullRequest':
				return true;
			case 'rescanForRepos': {
				// The settings action: re-read the repository set (the open repository plus its
				// submodules) and push it, exactly as the extension host did after a scan.
				void this.refreshRepos().then(() => {
					this.post({ command: 'loadRepos', repos: this.repoStates(), lastActiveRepo: this.currentRepo ?? this.repoPath, loadViewTo: null });
				});
				return true;
			}
			default:
				return false;
		}
	}

	private async openPullRequestUrl(request: Message): Promise<void> {
		const config = request['config'] as Record<string, unknown>;
		const fields = [
			String(config['hostRootUrl'] ?? ''),
			String(request['sourceOwner'] ?? ''), String(request['sourceRepo'] ?? ''), String(request['sourceBranch'] ?? ''),
			String(config['destOwner'] ?? ''), String(config['destRepo'] ?? ''), String(config['destProjectId'] ?? ''), String(config['destBranch'] ?? '')
		];
		let template: string;
		switch (config['provider']) {
			case 0: template = '$1/$2/$3/pull-requests/new?source=$2/$3::$4&dest=$5/$6::$8'; break; // Bitbucket
			case 1: template = String((config['custom'] as Record<string, unknown> | undefined)?.['templateUrl'] ?? ''); break;
			case 3: template = '$1/$2/$3/-/merge_requests/new?merge_request[source_branch]=$4&merge_request[target_branch]=$8' + (fields[6] !== '' ? '&merge_request[target_project_id]=$7' : ''); break; // GitLab
			default: template = '$1/$5/$6/compare/$8...$2:$4'; // GitHub
		}
		const url = template.replace(/\$([1-8])/g, (_, index: string) => fields[parseInt(index, 10) - 1] ?? '');
		try {
			await openUrl(url);
		} catch (error) {
			notify('error', `Could not open ${url}: ${String(error)}`);
		}
	}
}

/* ---------- The deferred "Uncommitted Changes" count ---------- */

/** The decision for one reading of the repository's uncommitted-change count. */
type UncommittedReading =
	| { readonly send: number } // deliver this count to the view now
	| { readonly recheckAfterMs: number }; // deliver nothing yet: read the count again after this delay

/** Ported from the extension's UncommittedCountStabiliser (src/gitGraphView.ts): decides when a
 *  reading of the "Uncommitted Changes" count may be delivered, so the row never disappears and
 *  reappears on a momentary reading (a `git status` that raced a concurrent index write reports
 *  0, not the real count - delivering that 0 removes the rendered row, and the next refresh
 *  brings it straight back):
 *  - a positive count is delivered immediately, whatever the row currently shows;
 *  - a zero that would REMOVE the row is delivered only once re-reads span the confirm window;
 *  - a failed reading (null) delivers nothing: the failure neither confirms nor denies
 *    anything, and the next refresh reads the status again. */
class UncommittedCountStabiliser {
	/** The count the view last rendered (null => unknown: nothing was delivered since the last reset). */
	private renderedCount: number | null = null;
	/** When the current streak of zero readings started (null => the latest reading wasn't a zero). */
	private zeroSince: number | null = null;

	constructor(private readonly confirmWindowMs: number, private readonly recheckIntervalMs: number) {}

	/** Observe one reading of the count; returns whether to deliver a count now or re-read after a delay. */
	public observe(count: number | null, now: number): UncommittedReading {
		if (count === null) return { recheckAfterMs: this.recheckIntervalMs };
		if (count > 0) {
			this.zeroSince = null;
			return { send: count };
		}
		if (this.renderedCount === null || this.renderedCount === 0) {
			// No row is rendered: delivering 0 changes nothing on screen, so there is nothing to stabilise
			return { send: 0 };
		}
		if (this.zeroSince === null) this.zeroSince = now;
		if (now - this.zeroSince < this.confirmWindowMs) return { recheckAfterMs: this.recheckIntervalMs };
		this.zeroSince = null;
		return { send: 0 };
	}

	/** Record the count a delivered response rendered in the view (call only after actually sending). */
	public delivered(count: number): void {
		this.renderedCount = count;
		if (count > 0) this.zeroSince = null;
	}

	/** Forget what the view renders (the view switched repository or was reset). */
	public reset(): void {
		this.renderedCount = null;
		this.zeroSince = null;
	}
}

const UNCOMMITTED_ZERO_CONFIRM_MS = 5000;
const UNCOMMITTED_RECHECK_MS = 1000;

/* ---------- Helpers ---------- */

/** The 8-character form the extension titles diffs with; a parent suffix (`^`) is kept. */
function abbrev(hash: string): string {
	if (hash === UNCOMMITTED) return 'Uncommitted';
	const suffix = hash.endsWith('^') ? '^' : '';
	const bare = suffix ? hash.slice(0, -1) : hash;
	return (bare.length > 8 ? bare.slice(0, 8) : bare) + suffix;
}

/** The left side of a diff, as the extension resolves it (src/utils.ts resolveDiffFromHash). */
function resolveDiffFromHash(fromHash: string, toHash: string): string {
	const from = fromHash === UNCOMMITTED ? 'HEAD' : fromHash;
	return from === toHash ? `${from}^` : from;
}

function quoteShellArg(value: string): string {
	return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `"${value.replace(/["\\$`]/g, '\\$&')}"`;
}

function touchCodeReview(repo: string, id: string): state.CodeReview | null {
	const review = state.codeReview(repo, id);
	if (review) {
		review.lastActive = Date.now();
		state.saveCodeReview(repo, review);
	}
	return review;
}

/** The exportable half of a repository's state (src/repoManager.ts generateExternalConfigFile). */
function exportableRepoConfig(repo: Record<string, unknown>): Record<string, unknown> & { exportedAt: number } {
	const file: Record<string, unknown> = {};
	if (repo['commitOrdering'] !== 'default') file['commitOrdering'] = repo['commitOrdering'];
	if (repo['fileViewType'] === 1) file['fileViewType'] = 'tree';
	if (repo['fileViewType'] === 2) file['fileViewType'] = 'list';
	if (Array.isArray(repo['hideRemotes']) && repo['hideRemotes'].length > 0) file['hideRemotes'] = repo['hideRemotes'];
	if (repo['includeCommitsMentionedByReflogs'] !== 0) file['includeCommitsMentionedByReflogs'] = repo['includeCommitsMentionedByReflogs'] === 1;
	if (repo['issueLinkingConfig'] !== null) file['issueLinkingConfig'] = repo['issueLinkingConfig'];
	if (repo['name'] !== null) file['name'] = repo['name'];
	if (repo['onlyFollowFirstParent'] !== 0) file['onlyFollowFirstParent'] = repo['onlyFollowFirstParent'] === 1;
	if (repo['onRepoLoadShowCheckedOutBranch'] !== 0) file['onRepoLoadShowCheckedOutBranch'] = repo['onRepoLoadShowCheckedOutBranch'] === 1;
	if (repo['onRepoLoadShowSpecificBranches'] !== null) file['onRepoLoadShowSpecificBranches'] = repo['onRepoLoadShowSpecificBranches'];
	if (repo['pullRequestConfig'] !== null) file['pullRequestConfig'] = repo['pullRequestConfig'];
	if (repo['showRemoteBranchesV2'] !== 0) file['showRemoteBranches'] = repo['showRemoteBranchesV2'] === 1;
	if (repo['showStashes'] !== 0) file['showStashes'] = repo['showStashes'] === 1;
	if (repo['showTags'] !== 0) file['showTags'] = repo['showTags'] === 1;
	return { ...file, exportedAt: Date.now() };
}
