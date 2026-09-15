// The localization sweep: with the display language switched to Chinese, every menu - the
// title bar's dropdowns and their submenus, the SCM view's "..." menu, and every label any of
// them builds - must render translated. Menu labels arrive as the registry's English text and
// localize in ui.ts's renderMenu (the one renderer every menu shares), so coverage is checked
// twice: every label source resolves through the translation table, and a menu actually drawn
// on screen shows Chinese. A label registered without a translation fails here, not in review.

import { beforeEach, describe, expect, it } from 'vitest';

import { Workbench } from '../src/workbench';
import { commands } from '../src/commands';
import { trText } from '../src/i18n';
import { settings, updateSetting } from '../src/settings';
import * as state from '../src/state';
import type { MenuEntry } from '../src/ui';
import { backend } from './tauriMock';
import { flush, hover, menuLabels, texts } from './helpers';

const REPO = 'C:\\repo';

/** Labels that stay Roman in Chinese by design: product names and VS Code's own "Git" category
 *  (the extension's "Git Graph RS" category is a manifest literal, untranslated in VS Code too). */
const BRANDS = new Set(['Git Graph', 'Git', 'Git Graph RS']);

function hasCJK(text: string): boolean {
	return /[\u4e00-\u9fff]/.test(text);
}

/** Every label (submenu labels included) an entries list would draw, translated as ui.ts does. */
function collectLabels(entries: MenuEntry[], out: string[] = []): string[] {
	for (const entry of entries) {
		if (entry === 'separator') continue;
		out.push(entry.label);
		if (entry.submenu) collectLabels(entry.submenu, out);
	}
	return out;
}

let workbench: Workbench;

beforeEach(async () => {
	localStorage.clear();
	document.body.innerHTML = `
		<div id="titlebar"></div>
		<div id="workbench">
			<div id="activitybar"></div>
			<div id="sidebar"></div>
			<div id="sidebarSash"></div>
			<div id="editorPart"><div id="editorGroup"></div><div id="panelSash" hidden></div><div id="panel" hidden></div></div>
		</div>
		<div id="statusbar"></div>
		<div id="notifications"></div>
		<div id="overlays"></div>`;
	workbench?.dispose();
	backend.reset();
	backend.on('initial_repo', () => REPO);
	backend.on('open_folder', ({ path }) => ({ root: path, isRepo: true }));
	backend.on('boot_stage', () => null);
	backend.on('list_dir', () => []);
	backend.on('list_files', () => []);
	backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: null }));
	backend.on('scm_status', () => []);
	backend.on('scm_branches', () => [{ name: 'main', remote: false, current: true, upstream: null }]);
	backend.on('scm_remotes', () => []);
	backend.on('scm_tags', () => []);
	backend.on('scm_stashes', () => []);
	backend.on('ext_list', () => []);
	backend.on('keybindings_read', () => null);
	backend.on('settings_read', () => null);
	backend.on('backup_list', () => []);
	backend.on('git_output_log', () => []);
	backend.on('graph_request', ({ message }) => ({ command: (message as { command: string }).command, error: null, errors: [null], commits: [] }));
	(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
	workbench = new Workbench();
	await workbench.boot();
	await flush(10);
	// No recent folders: their submenu would list folder basenames, which have no translations.
	state.save('recentFolders', []);
	updateSetting('locale', 'zh-cn');
	await flush(2);
});

describe('menu localization', () => {
	it('translates every registered command title and category', () => {
		const untranslated: string[] = [];
		for (const command of commands.all()) {
			for (const text of [command.title, command.category]) {
				if (text === undefined) continue;
				// A declared Chinese twin (the manifest's *.zhCn commands) or a brand name passes.
				if (!hasCJK(trText(text)) && !BRANDS.has(text)) untranslated.push(text);
			}
		}
		expect(untranslated).toEqual([]);
	});

	it('draws the title bar menus, submenus included, in Chinese', () => {
		const english: string[] = [];
		for (const menu of workbench.menus()) {
			for (const label of collectLabels(menu.entries())) {
				if (!hasCJK(trText(label)) && !BRANDS.has(label)) english.push(`${menu.label}: ${label}`);
			}
		}
		expect(english).toEqual([]);

		// And on screen: the File menu opens with every item Chinese.
		const file = document.querySelector<HTMLElement>('.menubar-item');
		file!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		expect(texts('.menubar-item')[0]).toBe('文件');
		expect(menuLabels().length).toBeGreaterThan(0);
		for (const label of menuLabels()) {
			if (!BRANDS.has(label)) expect(hasCJK(label)).toBe(true);
		}
		// The "Open Recent" submenu localizes too when hovered open.
		hover(document.querySelector('.context-menu .item')!);
		expect(menuLabels().every((label) => hasCJK(label) || BRANDS.has(label))).toBe(true);
	});

	it('draws the SCM view\'s "..." menu in Chinese', () => {
		const english = collectLabels(workbench.scm.moreMenu()).filter((label) => !hasCJK(trText(label)) && !BRANDS.has(label));
		expect(english).toEqual([]);
	});
});

describe('menu localization falls back safely', () => {
	it('keeps English labels when the locale is English', () => {
		updateSetting('locale', 'en');
		const file = document.querySelector<HTMLElement>('.menubar-item');
		file!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		expect(texts('.menubar-item')[0]).toBe('File');
		expect(menuLabels()).toContain('New File...');
		expect(settings.locale).toBe('en');
	});
});
