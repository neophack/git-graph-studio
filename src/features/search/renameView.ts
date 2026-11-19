// The symbol rename dialog (module 5): a plan preview over the persistent index's answer,
// then the apply — the planned sites grouped per file with 1-based jumps, the conflict list
// that disables the apply, the working state whose generation discards a stale answer, and
// the on-disk note whose external-change bar the editors raise after a write.

import { symbolRenameApply, symbolRenamePreview, type RenamePlan, type RenameSite } from '../../platform/ipc/symbols';
import { t, tf } from '../../platform/i18n';
import { el, icon } from '../../platform/ui/index';

import './rename.css';

/** What the host wires the dialog to: a site row's jump opens the file at its 1-based line. */
export interface RenameDialogHooks {
	/** A planned site's row click. `line` is 1-based; `path` is repo-relative as the index spells it. */
	onOpen: (path: string, line: number) => void;
}

/** Past this many planned sites the per-file groups start folded (the first file open):
 *  a workspace-wide name plans thousands of rows, and none of them is the answer's point. */
const FOLD_THRESHOLD = 400;

/** The single open dialog, so a second invocation just re-focuses it (the Settings dialog's rule). */
let openOverlay: HTMLElement | null = null;

/** The message an invoke refusal carries (a thrown Error's own, everything else its string). */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function openRenameDialog(initials: { old?: string } = {}, hooks: RenameDialogHooks): void {
	// A dialog left over from a torn-down DOM (a test, a reload) must not block a fresh one.
	if (openOverlay && !openOverlay.isConnected) openOverlay = null;
	if (openOverlay) {
		openOverlay.querySelector<HTMLInputElement>('.rename-new')?.focus();
		return;
	}

	const overlay = el('div', 'rename-overlay');
	const dialog = el('div', 'rename-dialog');
	const title = el('span', 'rename-title', [t('rename.title')]);
	const close = el('button', 'rename-close', [icon('chrome-close')]);

	const oldInput = el('input', 'input rename-old') as HTMLInputElement;
	oldInput.type = 'text';
	oldInput.readOnly = true;
	oldInput.value = initials.old ?? '';
	oldInput.spellcheck = false;
	const newInput = el('input', 'input rename-new') as HTMLInputElement;
	newInput.type = 'text';
	newInput.spellcheck = false;

	const previewButton = el('button', 'button secondary rename-preview', [t('rename.preview')]);
	const applyButton = el('button', 'button rename-apply', [t('rename.apply')]);
	const closeButton = el('button', 'button secondary rename-close-button', [t('rename.close')]);

	const results = el('div', 'rename-results');
	const note = el('div', 'rename-note', [t('rename.diskNote')]);

	dialog.append(
		el('div', 'rename-header', [title, close]),
		el('div', 'rename-form', [
			el('div', 'rename-row', [el('label', '', [t('rename.old')]), oldInput]),
			el('div', 'rename-row', [el('label', '', [t('rename.new')]), newInput]),
			el('div', 'rename-actions', [previewButton, applyButton, closeButton])
		]),
		results,
		note
	);
	overlay.appendChild(dialog);
	document.getElementById('overlays')!.appendChild(overlay);
	openOverlay = overlay;

	// The in-flight generation: a second request invalidates every answer still travelling,
	// so re-typing the new name and asking again never paints the first ask's late plan.
	let generation = 0;
	let inFlight: 'preview' | 'apply' | null = null;

	/** The request round's buttons: the asking one reads the working label, both sit
	 *  disabled until the (accepted) answer lands — the stale one restores nothing. */
	const setBusy = (busy: boolean, asking: 'preview' | 'apply'): void => {
		inFlight = busy ? asking : null;
		previewButton.disabled = busy;
		applyButton.disabled = busy || applyButton.disabled;
		previewButton.replaceChildren(busy && asking === 'preview' ? t('rename.working') : t('rename.preview'));
		applyButton.replaceChildren(busy && asking === 'apply' ? t('rename.working') : t('rename.apply'));
		if (!busy) applyButton.disabled = results.querySelector('.rename-conflicts, .rename-empty') !== null;
	};
	newInput.addEventListener('input', () => {
		// Editing the question mid-flight re-arms the preview: the answer still travelling
		// is for a name the field no longer holds, and the next click is a fresh ticket.
		if (inFlight === 'preview') {
			inFlight = null;
			previewButton.disabled = false;
			previewButton.replaceChildren(t('rename.preview'));
		}
	});

	/** One planned site's row: the 1-based line:column, its click the host's jump. */
	const siteRow = (site: RenameSite): HTMLButtonElement => {
		const row = el('button', 'rename-site', [`${site.line + 1}:${site.column + 1}`]);
		row.title = `${site.path}:${site.line + 1}`;
		row.addEventListener('click', () => hooks.onOpen(site.path, site.line + 1));
		return row;
	};

	const renderPlan = (oldName: string, plan: RenamePlan): void => {
		results.textContent = '';
		applyButton.disabled = plan.conflicts.length > 0 || plan.sites.length === 0;
		if (plan.conflicts.length > 0) {
			const conflicts = el('div', 'rename-conflicts', [el('div', 'rename-failed', [t('rename.conflictHeader')])]);
			for (const line of plan.conflicts) conflicts.appendChild(el('div', 'rename-conflict-line', [line]));
			results.appendChild(conflicts);
		}
		if (plan.sites.length === 0) {
			results.appendChild(el('div', 'rename-empty', [tf('rename.empty', oldName)]));
			return;
		}
		// The plan grouped per file, first appearance order; the fold rule keeps a
		// workspace-wide plan's later files closed (the first file open).
		const groups = new Map<string, RenameSite[]>();
		for (const site of plan.sites) {
			const list = groups.get(site.path);
			if (list) list.push(site);
			else groups.set(site.path, [site]);
		}
		const foldAll = plan.sites.length > FOLD_THRESHOLD;
		let first = true;
		for (const [path, sites] of groups) {
			const host = el('div', 'rename-sites');
			host.hidden = foldAll && !first;
			first = false;
			const twistie = el('span', 'rename-twistie', [icon(host.hidden ? 'chevron-right' : 'chevron-down')]);
			const head = el('button', 'rename-file-head', [twistie, tf('rename.locations', path, sites.length)]);
			head.addEventListener('click', () => {
				host.hidden = !host.hidden;
				twistie.replaceChildren(icon(host.hidden ? 'chevron-right' : 'chevron-down'));
			});
			results.append(head, host);
			for (const site of sites) host.appendChild(siteRow(site));
		}
	};

	const renderFailure = (error: unknown): void => {
		results.textContent = '';
		results.appendChild(el('div', 'rename-failed', [tf('rename.failed', messageOf(error))]));
	};

	const runPreview = (): void => {
		const oldName = oldInput.value.trim();
		const newName = newInput.value.trim();
		if (!oldName || !newName || previewButton.disabled) return;
		const ticket = ++generation;
		setBusy(true, 'preview');
		symbolRenamePreview(oldName, newName)
			.then((plan) => {
				if (ticket !== generation) return;
				setBusy(false, 'preview');
				renderPlan(oldName, plan);
			})
			.catch((error) => {
				if (ticket !== generation) return;
				setBusy(false, 'preview');
				renderFailure(error);
			});
	};

	const runApply = (): void => {
		const oldName = oldInput.value.trim();
		const newName = newInput.value.trim();
		if (!oldName || !newName || applyButton.disabled) return;
		const ticket = ++generation;
		setBusy(true, 'apply');
		symbolRenameApply(oldName, newName)
			.then((outcome) => {
				if (ticket !== generation) return;
				setBusy(false, 'apply');
				results.textContent = '';
				results.appendChild(el('div', 'rename-done', [tf('rename.done', outcome.applied, outcome.files.length)]));
				const files = el('div', 'rename-out-files');
				for (const path of outcome.files) files.appendChild(el('div', '', [path]));
				results.appendChild(files);
				for (const failure of outcome.errors) {
					results.appendChild(el('div', 'rename-failed', [`${failure.path}: ${failure.message}`]));
				}
			})
			.catch((error) => {
				if (ticket !== generation) return;
				setBusy(false, 'apply');
				renderFailure(error);
			});
	};

	previewButton.addEventListener('click', runPreview);
	applyButton.addEventListener('click', runApply);

	const closeDialog = () => {
		// No timers ride this dialog — the generation ticket is the only in-flight state, and
		// a stale answer arriving after the close paints nothing (its `results` is detached).
		document.removeEventListener('keydown', onKeyDown);
		overlay.remove();
		openOverlay = null;
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') closeDialog();
	};
	document.addEventListener('keydown', onKeyDown);
	overlay.addEventListener('mousedown', (event) => {
		if (event.target === overlay) closeDialog();
	});
	close.addEventListener('click', closeDialog);
	closeButton.addEventListener('click', closeDialog);

	newInput.focus();
}
