// The change groups: row building, the Merge / Staged / Changes headers with their group actions, and the sub-repo sections.


import type { ScmChange } from '../../platform/ipc/scm';
import { t, trText } from '../../platform/i18n';
import { actionButton, basename, el, icon, showMenuBelow } from '../../platform/ui/index';
import { ScmRow, SubRepoState, buildChangeTree, sortChanges } from './view';
import type { ScmGroup, SourceControlView, TreeNode } from './view';

/** The groups concern of SourceControlView — assigned onto the prototype by the module facade. */
export const groupsMethods: ThisType<SourceControlView> = {
	groupActions(key: ScmGroup, files: ScmChange[]): HTMLElement[] {
		switch (key) {
			case 'merge': return [actionButton('add', 'Stage All Merge Changes', () => void this.run('git_stage', { paths: files.map((c) => c.path) }))];
			case 'staged': return [actionButton('remove', 'Unstage All Changes', () => void this.run('git_unstage_all'))];
			default: return [
				actionButton('discard', 'Discard All Changes', () => void this.discardAll()),
				actionButton('add', 'Stage All Changes', () => void this.run('git_stage_all'))
			];
		}
	},

	buildRows(): ScmRow[] {
		const rows: ScmRow[] = [];
		const merge = this.changes.filter((c) => c.conflicted);
		const staged = this.changes.filter((c) => !c.conflicted && c.staged !== null);
		const unstaged = this.changes.filter((c) => !c.conflicted && (c.unstaged !== null || c.untracked));
		const groups: { label: string; key: ScmGroup; files: ScmChange[]; always: boolean }[] = [
			{ label: 'Merge Changes', key: 'merge', files: merge, always: false },
			{ label: 'Staged Changes', key: 'staged', files: staged, always: false },
			{ label: 'Changes', key: 'changes', files: unstaged, always: true }
		];
		for (const group of groups) {
			if (group.files.length === 0 && !group.always) continue;
			rows.push({ kind: 'group', key: group.key, label: group.label, count: group.files.length });
			if (this.collapsed[group.key]) continue;
			if (group.files.length === 0) {
				rows.push({ kind: 'empty', key: group.key });
				continue;
			}
			const sorted = sortChanges(group.files, this.sort, group.key);
			if (this.viewMode === 'tree') {
				const walk = (nodes: TreeNode[], depth: number) => {
					for (const node of nodes) {
						if (node.file) {
							rows.push({ kind: 'file', key: group.key, file: node.file, depth, inTree: true });
							continue;
						}
						const folderKey = `${group.key}:${node.path}`;
						const collapsed = this.collapsedFolders.has(folderKey);
						rows.push({ kind: 'folder', key: group.key, node, folderKey, collapsed, depth });
						if (!collapsed) walk(node.children, depth + 1);
					}
				};
				walk(buildChangeTree(sorted), 0);
			} else {
				for (const file of sorted) rows.push({ kind: 'file', key: group.key, file, depth: 0, inTree: false });
			}
		}
		return rows;
	},

	subGroups(sub: SubRepoState): { key: ScmGroup; label: string; files: ScmChange[]; always: boolean }[] {
		const merge = sub.changes.filter((c) => c.conflicted);
		const staged = sub.changes.filter((c) => !c.conflicted && c.staged !== null);
		const unstaged = sub.changes.filter((c) => !c.conflicted && (c.unstaged !== null || c.untracked));
		return [
			{ key: 'merge', label: 'Merge Changes', files: merge, always: false },
			{ key: 'staged', label: 'Staged Changes', files: staged, always: false },
			{ key: 'changes', label: 'Changes', files: unstaged, always: true }
		];
	},

	renderSubRepo(sub: SubRepoState): HTMLElement {
		const header = el('div', 'pane-header scm-repo-header', [
			icon(sub.sectionCollapsed ? 'chevron-right' : 'chevron-down', 'twistie'),
			el('span', 'icon', [icon('repo')]),
			el('span', 'label', [basename(sub.repoPath)])
		]);
		header.title = sub.repoPath;
		if (sub.branch) {
			const branchLabel = el('span', 'scm-repo-branch', [icon('git-branch'), ` ${sub.branch}`]);
			if (sub.upstream) {
				if (sub.behind > 0) branchLabel.append(` ${sub.behind}`, icon('arrow-down'));
				if (sub.ahead > 0) branchLabel.append(` ${sub.ahead}`, icon('arrow-up'));
			}
			header.appendChild(branchLabel);
		}
		// Same placement rule as the main repository's own title bar (render()).
		const headerActions: HTMLElement[] = this.extensionTitleButtons(sub.repoPath);
		headerActions.push(
			actionButton('refresh', 'Refresh', () => void this.refresh()),
			actionButton('ellipsis', 'More Actions...', (event) => showMenuBelow(event.currentTarget as HTMLElement, this.subMoreMenu(sub), 220))
		);
		header.appendChild(el('div', 'actions', headerActions));
		if (sub.changes.length > 0) header.appendChild(el('span', 'badge', [String(sub.changes.length)]));
		header.addEventListener('click', () => {
			sub.sectionCollapsed = !sub.sectionCollapsed;
			this.render();
		});
		const section = el('div', 'scm-repo', [header]);
		if (sub.sectionCollapsed) return section;

		const body = el('div', 'scm-repo-body');
		body.appendChild(this.subCommitBox(sub));
		if (sub.error) body.appendChild(el('div', 'scm-input', [el('div', 'error', [sub.error])]));
		for (const group of this.subGroups(sub)) {
			if (group.files.length === 0 && !group.always) continue;
			body.appendChild(this.subGroupSection(sub, group));
		}
		section.appendChild(body);
		return section;
	},

	subGroupSection(sub: SubRepoState, group: { key: ScmGroup; label: string; files: ScmChange[] }): HTMLElement {
		const files = sortChanges(group.files, this.sort, group.key);
		const groupActions = group.key === 'merge'
			? [actionButton('add', 'Stage All Merge Changes', () => void this.subRun(sub, 'git_stage', { paths: files.map((c) => c.path) }))]
			: group.key === 'staged'
			? [actionButton('remove', 'Unstage All Changes', () => void this.subRun(sub, 'git_unstage_all'))]
			: [
				actionButton('discard', 'Discard All Changes', () => void this.subDiscardAll(sub)),
				actionButton('add', 'Stage All Changes', () => void this.subRun(sub, 'git_stage_all'))
			];
		const header = el('div', 'pane-header', [
			icon(sub.collapsed[group.key] ? 'chevron-right' : 'chevron-down', 'twistie'),
			el('span', 'label', [trText(group.label)]),
			el('div', 'actions', groupActions),
			el('span', 'badge', [String(files.length)])
		]);
		header.addEventListener('click', () => {
			sub.collapsed[group.key] = !sub.collapsed[group.key];
			this.render();
		});
		const rows = sub.collapsed[group.key]
			? []
			: files.length === 0
			? [el('div', 'scm-empty', [t('scm.noChanges')])]
			: files.map((file) => this.subFileRow(sub, file, group.key));
		return el('div', 'scm-group', [header, ...rows]);
	},
};
