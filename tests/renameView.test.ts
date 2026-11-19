// The symbol rename dialog (module 5): the plan preview grouped per file with 1-based
// site jumps, the conflict list that disables the apply, the empty-answer note, the
// apply's done/failed wordings with its per-file errors, the in-flight disable, the
// stale-answer generation, the big list's fold rule, and the dismissals.

import { beforeEach, describe, expect, it } from 'vitest';

import { openRenameDialog } from '../src/features/search';
import { updateSetting } from '../src/platform/settings';
import { backend } from './tauriMock';
import { click, flush, key, texts, type } from './helpers';
import type { RenameOutcome, RenamePlan, RenameSite } from '../src/platform/ipc/symbols';

const plan = (over: Partial<RenamePlan>): RenamePlan => ({ name: 'alpha', sites: [], files: 0, conflicts: [], ...over });
const site = (path: string, line: number, column: number): RenameSite => ({ path, line, column });

let opened: { path: string; line: number }[] = [];

function open(initials: { old?: string } = {}): HTMLElement {
	opened = [];
	openRenameDialog(initials, { onOpen: (path, line) => opened.push({ path, line }) });
	return document.querySelector<HTMLElement>('.rename-overlay')!;
}

const results = () => document.querySelector<HTMLElement>('.rename-results')!;
const newInput = () => document.querySelector<HTMLInputElement>('.rename-new')!;
const previewButton = () => document.querySelector<HTMLButtonElement>('.rename-preview')!;
const applyButton = () => document.querySelector<HTMLButtonElement>('.rename-apply')!;
const closeButtons = () => document.querySelectorAll<HTMLButtonElement>('.rename-dialog .button.secondary');

/** Script a preview, type the new name and fire it. */
async function preview(planAnswer: RenamePlan | (() => RenamePlan | Promise<RenamePlan>)): Promise<void> {
	backend.on('symbol_rename_preview', planAnswer);
	open({ old: 'alpha' });
	type(newInput(), 'omega');
	click(previewButton());
	await flush(4);
}

beforeEach(() => {
	backend.reset();
	updateSetting('locale', 'en');
	document.body.innerHTML = '<div id="overlays"></div>';
});

describe('the dialog shell', () => {
	it('mounts with the title, the read-only current name and the editable new name', () => {
		open({ old: 'alpha' });
		expect(document.querySelector('.rename-title')!.textContent).toBe('Rename Symbol');
		const old = document.querySelector<HTMLInputElement>('.rename-old')!;
		expect(old.value).toBe('alpha');
		expect(old.readOnly).toBe(true);
		expect(newInput().value).toBe('');
		expect(texts('.rename-actions .button')).toEqual(['Preview', 'Rename', 'Close']);
		expect(document.querySelector('.rename-note')!.textContent).toContain('writes files on disk');

		// A second invocation re-focuses the open dialog instead of stacking another.
		open({ old: 'beta' });
		expect(document.querySelectorAll('.rename-overlay')).toHaveLength(1);
		expect(document.activeElement).toBe(newInput());
	});
});

describe('the preview', () => {
	it('renders the plan grouped per file, with 1-based site labels and the jump callback', async () => {
		await preview(() => plan({ sites: [site('src/a.ts', 0, 6), site('src/a.ts', 4, 2), site('src/b.ts', 2, 8)], files: 2 }));
		expect(texts('.rename-file-head', results())).toEqual(['src/a.ts — 2 locations', 'src/b.ts — 1 locations']);
		expect(applyButton().disabled).toBe(false);
		// The sites carry the 1-based line:column, each its click the host's jump at the
		// 1-based line.
		const rows = results().querySelectorAll<HTMLButtonElement>('.rename-site');
		expect([...rows].map((row) => row.textContent)).toEqual(['1:7', '5:3', '3:9']);
		click(rows[1]!);
		expect(opened).toEqual([{ path: 'src/a.ts', line: 5 }]);
		click(results().querySelectorAll<HTMLButtonElement>('.rename-site')[2]!);
		expect(opened.at(-1)).toEqual({ path: 'src/b.ts', line: 3 });

		// A file group folds and unfolds in place.
		const head = results().querySelectorAll<HTMLButtonElement>('.rename-file-head')[0]!;
		click(head);
		expect(results().querySelector('.rename-sites')!.hidden).toBe(true);
		click(head);
		expect(results().querySelector('.rename-sites')!.hidden).toBe(false);
	});

	it('lists the conflicts in their area and disables the apply', async () => {
		await preview(() => plan({ conflicts: ['beta.c holds a same-named function in this workspace'] }));
		expect(document.querySelector('.rename-conflicts')!.textContent).toContain('This rename cannot run safely:');
		expect(texts('.rename-conflict-line')).toEqual(['beta.c holds a same-named function in this workspace']);
		expect(applyButton().disabled).toBe(true);
	});

	it('answers an empty plan with the wording naming the symbol', async () => {
		await preview(() => plan({}));
		expect(results().textContent).toContain('No references found for alpha.');
		expect(results().querySelector('.rename-site')).toBeNull();
		expect(applyButton().disabled).toBe(true);
	});

	it('turns the asking button into the working label and disables both while in flight', async () => {
		let release: ((value: RenamePlan) => void) | null = null;
		backend.on('symbol_rename_preview', () => new Promise<RenamePlan>((resolve) => { release = resolve; }));
		open({ old: 'alpha' });
		type(newInput(), 'omega');
		click(previewButton());
		expect(previewButton().textContent).toBe('Working…');
		expect(previewButton().disabled).toBe(true);
		expect(applyButton().disabled).toBe(true);
		release!(plan({ sites: [site('src/a.ts', 0, 0)] }));
		await flush(4);
		expect(previewButton().textContent).toBe('Preview');
		expect(previewButton().disabled).toBe(false);
		expect(applyButton().disabled).toBe(false);
	});

	it('discards a stale answer: the last ask wins, the first one painting nothing late', async () => {
		let releaseStale: ((value: RenamePlan) => void) | null = null;
		backend.on('symbol_rename_preview', ({ newName }) => {
			if (newName === 'stale') {
				return new Promise<RenamePlan>((resolve) => { releaseStale = () => resolve(plan({ sites: [site('stale.ts', 0, 0)] })); });
			}
			return plan({ sites: [site('fresh.ts', 0, 0)] });
		});
		open({ old: 'alpha' });
		type(newInput(), 'stale');
		click(previewButton());
		type(newInput(), 'fresh');
		click(previewButton());
		await flush(6);
		expect(texts('.rename-file-head', results())).toEqual(['fresh.ts — 1 locations']);
		// The first ask's late answer must not repaint over the second one's.
		releaseStale!(plan({ sites: [site('stale.ts', 0, 0)] }));
		await flush(4);
		expect(texts('.rename-file-head', results())).toEqual(['fresh.ts — 1 locations']);
	});

	it('folds every file group but the first once the plan passes the fold threshold', async () => {
		const sites: RenameSite[] = [];
		for (let i = 0; i < 400; i++) sites.push(site('big.ts', i, 0));
		sites.push(site('tail.ts', 0, 0));
		await preview(() => plan({ sites, files: 2 }));
		const hosts = results().querySelectorAll<HTMLElement>('.rename-sites');
		expect(hosts[0]!.hidden).toBe(false);
		expect(hosts[1]!.hidden).toBe(true);
		// The folded group opens on its own head's click.
		click(results().querySelectorAll<HTMLButtonElement>('.rename-file-head')[1]!);
		expect(hosts[1]!.hidden).toBe(false);
	});
});

describe('the apply', () => {
	it('reports the applied totals, the per-file list, and the failures red', async () => {
		backend.on('symbol_rename_apply', ({ oldName, newName }) => {
			expect(oldName).toBe('alpha');
			expect(newName).toBe('omega');
			const outcome: RenameOutcome = { applied: 3, files: ['src/a.ts', 'src/b.ts'], errors: [{ path: 'src/c.ts', message: 'post-write verification failed' }] };
			return outcome;
		});
		open({ old: 'alpha' });
		type(newInput(), 'omega');
		click(applyButton());
		await flush(4);
		expect(results().textContent).toContain('Renamed 3 site(s) across 2 file(s).');
		expect(document.querySelector('.rename-out-files')!.textContent).toBe('src/a.tssrc/b.ts');
		expect(texts('.rename-failed', results())).toEqual(['src/c.ts: post-write verification failed']);
	});

	it('answers a refused apply with the failure wording', async () => {
		backend.on('symbol_rename_apply', () => {
			throw new Error('the file is read-only');
		});
		open({ old: 'alpha' });
		type(newInput(), 'omega');
		click(applyButton());
		await flush(4);
		expect(texts('.rename-failed', results())).toEqual(['Rename failed: the file is read-only']);
	});
});

describe('the dismissals', () => {
	it('closes on Escape, the backdrop and both close buttons', () => {
		key(document, 'Escape');
		// Nothing open, nothing closed — the Escape of an empty page answers nothing.
		expect(document.querySelector('.rename-overlay')).toBeNull();

		open({ old: 'alpha' });
		key(document, 'Escape');
		expect(document.querySelector('.rename-overlay')).toBeNull();

		const overlay = open({ old: 'alpha' });
		overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		expect(document.querySelector('.rename-overlay')).toBeNull();

		open({ old: 'alpha' });
		click(document.querySelector('.rename-close')!);
		expect(document.querySelector('.rename-overlay')).toBeNull();

		open({ old: 'alpha' });
		click(closeButtons()[1]!);
		expect(document.querySelector('.rename-overlay')).toBeNull();
	});
});
