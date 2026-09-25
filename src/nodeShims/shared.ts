// Primitives shared by the shim modules: the EventEmitter, the deliberate-failure helpers,
// and the next-tick shim. Pure — no host bridge, no imports from the barrel.

export class EventEmitter {
	static defaultMaxListeners = 10;

	private readonly events = new Map<string | symbol, { listener: (...args: unknown[]) => unknown; once: boolean }[]>();
	private maxListeners = EventEmitter.defaultMaxListeners;

	setMaxListeners(n: number): this {
		this.maxListeners = n;
		return this;
	}

	getMaxListeners(): number {
		return this.maxListeners;
	}

	emit(event: string | symbol, ...args: unknown[]): boolean {
		const list = this.events.get(event);
		if (list === undefined || list.length === 0) return false;
		for (const entry of [...list]) {
			if (entry.once) {
				const at = list.indexOf(entry);
				if (at !== -1) list.splice(at, 1);
			}
			entry.listener(...args);
		}
		return true;
	}

	addListener(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		this.emit('newListener', event, listener);
		const list = this.events.get(event) ?? [];
		if (this.maxListeners !== 0 && list.length >= this.maxListeners && event !== 'newListener' && event !== 'removeListener') {
			console.warn(`(node) warning: possible EventEmitter memory leak detected. ${list.length + 1} ${String(event)} listeners added.`);
		}
		list.push({ listener, once: false });
		this.events.set(event, list);
		return this;
	}

	on(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		return this.addListener(event, listener);
	}

	once(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		const list = this.events.get(event) ?? [];
		list.push({ listener, once: true });
		this.events.set(event, list);
		return this;
	}

	prependListener(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		const list = this.events.get(event) ?? [];
		list.unshift({ listener, once: false });
		this.events.set(event, list);
		return this;
	}

	prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		const list = this.events.get(event) ?? [];
		list.unshift({ listener, once: true });
		this.events.set(event, list);
		return this;
	}

	removeListener(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		const list = this.events.get(event);
		if (list !== undefined) {
			const at = list.findIndex((entry) => entry.listener === listener);
			if (at !== -1) list.splice(at, 1);
			if (list.length === 0) this.events.delete(event);
		}
		this.emit('removeListener', event, listener);
		return this;
	}

	off(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		return this.removeListener(event, listener);
	}

	removeAllListeners(event?: string | symbol): this {
		if (event === undefined) this.events.clear();
		else this.events.delete(event);
		return this;
	}

	listeners(event: string | symbol): (() => unknown)[] {
		return (this.events.get(event) ?? []).map((entry) => entry.listener as () => unknown);
	}

	rawListeners(event: string | symbol): (() => unknown)[] {
		return this.listeners(event);
	}

	listenerCount(event: string | symbol): number {
		return (this.events.get(event) ?? []).length;
	}

	eventNames(): (string | symbol)[] {
		return [...this.events.keys()];
	}
}

/* ---------- The modules that exist only to fail at call time ---------- */

/** A function whose every call fails with a clear reason — the require succeeds, the use
 *  does not (a spawn an extension never performs must not kill its activation). */
export function callThrowsFn(name: string): () => never {
	return () => {
		throw new Error(`${name} is not supported by the Git Graph Studio extension host (extensions run in a sandboxed frame; a package that needs real processes declares a ggs backend)`);
	};
}

/** An object whose every property is a call-time failure — `require('child_process')`
 *  answers it, and any use of any member says why. Promise/bundler protocol members
 *  (`then`, `default`, `__esModule`) read as absent so an accidental `await` or interop
 *  probe does not trip the failure. */
export function unavailableModule(name: string): Record<string, never> {
	return new Proxy({}, {
		get: (_target, member) => {
			if (member === 'then' || member === 'default' || member === '__esModule') return undefined;
			if (member === Symbol.toPrimitive || member === 'toString') return () => `[${name}]`;
			return callThrowsFn(`${name}.${String(member)}`);
		}
	}) as Record<string, never>;
}


export function processNextTick(fn: () => void): void {
	Promise.resolve().then(fn);
}
