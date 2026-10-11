// `@tauri-apps/api/event` for the remote workbench (§9.3): `listen` is a LISTEN frame the
// Relay turns into a real listener inside the instance; `emit` / `emitTo` an EMIT frame.
import { transport } from '../session';

export type EventTarget =
	| { kind: 'Any' }
	| { kind: 'AnyLabel'; label: string }
	| { kind: 'App' }
	| { kind: 'Window'; label: string }
	| { kind: 'Webview'; label: string }
	| { kind: 'WebviewWindow'; label: string };

export interface Event<T> {
	event: string;
	id: number;
	payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;
export type EventName = string;

export interface Options {
	target?: string | EventTarget;
}

export enum TauriEvent {
	WINDOW_RESIZED = 'tauri://resize',
	WINDOW_MOVED = 'tauri://move',
	WINDOW_CLOSE_REQUESTED = 'tauri://close-requested',
	WINDOW_DESTROYED = 'tauri://destroyed',
	WINDOW_FOCUS = 'tauri://focus',
	WINDOW_BLUR = 'tauri://blur',
	WINDOW_SCALE_FACTOR_CHANGED = 'tauri://scale-change',
	WINDOW_THEME_CHANGED = 'tauri://theme-changed',
	WINDOW_CREATED = 'tauri://window-created',
	WEBVIEW_CREATED = 'tauri://webview-created',
	DRAG_ENTER = 'tauri://drag-enter',
	DRAG_OVER = 'tauri://drag-over',
	DRAG_DROP = 'tauri://drag-drop',
	DRAG_LEAVE = 'tauri://drag-leave'
}

function targetOf(target: Options['target']): EventTarget | undefined {
	if (target === undefined) return undefined;
	return typeof target === 'string' ? { kind: 'AnyLabel', label: target } : target;
}

export async function listen<T>(event: EventName, handler: EventCallback<T>, options?: Options): Promise<UnlistenFn> {
	const stream = transport().listen(event, (e) => handler(e as Event<T>), targetOf(options?.target));
	let done = false;
	return () => {
		if (done) return;
		done = true;
		transport().unlisten(stream);
	};
}

export async function once<T>(event: EventName, handler: EventCallback<T>, options?: Options): Promise<UnlistenFn> {
	let unlisten: UnlistenFn = () => undefined;
	unlisten = await listen<T>(
		event,
		(e) => {
			unlisten();
			handler(e);
		},
		options
	);
	return unlisten;
}

export async function emit<T>(event: string, payload?: T): Promise<void> {
	transport().emit(event, payload);
}

export async function emitTo<T>(target: EventTarget | string, event: string, payload?: T): Promise<void> {
	transport().emit(event, payload, targetOf(target));
}
