"use strict";
/* The official Remote Control path (plan §2.1/P5): the conversation's own capsule,
 * toggled through the host's synthesized `toggle_remote_control` (exactly what the
 * desktop tab's own button does), its `connectUrl` read from the CLI's own state pushes.
 * Only claude.ai login + first-party models serve it — the CLI decides and reports
 * (`channelRemoteControlAvailable`); this module never guesses, and on a third-party
 * provider it answers the CLI's own reason and the panel says which mode applies.
 *
 * VS Code cannot reach another extension's webview: there this module only answers
 * `remoteControlAtStartup` (the all-sessions switch in Claude's own settings) and
 * explains what the desktop cannot do. */

const fs = require("fs");
const path = require("path");

/** Read/write the `remoteControlAtStartup` flag of Claude's own settings.json — an
 *  explicit user action through this extension's own setting, never the mirror path
 *  (the mirror writes nothing, reads everything). */
function allSessions(claudeRoot, { set } = {}) {
	const file = path.join(claudeRoot(), "settings.json");
	let settings = {};
	try {
		settings = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		settings = {};
	}
	if (set === undefined) return settings.remoteControlAtStartup === true;
	const next = { ...settings, remoteControlAtStartup: set === true };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(next, null, 2));
	return next.remoteControlAtStartup;
}

/**
 * @param {{ log, tap: { remoteControl, remoteState } | null }} options — the tap source
 *        on Git Graph Studio; null where the host cannot drive the tab (VS Code).
 */
function createOfficial(options) {
	const log = options.log || (() => {});
	let tap = options.tap || null;

	/** What the CLI itself says about a conversation's Remote Control. */
	async function state(sessionId) {
		if (!tap) {
			return { available: null, status: "unsupported", reason: "this host cannot reach the Claude Code tab's remote control", connectUrl: null, sessionUrl: null };
		}
		try {
			const answer = await tap.remoteState({ sessionId });
			return {
				available: answer.available === undefined || answer.available === null ? null : answer.available,
				status: answer.rc && answer.rc.status ? answer.rc.status : "off",
				connectUrl: answer.rc && answer.rc.connectUrl || null,
				sessionUrl: answer.rc && answer.rc.sessionUrl || null
			};
		} catch (error) {
			log(`reading the remote-control state failed: ${error && error.message}`);
			return { available: null, status: "unknown", reason: String(error && error.message), connectUrl: null, sessionUrl: null };
		}
	}

	/** Toggle it: the host synthesizes the page's own request and consumes the answer. */
	async function toggle(sessionId, enable) {
		if (!tap) throw new Error("this host cannot toggle the Claude Code tab's remote control");
		const answer = await tap.remoteControl({ sessionId, enable });
		const rc = answer && answer.rc;
		return {
			status: rc && rc.status ? rc.status : enable ? "connecting" : "disconnected",
			connectUrl: rc && rc.connectUrl || null,
			sessionUrl: rc && rc.sessionUrl || null
		};
	}

	return {
		state,
		toggle,
		allSessions,
		supported: () => tap !== null,
		/** The tap probe settles late; this swaps the driving source in when it lands. */
		adoptTap(next) {
			tap = next || null;
		}
	};
}

module.exports = { createOfficial, allSessions };
