// The desktop window's replica host (docs/ggs-remote-plan.md §22): the one real Git Graph
// Studio frontend of this instance, shown to any number of remote viewers. A viewer's hello
// starts the recorder and earns a snapshot; batches go out to everyone; input comes back
// and is replayed here. A viewer that stops saying hello is forgotten, and with the last
// one the recorder stops — a desktop nobody watches pays nothing. A remote page reload is
// just a new viewer: nothing on the PC restarts, the extension pages (Claude Code's chat)
// keep running in this window whatever the browsers do.
//
// The window wears one UI at a time (§22.5): the first viewer owns it — the window is fitted
// to that viewer only, so two viewers never resize it back and forth — and a viewer whose
// form factor differs from the owner's (a phone beside a desktop browser, or the reverse) is
// told to run its own workbench instead of watching a copy laid out for someone else.
//
// Such a page still shows this window's extension webviews — Claude Code's chat — as live
// copies of their frames (§22.6): its up messages carry the stream (`w`) and land in that
// stream's share (webviewShare.ts), loaded with the first one.

import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { DomRecorder } from './recorder';
import { InputReplayer } from './replay';
import { VIEWER_TTL_MS, MIRROR_DOWN, type DownMessage, type UpMessage } from './protocol';
import { isPhoneWidth } from './uiMode';
import type { WebviewShare } from './webviewShare';

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
	if (isPhoneWidth(vw)) return { width: Math.max(320, Math.round(vw)), height: Math.max(480, Math.round(vh)) };
	const width = Math.max(800, Math.round(vw));
	const height = Math.max(500, Math.round(vw > 0 ? (width * vh) / vw : 760));
	return { width, height };
}

interface Viewer {
	seen: number;
	vw: number;
	vh: number;
}

export class MirrorHost {
	/** In arrival order: the first entry owns the window's size and UI. */
	private readonly viewers = new Map<string, Viewer>();
	private readonly recorder: DomRecorder;
	private readonly replayer: InputReplayer;
	/** The webview streams remote workbenches watch (§22.6), by stream key. */
	private readonly shares = new Map<string, WebviewShare>();
	private shareModule: Promise<typeof import('./webviewShare')> | null = null;
	private focused = false;
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

	/** The viewer whose viewport the window follows. */
	private owner(): [string, Viewer] | undefined {
		return this.viewers.entries().next().value;
	}

	private touch(viewer: string): void {
		const entry = this.viewers.get(viewer);
		if (entry) entry.seen = this.deps.now();
	}

	private fitOwner(): void {
		const owner = this.owner();
		if (!owner) return;
		const size = fitFor(owner[1].vw, owner[1].vh);
		this.deps.fit(size.width, size.height);
	}

	/** Whether anyone watches anything here: the focus emulation and the prune timer last
	 *  exactly as long. */
	private watched(): boolean {
		return this.viewers.size > 0 || this.shares.size > 0;
	}

	private settle(): void {
		const watched = this.watched();
		if (watched !== this.focused) {
			this.focused = watched;
			this.deps.focus(watched);
		}
		if (watched) {
			this.armPrune();
		} else if (this.pruneTimer !== null) {
			clearInterval(this.pruneTimer);
			this.pruneTimer = null;
		}
	}

	/** A message for one webview stream: its share, created on the first hello. */
	private receiveStream(message: UpMessage, stream: string): void {
		const share = this.shares.get(stream);
		if (share) {
			share.receive(message);
			if (share.viewerCount === 0) this.shares.delete(stream);
			this.settle();
			return;
		}
		if (message.k !== 'hello') return;
		this.shareModule ??= import('./webviewShare');
		void this.shareModule.then(({ WebviewShare }) => {
			const next = this.shares.get(stream) ?? new WebviewShare(stream, { send: (down) => this.deps.send(down), now: () => this.deps.now() });
			this.shares.set(stream, next);
			next.receive(message);
			this.settle();
		});
	}

	receive(message: UpMessage): void {
		if (!message || typeof message.from !== 'string') return;
		if (typeof message.w === 'string') {
			this.receiveStream(message, message.w);
			return;
		}
		const known = this.viewers.has(message.from);
		switch (message.k) {
			case 'hello': {
				this.viewers.set(message.from, { seen: this.deps.now(), vw: message.vw, vh: message.vh });
				const [ownerId, owner] = this.owner()!;
				if (ownerId === message.from) {
					this.fitOwner();
				} else if (isPhoneWidth(message.vw) !== isPhoneWidth(owner.vw)) {
					// The window is laid out for the owner's form factor: this viewer runs its
					// own workbench (and says bye as its page leaves).
					this.deps.send({ k: 'own', to: message.from });
				}
				if (!known) {
					this.settle();
					this.snapshotTo(message.from);
				}
				return;
			}
			case 'resnap':
				if (!known) return;
				this.touch(message.from);
				this.snapshotTo(message.from);
				return;
			case 'bye':
				this.drop(message.from);
				return;
			default: {
				if (!known) return;
				this.touch(message.from);
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
		for (const [viewer, entry] of [...this.viewers]) if (now - entry.seen > VIEWER_TTL_MS) this.drop(viewer);
		for (const [stream, share] of [...this.shares]) if (!share.prune()) this.shares.delete(stream);
		this.settle();
	}

	private drop(viewer: string): void {
		const wasOwner = this.owner()?.[0] === viewer;
		if (!this.viewers.delete(viewer)) return;
		this.replayer.forget(viewer);
		if (this.viewers.size > 0) {
			// The next viewer inherits the window: it follows that viewer's viewport now.
			if (wasOwner) this.fitOwner();
			return;
		}
		this.recorder.stop();
		this.settle();
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
