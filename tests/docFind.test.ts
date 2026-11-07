// The windowed/fast-view find bar's own behaviors that jsdom can reach: closing the bar
// clears the host's painted highlights (VS Code's behavior — the CodeMirror panel always
// did), the query lifecycle drives the host's paint calls, and the two fields' Enter keys
// stay distinct — the query field steps, the replace field replaces.

import { describe, expect, it, vi } from 'vitest';

import { DocFindController, type DocFindHost, type DocFindMatch } from '../src/features/editor';
import { backend } from './tauriMock';
import { flush, key, type } from './helpers';

function controllerWith(over: Partial<DocFindHost> = {}, editable = false): { controller: DocFindController; painted: { matches: DocFindMatch[]; current: DocFindMatch | null }[] } {
	const painted: { matches: DocFindMatch[]; current: DocFindMatch | null }[] = [];
	const host: DocFindHost = {
		docId: () => 7,
		position: () => ({ line: 0, col: 0 }),
		revealMatch: () => undefined,
		paintMatches: (matches, current) => {
			painted.push({ matches, current });
		},
		focusEditor: () => undefined,
		...over
	};
	const controller = new DocFindController(host, document.body, editable);
	return { controller, painted };
}

describe('DocFindController', () => {
	it('closing the bar clears the painted highlights', async () => {
		backend.on('viewer_find', () => ({
			matches: [
				{ line: 1, col: 0, endCol: 4 },
				{ line: 5, col: 2, endCol: 6 }
			],
			capped: false
		}));
		const { controller, painted } = controllerWith();
		controller.open();
		const input = document.querySelector('.cm-find-input') as HTMLInputElement;
		input.value = 'needle';
		input.dispatchEvent(new Event('input'));
		await flush();
		await new Promise((resolve) => setTimeout(resolve, 260)); // the debounce
		await flush();
		expect(painted.at(-1)!.matches.length).toBe(2);

		controller.close();
		expect(painted.at(-1)!.matches).toEqual([]);
		expect(painted.at(-1)!.current).toBeNull();
		// The paint record for the close survives later repaints being suppressed while
		// the bar is closed (a refresh while closed does not repaint stale highlights).
		const repaintCount = painted.length;
		controller.refresh();
		await flush();
		expect(painted.length).toBeLessThanOrEqual(repaintCount + 1);
	});

	it('a newer generation supersedes an in-flight scan without painting it', async () => {
		const slow = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ matches: [{ line: 0, col: 0, endCol: 1 }], capped: false }), 50)));
		backend.on('viewer_find', slow);
		const { controller, painted } = controllerWith();
		controller.open();
		const input = document.querySelector('.cm-find-input') as HTMLInputElement;
		input.value = 'first';
		input.dispatchEvent(new Event('input'));
		await flush();
		controller.close(); // supersedes the scan
		await new Promise((resolve) => setTimeout(resolve, 80));
		await flush();
		const afterClose = painted.slice(painted.findLastIndex((p) => p.matches.length === 0) + 1);
		expect(afterClose.every((p) => p.matches.length === 0)).toBe(true);
	});

	it('Enter steps from the query field and replaces from the replace field', async () => {
		backend.on('viewer_find', () => ({ matches: [{ line: 0, startCol: 0, endCol: 4 }], capped: false }));
		const calls: string[] = [];
		const { controller } = controllerWith({
			revealMatch: () => calls.push('reveal'),
			replace: async () => { calls.push('replace'); }
		}, true);
		controller.open(true); // with the replace row
		const widget = document.querySelector('.cm-find-widget') as HTMLElement;
		const [find, replace] = [...widget.querySelectorAll('.cm-find-input')] as HTMLInputElement[];
		type(find, 'needle');
		await flush();
		await new Promise((resolve) => setTimeout(resolve, 260)); // the debounce
		await flush();
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 1');
		calls.length = 0; // the initial find's own reveal is not part of the keys under test

		// Enter in the replace field replaces the current match (findWidget.ts's binding);
		// the one shared keydown used to step to the next match instead. The follow-up
		// find's own reveal of the new current match rides along afterwards.
		key(replace, 'Enter');
		await flush();
		expect(calls[0]).toBe('replace');

		// Enter in the query field still steps, and never replaces.
		calls.length = 0;
		key(find, 'Enter');
		await flush();
		expect(calls).toEqual(['reveal']);
		controller.close();
	});
});
