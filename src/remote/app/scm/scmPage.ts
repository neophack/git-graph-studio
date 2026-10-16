// The phone's Source Control page (docs/remote-client-plan.md §6.4, the owner's
// 2026-10-16 direction: 手机端源代码管理界面不适合触控，要重新设计): the desktop view's
// 22 px rows, hover buttons and context menus rebuilt as a touch page — the branch row
// (tap to switch, the shared branch sheet), the commit card (a 16 px message box over a
// 48 px primary action whose label follows the repository's state: Commit, Push n, Sync,
// Publish), the change groups as sections with thumb-sized stage-all / unstage-all /
// discard-all, and 56 px rows whose tap opens the change, whose swipe-left uncovers the
// row's own verb (the platform's swipe-reveal, the same gesture §6.3 gave the classic
// rows) and whose ⋮ opens the row's sheet. Mounted INTO the SCM sidebar view exactly the
// way the Files page mounts into the explorer's (filesPage.ts): on a page-stack shell the
// classic view hides and this page shows; on the wide forms the classic view stays theirs.
//
// The page is a VIEW over the one SourceControlView instance — every action runs through
// its own methods (run, commit, discardFiles, subRun…), every state lives on it (message,
// collapsed groups, sort), so a device-class switch is seamless by construction: the wide
// form's classic view and this page are two renderings of the same repository state, and
// the switch re-renders both once.
import { basename, el, icon, toPosix, swipeReveal, type MenuEntry, type RevealAction } from '../../../platform/ui';
import { t, tf } from '../../../platform/i18n';
import { fileIcon, fileIconColor } from '../../../platform/fileIcons';
import { currentWorkbench } from '../../../workbench';
import { closeActionSheet, openSheet, showActionSheet } from '../../actionSheet';
import { onDeviceClassChange } from '../../responsive';
import { letterOf, LETTER_TITLE, sortChanges, type ScmGroup, type SubRepoState } from '../../../features/scm';
import type { ScmChange } from '../../../platform/ipc/scm';
import { openBranchSheet } from './branchSheet';

/** Rows drawn per group before the “show the rest” row (a refresh re-renders from the top). */
const PAGE_ROWS = 100;

/** The page-stack shells' marker (rowActions.ts's own check): the swipe gesture installs
 *  only where a finger drives the shell. */
function pageStackShell(): boolean {
	return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-page-stack');
}

/** The one-field sheet a sub-repo's commit message comes from. */
function askMessage(title: string): Promise<string | null> {
	return new Promise((resolve) => {
		const input = document.createElement('textarea');
		input.className = 'ggs-scm-message';
		input.rows = 2;
		const settle = (value: string | null) => {
			resolve(value);
			if (sheet.isConnected) closeActionSheet();
		};
		const commit = el('button', 'ggs-select-btn primary', [t('remote.scm.commit')]);
		commit.type = 'button';
		commit.addEventListener('click', () => settle(input.value.trim() || null));
		const cancel = el('button', 'ggs-select-btn', [t('transfer.cancel')]);
		cancel.type = 'button';
		cancel.addEventListener('click', () => settle(null));
		const body = el('div', 'ggs-name-body', [input, el('div', 'ggs-name-buttons', [cancel, commit])]);
		const sheet = openSheet({ title, body, onClose: () => resolve(null) });
		setTimeout(() => input.focus(), 80);
	});
}

/** Mount the phone Source Control page into the SCM sidebar view (idempotent). */
export function installScmPage(): void {
	const workbench = currentWorkbench;
	const view = workbench?.views.scm;
	if (!workbench || !view || view.querySelector('.ggs-scm-page')) return;
	const scm = workbench.scm;
	view.classList.add('ggs-scm-host');

	/** How many rows each group shows past the first page (a refresh keeps what grew). */
	const shownExtra = new Map<ScmGroup, number>();

	// Every state crossing of the one SourceControlView re-renders the page: onChanged after
	// an operation, onStatus / onHead after a refresh, chained onto whatever was there.
	const rerender = (): void => render();
	const previousChanged = scm.onChanged;
	scm.onChanged = () => {
		previousChanged?.();
		rerender();
	};
	const previousStatus = scm.onStatus;
	scm.onStatus = (next) => {
		previousStatus?.(next);
		rerender();
	};
	const previousHead = scm.onHead;
	scm.onHead = (head) => {
		previousHead?.(head);
		rerender();
	};

	// A device-class switch re-renders both renderings once: this page for the form it
	// lands on, the classic view for the wide forms (its commit box keeps the message
	// typed here — the state is shared, only its DOM was stale).
	onDeviceClassChange(() => {
		render();
		scm.render();
	});

	const page = el('div', 'ggs-scm-page');
	const scroll = el('div', 'ggs-scm-scroll');
	const shell = workbench;

	/* ---------- The branch row ---------- */

	const branchName = el('span', 'name');
	const branchMeta = el('span', 'meta');
	const branchRow = el('button', 'ggs-scm-branch', [icon('git-branch'), branchName, branchMeta, icon('chevron-right', 'chev')]);
	branchRow.type = 'button';
	branchRow.title = t('remote.branch.switch');
	branchRow.addEventListener('click', () => void openBranchSheet());

	function renderBranchRow(): void {
		const name = scm.isRepo ? scm.branch ?? '' : '';
		branchName.textContent = name || t('remote.scm.noBranch');
		branchMeta.replaceChildren();
		if (scm.upstream || scm.ahead > 0 || scm.behind > 0) {
			if (scm.behind > 0) branchMeta.append(icon('arrow-down'), `${scm.behind}`);
			if (scm.ahead > 0) branchMeta.append(icon('arrow-up'), `${scm.ahead}`);
		}
		branchRow.hidden = name === '';
	}

	/* ---------- The commit card ---------- */

	const message = document.createElement('textarea');
	message.className = 'ggs-scm-message';
	message.rows = 2;
	message.placeholder = t('remote.scm.messagePlaceholder');
	message.spellcheck = false;
	message.addEventListener('input', () => {
		scm.message = message.value;
		grow();
	});
	const grow = (): void => {
		message.style.height = 'auto';
		message.style.height = `${Math.min(160, message.scrollHeight + 2)}px`;
	};

	const commitButton = el('button', 'ggs-scm-commitbtn primary');
	commitButton.type = 'button';
	const commitMore = el('button', 'ggs-scm-commitmore', [icon('ellipsis')]);
	commitMore.type = 'button';
	commitMore.title = t('remote.scm.commitMore');
	commitMore.setAttribute('aria-label', t('remote.scm.commitMore'));
	commitMore.addEventListener('click', () => showActionSheet(commitMenu(), t('remote.scm.commitMore')));
	const commitCard = el('div', 'ggs-scm-commit', [message, el('div', 'ggs-scm-commitrow', [commitButton, commitMore])]);

	function commitMenu(): MenuEntry[] {
		return [
			{ label: t('remote.scm.commit'), run: () => void scm.commit() },
			{ label: t('remote.scm.commitPush'), run: () => void scm.commit({}, () => scm.afterCommit('scm_push', { remote: null, setUpstream: false, force: false })) },
			{ label: t('remote.scm.commitSync'), run: () => void scm.commit({}, () => scm.afterCommit('scm_sync', { rebase: false })) },
			{ label: t('remote.scm.commitStaged'), disabled: scm.changes.every((change) => change.staged === null), run: () => void scm.commit({ stagedOnly: true }) },
			{ label: t('remote.scm.commitAll'), run: () => void scm.commit({ all: true }) },
			'separator',
			{ label: t('remote.scm.amend'), run: () => void scm.commit({ amend: true }) },
			{ label: t('remote.scm.amendStaged'), run: () => void scm.commit({ amend: true, stagedOnly: true }) }
		];
	}

	/** The primary action's shape over the repository's own state — commitInput's own rule. */
	function renderCommitCard(): void {
		const action = scm.commitAction({ changes: scm.changes.length, branch: scm.branch, shortHash: scm.shortHash, ahead: scm.ahead, behind: scm.behind, upstream: scm.upstream });
		commitButton.replaceChildren();
		commitButton.disabled = false;
		if (action === 'commit') {
			commitButton.append(icon('check'), t('remote.scm.commit'));
			commitButton.onclick = () => void scm.commit();
		} else if (action === 'publish') {
			commitButton.append(icon('cloud-upload'), t('remote.scm.publish'));
			commitButton.onclick = () => void scm.run('scm_push', { remote: null, setUpstream: true, force: false });
		} else if (action === 'push') {
			commitButton.append(icon('cloud-upload'), tf('remote.scm.pushN', scm.ahead));
			commitButton.title = `${scm.upstream ?? ''}`;
			commitButton.onclick = () => void scm.run('scm_push', { remote: null, setUpstream: false, force: false });
		} else if (action === 'sync') {
			commitButton.append(icon('sync'), t('remote.scm.sync'));
			commitButton.onclick = () => void scm.run('scm_sync', { rebase: false });
		} else {
			commitButton.append(icon('check'), t('remote.scm.commit'));
			commitButton.disabled = true;
		}
		commitMore.hidden = action !== 'commit';
	}

	/* ---------- The change rows ---------- */

	function rowMenu(file: ScmChange, key: ScmGroup, sub?: SubRepoState): MenuEntry[] {
		const letter = letterOf(file, key);
		const absolute = sub ? scm.subAbsolute(sub, file.path) : scm.absolute(file.path);
		const open = (): void => scm.onOpenFile?.(absolute);
		const stage = (): void =>
			sub
				? void scm.subRun(sub, 'git_stage', { paths: [file.path] })
				: void scm.run('git_stage', { paths: scm.targetsFor(key, file, ['merge', 'changes']).map((change) => change.path) });
		const unstage = (): void =>
			sub
				? void scm.subRun(sub, 'git_unstage', { paths: [file.path] })
				: void scm.run('git_unstage', { paths: scm.targetsFor(key, file, ['staged']).map((change) => change.path) });
		const discard = (): void => (sub ? void scm.subDiscard(sub, file) : void scm.discardFiles(scm.targetsFor(key, file, ['changes'])));
		if (key === 'merge') {
			return [
				{ label: t('remote.scm.openMerge'), run: open },
				'separator',
				{ label: t('remote.scm.stageResolved'), run: stage }
			];
		}
		const entries: MenuEntry[] = [
			{ label: t('remote.scm.openChanges'), run: () => (sub ? scm.subOpenChange(sub, file, key, letter) : scm.openChange(file, key, letter)) },
			{ label: t('remote.scm.openFile'), run: open }
		];
		if (key === 'changes') {
			entries.push('separator', { label: t('remote.scm.stage'), run: stage }, { label: t('remote.scm.discard'), run: discard });
		} else {
			entries.push('separator', { label: t('remote.scm.unstage'), run: unstage });
		}
		return entries;
	}

	function changeRow(file: ScmChange, key: ScmGroup, sub?: SubRepoState): HTMLElement {
		const letter = letterOf(file, key);
		const cls = { M: 'git-modified', A: 'git-added', D: 'git-deleted', R: 'git-renamed', U: 'git-untracked', '!': 'git-conflict' }[letter] ?? '';
		const posix = toPosix(file.path);
		const name = basename(posix);
		const dir = posix.slice(0, Math.max(0, posix.length - name.length - 1));
		const glyph = icon(fileIcon(name));
		glyph.style.color = fileIconColor(name) ?? '';
		const more = el('button', 'ggs-scm-rowmore', [icon('ellipsis')]);
		more.type = 'button';
		more.title = t('remote.scm.rowMenu');
		more.setAttribute('aria-label', t('remote.scm.rowMenu'));
		more.addEventListener('click', (event) => {
			event.stopPropagation();
			showActionSheet(rowMenu(file, key, sub), name);
		});
		const row = el('div', `ggs-scm-row ${cls}`, [
			el('span', 'gicon', [glyph]),
			el('span', 'text', [el('span', 'name', [name]), dir ? el('span', 'dir', [dir]) : null]),
			el('span', letter === '!' ? 'letter conflict' : 'letter', [letter]),
			more
		]);
		row.title = `${posix} • ${LETTER_TITLE[letter] ?? letter}`;
		row.addEventListener('click', () => {
			if (sub) scm.subOpenChange(sub, file, key, letter);
			else scm.openChange(file, key, letter);
		});
		// The swipe gesture (§6.3): the row's own verb under a left swipe — the same
		// handlers the ⋮ sheet runs.
		if (pageStackShell()) {
			const swipe: RevealAction[] = [];
			if (key === 'changes') {
				swipe.push(
					{ icon: 'discard', label: t('remote.scm.discard'), danger: true, run: () => (sub ? void scm.subDiscard(sub, file) : void scm.discardFiles([file])) },
					{ icon: 'add', label: t('remote.scm.stage'), run: () => (sub ? void scm.subRun(sub, 'git_stage', { paths: [file.path] }) : void scm.run('git_stage', { paths: [file.path] })) }
				);
			} else if (key === 'merge') {
				swipe.push({ icon: 'add', label: t('remote.scm.stageResolved'), run: () => (sub ? void scm.subRun(sub, 'git_stage', { paths: [file.path] }) : void scm.run('git_stage', { paths: [file.path] })) });
			} else {
				swipe.push({ icon: 'remove', label: t('remote.scm.unstage'), run: () => (sub ? void scm.subRun(sub, 'git_unstage', { paths: [file.path] }) : void scm.run('git_unstage', { paths: [file.path] })) });
			}
			swipeReveal(row, swipe);
		}
		return row;
	}

	/* ---------- The groups ---------- */

	const GROUP_LABEL: Record<ScmGroup, () => string> = {
		merge: () => t('remote.scm.group.merge'),
		staged: () => t('remote.scm.group.staged'),
		changes: () => t('remote.scm.group.changes')
	};

	function groupActions(key: ScmGroup, files: ScmChange[], sub?: SubRepoState): HTMLElement[] {
		const button = (iconName: string, label: string, run: () => void): HTMLButtonElement => {
			const node = el('button', 'ggs-scm-groupbtn', [icon(iconName)]);
			node.type = 'button';
			node.title = label;
			node.setAttribute('aria-label', label);
			node.addEventListener('click', (event) => {
				event.stopPropagation();
				run();
			});
			return node;
		};
		if (key === 'merge') {
			return [button('add', t('remote.scm.stageResolved'), () => sub
				? void scm.subRun(sub, 'git_stage', { paths: files.map((change) => change.path) })
				: void scm.run('git_stage', { paths: files.map((change) => change.path) }))];
		}
		if (key === 'staged') {
			return [button('remove', t('remote.scm.unstageAll'), () => sub ? void scm.subRun(sub, 'git_unstage_all') : void scm.run('git_unstage_all'))];
		}
		return [
			button('discard', t('remote.scm.discardAll'), () => sub ? void scm.subDiscardAll(sub) : void scm.discardAll()),
			button('add', t('remote.scm.stageAll'), () => sub ? void scm.subRun(sub, 'git_stage_all') : void scm.run('git_stage_all'))
		];
	}

	function groupSection(key: ScmGroup, files: ScmChange[], always: boolean, sub?: SubRepoState): HTMLElement | null {
		if (files.length === 0 && !always) return null;
		const collapsed = sub ? sub.collapsed[key] : scm.collapsed[key];
		const head = el('button', 'ggs-scm-grouphead', [
			icon(collapsed ? 'chevron-right' : 'chevron-down', 'twistie'),
			el('span', 'label', [GROUP_LABEL[key]()]),
			el('span', 'badge', [String(files.length)]),
			...groupActions(key, files, sub)
		]);
		head.type = 'button';
		head.addEventListener('click', () => {
			if (sub) sub.collapsed[key] = !sub.collapsed[key];
			else scm.collapsed[key] = !scm.collapsed[key];
			render();
		});
		const section = el('div', 'ggs-scm-group', [head]);
		if (collapsed) return section;
		if (files.length === 0) {
			section.appendChild(el('div', 'ggs-scm-empty', [t('remote.scm.noChanges')]));
			return section;
		}
		const sorted = sortChanges(files, scm.sort, key);
		const limit = PAGE_ROWS + (shownExtra.get(key) ?? 0);
		for (const file of sorted.slice(0, limit)) section.appendChild(changeRow(file, key, sub));
		if (sorted.length > limit) {
			const more = el('button', 'ggs-scm-showmore', [tf('remote.scm.showMore', sorted.length - limit)]);
			more.type = 'button';
			more.addEventListener('click', () => {
				shownExtra.set(key, (shownExtra.get(key) ?? 0) + PAGE_ROWS);
				render();
			});
			section.appendChild(more);
		}
		return section;
	}

	function groupsOf(changes: ScmChange[]): { key: ScmGroup; files: ScmChange[] }[] {
		return [
			{ key: 'merge', files: changes.filter((change) => change.conflicted) },
			{ key: 'staged', files: changes.filter((change) => !change.conflicted && change.staged !== null) },
			{ key: 'changes', files: changes.filter((change) => !change.conflicted && (change.unstaged !== null || change.untracked)) }
		];
	}

	/* ---------- The sub-repo sections ---------- */

	function subSection(sub: SubRepoState): HTMLElement {
		const more = el('button', 'ggs-scm-rowmore', [icon('ellipsis')]);
		more.type = 'button';
		more.title = t('remote.scm.rowMenu');
		more.addEventListener('click', (event) => {
			event.stopPropagation();
			showActionSheet(subMenu(sub), basename(sub.repoPath));
		});
		const head = el('button', 'ggs-scm-grouphead sub', [
			icon(sub.sectionCollapsed ? 'chevron-right' : 'chevron-down', 'twistie'),
			el('span', 'gicon', [icon('repo')]),
			el('span', 'label', [basename(sub.repoPath)]),
			sub.branch ? el('span', 'branch', [sub.branch]) : null,
			el('span', 'badge', [String(sub.changes.length)]),
			more
		]);
		head.type = 'button';
		head.title = sub.repoPath;
		head.addEventListener('click', () => {
			sub.sectionCollapsed = !sub.sectionCollapsed;
			render();
		});
		const section = el('div', 'ggs-scm-group', [head]);
		if (sub.sectionCollapsed) return section;
		if (sub.error) section.appendChild(el('div', 'ggs-scm-error', [sub.error]));
		if (sub.changes.length === 0) {
			section.appendChild(el('div', 'ggs-scm-empty', [t('remote.scm.noChanges')]));
			return section;
		}
		for (const group of groupsOf(sub.changes)) {
			const inner = groupSection(group.key, group.files, false, sub);
			if (inner) section.appendChild(inner);
		}
		return section;
	}

	function subMenu(sub: SubRepoState): MenuEntry[] {
		return [
			{
				label: t('remote.scm.commit'),
				run: () => void (async () => {
					const text = await askMessage(tf('remote.scm.commitIn', basename(sub.repoPath)));
					if (text === null) return;
					sub.message = text;
					await scm.subCommit(sub, { all: true });
				})()
			},
			{ label: t('remote.scm.pull'), run: () => void scm.subRun(sub, 'scm_pull', { remote: null, branch: null, rebase: false }) },
			{ label: t('remote.scm.push'), run: () => void scm.subRun(sub, 'scm_push', { remote: null, setUpstream: false, force: false }) },
			'separator',
			{ label: t('remote.scm.discardAll'), run: () => void scm.subDiscardAll(sub) }
		];
	}

	/* ---------- The page ---------- */

	function render(): void {
		renderBranchRow();
		renderCommitCard();
		// A re-render under the user's hands keeps the message box's focus and caret.
		const hadFocus = document.activeElement === message;
		const caret = { start: message.selectionStart, end: message.selectionEnd };
		if (message.value !== scm.message) message.value = scm.message;
		grow();
		if (hadFocus) {
			message.focus();
			message.setSelectionRange(caret.start, caret.end);
		}

		scroll.replaceChildren();
		if (!scm.repoPath) {
			scroll.appendChild(el('div', 'ggs-scm-empty page', [t('remote.scm.needFolder')]));
			return;
		}
		if (!scm.isRepo) {
			const init = el('button', 'ggs-scm-init', [t('remote.scm.initRepo')]);
			init.type = 'button';
			init.addEventListener('click', () => void shell.initializeRepository());
			scroll.append(el('div', 'ggs-scm-empty page', [tf('remote.scm.notRepo', basename(scm.repoPath ?? ''))]), init);
			return;
		}
		if (scm.error) scroll.appendChild(el('div', 'ggs-scm-error', [scm.error]));
		for (const group of groupsOf(scm.changes)) {
			const section = groupSection(group.key, group.files, group.key === 'changes');
			if (section) scroll.appendChild(section);
		}
		for (const sub of scm.subRepos) scroll.appendChild(subSection(sub));
		if (scm.changes.length === 0 && scm.subRepos.length === 0) {
			scroll.appendChild(el('div', 'ggs-scm-empty page', [t('remote.scm.noChanges')]));
		}
	}

	page.append(branchRow, commitCard, scroll);
	view.appendChild(page);
	render();
}
