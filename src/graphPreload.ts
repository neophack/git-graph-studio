// The Git Graph Engine seam's boot warmer (module 10): starts the view page
// (static/gitgraph/view.html) in a hidden frame while the workbench chunk is still
// downloading and parsing, so the view bundle's fetch, parse and first data requests overlap
// the splash instead of serialising after the folder opens. The page is started with the one
// repository knowable at splash time - the same choice the boot's `lastFolder` /
// `boot_context` logic makes - and GraphHost claims the frame (claimGraphPreload) when the
// workbench comes up; its mount then feeds the live page the full repository set over
// loadRepos instead of reloading the page.
//
// This file is part of the TypeScript seam (docs/ggs-development-plan.md §3.7,
// scripts/check-seams.mjs): like graphHost.ts it names the view page and reads the config
// bundle, which is why the seam check allowlists it. It never speaks the view's own
// request protocol - only graphHost.ts does.

import { invoke } from '@tauri-apps/api/core';

import { themeById } from './settings';
import * as state from './state';

/** The frame the warmer started, still unclaimed. */
let preloaded: { frame: HTMLIFrameElement; repo: string } | null = null;

/** Boot the view page in a hidden frame for the folder this launch will open. Safe to call
 *  once per window; a no-op when the launch shows a file or a comparison, remembers no
 *  folder (or a workspace - the graph keys off the first root, resolved later), or when the
 *  config bundle is not there (tests). Never throws into the caller: a failed warm-up only
 *  means the mount reloads the page the plain way. */
export function startGraphPreload(): void {
	if (preloaded) return;
	void warm().catch(() => undefined);
}

async function warm(): Promise<void> {
	// The same launch-form choice the boot makes: a remembered workspace wins, then the
	// folder argument, then the remembered folder. Keep in step with workbench.boot.
	const context = await invoke<{ file: string | null; actions: unknown[]; repo: string | null }>('boot_context').catch(() => null);
	if (context === null || context.file !== null || context.actions.length > 0) return;
	const remembered = state.lastFolder();
	const last = remembered !== null && remembered.toLowerCase().endsWith('.ggs-workspace')
		? remembered
		: context.repo ?? remembered;
	if (last === null || last.toLowerCase().endsWith('.ggs-workspace')) return;
	const build = window.GitGraphStudioConfig;
	if (!build) return; // no config bundle (tests): the page has nothing to boot with
	const theme = themeById();
	// Exactly the initial state GraphHost.preload writes - the mount reconciles the page
	// with the full repository set over loadRepos.
	sessionStorage.setItem('ggstudio.initial', JSON.stringify({
		initialState: {
			config: build(state.graphSettings()),
			repos: { [last]: state.repoState(last) },
			lastActiveRepo: last,
			loadViewTo: null,
			loadRepoInfoRefreshId: 0,
			loadCommitsRefreshId: 0,
			backend: { platform: 'studio', engineAvailable: true, engineVersion: 'embedded', gitCliAvailable: true, capabilities: [] }
		},
		globalState: state.globalViewState(),
		workspaceState: state.workspaceViewState(),
		theme: { css: theme.css, kind: theme.kind, label: theme.label }
	}));
	const frame = document.createElement('iframe');
	frame.title = 'Git Graph';
	frame.setAttribute('aria-label', 'Git Graph');
	frame.style.display = 'none';
	document.body.appendChild(frame);
	preloaded = { frame, repo: last };
	// After this point the page owns its own boot; the host side learns of it through the
	// page's __studioGraphBooted message or by reading window.__ggViewBooted (see
	// graphHost.whenPreloadSettled).
	frame.src = '/gitgraph/view.html';
}

/** The frame the warmer started, removed from the document and handed to GraphHost; `null`
 *  when the warmer did not run or the frame was already claimed. */
export function claimGraphPreload(): { frame: HTMLIFrameElement; repo: string } | null {
	const claimed = preloaded;
	preloaded = null;
	claimed?.frame.remove();
	return claimed;
}
