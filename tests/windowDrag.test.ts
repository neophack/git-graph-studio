import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isWindowDragging, noteTitleBarMouseDown, noteWindowMoved } from '../src/platform/windowDrag';
import { FS_CHANGED_EVENT, Workbench } from '../src/workbench';
import { TitleBar } from '../src/workbench/titlebar';
import { backend } from './tauriMock';

beforeEach(() => {
	backend.on('boot_context', () => ({ file: null, actions: [], repo: null }));
	backend.on('ext_list', () => []);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the window drag gate', () => {
	it('marks a drag from the title bar mousedown and lets it decay after the quiet period', () => {
		vi.useFakeTimers();
		expect(isWindowDragging()).toBe(false);
		noteTitleBarMouseDown();
		expect(isWindowDragging()).toBe(true);
		// A plain click (no move followed) settles back: the refresh deferral is bounded.
		vi.advanceTimersByTime(251);
		expect(isWindowDragging()).toBe(false);
	});

	it('keeps the mark alive while the window moves and clears it a quiet period after the last move', () => {
		vi.useFakeTimers();
		noteWindowMoved();
		// A drag streams move events; each one re-arms the quiet decay.
		for (let i = 0; i < 10; i++) {
			vi.advanceTimersByTime(100);
			noteWindowMoved();
			expect(isWindowDragging()).toBe(true);
		}
		vi.advanceTimersByTime(249);
		expect(isWindowDragging()).toBe(true);
		vi.advanceTimersByTime(2);
		expect(isWindowDragging()).toBe(false);
	});

	it('the title bar marks on mousedown and the runtime moves re-mark through the window controls', () => {
		vi.useFakeTimers();
		const bar = new TitleBar(document.getElementById('titlebar')!);
		// A left mousedown anywhere on the bar marks (over a menu item too — the decay
		// bounds what a click defers); the runtime's move events re-mark while the drag lasts.
		document.getElementById('titlebar')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		expect(isWindowDragging()).toBe(true);
		expect(backend.window.moveHandlers.length).toBe(1);
		vi.advanceTimersByTime(200);
		backend.window.moveHandlers[0]!();
		expect(isWindowDragging()).toBe(true);
		vi.advanceTimersByTime(251);
		expect(isWindowDragging()).toBe(false);
	});
});

describe('refreshes defer while the window is being dragged', () => {
	it('an fs-change batch during a native window drag runs only after the drag settles', async () => {
		const workbench = new Workbench();
		let runs = 0;
		(workbench as unknown as { repoPath: string }).repoPath = 'C:\\repo';
		(workbench as unknown as { repoPaths: string[] }).repoPaths = ['C:\\repo'];
		workbench.editors.reloadIfClean = async () => undefined;
		(workbench as unknown as { scm: { refresh: () => void } }).scm.refresh = () => { runs++; };
		(workbench as unknown as { explorer: { refresh: () => void } }).explorer.refresh = () => undefined;
		vi.useFakeTimers();
		try {
			// The drag is live (the title bar mousedown and the moves keep re-marking).
			noteTitleBarMouseDown();
			noteWindowMoved();
			backend.emit(FS_CHANGED_EVENT, { root: 'C:\\repo', paths: ['src/a.ts'], truncated: false, gitChanged: false });
			await vi.advanceTimersByTimeAsync(300);
			// Both the batch's own run and the 200 ms deferral polls found the window
			// still dragging: nothing ran.
			expect(runs).toBe(0);
			// The drag ends (no further move); the deferral's next poll runs the refresh.
			vi.advanceTimersByTime(450);
			expect(runs).toBe(1);
		} finally {
			vi.useRealTimers();
		}
		workbench.dispose();
	});
});
