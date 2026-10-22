// Single-flight coalescing for refresh-shaped work: at most one run in flight and at most one
// queued behind it. A burst of callers (the watcher's batches during a build, a save and its
// own `.git` echo, a command's explicit refresh) used to start a run each — every one a full
// `git status` or directory re-read plus a re-render, piling up concurrently while the last
// was still running. Every caller still gets a promise that settles only after a run that
// STARTED after its call, so "mutate, then await refresh()" keeps seeing its own change.

export function coalesced(run: () => Promise<void>): () => Promise<void> {
	let current: Promise<void> | null = null;
	let queued: Promise<void> | null = null;
	const start = (): Promise<void> => {
		const running = run().finally(() => {
			if (current === running) current = null;
		});
		current = running;
		return running;
	};
	return () => {
		if (!current) return start();
		queued ??= current
			.catch(() => undefined)
			.then(() => {
				queued = null;
				return start();
			});
		return queued;
	};
}
