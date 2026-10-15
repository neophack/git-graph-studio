// The mirror's wire economy (module 19, docs/ggs-remote-plan.md §22.8): the owner's ask is
// 1/10 of the replica's traffic — the pages' own animations and re-render storms are not
// information, only the settled states and the core content are. This suite proves the
// three levers at the DOM level, on the same recorder/viewer pair the app runs:
//  - string deltas (a streamed chat token crosses as the token, not the paragraph),
//  - animation sampling (~5 Hz on attributes a script rewrites per frame; the settled
//    value always lands),
//  - storm holding (a virtualized list's passing re-renders collapse into the settled one),
// and then measures the three real workloads — a Claude-style streaming chat, a
// git-graph-rs-style virtualized list under scroll, and a JS-driven animation — against
// the pre-economy recorder (`{ legacy: true }`), asserting the 1/10 line on the modelled
// wire (each batch one EVENT frame, deflated past the frame codec's threshold) and on the
// raw JSON, with the copy verified identical to the PC at the end of every scenario.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { decode as decodeMsgpack, encode as encodeMsgpack } from '@msgpack/msgpack';
import { DomRecorder } from '../src/remote/mirror/recorder';
import { MirrorViewer } from '../src/remote/mirror/viewer';
import { applyDelta, stringDelta } from '../src/remote/mirror/protocol';
import type { DownMessage } from '../src/remote/mirror/protocol';

/** The frame codec's header, and its compression threshold — which the economy pass
 *  lowered from the shipped 1024 to 256 (DOM JSON collapses 4–8× even in small batches),
 *  so each side of the A/B uses its own era's threshold. The header is modelled so the
 *  benchmark counts the bytes the daemon actually puts on the socket. */
const HEADER_LEN = 20;
const THRESHOLD_LEGACY = 1024;
const THRESHOLD_ECONOMY = 256;
/** The EVENT envelope (`{event, id, payload}`) and per-message WebSocket overhead — the
 *  same constant on both sides of every A/B, so it never swings the ratio. */
const ENVELOPE = 64;

function pcDocument(body: string): Document {
	const doc = document.implementation.createHTMLDocument('pc');
	doc.body.innerHTML = body;
	return doc;
}

interface Session {
	pc: Document;
	recorder: DomRecorder;
	viewer: MirrorViewer;
	host: HTMLElement;
	sent: DownMessage[];
	snapshotBytes: number;
	/** The modelled wire bytes of everything this session sent (the snapshot included). */
	wire(): number;
	raw(): number;
}

function session(body: string, legacy = false): Session {
	const pc = pcDocument(body);
	const host = document.createElement('div');
	document.body.appendChild(host);
	const sent: DownMessage[] = [];
	let viewer: MirrorViewer;
	const recorder = new DomRecorder(
		pc,
		(ops, seq) => {
			const message: DownMessage = { k: 'ops', to: '*', seq, ops };
			sent.push(message);
			viewer.receive(message);
		},
		{ legacy }
	);
	viewer = new MirrorViewer(host, 'remote/1', {
		appBase: 'https://phone.example/w/i/v/1/main/',
		ggsBase: 'https://phone.example/w/i/ggs/tok/',
		resnap: () => undefined
	});
	const snap = recorder.snapshot();
	const snapBytes = Buffer.byteLength(JSON.stringify({ k: 'snap', to: 'remote/1', ...snap }));
	viewer.receive({ k: 'snap', to: 'remote/1', ...snap });
	const snapWire = HEADER_LEN + ENVELOPE + snapBytes;
	const threshold = legacy ? THRESHOLD_LEGACY : THRESHOLD_ECONOMY;
	const frameBytes = (message: DownMessage): number => {
		const payload = Buffer.from(JSON.stringify(message));
		const body = payload.length >= threshold ? Math.min(payload.length, deflateRawSync(payload).length) : payload.length;
		return HEADER_LEN + ENVELOPE + body;
	};
	return {
		pc,
		recorder,
		viewer,
		host,
		sent,
		snapshotBytes: snapWire,
		wire: () => snapWire + sent.reduce((sum, m) => sum + frameBytes(m), 0),
		raw: () => snapBytes + sent.reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify(m)), 0)
	};
}

/** The copy's body markup must equal the PC's after every scenario — the economy changes
 *  what crosses, never what the copy shows. */
function expectCopyMatches(session: Session): void {
	expect(session.viewer.root!.body.innerHTML).toBe(session.pc.body.innerHTML);
}

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = '';
});

describe('string deltas', () => {
	it('sends the edit, not the string, and reconstructs exactly', () => {
		const long = 'The quick brown fox jumps over the lazy dog. '.repeat(6);
		const appended = long + ' And so it ends.';
		const append = stringDelta(long, appended);
		expect(append.p).toBe(long.length);
		expect(append.s).toBe(0);
		expect(applyDelta(long, append)).toBe(appended);
		const mid = long.slice(0, 60) + 'XX' + long.slice(62);
		const edit = stringDelta(long, mid);
		expect(applyDelta(long, edit)).toBe(mid);
		// A whole-value rewrite does not pay as a delta; short strings never delta.
		expect(stringDelta(long, 'z'.repeat(long.length))).toEqual({ v: 'z'.repeat(long.length) });
		expect(stringDelta(undefined, long)).toEqual({ v: long });
		expect(stringDelta(long, long)).toEqual({ v: long });
		expect(stringDelta('short', 'shortish')).toEqual({ v: 'shortish' });
	});

	it('never splits a surrogate pair — an emoji swap keeps the fragment whole on the wire', () => {
		// The scans match UTF-16 code units, so an emoji swapped for its neighbour (the low
		// surrogate equal, the high not) once parked the suffix cut between the halves, and
		// the fragment plus one kept side each carried a lone surrogate — which msgpack's
		// UTF-8 turns into U+FFFD on the viewer: silent divergence, no resnap ever.
		const wellFormed = (text: string): boolean => {
			for (let i = 0; i < text.length; i += 1) {
				const unit = text.charCodeAt(i);
				if (unit >= 0xd800 && unit <= 0xdbff) {
					const after = text.charCodeAt(i + 1);
					if (!(after >= 0xdc00 && after <= 0xdfff)) return false;
					i += 1;
				} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
			}
			return true;
		};
		const head = '提交记录: a1b2c3 说明文字与状态 '.repeat(2);
		const tail = ' —— 尾部足够长，让后缀扫描停在交换的位置之后。'.repeat(2);
		// A neighbour emoji splits at the suffix scan; a same-high/different-low pair splits
		// at the prefix scan — both cuts must back off to the pair's start.
		for (const [was, now] of [
			['\u{1F510}', '\u{1F910}'],
			['\u{1F510}', '\u{1F511}']
		] as const) {
			const base = head + was + tail;
			const next = head + now + tail;
			const delta = stringDelta(base, next);
			expect(next.length).toBeGreaterThanOrEqual(48); // the delta path, not the short-string out
			expect(delta.p).toBeDefined();
			expect(applyDelta(base, delta)).toBe(next);
			expect(wellFormed(delta.v)).toBe(true);
			expect(wellFormed(base.slice(0, delta.p!))).toBe(true);
			expect(wellFormed(base.slice(base.length - (delta.s ?? 0)))).toBe(true);
			// The wire's own encoding: a lone surrogate would not survive it unchanged.
			const wire = decodeMsgpack(encodeMsgpack({ v: delta.v })) as { v: string };
			expect(wire.v).toBe(delta.v);
		}
	});

	it('a streamed paragraph crosses as its tokens — and the copy holds the whole text', () => {
		const s = session('<div class="transcript"><p id="p">seed</p></div>');
		const text = s.pc.getElementById('p')!.firstChild as Text;
		const words = 'the model rewrites this paragraph token by token as the reply streams in over the socket'.split(' ');
		for (const word of words) {
			text.data += ` ${word}`;
			s.recorder.flush();
		}
		const textOps = s.sent.flatMap((m) => (m.k === 'ops' ? m.ops.filter((op) => op.o === 'text') : [])) as Extract<DownMessage, { k: 'ops' }>['ops'];
		expect(textOps.length).toBeGreaterThan(10);
		// Short strings cross whole (the delta would not pay); past the threshold every
		// growth of a long paragraph is its token.
		const deltas = textOps.filter((op) => op.o === 'text' && op.p !== undefined);
		expect(deltas.length).toBeGreaterThanOrEqual(textOps.length - 10);
		expect(deltas.every((op) => op.v.length <= 12)).toBe(true);
		expectCopyMatches(s);
	});

	it('a long control value and a long style attribute cross as deltas', async () => {
		vi.useFakeTimers();
		const s = session('<textarea id="commit"></textarea><div id="bar" style=""></div>');
		const commit = s.pc.getElementById('commit') as HTMLTextAreaElement;
		let value = 'fix(remote): the mirror carries ';
		for (const word of 'only what changed across every text shaped value on the wire'.split(' ')) {
			value += `${word} `;
			commit.value = value;
			commit.dispatchEvent(new Event('input', { bubbles: true }));
			s.recorder.flush();
			await vi.advanceTimersByTimeAsync(1);
		}
		const valOps = s.sent.flatMap((m) => (m.k === 'ops' ? m.ops.filter((op) => op.o === 'val') : [])) as Extract<DownMessage, { k: 'ops' }>['ops'];
		expect(valOps.filter((op) => op.o === 'val' && op.p !== undefined).length).toBeGreaterThan(5);

		// A transform-only tween (the common JS animation): the numbers differ, the
		// declaration around them is the common prefix and suffix.
		const bar = s.pc.getElementById('bar')!;
		const styleOf = (i: number) => `will-change:transform;transform:translate3d(${i}.50px, ${(i * 2)}.25px, 0px) rotate(${i}.0deg)`;
		bar.setAttribute('style', styleOf(0));
		s.recorder.flush();
		for (let i = 1; i <= 8; i += 1) {
			bar.setAttribute('style', styleOf(i * 9));
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(16);
		}
		// The animation over: the settled value lands.
		await vi.advanceTimersByTimeAsync(1500);
		const styleOps = s.sent.flatMap((m) => (m.k === 'ops' ? m.ops.filter((op) => op.o === 'attr' && op.k === 'style') : [])) as Extract<DownMessage, { k: 'ops' }>['ops'];
		// The 8 follow-ups are one rapid run: sampled, and each sample is a delta of the numbers.
		const samples = styleOps.filter((op) => op.o === 'attr' && op.p !== undefined);
		expect(samples.length).toBeGreaterThanOrEqual(1);
		expect(styleOps.length).toBeLessThanOrEqual(4);
		expectCopyMatches(s);
	});

	it('a delta whose base the copy lost resnaps instead of diverging', () => {
		const s = session('<p id="p">seed</p>');
		const p = s.pc.getElementById('p')!.firstChild!;
		p.textContent = 'the paragraph grows into a long streamed answer that the viewer replays as deltas';
		s.recorder.flush();
		// The viewer forgets its base (a lost batch): the next delta must not land.
		const resnaps: number[] = [];
		s.viewer.dispose();
		s.sent.length = 0;
		const fresh = new MirrorViewer(s.host, 'remote/1', {
			appBase: 'https://phone.example/w/i/v/1/main/',
			ggsBase: 'https://phone.example/w/i/ggs/tok/',
			resnap: () => resnaps.push(1)
		});
		// A viewer without a snapshot ignores ops entirely; one WITH a snapshot but a lost
		// base throws inside apply — both paths end in a resnap, never a wrong copy.
		p.textContent += ' more';
		s.recorder.flush();
		const snap = s.recorder.snapshot();
		fresh.receive({ k: 'snap', to: 'remote/1', ...snap });
		expect(fresh.root!.body.innerHTML).toBe(s.pc.body.innerHTML);
		expect(resnaps).toHaveLength(0);
	});
});

describe('animation sampling', () => {
	it('an attribute a script rewrites per frame crosses at a sampled cadence, and its settled value lands', async () => {
		vi.useFakeTimers();
		const s = session('<div id="orbit" style="left:0px"></div>');
		const orbit = s.pc.getElementById('orbit')!;
		const styleOf = (i: number) => `will-change:transform;transform:translate3d(${(i * 7.25).toFixed(2)}px, ${(i * 3.5).toFixed(2)}px, 0px) rotate(${(i * 3).toFixed(1)}deg)`;
		// 60 frames of a JS-driven orbit at ~16 ms each.
		for (let i = 1; i <= 60; i += 1) {
			orbit.setAttribute('style', styleOf(i));
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(16);
		}
		const styleOps = s.sent.flatMap((m) => (m.k === 'ops' ? m.ops.filter((op) => op.o === 'attr' && op.k === 'style') : [])) as Extract<DownMessage, { k: 'ops' }>['ops'];
		// 60 frames under ~1 Hz sampling: the pre-animation state was the snapshot's, the
		// animation's own states cross at most once, and the settled value lands.
		expect(styleOps.length).toBeLessThanOrEqual(3);
		expect(styleOps.length).toBeGreaterThanOrEqual(1);
		// The animation over: the settled value lands without another mutation.
		await vi.advanceTimersByTimeAsync(1200);
		expectCopyMatches(s);
	});

	it('a single hover flip is not an animation — it crosses at once', () => {
		const s = session('<div id="row" class="row"></div>');
		const row = s.pc.getElementById('row')!;
		row.className = 'row hovered';
		s.recorder.flush();
		row.className = 'row';
		s.recorder.flush();
		const classOps = s.sent.flatMap((m) => (m.k === 'ops' ? m.ops.filter((op) => op.o === 'attr' && op.k === 'class') : [])) as Extract<DownMessage, { k: 'ops' }>['ops'];
		expect(classOps).toHaveLength(2);
		expectCopyMatches(s);
	});

	it('a snapshot taken mid-animation force-lands the pending value — deltas never desync', async () => {
		vi.useFakeTimers();
		const s = session('<div id="orbit" style="left:0px"></div>');
		const orbit = s.pc.getElementById('orbit')!;
		const styleOf = (i: number) => `will-change:transform;transform:translate3d(${(i * 11.5).toFixed(2)}px, ${(i * 4.25).toFixed(2)}px, 0px) rotate(${(i * 5).toFixed(1)}deg)`;
		// The run is under way — its newest value is pending — when a new viewer resnaps.
		for (let i = 1; i <= 12; i += 1) {
			orbit.setAttribute('style', styleOf(i));
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(16);
		}
		s.recorder.snapshot();
		// The animation continues past the snapshot; the first viewer's deltas must still
		// land against the value IT holds.
		for (let i = 13; i <= 30; i += 1) {
			orbit.setAttribute('style', styleOf(i));
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(16);
		}
		await vi.advanceTimersByTimeAsync(1200);
		expectCopyMatches(s);
	});

	it('an attribute changed away and back within one batch crosses nothing', () => {
		const s = session('<div id="row" class="row"></div>');
		const row = s.pc.getElementById('row')!;
		row.className = 'row hovered';
		row.className = 'row';
		s.recorder.flush();
		const classOps = s.sent.flatMap((m) => (m.k === 'ops' ? m.ops.filter((op) => op.o === 'attr' && op.k === 'class') : [])) as Extract<DownMessage, { k: 'ops' }>['ops'];
		expect(classOps).toHaveLength(0);
	});
});

describe('storm holding', () => {
	it('a virtualized list under scroll collapses its passing re-renders into the settled one', async () => {
		vi.useFakeTimers();
		const s = session('<div class="gg-list" id="list"></div>');
		const list = s.pc.getElementById('list')!;
		const row = (n: number) =>
			`<div class="gg-row" data-n="${n}"><span class="dot" style="color:#3aa">${n % 6}</span><span class="refs"><span class="chip main">main</span><span class="chip">feature/${n}</span></span><span class="msg">Commit number ${n}: refactor the streaming path and keep the wire thin</span><span class="by">dev</span><span class="at">2026-10-1${n % 10}</span></div>`;
		let next = 0;
		const fill = () => {
			for (let i = 0; i < 24; i += 1, next += 1) list.insertAdjacentHTML('beforeend', row(next));
		};
		fill();
		s.recorder.flush();
		s.sent.length = 0;
		// Ten scroll ticks, one rendered window each — the rows a passing viewer never reads.
		for (let tick = 0; tick < 10; tick += 1) {
			for (let i = 0; i < 4; i += 1) list.firstElementChild!.remove();
			for (let i = 0; i < 4; i += 1, next += 1) list.insertAdjacentHTML('beforeend', row(next));
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(50);
		}
		await vi.advanceTimersByTimeAsync(1100);
		expectCopyMatches(s);
		// The batches that carried the whole storm: held to the cap, a 500 ms scroll
		// settles in ~1-2 batches, not 10.
		const stormBatches = s.sent.filter((m) => m.k === 'ops' && m.ops.some((op) => op.o === 'add'));
		expect(stormBatches.length).toBeLessThanOrEqual(4);
	});
});

describe('the 1/10 line, on the modelled wire', () => {
	it('a Claude-style streaming chat', async () => {
		vi.useFakeTimers();
		const run = async (legacy: boolean) => {
			const s = session('<div class="chat"><div class="transcript" id="tr"></div><div id="composer" contenteditable="true">​</div></div>', legacy);
			const tr = s.pc.getElementById('tr')!;
			const para = (): Text => {
				const block = s.pc.createElement('div');
				block.className = 'msg assistant';
				const body = s.pc.createElement('div');
				body.className = 'body';
				const p = s.pc.createElement('p');
				p.appendChild(s.pc.createTextNode(''));
				body.appendChild(p);
				block.appendChild(body);
				tr.appendChild(block);
				return p.firstChild as Text;
			};
			let text = para();
			const words = ('Here is the analysis of the repository you asked for: the module map binds every file to one of nineteen modules, the seams are enforced by the build, and the plan is authoritative. '
				+ 'I walked the remote access path end to end, measured the bytes at each hop, and rewrote the batching so the wire carries the deltas only. ').split(' ');
			let sinceBlock = 0;
			// ~30 tokens a second for twelve seconds — a long real reply, on the recorder's
			// own cadence (not forced flushes).
			for (let i = 0; i < 360; i += 1) {
				text.data += `${words[i % words.length]} `;
				sinceBlock += 1;
				if (sinceBlock === 60) {
					sinceBlock = 0;
					text = para();
				}
				await Promise.resolve();
				await vi.advanceTimersByTimeAsync(33);
			}
			await vi.advanceTimersByTimeAsync(600);
			return s;
		};
		const legacy = await run(true);
		const economy = await run(false);
		expectCopyMatches(economy);
		expectCopyMatches(legacy);
		const ratio = legacy.wire() / economy.wire();
		// eslint-disable-next-line no-console
		console.log(`streaming chat: legacy ${legacy.wire()} B, economy ${economy.wire()} B (${ratio.toFixed(1)}x)`);
		expect(economy.wire()).toBeLessThan(legacy.wire() / 10);
	});

	it('a git-graph-style virtualized list under scroll', async () => {
		vi.useFakeTimers();
		const run = async (legacy: boolean) => {
			const s = session('<div class="gg-list" id="list"></div>', legacy);
			const list = s.pc.getElementById('list')!;
			const row = (n: number) =>
				`<div class="gg-row" data-n="${n}"><span class="dot" style="color:#3aa">${n % 6}</span><span class="refs"><span class="chip main">main</span><span class="chip">feature/${n}</span></span><span class="msg">Commit number ${n}: refactor the streaming path and keep the wire thin across every hop of the relay</span><span class="by">dev</span><span class="at">2026-10-1${n % 10}</span></div>`;
			// A fast fling re-renders the whole window per scroll event — the traffic hog.
			let base = 0;
			const window_ = () => {
				list.innerHTML = Array.from({ length: 24 }, (_, i) => row(base + i)).join('');
			};
			window_();
			s.recorder.flush();
			s.sent.length = 0;
			for (let tick = 1; tick <= 40; tick += 1) {
				base += 24;
				window_();
				await Promise.resolve();
				await vi.advanceTimersByTimeAsync(50);
			}
			await vi.advanceTimersByTimeAsync(700);
			return s;
		};
		const legacy = await run(true);
		const economy = await run(false);
		expectCopyMatches(economy);
		expectCopyMatches(legacy);
		const ratio = legacy.wire() / economy.wire();
		// eslint-disable-next-line no-console
		console.log(`virtualized scroll: legacy ${legacy.wire()} B, economy ${economy.wire()} B (${ratio.toFixed(1)}x)`);
		expect(economy.wire()).toBeLessThan(legacy.wire() / 10);
	}, 30_000); // two full recorder runs of 40 re-rendered windows: CPU-bound, slow under a parallel suite

	it('a JS-driven animation', async () => {
		vi.useFakeTimers();
		const run = async (legacy: boolean) => {
			const s = session('<div class="stage"><div class="orbit" id="o1" style="left:0px"></div><div class="orbit" id="o2" style="left:0px"></div><div class="orbit" id="o3" style="left:0px"></div><div class="orbit" id="o4" style="left:0px"></div></div>', legacy);
			const orbits = ['o1', 'o2', 'o3', 'o4'].map((id) => s.pc.getElementById(id)!);
			const styleOf = (el: number, i: number) =>
				`will-change:transform;transform:translate3d(${((i * (el + 1)) % 400).toFixed(2)}px, ${(i * 3.5).toFixed(2)}px, 0px) rotate(${(i * 3).toFixed(1)}deg)`;
			for (let i = 1; i <= 320; i += 1) {
				orbits.forEach((el, at) => el.setAttribute('style', styleOf(at, i)));
				await Promise.resolve();
				await vi.advanceTimersByTimeAsync(16);
			}
			await vi.advanceTimersByTimeAsync(1200);
			return s;
		};
		const legacy = await run(true);
		const economy = await run(false);
		expectCopyMatches(economy);
		expectCopyMatches(legacy);
		const ratio = legacy.wire() / economy.wire();
		// eslint-disable-next-line no-console
		console.log(`js animation: legacy ${legacy.wire()} B, economy ${economy.wire()} B (${ratio.toFixed(1)}x)`);
		expect(economy.wire()).toBeLessThan(legacy.wire() / 10);
	});

	it('the three workloads together stay under the line', async () => {
		vi.useFakeTimers();
		const totals = { legacy: 0, economy: 0 };
		const chat = async (legacy: boolean) => {
			const s = session('<div class="transcript" id="tr"></div>', legacy);
			const tr = s.pc.getElementById('tr')!;
			const p = s.pc.createElement('p');
			p.appendChild(s.pc.createTextNode(''));
			tr.appendChild(p);
			const text = p.firstChild as Text;
			const words = 'the reply streams token by token into the paragraph while the phone watches the copy settle at its own cadence'.repeat(3).split(' ');
			for (let i = 0; i < 200; i += 1) {
				text.data += `${words[i % words.length]} `;
				await Promise.resolve();
				await vi.advanceTimersByTimeAsync(33);
			}
			await vi.advanceTimersByTimeAsync(400);
			return s.wire();
		};
		totals.legacy += await chat(true);
		totals.economy += await chat(false);
		const scroll = async (legacy: boolean) => {
			const s = session('<div class="gg-list" id="list"></div>', legacy);
			const list = s.pc.getElementById('list')!;
			const row = (n: number) => `<div class="gg-row"><span class="msg">commit ${n} keeps the message long enough to look real</span><span class="by">dev</span></div>`;
			let base = 0;
			list.innerHTML = Array.from({ length: 24 }, (_, i) => row(i)).join('');
			s.recorder.flush();
			s.sent.length = 0;
			for (let tick = 1; tick <= 10; tick += 1) {
				base += 24;
				list.innerHTML = Array.from({ length: 24 }, (_, i) => row(base + i)).join('');
				await Promise.resolve();
				await vi.advanceTimersByTimeAsync(50);
			}
			await vi.advanceTimersByTimeAsync(400);
			return s.wire();
		};
		totals.legacy += await scroll(true);
		totals.economy += await scroll(false);
		const ratio = totals.legacy / totals.economy;
		// eslint-disable-next-line no-console
		console.log(`combined: legacy ${totals.legacy} B, economy ${totals.economy} B (${ratio.toFixed(1)}x)`);
		expect(totals.economy).toBeLessThan(totals.legacy / 10);
	});
});
