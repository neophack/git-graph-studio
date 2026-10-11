// The remote workbench's Service Worker (docs/ggs-remote-plan.md §10.2), built as sw.js and
// served by the daemon at its base path: the hashed assets of the remote build are cached
// forever (cache-first), the package files under the session token revalidate in the
// background, and everything else — the API, the WebSocket, the pages — goes to the network
// untouched. A new version's worker deletes the caches of the old ones.
export {};

// The worker scope's few members this file uses, typed here so the file checks under the
// project's DOM lib (the webworker lib cannot share one program with it).
interface ExtendableEvent extends Event {
	waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
	readonly request: Request;
	respondWith(response: Promise<Response> | Response): void;
}
interface MessageEventLike extends ExtendableEvent {
	readonly data: unknown;
}
interface WorkerScope {
	readonly registration?: { scope: string };
	readonly location: Location;
	skipWaiting(): Promise<void>;
	readonly clients: { claim(): Promise<void> };
	addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
	addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
	addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}
const self = globalThis as unknown as WorkerScope;

const VERSION = 'remote-workbench-v2';
const scope = new URL(self.registration?.scope ?? self.location.href);
const ASSETS = `${VERSION}:assets:${scope.pathname}`;
const PACKAGES = `${VERSION}:packages:${scope.pathname}`;

/** A cache lookup that never stalls the answer. CacheStorage operations can wedge behind
 * a concurrent large `put` (observed: a webview's stylesheet — parser-blocking, and with
 * it the whole iframe — held forever while the cache op never settled), so the lookup
 * races a short timer; a loss falls through to the network, which also refills the cache.
 * A hit slower than this is as good as a miss on any link this page is usable on. */
function cacheHit(cacheName: string, request: Request): Promise<Response | null> {
	return Promise.race([
		caches.open(cacheName)
			.then((cache) => cache.match(request).then((hit) => hit ?? null))
			.catch((): Response | null => null),
		new Promise<Response | null>((resolve) => setTimeout(() => resolve(null), 600)),
	]);
}

/** Fill the cache without ever letting the fill's failure surface: a rejected `put` is a
 * dropped optimization, never a failed response. */
function cacheFill(cacheName: string, request: Request, response: Response): void {
	void caches.open(cacheName)
		.then((cache) => cache.put(request, response))
		.catch(() => undefined);
}

self.addEventListener('install', (event) => {
	// Warm the shell and its hashed first-paint chunks from the build's own precache.json
	// (§10.2): the second visit then pays one revalidation, not a cold start. Any entry that
	// fails to fetch leaves the rest installed — the fetch handler fills gaps on demand.
	event.waitUntil(
		(async () => {
			try {
				const manifest = await fetch(new URL('precache.json', scope)).then((r) => r.json() as Promise<{ files?: string[] }>);
				const cache = await caches.open(ASSETS);
				await Promise.all(
					(manifest.files ?? []).map((file) =>
						fetch(new URL(file, scope))
							.then((response) => (response.ok ? cache.put(new URL(file, scope).href, response) : undefined))
							.catch(() => undefined)
					)
				);
			} catch {
				/* no manifest or offline: the cache-first handler still fills itself */
			}
			await self.skipWaiting();
		})()
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const name of await caches.keys()) {
				// Only this PC's caches (the scope is in the name: a Hub serves many PCs on one origin).
				if (name.endsWith(`:${scope.pathname}`) && name !== ASSETS && name !== PACKAGES) await caches.delete(name);
			}
			await self.clients.claim();
		})()
	);
});

function isShell(url: URL): boolean {
	return url.pathname === new URL('remote.html', scope).pathname;
}

function isHashedAsset(url: URL): boolean {
	return /\/w\/[^/]+\/v\/[^/]+\/assets\/[^/]+-[\w-]{6,}\.\w+$/.test(url.pathname);
}

function isPackageFile(url: URL): boolean {
	return /\/w\/[^/]+\/ggs\/[^/]+\//.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith(scope.pathname)) return;
	if (isShell(url)) {
		// The shell document carries no hash: serve the cached copy at once, refresh it in
		// the background — a new version lands on the next visit (§10.2).
		event.respondWith(
			(async () => {
				const hit = await cacheHit(ASSETS, request);
				return (
					hit ??
					fetch(request)
						.then((response) => {
							if (response.ok) cacheFill(ASSETS, request, response.clone());
							return response;
						})
						.catch(() => hit ?? Response.error())
				);
			})()
		);
		return;
	}
	if (isHashedAsset(url)) {
		event.respondWith(
			(async () => {
				const hit = await cacheHit(ASSETS, request);
				if (hit) return hit;
				const response = await fetch(request);
				if (response.ok) cacheFill(ASSETS, request, response.clone());
				return response;
			})()
		);
		return;
	}
	if (isPackageFile(url)) {
		event.respondWith(
			(async () => {
				const hit = await cacheHit(PACKAGES, request);
				return (
					hit ??
					fetch(request)
						.then((response) => {
							if (response.ok) cacheFill(PACKAGES, request, response.clone());
							return response;
						})
						.catch(() => hit ?? Response.error())
				);
			})()
		);
	}
});

// Sign-out clears this PC's package cache (the hashed app assets are public and stay).
self.addEventListener('message', (event) => {
	if ((event.data as { type?: string } | undefined)?.type === 'signed-out') event.waitUntil(caches.delete(PACKAGES));
});
