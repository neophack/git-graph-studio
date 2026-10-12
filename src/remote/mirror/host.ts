// The desktop window's replica host (docs/ggs-remote-plan.md §22): the one real Git Graph
// Studio frontend of this instance, shown to any number of remote viewers. A viewer's hello
// starts the recorder and earns a snapshot; batches go out to everyone; input comes back
// and is replayed here. A viewer that stops saying hello is forgotten, and with the last
// one the recorder stops — a desktop nobody watches pays nothing. A remote page reload is
// just a new viewer: nothing on the PC restarts, the extension pages (Claude Code's chat)
// keep running in this window whatever the browsers do.

import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { DomRecorder } from './recorder';
import { InputReplayer } from './replay';
import { VIEWER_TTL_MS, MIRROR_DOWN, type DownMessage, type UpMessage } from './protocol';

export interface MirrorHostDeps {
	send(message: DownMessage): void;
	/** Size the PC window for a viewer's viewport (only while the window is hidden). */
	fit(width: number, height: number): void;
	/** The page must believe it has the focus while viewers drive it. */
	focus(enabled: boolean): void;
	now(): number;
}

/** The window size a viewer's viewport asks for. A phone (below 600 px) gets its own size —
 *  the window then wears the phone shell (phoneShell.ts) and the copy is 1:1; anything
 *  wider gets the desktop workbench at the viewer's proportions, never below its minimum. */
export function fitFor(vw: number, vh: number): { width: number; height: number } {
	if (vw > 0 && vw < 600) return { width: Math.max(320, Math.round(vw)), height: Math.max(480, Math.round(vh)) };
	const width = Math.max(800, Math.round(vw));
	const height = Math.max(500, Math.round(vw > 0 ? (width * vh) / vw : 760));
	return { width, height };
}

export class MirrorHost {
	private readonly viewers = new Map<string, number>();
	private readonly recorder: DomRecorder;
	private readonly replayer: InputReplayer;
	private pruneTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		root: Document,
		private readonly deps: MirrorHostDeps
	) {
		this.recorder = new DomRecorder(root, (ops, seq) => this.deps.send({ k: 'ops', to: '*', seq, ops }));
		this.replayer = new InputReplayer(this.recorder, root);
	}

	get viewerCount(): number {
		return this.viewers.size;
	}

	receive(message: UpMessage): void {
		if (!message || typeof message.from !== 'string') return;
		const known = this.viewers.has(message.from);
		switch (message.k) {
			case 'hello':
				this.viewers.set(message.from, this.deps.now());
				{
					const size = fitFor(message.vw, message.vh);
					this.deps.fit(size.width, size.height);
				}
				if (!known) {
					this.armPrune();
					if (this.viewers.size === 1) this.deps.focus(true);
					this.snapshotTo(message.from);
				}
				return;
			case 'resnap':
				this.viewers.set(message.from, this.deps.now());
				this.snapshotTo(message.from);
				return;
			case 'bye':
				this.drop(message.from);
				return;
			default: {
				if (!known) return;
				this.viewers.set(message.from, this.deps.now());
				const text = this.replayer.handle(message);
				if (message.k === 'copy') this.deps.send({ k: 'clip', to: message.from, text: text ?? '' });
				// Input changes the page: the next batch should not wait out the throttle.
				this.recorder.flush();
			}
		}
	}

	private snapshotTo(viewer: string): void {
		const snap = this.recorder.snapshot();
		this.deps.send({ k: 'snap', to: viewer, ...snap });
	}

	private armPrune(): void {
		if (this.pruneTimer !== null) return;
		this.pruneTimer = setInterval(() => this.prune(), 5000);
	}

	prune(): void {
		const now = this.deps.now();
		for (const [viewer, seen] of this.viewers) if (now - seen > VIEWER_TTL_MS) this.drop(viewer);
	}

	private drop(viewer: string): void {
		if (!this.viewers.delete(viewer)) return;
		this.replayer.forget(viewer);
		if (this.viewers.size > 0) return;
		this.recorder.stop();
		this.deps.focus(false);
		if (this.pruneTimer !== null) clearInterval(this.pruneTimer);
		this.pruneTimer = null;
	}
}

/** The host wired to the app: batches out as app events (the Relay forwards them to the
 *  browsers), the window fitting and the focus emulation through the backend. */
export function createAppMirrorHost(): MirrorHost {
	let lastFit = '';
	return new MirrorHost(document, {
		send: (message) => void emit(MIRROR_DOWN, message).catch(() => undefined),
		fit: (width, height) => {
			const key = `${width}x${height}`;
			if (key === lastFit) return;
			lastFit = key;
			void invoke('remote_mirror_fit', { width, height }).catch(() => undefined);
		},
		focus: (enabled) => void invoke('remote_mirror_focus', { enabled }).catch(() => undefined),
		now: () => Date.now()
	});
}
