// The windowed/fast-view find bar's own behaviors that jsdom can reach: closing the bar
// clears the host's painted highlights (VS Code's behavior — the CodeMirror panel always
// did), and the query lifecycle drives the host's paint calls.

import { describe, expect, it, vi } from 'vitest';

import { DocFindController, type DocFindHost, type DocFindMatch } from '../src/docFind';
import { backend } from './tauriMock';
import { flush } from './helpers';

function controllerWith(over: Partial<DocFindHost> = {}): { controller: DocFindController; painted: { matches: DocFindMatch[]; current: DocFindMatch | null }[] } {
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
	const controller = new DocFindController(host, document.body, false);
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
});
