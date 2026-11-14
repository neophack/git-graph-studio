// The CAN database a `.dbc` opens in: the backend parsed the whole file once
// (`dbc_open` — messages, signals, value tables, comments), this view browses it — a
// filtered message list on the left, the selected frame's signals and its value
// tables on the right, and a Decode panel that feeds the crate's decoder a frame id
// and payload bytes (`dbc_decode`) and reads the physical values back. "Text" swaps
// the tab to the file's plain text form, editable (the caller owns the editor swap —
// the same one-button journey a CAN trace takes).

import { type DbcMessage, type DbcOpenResult, dbcClose, dbcDecode, dbcOpen } from '../../platform/ipc/dbc';
import { basename, el, icon } from '../../platform/ui/index';
import { t, tf } from '../../platform/i18n';

/** Messages the list renders before it stops and names the cap — a database past
 *  this many frames is browsed through the filter, not scrolled. */
const MAX_RENDERED = 3000;

export interface DbcViewOptions {
	/** "Text" swaps this tab to the file's plain text form, editable (the caller owns
	 *  the editor swap). */
	onEditText?: () => void;
}

export class DbcView {
	readonly root: HTMLElement;
	private readonly liveText: HTMLElement;
	private readonly search: HTMLInputElement;
	private readonly listBody: HTMLElement;
	private readonly detail: HTMLElement;
	private doc: DbcOpenResult | null = null;
	private failed = false;
	private selected: DbcMessage | null = null;
	private timer: number | null = null;
	private disposed = false;

	constructor(private path: string, options: DbcViewOptions = {}) {
		const pathChip = el('span', 'can-path', [this.path]);
		pathChip.title = this.path;
		this.liveText = el('span', 'can-live-text', [t('dbc.live.opening')]);
		const live = el('span', 'can-live can-live-parsing', [el('span', 'can-live-dot'), this.liveText]);
		this.search = el('input', 'dbc-search') as HTMLInputElement;
		this.search.type = 'text';
		this.search.placeholder = t('dbc.search');
		this.search.setAttribute('aria-label', t('dbc.search'));
		this.search.addEventListener('input', () => this.renderList());
		const toolbar = el('div', 'hex-toolbar can-toolbar', [pathChip, live, this.search]);
		if (options.onEditText) {
			const textButton = el('button', 'button secondary can-text', [icon('edit'), ` ${t('dbc.text')}`]) as HTMLButtonElement;
			textButton.title = t('dbc.text.title');
			textButton.addEventListener('click', () => options.onEditText?.());
			toolbar.appendChild(textButton);
		}
		this.listBody = el('div', 'dbc-list-body');
		const head = el('div', 'dbc-list-head', [
			el('span', 'dbc-hcell dbc-c-id', [t('dbc.col.id')]),
			el('span', 'dbc-hcell dbc-c-name', [t('dbc.col.name')]),
			el('span', 'dbc-hcell dbc-c-dlc', [t('dbc.col.dlc')]),
			el('span', 'dbc-hcell dbc-c-sender', [t('dbc.col.sender')])
		]);
		const list = el('div', 'dbc-list', [head, this.listBody]);
		this.detail = el('div', 'dbc-detail', [el('div', 'dbc-detail-empty', [t('dbc.pick')])]);
		const body = el('div', 'dbc-body', [list, this.detail]);
		this.root = el('div', 'can-view dbc-view', [toolbar, body]);
		void this.load();
	}

	private async load(): Promise<void> {
		let doc: DbcOpenResult;
		try {
			doc = await dbcOpen(this.path);
		} catch (error) {
			this.fail(tf('dbc.openFailed', basename(this.path), String(error)));
			return;
		}
		if (this.disposed) {
			void dbcClose(doc.docId);
			return;
		}
		this.doc = doc;
		this.liveText.parentElement?.classList.remove('can-live-parsing');
		this.setLive(tf('dbc.live.done', doc.messages.length.toLocaleString(), doc.nodes.length.toLocaleString()));
		this.renderList();
	}

	private setLive(text: string): void {
		this.liveText.textContent = text;
	}

	private fail(text: string): void {
		this.failed = true;
		this.liveText.parentElement?.classList.remove('can-live-parsing');
		this.setLive(t('dbc.live.failed'));
		this.listBody.replaceChildren(el('div', 'can-error dbc-banner', [text]));
	}

	/** The filtered message list, re-rendered on open and on every search keystroke. */
	private renderList(): void {
		const doc = this.doc;
		if (!doc || this.failed) return;
		const query = this.search.value.trim().toLowerCase();
		const matches = doc.messages.filter((m) => {
			if (query === '') return true;
			const idHex = m.id.toString(16).toLowerCase();
			return m.name.toLowerCase().includes(query) || idHex.includes(query.replace(/^0x/, '')) || String(m.id).includes(query);
		});
		const rows: HTMLElement[] = [];
		const shown = matches.slice(0, MAX_RENDERED);
		for (const m of shown) {
			const selected = this.selected?.id === m.id && this.selected?.extended === m.extended;
			const row = el('button', 'dbc-row' + (selected ? ' dbc-row-on' : ''), [
				el('span', 'dbc-cell dbc-c-id', [`0x${m.id.toString(16).toUpperCase()}`]),
				el('span', 'dbc-cell dbc-c-name', [el('span', 'dbc-name-text', [m.name])]),
				el('span', 'dbc-cell dbc-c-dlc', [String(m.dlc)]),
				el('span', 'dbc-cell dbc-c-sender', [m.transmitter || '—'])
			]) as HTMLButtonElement;
			row.type = 'button';
			if (m.extended) {
				const mark = el('span', 'dbc-ext', ['EXT']);
				mark.title = t('dbc.extended');
				row.children[1]?.appendChild(mark);
			}
			row.title = m.comment ?? '';
			row.addEventListener('click', () => this.select(m));
			rows.push(row);
		}
		const tail: HTMLElement[] = [];
		if (matches.length > MAX_RENDERED) {
			tail.push(el('div', 'dbc-capped', [tf('dbc.capped', matches.length.toLocaleString(), MAX_RENDERED.toLocaleString())]));
		} else if (matches.length === 0) {
			tail.push(el('div', 'dbc-capped', [t('dbc.noMatch')]));
		}
		this.listBody.replaceChildren(...rows, ...tail);
		if (this.selected && !matches.includes(this.selected)) {
			this.selected = null;
			this.renderDetail();
		}
	}

	private select(m: DbcMessage): void {
		this.selected = m;
		for (const row of this.listBody.querySelectorAll('.dbc-row')) row.classList.remove('dbc-row-on');
		this.renderDetail();
		this.renderList();
	}

	/** The selected frame's signals, value tables and comment — plus the decode panel. */
	private renderDetail(): void {
		const m = this.selected;
		if (!m) {
			this.detail.replaceChildren(el('div', 'dbc-detail-empty', [t('dbc.pick')]));
			return;
		}
		const title = el('div', 'dbc-detail-title', [
			el('span', 'dbc-title-name', [m.name]),
			el('span', 'dbc-title-id', [`0x${m.id.toString(16).toUpperCase()}`]),
			m.extended ? el('span', 'dbc-ext', ['EXT']) : el('span', 'dbc-ext dbc-ext-std', ['STD']),
			el('span', 'dbc-title-meta', [tf('dbc.title.meta', m.dlc, m.transmitter || '—')])
		]);
		const parts: HTMLElement[] = [title];
		if (m.comment) parts.push(el('div', 'dbc-comment', [m.comment]));
		// The signal table.
		const head = el('div', 'dbc-sig-head', [
			el('span', 'dbc-hcell dbc-s-name', [t('dbc.sig.name')]),
			el('span', 'dbc-hcell dbc-s-bits', [t('dbc.sig.bits')]),
			el('span', 'dbc-hcell dbc-s-order', [t('dbc.sig.order')]),
			el('span', 'dbc-hcell dbc-s-scale', [t('dbc.sig.scale')]),
			el('span', 'dbc-hcell dbc-s-range', [t('dbc.sig.range')]),
			el('span', 'dbc-hcell dbc-s-unit', [t('dbc.sig.unit')]),
			el('span', 'dbc-hcell dbc-s-rx', [t('dbc.sig.rx')])
		]);
		const sigRows = m.signals.map((s) => {
			const order = s.littleEndian ? t('dbc.order.intel') : t('dbc.order.motorola');
			const scale = s.offset === 0 ? `×${s.scale}` : `×${s.scale} ${s.offset >= 0 ? '+' : '−'} ${Math.abs(s.offset)}`;
			const range = s.min === null && s.max === null ? '—' : `[${s.min ?? ''}|${s.max ?? ''}]`;
			const mux = s.multiplex ? ` ${s.multiplex}` : '';
			const row = el('div', 'dbc-sig-row', [
				el('span', 'dbc-cell dbc-s-name', [s.name + mux]),
				el('span', 'dbc-cell dbc-s-bits', [`${s.startBit}|${s.length}`]),
				el('span', 'dbc-cell dbc-s-order', [order]),
				el('span', 'dbc-cell dbc-s-scale', [scale + (s.signed ? ' ' + t('dbc.signed') : '')]),
				el('span', 'dbc-cell dbc-s-range', [range]),
				el('span', 'dbc-cell dbc-s-unit', [s.unit || '—']),
				el('span', 'dbc-cell dbc-s-rx', [s.receivers.join(', ') || '—'])
			]);
			if (s.comment) row.title = s.comment;
			return row;
		});
		parts.push(el('div', 'dbc-signals', [head, ...sigRows]));
		// The decode panel.
		const idInput = el('input', 'dbc-decode-id') as HTMLInputElement;
		idInput.type = 'text';
		idInput.placeholder = t('dbc.decode.idHint');
		idInput.value = `0x${m.id.toString(16).toLowerCase()}`;
		const dataInput = el('input', 'dbc-decode-data') as HTMLInputElement;
		dataInput.type = 'text';
		dataInput.placeholder = t('dbc.decode.dataHint');
		const run = el('button', 'button secondary dbc-decode-run', [icon('zap'), ` ${t('dbc.decode.run')}`]) as HTMLButtonElement;
		run.type = 'button';
		const results = el('div', 'dbc-decode-results');
		run.addEventListener('click', () => void this.decode(idInput, dataInput, results));
		const enter = (event: KeyboardEvent) => {
			if (event.key === 'Enter') void this.decode(idInput, dataInput, results);
		};
		idInput.addEventListener('keydown', enter);
		dataInput.addEventListener('keydown', enter);
		const decodeBar = el('div', 'dbc-decode-bar', [
			el('span', 'dbc-decode-label', [t('dbc.decode.id')]),
			idInput,
			el('span', 'dbc-decode-label', [t('dbc.decode.data')]),
			dataInput,
			run
		]);
		parts.push(el('div', 'dbc-decode', [el('div', 'dbc-decode-title', [t('dbc.decode.title')]), decodeBar, results]));
		this.detail.replaceChildren(...parts);
	}

	private async decode(idInput: HTMLInputElement, dataInput: HTMLInputElement, results: HTMLElement): Promise<void> {
		const doc = this.doc;
		if (!doc || this.disposed) return;
		// The id field speaks hex first (a leading 0x, or any id carrying a hex
		// letter); bare digits read decimal.
		const raw = idInput.value.trim().toLowerCase();
		const base = raw.startsWith('0x') || /[a-f]/.test(raw.replace(/^0x/, '')) ? 16 : 10;
		const id = Number.parseInt(raw.replace(/^0x/, ''), base);
		if (!Number.isFinite(id) || id < 0) {
			results.replaceChildren(el('div', 'dbc-decode-error', [t('dbc.decode.badId')]));
			return;
		}
		try {
			const out = await dbcDecode(doc.docId, id, dataInput.value);
			if (this.disposed) return;
			const rows = out.map((d) =>
				el('div', 'dbc-decode-row', [
					el('span', 'dbc-cell dbc-d-name', [d.name]),
					el('span', 'dbc-cell dbc-d-raw', [tf('dbc.decode.raw', String(d.raw))]),
					el('span', 'dbc-cell dbc-d-value', [
						String(d.value),
						d.unit ? ` ${d.unit}` : '',
						d.label ? ` (${d.label})` : ''
					])
				])
			);
			results.replaceChildren(...rows);
		} catch (error) {
			if (this.disposed) return;
			results.replaceChildren(el('div', 'dbc-decode-error', [String(error)]));
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) clearTimeout(this.timer);
		if (this.doc) void dbcClose(this.doc.docId);
		this.root.remove();
	}
}
