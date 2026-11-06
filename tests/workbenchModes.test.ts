// The window/view modes (the Appearance menu's family): zen mode's lifecycle over a stand-in
// workbench (the pre-zen visibility remembered and restored exactly, the Escape-Escape exit
// and the Escapes that must not count), and the fullscreen / zoom commands' absence guard —
// the browser shim and the tests' mock carry no setFullscreen / setZoom, where both answer
// nothing instead of throwing.

import { describe, expect, it } from 'vitest';

import { layoutMethods } from '../src/workbench/layout';
import type { Workbench } from '../src/workbench';
import { key } from './helpers';

/** A stand-in `this` with just the surface the layout concern touches in the modes: the side
 *  bar pair, the panel (its own visibility bookkeeping, like the real panel's element) and
 *  the layout methods themselves — the real facade Object.assigns them onto the prototype,
 *  so the zen toggles resolve their siblings through `this`. */
function modeHost() {
	const sidebar = document.createElement('div');
	const sidebarSash = document.createElement('div');
	document.body.appendChild(sidebar);
	document.body.appendChild(sidebarSash);
	const panel = {
		visible: false,
		isVisible(): boolean {
			return this.visible;
		},
		hide(): void {
			this.visible = false;
		},
		show(): void {
			this.visible = true;
		}
	};
	const host = { sidebar, sidebarSash, panel, ...layoutMethods } as unknown as Workbench;
	return { host, sidebar, sidebarSash, panel };
}

describe('zen mode', () => {
	it('folds the chrome away, remembers the pre-zen visibility and restores it exactly on exit', () => {
		const { host, sidebar, sidebarSash, panel } = modeHost();
		sidebar.hidden = false;
		sidebarSash.hidden = false;
		panel.visible = true;

		layoutMethods.toggleZenMode.call(host);
		expect(document.body.classList.contains('zen')).toBe(true);
		expect(sidebar.hidden).toBe(true);
		expect(sidebarSash.hidden).toBe(true);
		expect(panel.visible).toBe(false);

		layoutMethods.toggleZenMode.call(host);
		expect(document.body.classList.contains('zen')).toBe(false);
		expect(sidebar.hidden).toBe(false);
		expect(sidebarSash.hidden).toBe(false);
		expect(panel.visible).toBe(true);
	});

	it('leaves chrome hidden when it was hidden before zen, and never shows it on exit', () => {
		const { host, sidebar, sidebarSash, panel } = modeHost();
		sidebar.hidden = true;
		sidebarSash.hidden = true;
		panel.visible = false;

		layoutMethods.toggleZenMode.call(host);
		layoutMethods.toggleZenMode.call(host);
		expect(document.body.classList.contains('zen')).toBe(false);
		expect(sidebar.hidden).toBe(true);
		expect(sidebarSash.hidden).toBe(true);
		expect(panel.visible).toBe(false);
	});

	it('exits on Escape-Escape (two within ~600 ms) and only then', () => {
		const { host } = modeHost();
		layoutMethods.toggleZenMode.call(host);
		expect(document.body.classList.contains('zen')).toBe(true);

		// One Escape waits; a second inside the window exits.
		key(document, 'Escape');
		expect(document.body.classList.contains('zen')).toBe(true);
		key(document, 'Escape');
		expect(document.body.classList.contains('zen')).toBe(false);

		// An Escape, then another key, then Escape: the sequence was broken.
		layoutMethods.toggleZenMode.call(host);
		key(document, 'Escape');
		key(document, 'a');
		key(document, 'Escape');
		expect(document.body.classList.contains('zen')).toBe(true);
		layoutMethods.toggleZenMode.call(host);
	});

	it('an Escape a surface already claimed (defaultPrevented) never counts toward the double', () => {
		const { host } = modeHost();
		// A document-level listener registered before zen's, claiming every Escape the way
		// the quick input or the palette closes itself — zen's listener must see the
		// prevention and never count those.
		const claimer = (event: KeyboardEvent) => {
			if (event.key === 'Escape') event.preventDefault();
		};
		document.addEventListener('keydown', claimer);
		layoutMethods.toggleZenMode.call(host);
		key(document, 'Escape');
		key(document, 'Escape');
		expect(document.body.classList.contains('zen')).toBe(true);
		document.removeEventListener('keydown', claimer);

		// With the claims gone, the double exits as usual.
		key(document, 'Escape');
		key(document, 'Escape');
		expect(document.body.classList.contains('zen')).toBe(false);
	});

	it('the fullscreen and zoom commands answer nothing where the API lacks the methods', () => {
		const { host } = modeHost();
		// The mock's window/webview carry no setFullscreen / setZoom: both calls must be
		// silent no-ops (the browser shim's shape), never a TypeError.
		expect(() => layoutMethods.toggleFullScreen.call(host)).not.toThrow();
		expect(() => layoutMethods.zoomWorkbench.call(host, 'in')).not.toThrow();
		expect(() => layoutMethods.zoomWorkbench.call(host, 'reset')).not.toThrow();
	});
});
