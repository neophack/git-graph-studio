// The daemon's local admin API (docs/ggs-remote-plan.md §7.11), reached through the CLI
// (`ggs-remote admin METHOD PATH -` with the JSON body on stdin — a password never lands in
// a process's argv). Answers parsed JSON.
'use strict';

const daemon = require('./daemon');

function createAdmin(extensionPath) {
	async function call(method, path, body) {
		const args = ['admin', method, path];
		let input;
		if (body !== undefined) {
			args.push('-');
			input = JSON.stringify(body);
		}
		const out = await daemon.run(extensionPath, args, input);
		const text = out.trim();
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	return {
		call,
		status: (unlock) => call('GET', `/admin/status${unlock ? `?unlock=${encodeURIComponent(unlock)}` : ''}`),
		unlock: (password) => call('POST', '/admin/unlock', { password }),
		setPassword: (password) => call('POST', '/admin/password', { password }),
		devices: () => call('GET', '/admin/devices'),
		removeDevice: (id) => call('DELETE', `/admin/devices/${encodeURIComponent(id)}`),
		signOutAll: () => call('POST', '/admin/signout-all', {}),
		pause: () => call('POST', '/admin/pause', {}),
		resume: () => call('POST', '/admin/resume', {}),
		config: (patch) => call('PUT', '/admin/config', patch),
		qr: (unlock, text) => call('GET', `/admin/qr?unlock=${encodeURIComponent(unlock)}&text=${encodeURIComponent(text)}`),
		pairTicket: () => call('POST', '/admin/pair-ticket', {}),
		shutdown: () => call('POST', '/admin/shutdown', {}),
		hubStatus: () => call('GET', '/admin/hub/status'),
		hubConnect: (url, joinKey, fingerprint) => call('POST', '/admin/hub/connect', { url, joinKey: joinKey || '', fingerprint: fingerprint || '' }),
		hubDisconnect: () => call('POST', '/admin/hub/disconnect', {}),
		hubRelink: () => call('POST', '/admin/hub/relink', {}),
		hubExportKey: (password) => call('POST', '/admin/hub/export-key', { password }),
		hubImportKey: (password, data) => call('POST', '/admin/hub/import-key', { password, data })
	};
}

module.exports = { createAdmin };
