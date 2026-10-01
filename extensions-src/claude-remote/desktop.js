"use strict";
/* The desktop side of a remote turn: the conversation's Claude Code tab.
 *
 * A phone prompt runs through the CLI, outside the Claude Code chat panel. So that the
 * desktop shows what happened, the session's tab is opened (or revealed) when the turn
 * starts, and reloaded when it ends: an open chat panel never re-reads its session file,
 * and the turn it would run next would continue from the history it still holds — a
 * branch that silently drops the phone's turn. Reloading = closing the session's tab and
 * opening it again, which loads the session from disk.
 *
 * Which tab hosts a session: Git Graph Studio answers exactly (`ggs.sessionTabs.*`, from
 * the session each chat panel reports); VS Code has no session→tab map, so there the
 * session's tab is revealed first and closed only when the active tab is then a Claude
 * Code panel. A desktop turn in flight is never interrupted: a busy session is left alone.
 */

const OPEN = "claude-vscode.editor.open";
const PANEL_VIEW_TYPE = /claudeVSCodePanel/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {typeof import('vscode')} vscode
 * @param {{ mode: () => "reload" | "open" | "off", busy: (sessionId: string) => boolean, log?: (line: string) => void, settleMs?: number }} options
 */
function createDesktopTabs(vscode, options) {
	const log = options.log || (() => {});
	const settle = options.settleMs ?? 350;
	let hostTabs = null; // null: not asked yet; false: this host has no session-tab commands
	let openSessions = new Set();
	let claudeAvailable = null;
	const chains = new Map(); // session id → the last queued operation

	const exec = (id, ...args) => Promise.resolve(vscode.commands.executeCommand(id, ...args));

	async function hasClaude() {
		if (claudeAvailable !== null) return claudeAvailable;
		try {
			const commands = await vscode.commands.getCommands(true);
			claudeAvailable = commands.includes(OPEN);
		} catch {
			claudeAvailable = false;
		}
		if (!claudeAvailable) log("the Claude Code extension is not installed — remote turns run without a desktop tab");
		return claudeAvailable;
	}

	/** The sessions with an open tab (Git Graph Studio); null where the host cannot tell. */
	async function refresh() {
		if (hostTabs === false) return null;
		try {
			const ids = await exec("ggs.sessionTabs.list");
			if (!Array.isArray(ids)) throw new Error("no session tabs");
			hostTabs = true;
			openSessions = new Set(ids.filter((id) => typeof id === "string"));
			return openSessions;
		} catch {
			hostTabs = false;
			openSessions = new Set();
			return null;
		}
	}

	async function openTab(sessionId) {
		// (sessionId, initialPrompt, viewColumn, groupId, fullEditor, { programmatic }) —
		// "pin-to-panel" lands it in an editor tab even when the sidebar is the preference
		await exec(OPEN, sessionId, undefined, undefined, undefined, undefined, { programmatic: "pin-to-panel" });
	}

	async function reload(sessionId) {
		if (hostTabs === null) await refresh();
		if (hostTabs) {
			const closed = Number(await exec("ggs.sessionTabs.close", sessionId)) || 0;
			if (!closed) return false; // the user closed it meanwhile: leave it closed
			await sleep(settle);
			await openTab(sessionId);
			return true;
		}
		const groups = vscode.window.tabGroups;
		if (!groups || typeof groups.close !== "function") return false;
		await openTab(sessionId); // reveals the session's tab
		await sleep(settle);
		const tab = groups.activeTabGroup && groups.activeTabGroup.activeTab;
		const viewType = tab && tab.input && tab.input.viewType;
		if (!tab || typeof viewType !== "string" || !PANEL_VIEW_TYPE.test(viewType)) return false;
		await groups.close(tab, true);
		await sleep(settle);
		await openTab(sessionId);
		return true;
	}

	/** Serialize per session: a start racing the previous turn's reload would reveal the closing tab. */
	function queue(sessionId, job) {
		const previous = chains.get(sessionId) || Promise.resolve();
		const next = previous.then(job, job).catch((error) => log(`desktop tab for ${sessionId}: ${error && error.message || error}`));
		chains.set(sessionId, next);
		next.then(() => { if (chains.get(sessionId) === next) chains.delete(sessionId); });
		return next;
	}

	/** The runner's turn hook. */
	function onTurn(phase, { sessionId, moreQueued, injected }) {
		const mode = options.mode();
		// an injected turn ran in the tab itself: it is open and current already
		if (mode === "off" || !sessionId || injected) return Promise.resolve();
		return queue(sessionId, async () => {
			if (!(await hasClaude())) return;
			if (phase === "start" || phase === "session") {
				await openTab(sessionId);
			} else if (phase === "end" && mode === "reload" && !moreQueued) {
				if (options.busy(sessionId)) { log(`desktop tab for ${sessionId}: the desktop is mid-turn — not reloading`); return; }
				if (await reload(sessionId)) log(`reloaded the desktop tab of ${sessionId}`);
			}
			await refresh();
		});
	}

	return { onTurn, refresh, openTab, reload, list: () => openSessions };
}

module.exports = { createDesktopTabs };
