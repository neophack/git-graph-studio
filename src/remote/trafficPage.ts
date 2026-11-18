// The session's Traffic page (docs/ggs-remote-plan.md §10.5): the Transport's own
// accounting (traffic.ts) rendered live — the totals and the compression's saving up top,
// then the wire by frame type and the subjects behind it (each invoke command, each event
// family, channel data). Re-renders once a second while open: the rate row is the diff.
// Opened from the navigation drawer and the `remote.traffic` command; the phone's back
// and Escape close it.
import { formatBytes } from '../platform/ui';
import { t, tf } from '../platform/i18n';
import { pushBack } from './backStack';
import { T } from './frame';
import { compressionSaved, type TrafficStats } from './traffic';
import { codicon } from './widgets';

let page: HTMLElement | null = null;
let body: HTMLElement | null = null;
let releaseBack: (() => void) | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
/** The previous tick's totals — the rate row is their diff. */
let lastUp = 0;
let lastDown = 0;
let lastAt = 0;

export function trafficPageOpen(): boolean {
	return page !== null;
}

/** The frame types the tables name, in display order; anything else folds into Other. */
const FRAME_LABELS: [number, string][] = [
	[T.INVOKE, 'invoke'],
	[T.RESULT, 'result'],
	[T.EVENT, 'event'],
	[T.CHAN_DATA, 'channel'],
	[T.LISTEN, 'listen']
];

function frameLabel(type: number): string {
	const hit = FRAME_LABELS.find(([key]) => key === type);
	return hit ? t(`remote.traffic.type.${hit[1]}` as 'remote.traffic.type.invoke') : t('remote.traffic.other');
}

function stats(): TrafficStats | null {
	// Off the shared session env: the desktop never builds a Transport, and this module
	// must not pull the socket stack into every page's boot.
	const env = (globalThis as { __GGS_REMOTE__?: { transport: { stats: TrafficStats } } }).__GGS_REMOTE__;
	return env?.transport.stats ?? null;
}

export function openTrafficPage(): void {
	if (page && !page.isConnected) closeTrafficPage();
	if (page) return;

	const root = document.createElement('div');
	root.className = 'ggs-settings-page';
	root.setAttribute('role', 'dialog');
	root.setAttribute('aria-modal', 'true');
	root.setAttribute('aria-label', t('remote.traffic.page'));

	const header = document.createElement('div');
	header.className = 'ggs-settings-header';
	const back = document.createElement('button');
	back.className = 'ggs-settings-back';
	back.title = t('remote.sheet.back');
	back.setAttribute('aria-label', t('remote.sheet.back'));
	back.appendChild(codicon('chevron-left'));
	back.addEventListener('click', closeTrafficPage);
	const title = document.createElement('div');
	title.className = 'ggs-settings-title';
	title.textContent = t('remote.traffic.page');
	const reset = document.createElement('button');
	reset.className = 'ggs-settings-back';
	reset.title = t('remote.traffic.reset');
	reset.setAttribute('aria-label', t('remote.traffic.reset'));
	reset.appendChild(codicon('clear-all'));
	reset.addEventListener('click', () => {
		// The counters are the Transport's own fields: zero them in place, keeping the
		// object identity every reader (the drawer's footer) already holds.
		const current = stats();
		if (!current) return;
		current.up = 0;
		current.down = 0;
		current.upPlain = 0;
		current.downPlain = 0;
		current.upByType.clear();
		current.downByType.clear();
		current.byName.clear();
		current.startedAt = Date.now();
		lastUp = 0;
		lastDown = 0;
		lastAt = 0;
		render();
	});
	header.append(back, title, reset);

	body = document.createElement('div');
	body.className = 'ggs-settings-level ggs-traffic-body';
	root.append(header, body);
	document.body.appendChild(root);
	page = root;
	lastUp = 0;
	lastDown = 0;
	lastAt = 0;
	render();
	ticker = setInterval(render, 1000);
	releaseBack = pushBack(closeTrafficPage);
	document.addEventListener('keydown', onKeyDown);
	requestAnimationFrame(() => root.classList.add('open'));
}

export function closeTrafficPage(): void {
	if (!page) return;
	const root = page;
	page = null;
	body = null;
	if (ticker !== null) {
		clearInterval(ticker);
		ticker = null;
	}
	releaseBack?.();
	releaseBack = null;
	document.removeEventListener('keydown', onKeyDown);
	root.classList.remove('open');
	setTimeout(() => root.remove(), 260);
}

function onKeyDown(event: KeyboardEvent): void {
	if (event.key === 'Escape') closeTrafficPage();
}

function render(): void {
	if (!body) return;
	const next = document.createElement('div');
	next.className = 'ggs-settings-level ggs-traffic-body';
	fill(next, stats());
	body.replaceWith(next);
	body = next;
}

function heading(text: string): HTMLElement {
	const el = document.createElement('div');
	el.className = 'ggs-settings-heading';
	el.textContent = text;
	return el;
}

function fill(root: HTMLElement, stats: TrafficStats | null): void {
	if (!stats) {
		root.appendChild(heading(t('remote.traffic.page')));
		const note = document.createElement('p');
		note.className = 'empty';
		note.textContent = t('remote.drawer.local');
		root.appendChild(note);
		return;
	}
	const now = Date.now();
	// The rate row: this render's diff against the previous one — 0 B/s until a second
	// tick has landed.
	const span = lastAt ? Math.max(1, (now - lastAt) / 1000) : 0;
	const rateUp = span ? (stats.up - lastUp) / span : 0;
	const rateDown = span ? (stats.down - lastDown) / span : 0;
	lastUp = stats.up;
	lastDown = stats.down;
	lastAt = now;

	root.appendChild(heading(t('remote.traffic.total')));
	const summary = document.createElement('div');
	summary.className = 'ggs-traffic-summary';
	const cell = (label: string, value: string): HTMLElement => {
		const el = document.createElement('div');
		el.className = 'ggs-traffic-cell';
		const name = document.createElement('span');
		name.className = 'name';
		name.textContent = label;
		const amount = document.createElement('span');
		amount.className = 'value';
		amount.textContent = value;
		el.append(name, amount);
		return el;
	};
	const minutes = Math.max(1, Math.round((now - stats.startedAt) / 60_000));
	summary.append(
		cell('↑', formatBytes(stats.up)),
		cell('↓', formatBytes(stats.down)),
		cell(t('remote.traffic.rate'), `${formatBytes(rateUp)}/s · ${formatBytes(rateDown)}/s`),
		cell(t('remote.traffic.savings'), `${Math.round(compressionSaved(stats) * 100)}%`),
		cell(t('remote.traffic.duration'), tf('remote.traffic.minutes', minutes))
	);
	root.appendChild(summary);

	const totalFrames = [...stats.upByType.values(), ...stats.downByType.values()].reduce((sum, bucket) => sum + bucket.frames, 0);
	if (totalFrames === 0) {
		const note = document.createElement('p');
		note.className = 'empty';
		note.textContent = t('remote.traffic.empty');
		root.appendChild(note);
		return;
	}

	root.appendChild(heading(t('remote.traffic.byType')));
	const types = table(['type', '↑', '↓', 'frames']);
	const seen = new Set<number>([...stats.upByType.keys(), ...stats.downByType.keys()]);
	const rows = [...seen].sort(
		(a, b) =>
			(stats.upByType.get(b)?.bytes ?? 0) + (stats.downByType.get(b)?.bytes ?? 0) - ((stats.upByType.get(a)?.bytes ?? 0) + (stats.downByType.get(a)?.bytes ?? 0))
	);
	for (const type of rows) {
		const up = stats.upByType.get(type);
		const down = stats.downByType.get(type);
		tableRow(types, [frameLabel(type), up ? formatBytes(up.bytes) : '—', down ? formatBytes(down.bytes) : '—', String((up?.frames ?? 0) + (down?.frames ?? 0))]);
	}
	root.appendChild(types);

	const names = [...stats.byName.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
	root.appendChild(heading(t('remote.traffic.bySubject')));
	const subjects = table(['subject', 'bytes', 'frames']);
	const top = 14;
	for (const [name, bucket] of names.slice(0, top)) tableRow(subjects, [name, formatBytes(bucket.bytes), String(bucket.frames)]);
	const rest = names.slice(top);
	if (rest.length) {
		const bytes = rest.reduce((sum, [, bucket]) => sum + bucket.bytes, 0);
		const frames = rest.reduce((sum, [, bucket]) => sum + bucket.frames, 0);
		tableRow(subjects, [t('remote.traffic.other'), formatBytes(bytes), String(frames)]);
	}
	root.appendChild(subjects);
	const note = document.createElement('p');
	note.className = 'ggs-traffic-note';
	note.textContent = t('remote.traffic.note');
	root.appendChild(note);
}

function table(headers: string[]): HTMLTableElement {
	const el = document.createElement('table');
	el.className = 'ggs-traffic-table';
	const head = el.createTHead().insertRow();
	for (const text of headers) {
		const th = document.createElement('th');
		// Literal marks (the ↑ / ↓ arrows) pass through; words resolve as i18n keys.
		th.textContent = text === 'type' || text === 'frames' || text === 'subject' || text === 'bytes' ? t(`remote.traffic.col.${text}` as 'remote.traffic.col.bytes') : text;
		head.appendChild(th);
	}
	return el;
}

function tableRow(table: HTMLTableElement, cells: string[]): void {
	const tr = table.insertRow();
	for (const text of cells) tr.insertCell().textContent = text;
}
