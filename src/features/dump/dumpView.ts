// The view a `.dmp` / `.mdmp` opens in: the backend parsed the minidump's header,
// stream table, module list and memory map (`dump_open`) while this view mounts, and the
// carve pass (`dump_scan`) then walks the dumped memory regions for embedded files by
// magic signature — one streamed scan: progress as it runs, entries in batches, one
// done. The list is a proper extraction workbench: a header row with a select-all
// checkbox over column labels, per-row checkboxes with click / ctrl+click / shift+range
// selection and Ctrl+A, family and per-format filters that hide everything off-target,
// and an extract row that writes the selection (or the whole filtered set — carved
// files flat, rebuilt modules under `modules/`) into the output folder beside the dump.
// A preview pane shows the picked entry (images in place, a hex head otherwise) with
// two opens: extract-and-open in the app's own viewer, or extract-and-hand-to the
// system's default application.
//
// Filters run client-side over the entries the scan already delivered. The scan can be
// stopped (it retires on the backend's generation) and restarted from the toolbar.

import {
	dumpCancel,
	dumpExtract,
	dumpOpen,
	dumpPreview,
	dumpScan,
	type CarvedEntry,
	type DumpEvent,
	type DumpExtractRequest,
	type DumpOverview,
	type DumpScanStart,
} from '../../platform/ipc/dump';
import { Channel } from '../../platform/ipc/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { basename, el, icon, notify } from '../../platform/ui/index';
import { t, tf } from '../../platform/i18n';
import {
	countByFormat,
	countByTag,
	carvedName,
	filterCarved,
	formatBytes,
	hexDump,
	imageMime,
	TAG_ORDER,
	type DumpFilter,
} from './dumpModel';

/** The list stops rendering past this many rows — a filter hint takes over. */
const MAX_RENDER_ROWS = 4000;
/** The preview's byte cap (a data URL twice this size still decodes instantly). */
const PREVIEW_BYTES = 512 * 1024;
/** The hex preview's rows. */
const HEX_ROWS = 12;
/** One extraction in flight at a time; a second press is ignored. */
const OUT_DIR_SUFFIX = '_extracted';

/** A row identity: a carved entry by its id, a module by its base. */
type RowKey = string;

export interface DumpViewOptions {
	/** Opens an extracted file inside the app — the caller's own open routing picks the
	 *  viewer by extension (images to the image viewer, the rest to the hex viewer). */
	onOpenPath?: (path: string) => void;
}

export class DumpView {
	readonly root: HTMLElement;
	private readonly pathChip: HTMLElement;
	private readonly filesChip: HTMLButtonElement;
	private readonly modulesChip: HTMLButtonElement;
	private readonly scanButton: HTMLButtonElement;
	private readonly liveDot: HTMLElement;
	private readonly liveText: HTMLElement;
	private readonly live: HTMLElement;
	private readonly progressFill: HTMLElement;
	private readonly progress: HTMLElement;
	private readonly banner: HTMLElement;
	private readonly overview: HTMLElement;
	private readonly tagSelect: HTMLSelectElement;
	private readonly formatSelect: HTMLSelectElement;
	private readonly checkSelect: HTMLSelectElement;
	private readonly queryInput: HTMLInputElement;
	private readonly minInput: HTMLInputElement;
	private readonly countLabel: HTMLElement;
	private readonly selectAllBox: HTMLInputElement;
	private readonly selectAllBtn: HTMLButtonElement;
	private readonly selectNoneBtn: HTMLButtonElement;
	private readonly selectedLabel: HTMLElement;
	private readonly outInput: HTMLInputElement;
	private readonly extractButton: HTMLButtonElement;
	private readonly extractFilteredButton: HTMLButtonElement;
	private readonly openAppButton: HTMLButtonElement;
	private readonly openExternalButton: HTMLButtonElement;
	private readonly headRow: HTMLElement;
	private readonly list: HTMLElement;
	private readonly emptyHint: HTMLElement;
	private readonly previewBody: HTMLElement;
	private readonly previewHead: HTMLElement;
	private readonly previewActions: HTMLElement;

	/** The open answer (null until `dump_open` lands; failure shows the banner). */
	private overviewData: DumpOverview | null = null;
	private scanStart: DumpScanStart | null = null;
	/** The carved entries in scan order; the modules keep their own list. */
	private entries: CarvedEntry[] = [];
	/** 'opening' → 'scanning' → 'done' | 'failed'. */
	private phase: 'opening' | 'scanning' | 'done' | 'failed' = 'opening';
	/** Which tab the body shows. */
	private tab: 'files' | 'modules' = 'files';
	private filter: DumpFilter = { tag: '', format: '', query: '', minSize: 0, check: 'pass' };
	/** The selected rows across both tabs. */
	private selection = new Set<RowKey>();
	/** The range anchor for shift+click (the last direct selection). */
	private anchorKey: RowKey | null = null;
	/** The filtered rows as the last render laid them out — shift ranges and Ctrl+A
	 *  select within this. */
	private filteredCache: CarvedEntry[] = [];
	/** The row the preview shows (the last clicked). */
	private previewed: RowKey | null = null;
	private extractBusy = false;
	private disposed = false;

	constructor(private path: string, private options: DumpViewOptions = {}) {
		this.pathChip = el('span', 'can-path', [basename(path)]);
		this.pathChip.title = path;
		this.filesChip = el('button', 'button secondary csv-mode-chip', [icon('search'), ` ${t('dump.tab.files')}`]) as HTMLButtonElement;
		this.filesChip.title = t('dump.tab.files.title');
		this.filesChip.addEventListener('click', () => this.setTab('files'));
		this.modulesChip = el('button', 'button secondary csv-mode-chip', [icon('file-binary'), ` ${t('dump.tab.modules')}`]) as HTMLButtonElement;
		this.modulesChip.title = t('dump.tab.modules.title');
		this.modulesChip.addEventListener('click', () => this.setTab('modules'));
		this.scanButton = el('button', 'button secondary', [icon('refresh'), ` ${t('dump.scan')}`]) as HTMLButtonElement;
		this.scanButton.title = t('dump.scan.title');
		this.scanButton.addEventListener('click', () => void this.startScan());
		this.liveDot = el('span', 'can-live-dot');
		this.liveText = el('span', 'can-live-text', [t('dump.live.opening')]);
		this.live = el('span', 'can-live can-live-parsing', [this.liveDot, this.liveText]);
		this.progressFill = el('i');
		this.progress = el('div', 'can-progress', [this.progressFill]);
		const toolbar = el('div', 'hex-toolbar can-toolbar dump-toolbar', [
			this.pathChip,
			this.filesChip,
			this.modulesChip,
			this.scanButton,
			this.live,
		]);
		this.overview = el('div', 'dump-overview');
		this.banner = el('div', 'can-error dump-banner');
		this.banner.hidden = true;

		// The filter row: family, format, name query, minimum size — every control
		// narrows client-side, and the count label reports what survived.
		this.tagSelect = el('select', 'dump-tag-select') as HTMLSelectElement;
		this.tagSelect.setAttribute('aria-label', t('dump.filter.tag'));
		this.tagSelect.addEventListener('change', () => {
			this.filter = { ...this.filter, tag: this.tagSelect.value };
			this.renderList();
		});
		this.formatSelect = el('select', 'dump-tag-select dump-format-select') as HTMLSelectElement;
		this.formatSelect.setAttribute('aria-label', t('dump.filter.format'));
		this.formatSelect.addEventListener('change', () => {
			this.filter = { ...this.filter, format: this.formatSelect.value };
			this.renderList();
		});
		this.checkSelect = el('select', 'dump-tag-select dump-check-select') as HTMLSelectElement;
		this.checkSelect.setAttribute('aria-label', t('dump.filter.check'));
		this.checkSelect.addEventListener('change', () => {
			this.filter = { ...this.filter, check: this.checkSelect.value as DumpFilter['check'] };
			this.renderList();
		});
		this.queryInput = el('input', 'dump-query') as HTMLInputElement;
		this.queryInput.type = 'search';
		this.queryInput.placeholder = t('dump.filter.query');
		this.queryInput.addEventListener('input', () => {
			this.filter = { ...this.filter, query: this.queryInput.value };
			this.renderList();
		});
		this.minInput = el('input', 'dump-min') as HTMLInputElement;
		this.minInput.type = 'number';
		this.minInput.min = '0';
		this.minInput.placeholder = t('dump.filter.min');
		this.minInput.title = t('dump.filter.min.title');
		this.minInput.addEventListener('input', () => {
			const parsed = Number(this.minInput.value);
			this.filter = { ...this.filter, minSize: Number.isFinite(parsed) && parsed > 0 ? parsed : 0 };
			this.renderList();
		});
		this.countLabel = el('span', 'dump-count');
		this.checkSelect.replaceChildren(
			this.option('pass', t('dump.check.pass')),
			this.option('all', t('dump.check.all')),
			this.option('fail', t('dump.check.fail')),
		);
		const filterRow = el('div', 'dump-filter-row', [
			el('span', 'dump-filter-label', [t('dump.filter.tag')]),
			this.tagSelect,
			el('span', 'dump-filter-label', [t('dump.filter.format')]),
			this.formatSelect,
			el('span', 'dump-filter-label', [t('dump.filter.check')]),
			this.checkSelect,
			this.queryInput,
			this.minInput,
			this.countLabel,
		]);

		// The extract row: the selection's own controls (select the filtered set, clear,
		// a running total), the output folder, and the two extract scopes.
		this.selectAllBtn = el('button', 'button secondary dump-mini', [t('dump.select.all')]) as HTMLButtonElement;
		this.selectAllBtn.title = t('dump.select.all.title');
		this.selectAllBtn.addEventListener('click', () => this.selectAll());
		this.selectNoneBtn = el('button', 'button secondary dump-mini', [t('dump.select.none')]) as HTMLButtonElement;
		this.selectNoneBtn.title = t('dump.select.none.title');
		this.selectNoneBtn.addEventListener('click', () => this.clearSelection());
		this.selectedLabel = el('span', 'dump-selected');
		this.outInput = el('input', 'dump-out') as HTMLInputElement;
		this.outInput.type = 'text';
		this.outInput.title = t('dump.out.title');
		this.outInput.value = this.defaultOutDir();
		this.extractButton = el('button', 'button secondary dump-extract-sel', [icon('save'), ` ${t('dump.extract')}`]) as HTMLButtonElement;
		this.extractButton.title = t('dump.extract.title');
		this.extractButton.addEventListener('click', () => void this.extract(false));
		this.extractFilteredButton = el('button', 'button secondary dump-extract-all', [icon('save'), ` ${t('dump.extractAll')}`]) as HTMLButtonElement;
		this.extractFilteredButton.title = t('dump.extractAll.title');
		this.extractFilteredButton.addEventListener('click', () => void this.extract(true));
		const extractRow = el('div', 'dump-extract-row', [
			this.selectAllBtn,
			this.selectNoneBtn,
			this.selectedLabel,
			el('span', 'dump-filter-label', [t('dump.out')]),
			this.outInput,
			this.extractButton,
			this.extractFilteredButton,
		]);

		// The list's header row: the select-all checkbox over the column labels.
		this.selectAllBox = el('input', 'dump-check dump-check-all') as HTMLInputElement;
		this.selectAllBox.type = 'checkbox';
		this.selectAllBox.title = t('dump.select.all.title');
		this.selectAllBox.addEventListener('click', (event) => {
			event.stopPropagation();
			if (this.selectAllBox.checked) this.selectAll();
			else this.clearSelection();
		});
		const head = (cls: string, label: string) => el('span', `dump-hcell ${cls}`, [label]);
		this.headRow = el('div', 'dump-head', [
			el('span', 'dump-hcheck', [this.selectAllBox]),
			el('span', 'dump-hcell dump-hdot'),
			head('dump-hname', t('dump.col.file')),
			head('dump-cell', t('dump.col.type')),
			head('dump-cell dump-num', t('dump.col.size')),
			head('dump-cell dump-num', t('dump.col.offset')),
			head('dump-cell', t('dump.col.module')),
		]);

		this.list = el('div', 'dump-list');
		this.emptyHint = el('div', 'csv-empty dump-empty', [t('dump.empty')]);
		this.emptyHint.hidden = true;
		this.list.addEventListener('click', (event) => this.onListClick(event));
		const listPane = el('div', 'dump-list-pane', [this.headRow, this.list, this.emptyHint]);
		this.previewHead = el('div', 'dump-preview-head');
		this.openAppButton = el('button', 'button secondary dump-mini dump-open-app', [icon('folder-opened'), ` ${t('dump.openInApp')}`]) as HTMLButtonElement;
		this.openAppButton.title = t('dump.openInApp.title');
		this.openAppButton.addEventListener('click', () => void this.openPreviewed(false));
		this.openExternalButton = el('button', 'button secondary dump-mini dump-open-ext', [icon('open-as-editor'), ` ${t('dump.openExternal')}`]) as HTMLButtonElement;
		this.openExternalButton.title = t('dump.openExternal.title');
		this.openExternalButton.addEventListener('click', () => void this.openPreviewed(true));
		this.previewActions = el('div', 'dump-preview-actions', [this.openAppButton, this.openExternalButton]);
		this.previewActions.hidden = true;
		this.previewBody = el('div', 'dump-preview-body');
		const previewPane = el('div', 'dump-preview-pane', [this.previewHead, this.previewActions, this.previewBody]);
		const body = el('div', 'dump-body', [listPane, previewPane]);

		this.root = el('div', 'can-view dump-view', [
			toolbar,
			this.progress,
			this.banner,
			this.overview,
			filterRow,
			extractRow,
			body,
		]);
		this.root.addEventListener('keydown', (event) => {
			// Ctrl+A is the list's select-all — not the workbench's editor select-all.
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && this.tab === 'files') {
				event.preventDefault();
				event.stopPropagation();
				this.selectAll();
			}
		});
		this.syncChips();
		this.syncButtons();
		void this.load();
	}

	/** Closes the tab: a running scan retires on the backend (the page is gone). */
	dispose(): void {
		this.disposed = true;
		if (this.phase === 'scanning') void dumpCancel().catch(() => undefined);
	}

	/* ---------- loading and scanning ---------- */

	private async load(): Promise<void> {
		try {
			this.overviewData = await dumpOpen(this.path);
			this.renderOverview();
			await this.startScan();
		} catch (e) {
			this.fail(e instanceof Error ? e.message : String(e));
		}
	}

	private async startScan(): Promise<void> {
		if (this.phase === 'scanning') return;
		this.entries = [];
		this.selection.clear();
		this.anchorKey = null;
		this.previewed = null;
		this.previewBody.replaceChildren();
		this.previewHead.replaceChildren();
		this.previewActions.hidden = true;
		this.phase = 'scanning';
		this.setLive(t('dump.live.scanning'), true);
		this.progress.hidden = false;
		this.progressFill.style.width = '0%';
		this.syncButtons();
		this.renderList();
		try {
			const channel = new Channel<DumpEvent>((event) => this.onScanEvent(event));
			this.scanStart = await dumpScan(this.path, null, channel);
			// The tab's own list is what the events already rendered; only the modules tab
			// needs a pass now that the module list has landed — an unconditional module
			// render would wipe the Files tab's carved rows.
			if (this.tab === 'modules') this.renderModules();
		} catch (e) {
			if (!this.disposed) this.fail(e instanceof Error ? e.message : String(e));
		}
	}

	private onScanEvent(event: DumpEvent): void {
		if (this.disposed || this.phase !== 'scanning') return;
		if (event.kind === 'progress') {
			this.progressFill.style.width = event.total > 0 ? `${Math.min(100, (event.scanned / event.total) * 100).toFixed(1)}%` : '0%';
			this.liveText.textContent = `${t('dump.live.scanning')} ${formatBytes(event.scanned)} / ${formatBytes(event.total)} · ${event.entries}`;
			this.renderList();
		} else if (event.kind === 'batch') {
			this.entries = this.entries.concat(event.entries);
			this.fillFilterSelects();
			this.renderList();
		} else {
			this.phase = 'done';
			this.progress.hidden = true;
			this.fillFilterSelects();
			this.setLive(
				event.cancelled
					? t('dump.live.cancelled')
					: tf('dump.live.done', String(event.entries), `${(event.elapsedMs / 1000).toFixed(1)}s`),
				false
			);
			this.syncButtons();
			this.renderList();
		}
	}

	private fail(message: string): void {
		this.phase = 'failed';
		this.progress.hidden = true;
		this.banner.hidden = false;
		this.banner.textContent = tf('dump.openFailed', basename(this.path), message);
		this.setLive(t('dump.live.failed'), false);
		this.syncButtons();
	}

	private setLive(text: string, busy: boolean): void {
		this.liveText.textContent = text;
		this.live.classList.toggle('can-live-parsing', busy);
		this.live.classList.toggle('can-live-done', !busy);
	}

	/* ---------- rendering ---------- */

	private renderOverview(): void {
		const o = this.overviewData;
		if (!o) return;
		const date = o.timeDateStamp > 0 ? new Date(o.timeDateStamp * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';
		const bits: string[] = [
			`${o.os.arch} ${o.os.version}`,
			tf('dump.overview.pid', String(o.pid)),
			tf('dump.overview.threads', String(o.threads)),
			tf('dump.overview.modules', String(o.modules.length), formatBytes(o.moduleTotalBytes)),
			tf('dump.overview.memory', String(o.memoryRegions), formatBytes(o.memoryTotalBytes)),
			tf('dump.overview.streams', String(o.streams.length)),
			o.hasException ? t('dump.overview.crash') : t('dump.overview.live'),
			date,
		];
		this.overview.replaceChildren(...bits.map((b) => el('span', 'dump-overview-item', [b])));
		this.overview.title = o.flagNames.length > 0 ? `${t('dump.overview.flags')}: ${o.flagNames.join(', ')}` : '';
	}

	/** Both filter selects: the family chips and the concrete formats, each naming its
	 *  own count. Preserves the user's choice across scan updates. */
	private fillFilterSelects(): void {
		const counts = countByTag(this.entries);
		const tagOptions: HTMLOptionElement[] = [
			this.option('', `${t('dump.filter.all')} (${this.entries.length})`),
		];
		for (const tag of TAG_ORDER) {
			if (counts[tag]) tagOptions.push(this.option(tag, `${t(`dump.tag.${tag}`)} (${counts[tag]})`));
		}
		// A family the scan found but this build does not name still gets a chip.
		for (const tag of Object.keys(counts)) {
			if (!TAG_ORDER.includes(tag as (typeof TAG_ORDER)[number]) && !tagOptions.some((o) => o.value === tag)) {
				tagOptions.push(this.option(tag, `${tag} (${counts[tag]})`));
			}
		}
		this.tagSelect.replaceChildren(...tagOptions);
		this.tagSelect.value = this.filter.tag;
		if (this.tagSelect.value !== this.filter.tag) {
			this.filter = { ...this.filter, tag: '' };
			this.tagSelect.value = '';
		}

		const formatOptions: HTMLOptionElement[] = [
			this.option('', t('dump.filter.allFormats')),
		];
		for (const [format, n] of countByFormat(this.entries)) {
			formatOptions.push(this.option(format, `${format} (${n})`));
		}
		this.formatSelect.replaceChildren(...formatOptions);
		this.formatSelect.value = this.filter.format;
		if (this.formatSelect.value !== this.filter.format) {
			this.filter = { ...this.filter, format: '' };
			this.formatSelect.value = '';
		}
	}

	private option(value: string, label: string): HTMLOptionElement {
		const option = el('option', undefined, [label]) as HTMLOptionElement;
		option.value = value;
		return option;
	}

	private setTab(tab: 'files' | 'modules'): void {
		if (this.tab === tab) return;
		this.tab = tab;
		this.previewed = null;
		this.previewBody.replaceChildren();
		this.previewHead.replaceChildren();
		this.previewActions.hidden = true;
		this.syncChips();
		this.renderList();
	}

	private syncChips(): void {
		this.filesChip.classList.toggle('can-chip-on', this.tab === 'files');
		this.filesChip.setAttribute('aria-pressed', String(this.tab === 'files'));
		this.modulesChip.classList.toggle('can-chip-on', this.tab === 'modules');
		this.modulesChip.setAttribute('aria-pressed', String(this.tab === 'modules'));
		this.tagSelect.disabled = this.tab === 'modules';
		this.formatSelect.disabled = this.tab === 'modules';
		this.checkSelect.disabled = this.tab === 'modules';
		this.minInput.disabled = this.tab === 'modules';
	}

	private filtered(): CarvedEntry[] {
		return filterCarved(this.entries, this.filter);
	}

	private syncButtons(): void {
		const busy = this.phase === 'scanning';
		this.scanButton.disabled = busy;
		this.extractButton.disabled = busy || this.extractBusy || this.selection.size === 0;
		this.extractFilteredButton.disabled = busy || this.extractBusy;
		this.selectAllBtn.disabled = busy || this.filteredCache.length === 0;
		this.selectNoneBtn.disabled = busy || this.selection.size === 0;
		this.extractButton.textContent = '';
		this.extractButton.replaceChildren(
			icon('save'),
			` ${t('dump.extract')}${this.selection.size > 0 ? ` (${this.selection.size})` : ''}`
		);
	}

	/** The selection's own UI: the header checkbox's three states, the running total,
	 *  and every row's checked mark. */
	private syncSelectionUi(): void {
		const total = this.tab === 'modules'
			? (this.scanStart?.modules ?? this.overviewData?.modules ?? []).length
			: this.filteredCache.length;
		const selected = this.selection.size;
		this.selectAllBox.checked = total > 0 && selected >= total;
		this.selectAllBox.indeterminate = selected > 0 && selected < total;
		const bytes = this.selectedBytes();
		this.selectedLabel.textContent = selected > 0 ? tf('dump.selected', String(selected), formatBytes(bytes)) : '';
		this.selectNoneBtn.disabled = this.phase === 'scanning' || selected === 0;
		this.selectAllBtn.disabled = this.phase === 'scanning' || total === 0;
		for (const row of this.list.querySelectorAll('.dump-row')) {
			const key = (row as HTMLElement).dataset.key ?? '';
			const box = row.querySelector('.dump-check') as HTMLInputElement | null;
			if (box) box.checked = this.selection.has(key);
		}
		this.syncButtons();
	}

	private selectedBytes(): number {
		let bytes = 0;
		for (const entry of this.entries) {
			if (this.selection.has(`f${entry.id}`)) bytes += entry.size;
		}
		for (const module of this.scanStart?.modules ?? this.overviewData?.modules ?? []) {
			if (this.selection.has(`m${module.base}`)) bytes += module.size;
		}
		return bytes;
	}

	private renderList(): void {
		if (this.tab === 'modules') {
			this.renderModules();
			return;
		}
		const filtered = this.filtered();
		this.filteredCache = filtered;
		const hidden = this.entries.length - filtered.length;
		this.countLabel.textContent = tf('dump.count', String(filtered.length), String(hidden));
		this.emptyHint.hidden = filtered.length > 0;
		this.emptyHint.textContent = this.phase === 'scanning' ? t('dump.scanningHint') : t('dump.empty');
		const rows: HTMLElement[] = [];
		for (const entry of filtered.slice(0, MAX_RENDER_ROWS)) {
			const key = `f${entry.id}`;
			const box = el('input', 'dump-check') as HTMLInputElement;
			box.type = 'checkbox';
			box.checked = this.selection.has(key);
			box.setAttribute('aria-label', carvedName(entry));
			const name = el('span', 'dump-name', [carvedName(entry)]);
			const row = el('div', 'dump-row', [
				el('span', 'dump-checkcell', [box]),
				el('span', `dump-dot dump-dot-${entry.tag}`),
				name,
				el('span', 'dump-cell', [entry.format]),
				el('span', 'dump-cell dump-num', [formatBytes(entry.size)]),
				el('span', 'dump-cell dump-num', [`0x${entry.offset.toString(16)}`]),
				el('span', 'dump-cell', [entry.inModule ?? '']),
			]);
			row.dataset.key = key;
			if (!entry.verified) {
				row.classList.add('dump-row-bad');
				row.title = t('dump.check.badge');
			}
			row.classList.toggle('dump-row-on', this.selection.has(key));
			rows.push(row);
		}
		if (filtered.length > MAX_RENDER_ROWS) {
			rows.push(el('div', 'dump-more', [tf('dump.more', String(filtered.length - MAX_RENDER_ROWS))]));
		}
		this.list.replaceChildren(...rows);
		this.syncSelectionUi();
	}

	private renderModules(): void {
		const modules = this.scanStart?.modules ?? this.overviewData?.modules ?? [];
		this.filteredCache = [];
		this.countLabel.textContent = tf('dump.count', String(modules.length), '0');
		this.emptyHint.hidden = modules.length > 0;
		const rows: HTMLElement[] = [];
		for (const module of modules) {
			const key = `m${module.base}`;
			const box = el('input', 'dump-check') as HTMLInputElement;
			box.type = 'checkbox';
			box.checked = this.selection.has(key);
			box.setAttribute('aria-label', module.fileName || module.name);
			const row = el('div', 'dump-row dump-row-module', [
				el('span', 'dump-checkcell', [box]),
				el('span', 'dump-dot dump-dot-module'),
				el('span', 'dump-name', [module.fileName || module.name]),
				el('span', 'dump-cell', [t('dump.kind.module')]),
				el('span', 'dump-cell dump-num', [formatBytes(module.size)]),
				el('span', 'dump-cell dump-num', [`0x${module.base.toString(16)}`]),
				el('span', 'dump-cell', [module.name]),
			]);
			row.dataset.key = key;
			row.title = module.name;
			row.classList.toggle('dump-row-on', this.selection.has(key));
			rows.push(row);
		}
		this.list.replaceChildren(...rows);
		this.syncSelectionUi();
	}

	/* ---------- selection and preview ---------- */

	private onListClick(event: MouseEvent): void {
		const target = event.target as HTMLElement;
		const row = target.closest('.dump-row') as HTMLElement | null;
		if (!row?.dataset.key) return;
		const key = row.dataset.key;
		const keys = this.tab === 'modules'
			? (this.scanStart?.modules ?? this.overviewData?.modules ?? []).map((m) => `m${m.base}`)
			: this.filteredCache.map((e) => `f${e.id}`);
		const checkbox = target.closest('.dump-check') as HTMLInputElement | null;
		if (checkbox) {
			// The checkbox is its own actuator: toggle without touching the rest.
			if (checkbox.checked) this.selection.add(key);
			else this.selection.delete(key);
			this.anchorKey = key;
			this.previewed = key;
			row.classList.toggle('dump-row-on', this.selection.has(key));
			this.syncSelectionUi();
			void this.renderPreview(key);
			return;
		}
		if (event.shiftKey && this.anchorKey) {
			// The range runs from the anchor to this row within the laid-out order.
			const from = keys.indexOf(this.anchorKey);
			const to = keys.indexOf(key);
			if (from !== -1 && to !== -1) {
				for (const k of keys.slice(Math.min(from, to), Math.max(from, to) + 1)) {
					this.selection.add(k);
				}
			} else {
				this.selection.add(key);
			}
		} else if (event.ctrlKey || event.metaKey) {
			if (this.selection.has(key)) this.selection.delete(key);
			else this.selection.add(key);
		} else {
			this.selection.clear();
			this.selection.add(key);
		}
		this.anchorKey = key;
		this.previewed = key;
		for (const el of this.list.querySelectorAll('.dump-row')) {
			el.classList.toggle('dump-row-on', this.selection.has((el as HTMLElement).dataset.key ?? ''));
		}
		this.syncSelectionUi();
		void this.renderPreview(key);
	}

	private selectAll(): void {
		if (this.tab === 'modules') {
			for (const module of this.scanStart?.modules ?? this.overviewData?.modules ?? []) {
				this.selection.add(`m${module.base}`);
			}
		} else {
			for (const entry of this.filteredCache) {
				this.selection.add(`f${entry.id}`);
			}
		}
		for (const el of this.list.querySelectorAll('.dump-row')) {
			el.classList.toggle('dump-row-on', true);
		}
		this.syncSelectionUi();
	}

	private clearSelection(): void {
		this.selection.clear();
		for (const el of this.list.querySelectorAll('.dump-row')) {
			el.classList.toggle('dump-row-on', false);
		}
		this.syncSelectionUi();
	}

	private moduleByBase(base: number) {
		const modules = this.scanStart?.modules ?? this.overviewData?.modules ?? [];
		return modules.find((m) => m.base === base) ?? null;
	}

	private carvedById(id: number): CarvedEntry | null {
		return this.entries.find((e) => e.id === id) ?? null;
	}

	private async renderPreview(key: RowKey): Promise<void> {
		this.previewHead.replaceChildren();
		this.previewActions.hidden = true;
		this.previewBody.replaceChildren(el('div', 'dump-preview-hint', [t('dump.preview.loading')]));
		try {
			if (key.startsWith('m')) {
				const module = this.moduleByBase(Number(key.slice(1)));
				if (!module) return;
				this.previewHead.replaceChildren(
					el('span', 'dump-preview-title', [module.fileName || module.name])
				);
				this.previewBody.replaceChildren(
					el('div', 'dump-preview-card', [
						el('div', 'dump-preview-line', [module.name]),
						el('div', 'dump-preview-line', [
							`base 0x${module.base.toString(16)} · ${formatBytes(module.size)} · ${new Date(
								module.timestamp * 1000
							).toISOString().slice(0, 10)}`,
						]),
						el('div', 'dump-preview-line', [t('dump.preview.moduleHint')]),
					])
				);
				this.previewActions.hidden = false;
				return;
			}
			const entry = this.carvedById(Number(key.slice(1)));
			if (!entry) return;
			const mime = imageMime(entry.format);
			this.previewHead.replaceChildren(
				el('span', 'dump-preview-title', [carvedName(entry)]),
				el('span', 'dump-preview-meta', [
					`${entry.format} · ${formatBytes(entry.size)} · 0x${entry.offset.toString(16)}${
						entry.inModule ? ` · ${entry.inModule}` : ''
					}`,
				])
			);
			const preview = await dumpPreview(this.path, entry.offset, entry.size, PREVIEW_BYTES);
			if (this.previewed !== key || this.disposed) return;
			const bytes = base64Bytes(preview.data);
			if (mime) {
				const blob = new Blob([bytes.slice(0, bytes.length)], { type: mime });
				const url = URL.createObjectURL(blob);
				const img = el('img', 'dump-preview-img') as HTMLImageElement;
				img.src = url;
				img.alt = carvedName(entry);
				img.addEventListener('load', () => {
					if (!preview.truncated) return;
					const note = el('div', 'dump-preview-line', [t('dump.preview.truncated')]);
					this.previewBody.appendChild(note);
				});
				this.previewBody.replaceChildren(img);
			}
			const head = hexDump(bytes.subarray(0, HEX_ROWS * 16), HEX_ROWS);
			this.previewBody.appendChild(el('pre', 'dump-preview-hex', [head]));
			this.previewActions.hidden = false;
		} catch (e) {
			if (!this.disposed) {
				this.previewBody.replaceChildren(
					el('div', 'dump-preview-hint', [tf('dump.preview.failed', e instanceof Error ? e.message : String(e))])
				);
			}
		}
	}

	/* ---------- open the previewed entry ---------- */

	/** Extracts the previewed entry (a single-item extract through the same path the
	 *  bulk extract takes) and opens it — inside the app via the caller's routing, or
	 *  in the system's default application. */
	private async openPreviewed(external: boolean): Promise<void> {
		if (!this.previewed || this.extractBusy) return;
		let request: DumpExtractRequest | null = null;
		let name = '';
		if (this.previewed.startsWith('m')) {
			const module = this.moduleByBase(Number(this.previewed.slice(1)));
			if (!module) return;
			name = module.fileName || 'module';
			request = {
				kind: 'module',
				format: 'exe',
				name,
				base: module.base,
				moduleSize: module.size,
			};
		} else {
			const entry = this.carvedById(Number(this.previewed.slice(1)));
			if (!entry) return;
			name = carvedName(entry);
			request = {
				kind: 'file',
				format: entry.format,
				name,
				offset: entry.offset,
				size: entry.size,
			};
		}
		const outDir = this.outInput.value.trim() || this.defaultOutDir();
		this.extractBusy = true;
		this.syncButtons();
		try {
			const channel = new Channel<DumpExtractProgressLike>(() => undefined);
			const result = await dumpExtract(this.path, [request], outDir, channel);
			const item = result.items.find((i) => i.name === name);
			if (!item || item.error || !item.path) {
				notify('error', tf('dump.extractFailed', item?.error ?? name));
				return;
			}
			if (external) {
				await openPath(item.path).catch((e) => notify('error', String(e)));
			} else {
				this.options.onOpenPath?.(item.path);
			}
		} catch (e) {
			notify('error', tf('dump.extractFailed', e instanceof Error ? e.message : String(e)));
		} finally {
			this.extractBusy = false;
			this.syncButtons();
		}
	}

	/* ---------- extract ---------- */

	private defaultOutDir(): string {
		const sep = this.path.includes('\\') ? '\\' : '/';
		const dir = this.path.slice(0, Math.max(this.path.lastIndexOf(sep), 0));
		const stem = basename(this.path).replace(/\.[^.]+$/, '');
		return `${dir}${sep}${stem}${OUT_DIR_SUFFIX}`;
	}

	private extractRequests(all: boolean) {
		const requests: DumpExtractRequest[] = [];
		if (this.tab === 'modules') {
			for (const module of this.scanStart?.modules ?? this.overviewData?.modules ?? []) {
				const key = `m${module.base}`;
				if (!all && !this.selection.has(key)) continue;
				requests.push({
					kind: 'module' as const,
					format: 'exe',
					name: module.fileName || 'module',
					base: module.base,
					moduleSize: module.size,
				});
			}
			return requests;
		}
		for (const entry of filterCarved(this.entries, this.filter)) {
			const key = `f${entry.id}`;
			if (!all && !this.selection.has(key)) continue;
			requests.push({
				kind: 'file' as const,
				format: entry.format,
				name: carvedName(entry),
				offset: entry.offset,
				size: entry.size,
			});
		}
		return requests;
	}

	private async extract(all: boolean): Promise<void> {
		if (this.extractBusy || this.phase === 'scanning') return;
		const requests = this.extractRequests(all);
		if (requests.length === 0) return;
		const outDir = this.outInput.value.trim() || this.defaultOutDir();
		this.extractBusy = true;
		this.syncButtons();
		this.setLive(tf('dump.live.extracting', String(requests.length)), true);
		try {
			const channel = new Channel<DumpExtractProgressLike>((event) => {
				this.liveText.textContent = tf('dump.live.extracting', `${event.done}/${event.total}`);
			});
			const result = await dumpExtract(this.path, requests, outDir, channel);
			const ok = result.items.filter((i) => !i.error).length;
			const failed = result.items.length - ok;
			this.setLive(
				failed > 0
					? tf('dump.extractPartial', String(ok), String(failed), result.outDir)
					: tf('dump.extractDone', String(ok), result.outDir),
				false
			);
		} catch (e) {
			this.setLive(tf('dump.extractFailed', e instanceof Error ? e.message : String(e)), false);
		} finally {
			this.extractBusy = false;
			this.syncButtons();
		}
	}
}

/** The extract channel's event, as this view reads it (the ipc type without the import). */
interface DumpExtractProgressLike {
	done: number;
	total: number;
	bytes: number;
	name: string;
}

/** Base64 → bytes, the preview's bridge shape. */
function base64Bytes(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
