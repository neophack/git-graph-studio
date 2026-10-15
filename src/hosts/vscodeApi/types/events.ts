// Disposable, Event/EventEmitter (one listener's throw never kills the others),
// the never-firing event, and VS Code's cancellation shapes.

import { guarded } from '../shimLog';

export class Disposable {
	private disposed = false;
	private readonly callOnDispose: () => unknown;
	constructor(callOnDispose: () => unknown) {
		this.callOnDispose = callOnDispose;
	}
	/** Runs the cleanup once; a second dispose is a no-op (VS Code's contract). */
	dispose(): unknown {
		if (this.disposed) return undefined;
		this.disposed = true;
		return guarded('Disposable.dispose', () => this.callOnDispose());
	}
	static from(...disposables: ({ dispose(): unknown } | undefined | null)[]): Disposable {
		return new Disposable(() => {
			for (const disposable of disposables) if (disposable && typeof disposable.dispose === 'function') guarded('Disposable.from member', () => disposable.dispose());
		});
	}
}

/** VS Code's event signature: `event(listener, thisArgs?, disposables?)`. */
export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: { dispose(): unknown }[]) => Disposable;

export class EventEmitter<T> {
	private readonly listeners = new Set<{ fn: (e: T) => unknown; thisArgs: unknown }>();
	private disposed = false;
	/** Subscribe: `thisArgs` binds the listener (the `onDidX(this.handler, this, …)` idiom)
	 *  and a `disposables` array collects the subscription, as VS Code's Event does. */
	readonly event: Event<T> = (listener, thisArgs, disposables) => {
		const entry = { fn: listener, thisArgs };
		if (!this.disposed) this.listeners.add(entry);
		const subscription = new Disposable(() => this.listeners.delete(entry));
		if (Array.isArray(disposables)) disposables.push(subscription);
		return subscription;
	};
	/** Deliver to every listener; one listener's throw is logged and the rest still run. */
	fire(event: T): void {
		for (const entry of [...this.listeners]) {
			if (!this.listeners.has(entry)) continue;
			guarded('event listener', () => entry.fn.call(entry.thisArgs, event));
		}
	}
	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
	}
}

/** An event that never fires: the registration survives and disposes, nothing arrives. */
export function silentEvent<T = unknown>(): Event<T> {
	return (_listener, _thisArgs, disposables) => {
		const subscription = new Disposable(() => undefined);
		if (Array.isArray(disposables)) disposables.push(subscription);
		return subscription;
	};
}

/** VS Code's cancellation shape: the token reports and notifies, the source cancels. */
export class CancellationTokenSource {
	private readonly emitter = new EventEmitter<void>();
	readonly token: CancellationToken = {
		isCancellationRequested: false,
		onCancellationRequested: this.emitter.event
	};
	cancel(): void {
		if (this.token.isCancellationRequested) return;
		this.token.isCancellationRequested = true;
		this.emitter.fire(undefined);
	}
	dispose(cancel = false): void {
		if (cancel) this.cancel();
		this.emitter.dispose();
	}
}
export interface CancellationToken {
	isCancellationRequested: boolean;
	onCancellationRequested: Event<void>;
}
/** `CancellationToken.None` / `.Cancelled`: the two static tokens packages pass around. */
export const CancellationTokenNone: CancellationToken = Object.freeze({ isCancellationRequested: false, onCancellationRequested: silentEvent<void>() });
export const CancellationTokenCancelled: CancellationToken = Object.freeze({ isCancellationRequested: true, onCancellationRequested: silentEvent<void>() });
