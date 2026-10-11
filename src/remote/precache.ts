// The precache manifest's selector (docs/ggs-remote-plan.md §10.2): what the Service Worker
// warms at install — the shell document and exactly the hashed assets it references (the
// first-paint chunks; everything lazier still loads on demand). The build writes the list it
// returns next to remote.html as precache.json; the worker never trusts a list it did not
// fetch from its own scope.
export function precacheList(shellHtml: string, shellName = 'remote.html'): string[] {
	const files = new Set<string>([shellName]);
	for (const match of shellHtml.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
		const url = match[1].replace(/^\.\//, '');
		// Only this build's own hashed artifacts — versioned by content, safe to keep forever.
		if (url.startsWith('assets/') && /-[\w-]{6,}\.(?:js|css|woff2?)$/.test(url)) {
			files.add(url);
		}
	}
	return [...files].sort();
}
