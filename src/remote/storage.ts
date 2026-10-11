// Per-PC storage through a Hub (docs/ggs-remote-plan.md §20.6.1): every PC's link shares the
// Hub's one origin, so `localStorage` / `sessionStorage` are replaced — before any workbench
// module touches them — by views that prefix every key with this PC's base path. On the LAN
// (base `/`) nothing is replaced: the origin is the PC's own.
class ScopedStorage implements Storage {
	constructor(
		private readonly inner: Storage,
		private readonly prefix: string
	) {}
	private keys(): string[] {
		const out: string[] = [];
		for (let i = 0; i < this.inner.length; i++) {
			const key = this.inner.key(i);
			if (key !== null && key.startsWith(this.prefix)) out.push(key.slice(this.prefix.length));
		}
		return out;
	}
	get length(): number {
		return this.keys().length;
	}
	key(index: number): string | null {
		return this.keys()[index] ?? null;
	}
	getItem(key: string): string | null {
		return this.inner.getItem(this.prefix + key);
	}
	setItem(key: string, value: string): void {
		this.inner.setItem(this.prefix + key, value);
	}
	removeItem(key: string): void {
		this.inner.removeItem(this.prefix + key);
	}
	clear(): void {
		for (const key of this.keys()) this.inner.removeItem(this.prefix + key);
	}
}

export function scopedStorage(inner: Storage, basePath: string): Storage {
	return new ScopedStorage(inner, `u:${basePath}:`);
}

export function installScopedStorage(basePath: string): void {
	if (basePath === '/' || !basePath.startsWith('/u/')) return;
	for (const name of ['localStorage', 'sessionStorage'] as const) {
		let inner: Storage;
		try {
			inner = window[name];
		} catch {
			continue;
		}
		const scoped = scopedStorage(inner, basePath);
		Object.defineProperty(window, name, { configurable: true, get: () => scoped });
	}
}
