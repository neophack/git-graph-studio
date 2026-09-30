import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EditorArea } from '../src/editorArea';
import { tabDrag } from '../src/editor';
import { applyContributions, removeContributions } from '../src/contributions';
import { SETTINGS_EVENT } from '../src/settings';
import { backend } from './tauriMock';
import { click, flush, notificationButton, notifications, texts } from './helpers';

function files(contents: Record<string, string | null>): void {
	backend.on('read_file', ({ path }) => {
		const text = contents[String(path)];
		if (text === undefined) throw new Error(`${path}: not found`);
		return { contents: text, binary: text === null, size: text?.length ?? 0 };
	});
}

function drag(from: Element, to: Element): void {
	from.dispatchEvent(new Event('dragstart', { bubbles: true }));
	to.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
	to.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
	from.dispatchEvent(new Event('dragend', { bubbles: true }));
}

/** Every group's tab labels, one array per group, in visual order (the grid renders groups
 *  depth-first, which is left-to-right, top-to-bottom). */
function groupTabs(): string[][] {
	return Array.from(document.querySelectorAll('.editor-group-box')).map((box) => texts('.tab .label', box));
}

describe('editor area (M3 3.1)', () => {
	beforeEach(() => {
		// Only the editor part is rebuilt: the notifications container the close prompts use
		// (and anything else the shell set up) stays.
		const part = document.getElementById('editorGroup')!;
		part.innerHTML = '';
	});

	it('splits right and down, and focuses groups by index', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n', 'C:\\repo\\c.ts': 'c\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		expect(area.groupCount).toBe(1);

		const second = area.split('right');
		await second.openFile('C:\\repo\\b.ts');
		const third = area.split('down');
		await third.openFile('C:\\repo\\c.ts');
		expect(area.groupCount).toBe(3);
		expect(groupTabs()).toEqual([['a.ts'], ['b.ts'], ['c.ts']]);

		// Ctrl+1/2/3 route through focusIndex; the focused group's editor answers the facade.
		area.focusIndex(0);
		expect(area.activeInput?.kind === 'file' && area.activeInput.path.endsWith('a.ts')).toBe(true);
		area.focusIndex(1);
		expect(area.activeInput?.kind === 'file' && area.activeInput.path.endsWith('b.ts')).toBe(true);
		expect(area.focusedIndex).toBe(1);
	});

	it('moves a tab between groups by drag and drop', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');
		expect(groupTabs()).toEqual([['a.ts'], ['b.ts']]);

		// Drag group 2's tab onto group 1. The empty source group collapses once the target
		// takes the focus, as VS Code's empty groups do.
		const boxes = document.querySelectorAll('.editor-group-box');
		const tab = boxes[1]!.querySelector('.tab')!;
		drag(tab, boxes[0]!);
		expect(tabDrag.editor).toBeNull();
		expect(groupTabs()).toEqual([['a.ts', 'b.ts']]);
		expect(area.groupCount).toBe(1);

		// The moved editor is the source group's no more; the target owns it.
		expect(area.groupAt(0).openFilePaths()).toEqual(['C:\\repo\\a.ts', 'C:\\repo\\b.ts']);
	});

	it('collapses a group as soon as its last tab closes, even while it holds the focus', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');

		// Closing the second group's only tab empties it: the layer disappears at once and
		// the focus falls back to the remaining group.
		const boxes = document.querySelectorAll('.editor-group-box');
		click(boxes[1]!.querySelector('.tab .close'));
		await flush();
		expect(area.groupCount).toBe(1);
		expect(area.focusedIndex).toBe(0);
		expect(groupTabs()).toEqual([['a.ts']]);
	});

	it('opens a file in every direction, reusing the neighbouring layer or creating it at the edge', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n', 'C:\\repo\\c.ts': 'c\n', 'C:\\repo\\d.ts': 'd\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');

		// Right creates a second layer beside the first and opens the file there.
		area.openInDirection('C:\\repo\\b.ts', 'right');
		await flush();
		expect(area.groupCount).toBe(2);
		expect(groupTabs()).toEqual([['a.ts'], ['b.ts']]);

		// Left of the focused group is the existing first layer.
		area.openInDirection('C:\\repo\\c.ts', 'left');
		await flush();
		expect(area.groupCount).toBe(2);
		expect(area.groupAt(0).openFilePaths()).toEqual(['C:\\repo\\a.ts', 'C:\\repo\\c.ts']);

		// Below creates a stacked layer under the focused one; above the focused group reuses it.
		area.openInDirection('C:\\repo\\d.ts', 'down');
		await flush();
		expect(area.groupCount).toBe(3);
		expect(groupTabs()).toEqual([['a.ts', 'c.ts'], ['d.ts'], ['b.ts']]);
		area.openInDirection('C:\\repo\\a.ts', 'up');
		await flush();
		expect(area.groupCount).toBe(3);
	});

	it('opens a placed editor beside the focused group and keeps landing in that side layer', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');

		// 'beside' splits a right layer when there is none — the claude-code shape: the
		// chat panel keeps its half of the area, the clicked output takes the other. The
		// opened tab takes the focus (a group's activation focuses it, as a tab click does).
		await area.openContent({ kind: 'content', id: 'ext-content:Claude Code (ab12cd)', title: 'Claude Code (ab12cd)', path: '/temp/readonly/Claude Code (ab12cd)', text: 'the tool output\n' }, 'beside');
		expect(area.groupCount).toBe(2);
		expect(groupTabs()).toEqual([['a.ts'], ['Claude Code (ab12cd)']]);
		expect(area.focusedIndex).toBe(1);

		// A later placed open lands in the same side layer — never a third split, even
		// though the focus now sits inside it (clicking inside a webview never refocuses
		// its editor group, so the focused group alone cannot name "the other view").
		await area.openFile('C:\\repo\\b.ts', undefined, 'beside');
		expect(area.groupCount).toBe(2);
		expect(groupTabs()).toEqual([['a.ts'], ['Claude Code (ab12cd)', 'b.ts']]);

		// A ViewColumn number is a group index: One answers — and focuses — the first.
		await area.openFile('C:\\repo\\a.ts', { line: 1 }, 1);
		expect(area.focusedIndex).toBe(0);
	});

	it('reports the focused group as the area, spanning groups for closeAll and dirty state', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');
		area.focusIndex(1);
		(right.activeView ?? area.activeView)!.dispatch({ changes: { from: 0, insert: 'x' } });
		expect(area.hasDirtyEditors()).toBe(true);
		expect(area.openFilePaths()).toEqual(['C:\\repo\\a.ts', 'C:\\repo\\b.ts']);

		// Closing all asks about the dirty editor; "Don't Save" lets it close.
		const closing = area.closeAll();
		await flush();
		click(notificationButton("Don't Save"));
		expect(await closing).toBe(true);
		expect(area.openFilePaths()).toEqual([]);
	});

	it('asks once for several dirty files across groups, and Save All writes them all', async () => {
		const contents: Record<string, string> = { 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' };
		files(contents);
		backend.on('write_file', ({ path, contents: text }) => { contents[String(path)] = String(text); return null; });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		area.activeView!.dispatch({ changes: { from: 0, insert: 'x' } });
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');
		right.activeView!.dispatch({ changes: { from: 0, insert: 'y' } });

		const closing = area.closeAll();
		await flush();
		// One VS Code-style prompt naming both files, not two prompts in a row.
		expect(notifications()).toHaveLength(1);
		expect(notifications()[0]).toContain('the following 2 files? a.ts, b.ts');
		click(notificationButton('Save All'));
		expect(await closing).toBe(true);
		expect(backend.callsTo('write_file').map((c) => c['contents'])).toEqual(['xa\n', 'yb\n']);
		expect(area.openFilePaths()).toEqual([]);
	});

	it('opens files in parallel as inactive tabs and activates a chosen one afterwards', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n', 'C:\\repo\\c.ts': 'c\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		const group = area.groupAt(0);
		await group.openFile('C:\\repo\\a.ts');
		await Promise.all([
			group.openFile('C:\\repo\\b.ts', { inactive: true }),
			group.openFile('C:\\repo\\c.ts', { inactive: true })
		]);
		// The shown editor is untouched by the inactive opens; the tabs are all there.
		expect(group.activeInput?.kind === 'file' && group.activeInput.path.endsWith('a.ts')).toBe(true);
		expect(group.openFilePaths().length).toBe(3);
		group.activateLast();
		expect(group.activeInput?.kind === 'file' && !group.activeInput.path.endsWith('a.ts')).toBe(true);
	});

	it('carries an extension page tab into a group split after it opened', async () => {
		files({ 'C:\\repo\\a.ts': 'a\\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		const pane = document.createElement('div');
		area.split('right');
		await area.openExtPage({ kind: 'extpage', id: 'extpage:x:1', title: 'Page', extId: 'x', pageId: '1' }, (container) => { container.appendChild(pane); });
		expect(area.activeInput?.kind).toBe('extpage');
		expect(pane.parentElement).not.toBeNull();
	});

	it('an extension page\'s frame is never detached by a layout change (the chat keeps its page)', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		// The mounted frame stands for the extension chat's page: whatever holds it must keep
		// its DOM home across every layout change, because WKWebView discards a detached
		// iframe's browsing context and reloads the page — the conversation interrupted on
		// every split/merge this fix removes.
		const frame = document.createElement('iframe');
		await area.openExtPage({ kind: 'extpage', id: 'extpage:x:1', title: 'Claude', extId: 'x', pageId: 'webview' }, (host) => { host.appendChild(frame); });
		const home = frame.parentElement!;
		// The frame lives in the overlay layer, outside the group tree the area rebuilds.
		expect(home.classList.contains('ext-overlay-host')).toBe(true);
		expect(frame.closest('.editor-groups-root')).toBeNull();
		expect(frame.isConnected).toBe(true);

		// A detached subtree would surface as a childList removal record carrying the frame,
		// even though the re-render re-attaches it before anything can observe the gap.
		const removed: Node[] = [];
		const observer = new MutationObserver((records) => {
			for (const record of records) removed.push(...record.removedNodes);
		});
		observer.observe(document.getElementById('editorGroup')!, { childList: true, subtree: true });

		// Single -> split: the whole group tree is rebuilt.
		await area.split('right').openFile('C:\\repo\\b.ts');
		expect(area.groupCount).toBe(2);
		// Split -> single: the layer collapses when its last tab closes.
		await area.close();
		expect(area.groupCount).toBe(1);
		expect(frame.parentElement).toBe(home);
		expect(frame.isConnected).toBe(true);

		// A tab dragged into another group re-parents its placeholder pane, never the frame.
		await area.split('right').openFile('C:\\repo\\b.ts');
		const boxes = document.querySelectorAll('.editor-group-box');
		const chatTab = [...boxes[0]!.querySelectorAll('.tab')].find((tab) => tab.textContent?.includes('Claude'))!;
		drag(chatTab, boxes[1]!);
		expect(boxes[1]!.querySelector('.editor-pane.ext-page')).not.toBeNull();
		expect(frame.parentElement).toBe(home);
		observer.disconnect();
		expect(removed.some((node) => node.contains(frame))).toBe(false);

		// Closing the tab tears the overlay down with it.
		await area.closeById('extpage:x:1');
		expect(document.querySelector('.ext-overlay-layer')!.childElementCount).toBe(0);
	});

	it('a locked group keeps its editors — placed opens land elsewhere (claude-code locks its chat group)', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n', 'C:\\repo\\c.ts': 'c\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');
		await area.openExtPage({ kind: 'extpage', id: 'extpage:x:1', title: 'Claude', extId: 'x', pageId: 'webview' }, () => undefined);
		// The lock claude-code asks for: the chat's group keeps its editors.
		area.setGroupLock(right, true);
		expect(right.locked).toBe(true);
		const badge = document.querySelector('.editor-group-box.locked .group-lock')!;
		expect(badge).not.toBeNull();
		// The badge is the tab strip's own last item, in flow after the title actions — a
		// marker beside them, never an overlay covering them (an extension's title button
		// sits at that edge; the absolute overlay once ate the Claude one whole).
		expect(badge.closest('.tabs-container')).not.toBeNull();
		expect(badge.querySelector('.codicon-lock')).not.toBeNull();

		// An open without a placement while the locked group is focused lands in the other
		// group — the chat layer is never the destination.
		area.focusIndex(1);
		await area.openFile('C:\\repo\\c.ts');
		expect(area.groups()[0]!.openFilePaths()).toContain('C:\\repo\\c.ts');
		expect(right.openFilePaths()).toEqual(['C:\\repo\\b.ts']);

		// A placed 'beside' open skips the locked layer too: with the locked group focused,
		// a fresh split beside it takes the content.
		area.focusIndex(1);
		await area.openFile('C:\\repo\\a.ts', undefined, 'beside');
		expect(area.groupCount).toBe(3);
		expect(area.groups()[2]!.openFilePaths()).toEqual(['C:\\repo\\a.ts']);
		expect(right.openFilePaths()).toEqual(['C:\\repo\\b.ts']);

		// Unlocking restores the group as a destination for its own opens.
		area.setGroupLock(right, false);
		expect(document.querySelector('.editor-group-box.locked')).toBeNull();
		expect(document.querySelector('.group-lock')).toBeNull();
		area.focusIndex(1);
		await area.openFile('C:\\repo\\c.ts');
		expect(right.openFilePaths()).toEqual(['C:\\repo\\b.ts', 'C:\\repo\\c.ts']);
	});

	it('a placed webview panel opens its own side group — the lock claude-code asks for lands on the chat, not the code', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const code = area.activeGroup;
		// claude-code's chat panel: ViewColumn.Beside with no preserveFocus — the create's
		// showOptions reach the open as placement plus focus, as in VS Code.
		await area.openExtPage({ kind: 'extpage', id: 'webview:claude:1', title: 'Claude Code', extId: 'claude', pageId: 'webview' }, () => undefined, null, 'beside', true);
		expect(area.groupCount).toBe(2);
		const chat = area.activeGroup;
		expect(chat).not.toBe(code);
		expect(chat.activeInput?.kind).toBe('extpage');
		// The lock the extension runs right after its create (`workbench.action.lock
		// EditorGroup` locks the focused group): with the chat's group focused, the code's
		// group stays unlocked — its tab strip keeps every title action clear.
		area.setGroupLock(area.activeGroup, true);
		expect(chat.locked).toBe(true);
		expect(code.locked).toBe(false);
		const boxes = document.querySelectorAll('.editor-group-box');
		expect(boxes[1]!.querySelector('.group-lock')).not.toBeNull();
		expect(boxes[0]!.querySelector('.group-lock')).toBeNull();
	});

	it('a webview panel tab opens at once and its package icon joins it when the read answers', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		await area.openExtPage({ kind: 'extpage', id: 'webview:x:1', title: 'Chat', extId: 'x', pageId: 'webview' }, () => undefined, null);
		const tabOf = () => [...document.querySelectorAll('.tab')].find((entry) => entry.textContent?.includes('Chat'))!;
		// The globe placeholder stands in until the icon's data URL arrives.
		expect(tabOf().querySelector('.icon .codicon-globe')).not.toBeNull();
		expect(area.setIconSrc('webview:x:1', 'data:image/svg+xml;base64,AAA')).toBe(true);
		// renderTabs rebuilds the strip: the fresh tab carries the image.
		expect(tabOf().querySelector('.icon img')?.getAttribute('src')).toBe('data:image/svg+xml;base64,AAA');
		expect(area.setIconSrc('webview:missing:1', 'x')).toBe(false);
	});

	it('the reopen-closed stack restores the last closed tab where it closed', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		await area.openFile('C:\\repo\\b.ts');
		await area.close(); // closes b.ts, the active tab
		expect(area.openFilePaths()).toEqual(['C:\\repo\\a.ts']);
		area.reopenClosed();
		await flush();
		expect(area.openFilePaths()).toEqual(['C:\\repo\\a.ts', 'C:\\repo\\b.ts']);
		expect(area.activeInput?.kind === 'file' && area.activeInput.path.endsWith('b.ts')).toBe(true);
		// The stack empties: a second reopen with nothing closed does nothing.
		area.reopenClosed();
		await flush();
		expect(area.openFilePaths()).toEqual(['C:\\repo\\a.ts', 'C:\\repo\\b.ts']);
	});

	it('reopen lands in the active group once the closed tab\'s layer is gone', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');
		await area.close(); // closes b.ts; the empty right layer collapses away
		expect(area.groupCount).toBe(1);
		area.reopenClosed();
		await flush();
		expect(area.groupCount).toBe(1);
		expect(area.groups()[0]!.openFilePaths()).toEqual(['C:\\repo\\a.ts', 'C:\\repo\\b.ts']);
	});

	it('the welcome page belongs to the first group, and a split without files collapses back', async () => {
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.renderWelcome = (container) => container.appendChild(document.createElement('h1'));
		area.split('right');
		// A layer only exists while it holds editors: the welcome split folds back to one
		// pane, and the welcome page stays with it - never duplicated.
		expect(document.querySelectorAll('.editor-group-box')).toHaveLength(1);
		expect(document.querySelectorAll('.welcome h1')).toHaveLength(1);
	});

	it('serialises the grid and rebuilds it as it was, so a 2x2 session reopens as 2x2', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n', 'C:\\repo\\c.ts': 'c\n', 'C:\\repo\\d.ts': 'd\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		area.openInDirection('C:\\repo\\b.ts', 'right');
		await flush();
		area.focusIndex(0);
		area.openInDirection('C:\\repo\\c.ts', 'down');
		await flush();
		area.focusIndex(2);
		area.openInDirection('C:\\repo\\d.ts', 'down');
		await flush();
		expect(area.groupCount).toBe(4);
		// a 2x2: one outer row, each half a stacked column pair.
		expect(document.querySelectorAll('.editor-area-row')).toHaveLength(1);
		expect(document.querySelectorAll('.editor-area-col')).toHaveLength(2);
		expect(groupTabs()).toEqual([['a.ts'], ['c.ts'], ['b.ts'], ['d.ts']]);
		const saved = area.gridLayout();
		expect(saved).toEqual({ axis: 'x', sizes: [0.5, 0.5], children: [
			{ axis: 'y', sizes: [0.5, 0.5], children: [{ group: 0 }, { group: 1 }] },
			{ axis: 'y', sizes: [0.5, 0.5], children: [{ group: 2 }, { group: 3 }] }
		] });

		// Rebuild on a fresh area: same shape, same visual order of the groups.
		document.getElementById('editorGroup')!.innerHTML = '';
		const reopened = new EditorArea(document.getElementById('editorGroup')!);
		reopened.setRoot('C:\\repo');
		// The groups come back in the saved DFS order (a, c, b, d); each cell's files open in it.
		const groups = reopened.applyGridLayout(saved);
		await Promise.all(groups.map((group, index) => group.openFile(`C:\\repo\\${['a', 'c', 'b', 'd'][index]}.ts`, { inactive: true })));
		reopened.restoringLayout = false;
		await flush();
		expect(reopened.groupCount).toBe(4);
		expect(document.querySelectorAll('.editor-area-row')).toHaveLength(1);
		expect(document.querySelectorAll('.editor-area-col')).toHaveLength(2);
		expect(reopened.groups().map((group) => group.openFilePaths()[0])).toEqual([
			'C:\\repo\\a.ts', 'C:\\repo\\c.ts', 'C:\\repo\\b.ts', 'C:\\repo\\d.ts'
		]);
	});

	it('drops empty groups from the snapshot sessions', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		area.split('right'); // an empty second group: nothing to restore from it
		expect(area.groupSessions()).toEqual([{ files: ['C:\\repo\\a.ts'], active: 'C:\\repo\\a.ts' }]);
	});

	it('serialises per-group sessions for the workspace snapshot', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');
		expect(area.groupSessions()).toEqual([
			{ files: ['C:\\repo\\a.ts'], active: 'C:\\repo\\a.ts' },
			{ files: ['C:\\repo\\b.ts'], active: 'C:\\repo\\b.ts' }
		]);
	});

	it('opens the markdown preview to the side without a path argument (Ctrl+K V)', async () => {
		(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
		backend.on('read_file', () => ({ contents: '# T\n', binary: false, size: 4, encoding: 'utf8', eol: 'lf' }));
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\README.md');
		// The command passes no path: the active file's path must be taken from the group
		// that is active BEFORE the split, not from the fresh empty group the split focuses.
		await area.openMarkdownPreviewToSide();
		await flush();
		expect(area.groupCount).toBe(2);
		expect(area.groups()[0]!.openEditorIds()).toEqual(['file:C:\\repo\\README.md']);
		expect(area.groups()[1]!.openEditorIds()).toEqual(['markdown:C:\\repo\\README.md']);
	});

	it('opens no empty split when there is no file to preview to the side', async () => {
		const area = new EditorArea(document.getElementById('editorGroup')!);
		await area.openMarkdownPreviewToSide();
		expect(area.groupCount).toBe(1);
	});

	it('the markdown tab\'s preview-to-the-side button opens the preview in a split', async () => {
		(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
		backend.on('read_file', () => ({ contents: '# T\n', binary: false, size: 4, encoding: 'utf8', eol: 'lf' }));
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\NOTE.md');
		click(document.querySelector('.markdown-preview-button'));
		await flush();
		expect(area.groupCount).toBe(2);
		expect(area.groups()[1]!.openEditorIds()).toEqual(['markdown:C:\\repo\\NOTE.md']);
	});

	it('a markdown file\'s preview button shares the one action cluster with the extensions\' title actions', async () => {
		// claude-code contributes an editor/title navigation action (the Claude button);
		// a .md file adds the preview button. Both must ride ONE `tab-actions` container —
		// two would split the strip's free space between their `margin-left: auto`s and
		// maroon the preview button mid-strip, apart from the title actions.
		files({ 'C:\\repo\\README.md': '# t\n' });
		applyContributions('acme.demo', {
			commands: [{ command: 'acme.demo.open', title: 'Open Side Panel' }],
			menus: { 'editor/title': [{ command: 'acme.demo.open', group: 'navigation' }] }
		}, {}, () => undefined, () => true);
		try {
			const area = new EditorArea(document.getElementById('editorGroup')!);
			area.setRoot('C:\\repo');
			await area.openFile('C:\\repo\\README.md');
			const clusters = document.querySelectorAll('.tabs-container .tab-actions');
			expect(clusters).toHaveLength(1);
			const cluster = clusters[0]!;
			expect(cluster.querySelector('.markdown-preview-button:not(.ext-editor-action)')).not.toBeNull();
			expect(cluster.querySelector('.ext-editor-action')).not.toBeNull();
			// The preview button leads the cluster, the title actions follow it.
			expect(cluster.firstElementChild!.classList.contains('markdown-preview-button')).toBe(true);
			// A non-markdown file shows the title actions alone — no preview button.
			files({ 'C:\\repo\\README.md': '# t\n', 'C:\\repo\\a.ts': 'a\n' });
			await area.openFile('C:\\repo\\a.ts');
			const only = document.querySelector('.tabs-container .tab-actions')!;
			expect(only.querySelector('.markdown-preview-button:not(.ext-editor-action)')).toBeNull();
			expect(only.querySelector('.ext-editor-action')).not.toBeNull();
		} finally {
			removeContributions('acme.demo');
		}
	});

	it('a python file\'s run button joins the action cluster and reports its path', async () => {
		files({ 'C:\\repo\\main.py': 'print(1)\n', 'C:\\repo\\a.ts': 'a\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		const runs: string[] = [];
		area.onRunInTerminal = (path) => runs.push(path);
		await area.openFile('C:\\repo\\main.py');
		const cluster = document.querySelector('.tabs-container .tab-actions')!;
		const run = cluster.querySelector('.python-run-button')!;
		expect(run).not.toBeNull();
		click(run);
		expect(runs).toEqual(['C:\\repo\\main.py']);
		// The button is a .py file's alone: a .ts tab carries none.
		await area.openFile('C:\\repo\\a.ts');
		expect(document.querySelector('.python-run-button')).toBeNull();
	});

	it('an upgrade\'s fresh manifest re-renders the title button — whichever icon and placement the new version declares', async () => {
		// The Claude button is the extension\'s own editor/title contribution; an upgrade
		// must never lose it. What the host does on an install (reload(): drop the old
		// contributions, apply the new manifest) is simulated here version by version —
		// the rendering follows whatever the new manifest says, not any memory of the old.
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		applyContributions('Anthropic.claude-code', {
			commands: [{ command: 'claude-vscode.editor.openLast', title: 'Claude Code: Open', icon: { light: 'resources/claude-logo.svg', dark: 'resources/claude-logo.svg' } }],
			menus: { 'editor/title': [{ command: 'claude-vscode.editor.openLast', when: '!config.claudeCode.useTerminal', group: 'navigation' }] }
		}, {}, () => undefined, () => true);
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const ofOld = document.querySelector('.ext-editor-action')!;
		expect(ofOld.title).toBe('Claude Code: Open');

		// The upgrade lands: the host re-applies the package's new manifest — here a future
		// version that spells its icon as a codicon and keeps the same command.
		removeContributions('Anthropic.claude-code');
		applyContributions('Anthropic.claude-code', {
			commands: [{ command: 'claude-vscode.editor.openLast', title: 'Claude Code: Open', icon: '$(play)' }],
			menus: { 'editor/title': [{ command: 'claude-vscode.editor.openLast', group: 'navigation' }] }
		}, {}, () => undefined, () => true);
		await area.openFile('C:\\repo\\b.ts');
		const buttons = document.querySelectorAll('.ext-editor-action');
		expect(buttons).toHaveLength(1);
		expect(buttons[0]!.title).toBe('Claude Code: Open');
		expect(buttons[0]!.querySelector('.codicon-play')).not.toBeNull();
		// The old version\'s image spelling is gone with it.
		expect(buttons[0]!.querySelector('img')).toBeNull();
	});

	it('detaches a destroyed group\'s settings listener (collapse and grid rebuild)', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n' });
		const removed: string[] = [];
		const original = document.removeEventListener;
		const spy = vi.spyOn(document, 'removeEventListener').mockImplementation((type: string, listener?: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
			removed.push(type);
			original.call(document, type, listener, options);
		});
		try {
			const area = new EditorArea(document.getElementById('editorGroup')!);
			area.setRoot('C:\\repo');
			await area.openFile('C:\\repo\\a.ts');
			area.split('right');
			area.focusIndex(0); // the empty split collapses: its group is destroyed
			expect(area.groupCount).toBe(1);
			expect(removed).toContain(SETTINGS_EVENT);

			removed.length = 0;
			area.applyGridLayout({ axis: 'x', sizes: [0.5, 0.5], children: [{ group: 0 }, { group: 1 }] });
			expect(area.groupCount).toBe(2);
			area.applyGridLayout(null);
			expect(area.groupCount).toBe(1);
			expect(removed).toContain(SETTINGS_EVENT);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('the grid snapshot when a group holds no files', () => {
	it('numbers the cells over the session-bearing groups only, so a restore lands files in their panes', async () => {
		files({ 'C:\repo\a.ts': 'a\n', 'C:\repo\c.ts': 'c\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\repo');
		await area.openFile('C:\repo\a.ts');
		// Three groups: a.ts | Git Graph (no file - dropped from the sessions) | c.ts.
		const middle = area.split('right');
		await middle.openHelp('welcome');
		const right = area.split('right');
		await right.openFile('C:\repo\c.ts');
		expect(area.groupCount).toBe(3);
		expect(area.groupSessions()).toEqual([
			{ files: ['C:\repo\a.ts'], active: 'C:\repo\a.ts' },
			{ files: ['C:\repo\c.ts'], active: 'C:\repo\c.ts' }
		]);
		// The cells line up with the sessions: two of them, the graph's pane left out, its
		// share handed to the survivors (proportions still sum to one).
		const saved = area.gridLayout()!;
		expect('axis' in saved && saved.children).toEqual([{ group: 0 }, { group: 1 }]);
		expect('axis' in saved && saved.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);

		// A layout whose only file-bearing group is one of several is a single-group session.
		const single = new EditorArea(document.getElementById('editorGroup')!);
		single.setRoot('C:\repo');
		await single.openFile('C:\repo\a.ts');
		await single.split('right').openHelp('welcome');
		expect(single.groupCount).toBe(2);
		expect(single.gridLayout()).toBeNull();
	});

	it('collapses a split left with one cell into that cell', async () => {
		files({ 'C:\repo\a.ts': 'a\n', 'C:\repo\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\repo');
		await area.openFile('C:\repo\a.ts');
		// a.ts | (graph over b.ts): the right column's graph pane drops, leaving b.ts alone
		// in it - the column disappears and b.ts becomes the row's second cell directly.
		const rightTop = area.split('right');
		await rightTop.openHelp('welcome');
		const rightBottom = area.split('down');
		await rightBottom.openFile('C:\repo\b.ts');
		expect(area.groupCount).toBe(3);
		expect(area.gridLayout()).toEqual({ axis: 'x', sizes: [0.5, 0.5], children: [{ group: 0 }, { group: 1 }] });
	});
});

describe('the sash between three groups', () => {
	it('moves a pair\'s shares by the dragged fraction of the split, not of the pair', async () => {
		files({ 'C:\repo\a.ts': 'a\n', 'C:\repo\b.ts': 'b\n', 'C:\repo\c.ts': 'c\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\repo');
		await area.openFile('C:\repo\a.ts');
		await area.split('right').openFile('C:\repo\b.ts');
		await area.split('right').openFile('C:\repo\c.ts');
		expect(area.gridLayout()).toEqual({ axis: 'x', sizes: [0.5, 0.25, 0.25], children: [{ group: 0 }, { group: 1 }, { group: 2 }] });
		const row = document.querySelector<HTMLElement>('.editor-area-row')!;
		row.getBoundingClientRect = () => ({ width: 1000, height: 500, top: 0, left: 0, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => undefined });
		// Drag the second sash (between b and c) 100px to the right: a tenth of the row's
		// width moves from c to b - 0.25 -> 0.35 and 0.25 -> 0.15, the first group untouched.
		const sash = document.querySelectorAll<HTMLElement>('.editor-sash')[1]!;
		sash.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 750, clientY: 100 }));
		document.dispatchEvent(new MouseEvent('mousemove', { clientX: 850, clientY: 100 }));
		document.dispatchEvent(new MouseEvent('mouseup', { clientX: 850, clientY: 100 }));
		await flush();
		const sizes = (area.gridLayout() as { sizes: number[] }).sizes;
		expect(sizes[0]).toBeCloseTo(0.5);
		expect(sizes[1]).toBeCloseTo(0.35);
		expect(sizes[2]).toBeCloseTo(0.15);
	});
});
