// The branch sheet (docs/remote-client-plan.md §6, the owner's 2026-10-16 direction: 手机端
// 文件管理页面没有切换分支的按钮): one touch surface for the repository's branches, shared
// by the Files page's toolbar chip and the phone Source Control page's branch row. The
// current branch leads (checked), the locals follow, the remote branches close (the
// backend's own checkout turns `origin/x` into a tracking `x`), and 新建分支… asks for one
// name — `scm_create_branch` is a checkout -b, so the new branch is the one left on. Every
// switch ends in the SCM view's own refresh, whose onHead/onStatus chain updates the status
// bar, the phone pages' letters and the app bar behind this sheet.
import { el, notify, type MenuEntry } from '../../../platform/ui';
import { t, tf } from '../../../platform/i18n';
import { scmBranches, scmCheckout, scmCreateBranch } from '../../../platform/ipc/scm';
import { validateSubRef } from '../../../features/scm/view';
import { currentWorkbench } from '../../../workbench';
import { closeActionSheet, openSheet, showActionSheet } from '../../actionSheet';

/** Switch the repository to `name` and refresh what every surface reads. */
export async function checkoutBranch(name: string): Promise<void> {
	const workbench = currentWorkbench;
	try {
		await scmCheckout(name);
		notify('info', tf('remote.branch.switched', name));
	} catch (error) {
		notify('error', String(error));
	}
	if (workbench) await workbench.scm.refresh();
}

/** The one-field sheet a new branch's name comes from (the Files page's own askName shape). */
function askBranchName(): Promise<string | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'ggs-name-input';
		input.placeholder = t('remote.branch.namePlaceholder');
		const warn = el('div', 'ggs-name-warn');
		const settle = (value: string | null) => {
			resolve(value);
			if (sheet.isConnected) closeActionSheet();
		};
		const create = el('button', 'ggs-select-btn primary', [t('remote.branch.create')]);
		create.type = 'button';
		create.addEventListener('click', () => {
			const problem = validateSubRef(input.value);
			if (problem) {
				warn.textContent = problem;
				return;
			}
			settle(input.value.trim());
		});
		const cancel = el('button', 'ggs-select-btn', [t('transfer.cancel')]);
		cancel.type = 'button';
		cancel.addEventListener('click', () => settle(null));
		const body = el('div', 'ggs-name-body', [input, warn, el('div', 'ggs-name-buttons', [cancel, create])]);
		const sheet = openSheet({ title: t('remote.branch.new'), body, onClose: () => resolve(null) });
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') create.click();
			if (event.key === 'Escape') settle(null);
		});
		setTimeout(() => input.focus(), 80);
	});
}

async function createBranch(): Promise<void> {
	const name = await askBranchName();
	if (!name) return;
	const workbench = currentWorkbench;
	try {
		await scmCreateBranch(name, null);
		notify('info', tf('remote.branch.switched', name));
	} catch (error) {
		notify('error', String(error));
	}
	if (workbench) await workbench.scm.refresh();
}

/** Open the branch sheet: the current branch checked, the locals, the remotes, and the
 *  new-branch row. A repository-less page answers with the same info the commands give. */
export async function openBranchSheet(): Promise<void> {
	const workbench = currentWorkbench;
	if (!workbench?.repoPath || !workbench.scm.isRepo) {
		notify('info', t('remote.branch.noRepo'));
		return;
	}
	let branches: Awaited<ReturnType<typeof scmBranches>>;
	try {
		branches = await scmBranches();
	} catch (error) {
		notify('error', String(error));
		return;
	}
	const current = branches.find((branch) => branch.current) ?? null;
	const locals = branches.filter((branch) => !branch.current && !branch.remote);
	const remotes = branches.filter((branch) => branch.remote);
	if (!current && locals.length === 0 && remotes.length === 0) {
		notify('info', t('remote.branch.none'));
		return;
	}
	const entries: MenuEntry[] = [];
	const branchRow = (name: string, checked: boolean): MenuEntry => ({
		label: name,
		checked,
		run: () => {
			if (!checked) void checkoutBranch(name);
		}
	});
	if (current) entries.push(branchRow(current.name, true));
	if (locals.length > 0) {
		if (current) entries.push('separator');
		for (const branch of locals) entries.push(branchRow(branch.name, false));
	}
	if (remotes.length > 0) {
		entries.push('separator');
		for (const branch of remotes) entries.push(branchRow(branch.name, false));
	}
	entries.push('separator');
	entries.push({ label: t('remote.branch.new'), run: () => void createBranch() });
	showActionSheet(entries, t('remote.branch.switch'));
}
