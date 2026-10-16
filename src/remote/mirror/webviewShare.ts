// The PC half of a webview stream (docs/ggs-remote-plan.md §22.6): one extension webview's
// live page in the desktop window — Claude Code's chat — copied into every remote page that
// runs its own workbench and asked for it. Every webview lives in the desktop window
// (ext_routing.rs), so the copy is the conversation itself: a question asked at the PC
// streams into the phone's copy, and the phone's taps and keys are replayed into this very
// page, streaming back on the PC. The recorder and the input replay are the window
// replica's own (recorder.ts, replay.ts), rooted at the frame's document instead of the
// window's; a frame that reloads (`setHtml`) or is replaced (the sidebar rebuilt) restarts
// them, and every viewer gets a fresh snapshot. The page the copy shows is Claude's own,
// composer included (2026-10-16, the owner's direction: 远程 claude 使用原始界面 — no
// hand-written remote chat UI), so every control in it replays through the same input path.

import { DomRecorder } from './recorder';
import { InputReplayer } from './replay';
import { VIEWER_TTL_MS, type DownMessage, type UpMessage } from './protocol';
import { webviewFrameSource } from './webviewFrames';

/** How often a watched stream re-checks its frame (a view resolving, a tab remounting). */
const FOLLOW_MS = 1000;

/** How long the last interaction holds a stream's scroll ownership (§9.2: 3 seconds). */
const SCROLL_LEASE_MS = 3000;

/** The events that count as the PC user interacting with this frame (§9.2: wheel, touch,
 *  key). Observed, capture-phase, passive — the page's own handling is untouched. */
const LOCAL_INPUTS = ['wheel', 'pointerdown', 'keydown'] as const;

const LOCAL_OPTS = { capture: true, passive: true } as const;

export interface WebviewShareDeps {
	send(message: DownMessage): void;
	now(): number;
	/** Which events count as the PC user's own input on the frame (§9.2) — the browser's
	 *  trusted ones by default; a test rig may say every event does. */
	trusted?: (event: Event) => boolean;
}

export class WebviewShare {
	private readonly viewers = new Map<string, number>();
	private frame: HTMLIFrameElement | null = null;
	private doc: Document | null = null;
	private recorder: DomRecorder | null = null;
	private replayer: InputReplayer | null = null;
	private followTimer: ReturnType<typeof setInterval> | null = null;
	/** The stream's scroll owner (§9.2): who last interacted — `main` (the PC user's own
	 *  wheel, touch or key on this frame) or a viewer id — and when the lease lapses.
	 *  Only the owner's `scroll` replays; another end's scroll is dropped until it holds. */
	private scrollOwner: { who: string; until: number } | null = null;
	/** Each viewer's device label, from its hello — the follow hint names the owner. */
	private readonly viewerDevices = new Map<string, string>();
	private readonly onLoad = () => void this.follow();
	/** The PC user's own input on this frame: main takes the scroll ownership outright —
	 *  the real page already scrolled natively, the lease follows reality (§9.2). Only
	 *  trusted events count: the ones the replayer dispatches below are not. */
	private readonly onLocalInput = (event: Event): void => {
		if ((this.deps.trusted ?? ((e) => e.isTrusted))(event)) this.setScrollOwner('main');
	};

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
				if (message.device) this.viewerDevices.set(message.from, message.device);
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
				if (!this.gateScroll(message)) return;
				const text = this.replayer.handle(message);
				if (message.k === 'copy') this.deps.send({ k: 'clip', to: message.from, w: this.stream, text: text ?? '' });
				this.recorder.flush();
			}
		}
	}

	/** §9.2's scroll ownership. Every input message is an interaction (a bare hover is
	 *  not); the last end to interact owns the stream's scrolling for SCROLL_LEASE_MS,
	 *  renewed by its own further input. Only the owner's `scroll` and `wheel` replay —
	 *  another end's scroll attempt is dropped (nothing transfers while the lease holds)
	 *  and its author is told who holds it, so its copy shows the follow hint. Pointer,
	 *  key and text from a non-owner still replay — clicking a commit row or typing is
	 *  not scrolling — but take ownership only once the lease has lapsed. Answers whether
	 *  the message may replay. */
	private gateScroll(message: UpMessage): boolean {
		if (message.k === 'ptr' && message.ev === 'hover') return true;
		const now = this.deps.now();
		const owner = this.scrollOwner;
		if (owner === null || owner.until <= now || owner.who === message.from) {
			this.setScrollOwner(message.from);
			return true;
		}
		if (message.k === 'scroll' || message.k === 'wheel') {
			this.pushOwn(message.from);
			return false;
		}
		return true;
	}

	/** Take or renew the lease for `who` (`main` or a viewer id); a change of holder is
	 *  broadcast, so every copy shows or clears its follow hint. */
	private setScrollOwner(who: string): void {
		const changed = this.scrollOwner?.who !== who;
		this.scrollOwner = { who, until: this.deps.now() + SCROLL_LEASE_MS };
		if (changed) this.pushOwn('*');
	}

	/** Name the current holder for a viewer's hint (`main` is the PC; a viewer is the
	 *  device label its hello carried, its id when it carried none). */
	private pushOwn(to: string): void {
		const owner = this.scrollOwner;
		if (!owner) return;
		const name = owner.who === 'main' ? 'PC' : this.viewerDevices.get(owner.who) ?? owner.who;
		const ms = Math.max(0, owner.until - this.deps.now());
		this.deps.send({ k: 'own', to, w: this.stream, who: owner.who, name, ms });
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
		// The holder left: the lease is vacant (the next interaction anywhere takes it);
		// other copies' hints expire on their own timers.
		if (this.scrollOwner?.who === viewer) this.scrollOwner = null;
		if (this.viewers.size === 0) this.stop();
	}

	stop(): void {
		if (this.followTimer !== null) clearInterval(this.followTimer);
		this.followTimer = null;
		this.frame?.removeEventListener('load', this.onLoad);
		this.frame = null;
		this.wireLocalInput(null);
		this.recorder?.stop();
		this.recorder = null;
		this.replayer = null;
		this.doc = null;
		this.scrollOwner = null;
	}

	private wireLocalInput(doc: Document | null): void {
		this.doc?.removeEventListener('wheel', this.onLocalInput, LOCAL_OPTS);
		this.doc?.removeEventListener('pointerdown', this.onLocalInput, LOCAL_OPTS);
		this.doc?.removeEventListener('keydown', this.onLocalInput, LOCAL_OPTS);
		if (doc) for (const type of LOCAL_INPUTS) doc.addEventListener(type, this.onLocalInput, LOCAL_OPTS);
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
		// Unwire before the field moves: wireLocalInput removes from this.doc, which must
		// still be the OLD document — a swap to another live frame's document would
		// otherwise leave the wheel/pointer/key listeners armed on it.
		this.wireLocalInput(doc);
		this.doc = doc;
		this.makeRecorder();
		for (const viewer of this.viewers.keys()) this.snapshotTo(viewer);
		return true;
	}

	private makeRecorder(): void {
		const doc = this.doc;
		this.recorder = doc ? new DomRecorder(doc, (ops, seq) => this.deps.send({ k: 'ops', to: '*', w: this.stream, seq, ops })) : null;
		this.replayer = this.recorder && doc ? new InputReplayer(this.recorder, doc) : null;
	}

	private snapshotTo(viewer: string): void {
		if (!this.recorder) return;
		const snap = this.recorder.snapshot();
		this.deps.send({ k: 'snap', to: viewer, w: this.stream, ...snap });
	}
}
