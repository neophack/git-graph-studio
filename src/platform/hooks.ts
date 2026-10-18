// The extension points the remote form factor plugs into (plan §5.5). The core modules
// (editor, panel, extHost, transfer, workbench) reach every remote behaviour through
// `hook('…')` lookups at call time; the remote side installs its implementations before the
// workbench loads (`remote/boot.ts`), and the desktop's own remote-shaped halves (the mirror
// host, the asset protocol, the workbench sync) are installed by `remote/desktopHooks.ts`
// from `main.ts` — the composition root. Nothing under features/, workbench/ or hosts/ may
// import `remote/` statically; the defaults below are the desktop answers, and a desktop
// with nothing installed pays nothing.

/** The phone's read-only open (docs/ggs-remote-plan.md §11.3): whether a freshly opened
 *  file starts locked, and how a locked editor registers its toggle. */
export interface EditLockPolicy {
	defaultLocked(): boolean;
	register(host: HTMLElement, setLocked: (locked: boolean) => void, focus: () => void): void;
}

/** The phone's page-stack navigation (§11.2): full-screen side views dismiss when the
 *  editor page must come forward. */
export interface NavigationPolicy {
	phoneShell(): boolean;
	fullScreenSideViewOpen(): boolean;
	dismissFullScreenSideView(): void;
	revealEditorPage(): void;
	/** The same reveal with NO hold gating it — the user's own navigation. An act this
	 *  frontend's user just caused (a mirrored create their tap in a webview copy opened,
	 *  2026-10-16: 手机端 claude 的 new session/history 点击后新页面没有到前台) is their
	 *  own navigation even while another operation's page hold is still live (a sync apply
	 *  in flight, a catch-up merge): the hold keeps REMOTE acts in the background, and this
	 *  act is not one. `revealEditorPage`'s own call stays gated — only the explicit
	 *  own-act call sites may take this door. */
	revealEditorPageUngated?: () => void;
	/** Hold the phone's page still (2026-10-16, the owner's direction: 文件页面会被其他页面
	 *  顶到最前): while at least one hold is live, `revealEditorPage` is a no-op — the
	 *  editor tab still opens, but the page showing keeps its place. What a hold wraps is
	 *  never this user's own act: a remote-originated sync operation, a session restore, a
	 *  panel another frontend created. The desktop default answers a no-op release — its
	 *  `revealEditorPage` already is one. */
	holdPage(): () => void;
	/** A remote-originated open landed while a hold kept the editor page back (the tab is
	 *  open and active, nothing on screen says so): name it to this frontend's user, with a
	 *  way forward. Optional — the desktop default answers nothing (its opens never land
	 *  behind a full-screen page). */
	noteBackgroundOpen?(title: string): void;
}

/** Which this frontend is: the desktop window, or one remote session. */
export interface SessionInfo {
	/** Whether this frontend runs as a remote session (a browser over the relay). */
	remote(): boolean;
	/** This frontend's id: `main` on the desktop, `remote/<n>` in a session. */
	frontendId(): string;
	/** The class a backend host request addresses: `main` or `remote`. */
	frontendClass(): 'main' | 'remote';
	/** Whether a host request addressed to `frontend` is this frontend's to answer. */
	addressedHere(frontend: string): boolean;
}

/** Where the replica host finds an extension webview's live frame (§22.6). */
export interface WebviewFrameSource {
	frameFor(stream: string): HTMLIFrameElement | null;
	ensure(stream: string): void;
}

/** The webview stream vocabulary the extension host speaks on both mirror sides: the
 *  desktop registers its frames, a viewer mounts a copy of a stream. */
export interface WebviewStreamBridge {
	panelStream(extId: string, panelId: number): string;
	viewStream(viewId: string): string;
	parseStream(stream: string): { view: string } | { extId: string; panelId: number } | null;
	setWebviewFrameSource(source: WebviewFrameSource | null): void;
	/** Mount the live copy of the desktop window's frame for a stream (the viewer side);
	 *  resolves the disposer once the copy module has loaded. `extId` names the stream's
	 *  extension (a view's stream id alone does not carry it) — the copy notes this
	 *  frontend's interactions under it. */
	mountCopy(container: HTMLElement, stream: string, extId?: string): () => void;
	/** Note THIS frontend's user just interacted with a copy of `extId`'s webview (a tap,
	 *  key or scroll sent up for replay): a tap in a mirrored page — Claude's "new session" —
	 *  replays into the PC's real page, and the panel that opens arrives BACK here as a
	 *  mirrored create the K7 page hold would keep in the background. The input trail is the
	 *  one honest witness that the create is this user's own act: the backend reads a
	 *  replayed tap as the PC user's input, and the mirror's `caller` names no one. */
	noteCopyInteraction?(extId: string): void;
	/** Whether THIS frontend's user interacted with a copy of `extId`'s webview within the
	 *  act's window (a remote answers from its copies; the desktop hosts the real pages and
	 *  answers false). */
	recentCopyInteraction?(extId: string): boolean;
}

/** The desktop window's mirror-host door (§22): the host loads when the first viewer says
 *  hello; the bridge answers whether one is watching. */
export interface MirrorHostBridge {
	install(): () => void;
	viewersActive(): Promise<boolean>;
	viewersNow(): boolean;
}

/** The cross-frontend operation sync (§22.7): the handle the workbench keeps. */
export interface WorkbenchSyncHandle {
	start(): void;
	localOnly(local: boolean): void;
	/** The desktop's close-to-hide path (§17): this frontend is going invisible — the
	 *  presence table must say so at once, whatever the page's own visibility events do. */
	noteWindowHidden(): void;
	detach(): void;
}

/** The remote wire's transfer transport (module 19's chunked uploads and ticket
 *  downloads) — what `uploadInto` / `downloadTo` / `downloadManyTo` dispatch to on a
 *  remote session. */
export interface TransferWireTransport {
	uploadFiles(dir: string, folder: boolean, onProgress?: (progress: { name: string; sent: number; total: number }, index: number, count: number) => void): Promise<{ uploaded: string[]; failed: { name: string; error: string }[] }>;
	download(path: string, zip?: boolean): Promise<void>;
	/** The multi-select pack (docs/remote-client-plan.md §6.7): two or more paths as one
	 *  zipped download. */
	downloadMany?(paths: string[]): Promise<void>;
}

/** Open Folder for someone not sitting at the PC (docs/remote-ui-redesign-plan.md §P0):
 *  resolves whether it took the request. A browser session browses the PC's disk and opens
 *  the folder in a PC window (its own `open_folder` is refused); the desktop window, while
 *  a mirror viewer watches, browses in-window — the copy shows it, where the native dialog
 *  would open on the PC's screen alone — and opens through `open`. False leaves the
 *  desktop's native dialog to run. */
export type FolderOpenPolicy = (open: (path: string) => Promise<void>, roots: string[]) => Promise<boolean>;

interface HookMap {
	editLock: EditLockPolicy;
	navigation: NavigationPolicy;
	openThreshold: (desktopBytes: number) => number;
	assetUrl: (path: string, protocol?: string) => string;
	session: SessionInfo;
	webviewStreams: WebviewStreamBridge | null;
	mirror: MirrorHostBridge | null;
	workbenchSync: (workbench: unknown) => WorkbenchSyncHandle | null;
	summaryReporter: (source: { tabs(): { path: string; dirty: boolean; active: boolean }[]; scmChanges(): number }) => () => void;
	transferWire: (() => Promise<TransferWireTransport>) | null;
	folderOpen: FolderOpenPolicy | null;
}

const noop = (): void => undefined;
const noopRelease = (): (() => void) => (): void => undefined;

const defaults: HookMap = {
	editLock: { defaultLocked: () => false, register: noop },
	navigation: { phoneShell: () => false, fullScreenSideViewOpen: () => false, dismissFullScreenSideView: noop, revealEditorPage: noop, holdPage: noopRelease },
	openThreshold: (desktopBytes) => desktopBytes,
	// The bare scheme, the shape every protocol handler answers — what a build without
	// Tauri internals (jsdom, probes) always saw.
	assetUrl: (path, protocol = 'ggs') => `${protocol}://localhost/${path}`,
	session: { remote: () => false, frontendId: () => 'main', frontendClass: () => 'main', addressedHere: (frontend) => frontend === 'main' },
	webviewStreams: null,
	mirror: null,
	workbenchSync: () => null,
	summaryReporter: () => noop,
	transferWire: null,
	folderOpen: null
};

const provided = new Map<keyof HookMap, HookMap[keyof HookMap]>();

/** The installed implementation of an extension point, or the desktop default. */
export function hook<K extends keyof HookMap>(k: K): HookMap[K] {
	return (provided.get(k) as HookMap[K] | undefined) ?? defaults[k];
}

/** Install an implementation (the remote boot, or the desktop's own remote halves). */
export function provideHook<K extends keyof HookMap>(k: K, value: HookMap[K]): void {
	provided.set(k, value as HookMap[keyof HookMap]);
}
