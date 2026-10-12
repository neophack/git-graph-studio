// The PC half of a webview stream (docs/ggs-remote-plan.md §22.6): one extension webview's
// live page in the desktop window — Claude Code's chat — copied into every remote page that
// runs its own workbench and asked for it. Every webview lives in the desktop window
// (ext_routing.rs), so the copy is the conversation itself: a question asked at the PC
// streams into the phone's copy, and the phone's taps and keys are replayed into this very
// page, streaming back on the PC. The recorder and the input replay are the window
// replica's own (recorder.ts, replay.ts), rooted at the frame's document instead of the
// window's; a frame that reloads (`setHtml`) or is replaced (the sidebar rebuilt) restarts
// them, and every viewer gets a fresh snapshot.

import { DomRecorder } from './recorder';
import { InputReplayer } from './replay';
import { VIEWER_TTL_MS, type DownMessage, type UpMessage } from './protocol';
import { webviewFrameSource } from './webviewFrames';

/** How often a watched stream re-checks its frame (a view resolving, a tab remounting). */
const FOLLOW_MS = 1000;

export interface WebviewShareDeps {
	send(message: DownMessage): void;
	now(): number;
}

export class WebviewShare {
	private readonly viewers = new Map<string, number>();
	private frame: HTMLIFrameElement | null = null;
	private doc: Document | null = null;
	private recorder: DomRecorder | null = null;
	private replayer: InputReplayer | null = null;
	private followTimer: ReturnType<typeof setInterval> | null = null;
	private readonly onLoad = () => void this.follow();

	constructor(
		readonly stream: string,
		private readonly deps: WebviewShareDeps
	) {}

	get viewerCount(): number {
		return this.viewers.size;
	}

	receive(message: UpMessage): void {
		const known = this.viewers.has(message.from);
		switch (message.k) {
			case 'hello':
				this.viewers.set(message.from, this.deps.now());
				if (known) return;
				webviewFrameSource()?.ensure(this.stream);
				if (this.followTimer === null) this.followTimer = setInterval(() => void this.follow(), FOLLOW_MS);
				// A document the follow just found snapshots everyone; an unchanged one still
				// owes this new viewer its first picture.
				if (!this.follow()) this.snapshotTo(message.from);
				return;
			case 'resnap':
				if (!known) return;
				this.viewers.set(message.from, this.deps.now());
				this.snapshotTo(message.from);
				return;
			case 'bye':
				this.drop(message.from);
				return;
			default: {
				if (!known || !this.replayer || !this.recorder) return;
				this.viewers.set(message.from, this.deps.now());
				const text = this.replayer.handle(message);
				if (message.k === 'copy') this.deps.send({ k: 'clip', to: message.from, w: this.stream, text: text ?? '' });
				this.recorder.flush();
			}
		}
	}

	/** Forget viewers gone silent; answers whether anyone still watches. */
	prune(): boolean {
		const now = this.deps.now();
		for (const [viewer, seen] of [...this.viewers]) if (now - seen > VIEWER_TTL_MS) this.drop(viewer);
		return this.viewers.size > 0;
	}

	private drop(viewer: string): void {
		if (!this.viewers.delete(viewer)) return;
		this.replayer?.forget(viewer);
		if (this.viewers.size === 0) this.stop();
	}

	stop(): void {
		if (this.followTimer !== null) clearInterval(this.followTimer);
		this.followTimer = null;
		this.frame?.removeEventListener('load', this.onLoad);
		this.frame = null;
		this.recorder?.stop();
		this.recorder = null;
		this.replayer = null;
		this.doc = null;
	}

	/** Track the stream's current frame and document; a new document restarts the
	 *  recording and re-snapshots every viewer (answers whether it did). */
	private follow(): boolean {
		const frame = webviewFrameSource()?.frameFor(this.stream) ?? null;
		if (frame !== this.frame) {
			this.frame?.removeEventListener('load', this.onLoad);
			frame?.addEventListener('load', this.onLoad);
			this.frame = frame;
		}
		let doc: Document | null = null;
		try {
			doc = frame?.contentDocument ?? null;
		} catch {
			doc = null;
		}
		if (doc === this.doc) return false;
		this.recorder?.stop();
		this.doc = doc;
		this.recorder = doc ? new DomRecorder(doc, (ops, seq) => this.deps.send({ k: 'ops', to: '*', w: this.stream, seq, ops })) : null;
		this.replayer = this.recorder && doc ? new InputReplayer(this.recorder, doc) : null;
		for (const viewer of this.viewers.keys()) this.snapshotTo(viewer);
		return true;
	}

	private snapshotTo(viewer: string): void {
		if (!this.recorder) return;
		const snap = this.recorder.snapshot();
		this.deps.send({ k: 'snap', to: viewer, w: this.stream, ...snap });
	}
}
