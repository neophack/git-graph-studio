// `@tauri-apps/api/window` for the remote workbench (§9.3): a browser tab has no native
// window, so `close` leaves for the window picker (after the workbench's own unsaved-changes
// flow), maximize is the Fullscreen API and the rest are harmless defaults. Unknown methods
// resolve to no-ops instead of throwing — a foreign call must never break the shell.
import { transport, remoteEnv } from '../session';
import { leavingPage } from '../backStack';

type CloseHandler = (event: { preventDefault(): void; isPreventDefault(): boolean }) => void | Promise<void>;
const closeHandlers = new Set<CloseHandler>();
const resizeHandlers = new Set<() => void>();

if (typeof window !== 'undefined') {
	window.addEventListener('resize', () => {
		for (const handler of resizeHandlers) handler();
	});
}

async function requestClose(): Promise<void> {
	let prevented = false;
	const event = {
		preventDefault: () => {
			prevented = true;
		},
		isPreventDefault: () => prevented
	};
	for (const handler of closeHandlers) await handler(event);
	if (prevented) return;
	const env = remoteEnv();
	try {
		transport().detach();
		transport().shutdown();
	} catch {
		/* not connected */
	}
	// The menus this runs from are the phone's drawer sheets: their close queued a
	// history.back() one tick out, and that traversal would cancel the assign below.
	leavingPage();
	const base = new URL(env?.basePath ?? '/', location.href);
	location.assign(new URL('windows', base).href);
}

const methods = {
	label: 'main',
	close: requestClose,
	destroy: requestClose,
	minimize: async () => undefined,
	unminimize: async () => undefined,
	maximize: async () => {
		await document.documentElement.requestFullscreen?.().catch(() => undefined);
	},
	unmaximize: async () => {
		if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
	},
	toggleMaximize: async () => {
		if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
		else await document.documentElement.requestFullscreen?.().catch(() => undefined);
	},
	isMaximized: async () => Boolean(document.fullscreenElement),
	isFullscreen: async () => Boolean(document.fullscreenElement),
	isMinimized: async () => false,
	isVisible: async () => document.visibilityState === 'visible',
	isFocused: async () => document.hasFocus(),
	setTitle: async (title: string) => {
		document.title = title;
	},
	title: async () => document.title,
	startDragging: async () => undefined,
	setFocus: async () => window.focus(),
	show: async () => undefined,
	hide: async () => undefined,
	onCloseRequested: async (handler: CloseHandler) => {
		closeHandlers.add(handler);
		return () => closeHandlers.delete(handler);
	},
	onResized: async (handler: () => void) => {
		resizeHandlers.add(handler);
		return () => resizeHandlers.delete(handler);
	},
	onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
		const focus = () => handler({ payload: true });
		const blur = () => handler({ payload: false });
		window.addEventListener('focus', focus);
		window.addEventListener('blur', blur);
		return () => {
			window.removeEventListener('focus', focus);
			window.removeEventListener('blur', blur);
		};
	},
	scaleFactor: async () => window.devicePixelRatio || 1,
	innerSize: async () => ({ width: window.innerWidth, height: window.innerHeight }),
	outerSize: async () => ({ width: window.innerWidth, height: window.innerHeight })
};

const handle: Record<string, unknown> = new Proxy(methods as Record<string, unknown>, {
	get(target, key) {
		if (key in target) return target[key as string];
		if (typeof key === 'symbol' || key === 'then') return undefined;
		return async () => undefined;
	}
});

export function getCurrentWindow(): typeof methods {
	return handle as unknown as typeof methods;
}

export function getAllWindows(): (typeof methods)[] {
	return [getCurrentWindow()];
}

export class Window {
	static getCurrent(): typeof methods {
		return getCurrentWindow();
	}
}
