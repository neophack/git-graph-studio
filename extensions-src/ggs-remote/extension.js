// GGS Remote, the extension (docs/ggs-remote-plan.md §14): installs and starts the tray
// daemon this package carries, keeps its settings in step with the `ggsRemote.*`
// configuration, and shows the Remote Access page — status, links and QR codes (after the
// password unlock, R19), devices, password, certificate and service switches. The daemon
// keeps running when GGS closes; it is the one serving the phone.
'use strict';

const vscode = require('vscode');
const daemon = require('./lib/daemon');
const { createAdmin } = require('./lib/admin');

let admin;
let extensionPath;
let panel;
/** The page's unlock token (5 minutes, in memory only). */
let unlockToken = '';

const SETTING_KEYS = {
	port: 'port',
	bind: 'bind',
	tlsMode: 'tls',
	autostart: 'autostart',
	spawnVisible: 'spawnVisible',
	mdns: 'mdns'
};

function configPatch() {
	const config = vscode.workspace.getConfiguration('ggsRemote');
	const patch = {};
	for (const key of Object.keys(SETTING_KEYS)) {
		const value = config.get(key);
		if (value === undefined) continue;
		if (key === 'tlsMode') {
			const certPath = config.get('tlsCertPath') || null;
			const keyPath = config.get('tlsKeyPath') || null;
			patch.tls = { mode: value, certPath, keyPath };
		} else patch[SETTING_KEYS[key]] = value;
	}
	return patch;
}

async function ensureService() {
	try {
		const result = await daemon.ensureRunning(extensionPath);
		// A daemon that was already running (outcome "current") owns its listener: the
		// activation reads configuration before any frontend has served the stored
		// settings — pushing that (the defaults) would rebind the live daemon off the
		// port every open page is on. User-made changes still land through the
		// configuration-change push; a daemon this activation installed or upgraded is
		// freshly started, and takes the config here.
		if (!result || result.outcome !== 'current') {
			await admin.config(configPatch()).catch(() => undefined);
			await applyHubConfig().catch(() => undefined);
		}
		return result;
	} catch (error) {
		vscode.window.showErrorMessage(`GGS Remote could not start: ${error.message || error}`);
		return null;
	}
}

// The hub settings are the source of truth: a URL points this PC at its relay, an empty one
// keeps it LAN-only (the page's Connect fills the setting, so both roads meet here).
async function applyHubConfig() {
	const config = vscode.workspace.getConfiguration('ggsRemote');
	const url = (config.get('hubUrl') || '').trim();
	const status = await admin.hubStatus();
	if (!url) {
		if (status && status.state !== 'unconfigured') await admin.hubDisconnect();
		return;
	}
	const joinKey = config.get('hubJoinKey') || '';
	const settings = status && status.settings;
	if (settings && settings.url === url && settings.joinKey === joinKey) return;
	await admin.hubConnect(url, joinKey, '');
}

async function firstLink() {
	const status = await admin.status(unlockToken);
	return status && status.link;
}

async function openPairPage() {
	const ticket = await admin.pairTicket();
	if (ticket && ticket.url) await vscode.env.openExternal(vscode.Uri.parse(ticket.url));
}

// ---- the page ----

function pageHtml(webview) {
	const base = vscode.Uri.joinPath(vscode.Uri.file(extensionPath), 'media', 'page');
	const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'page.js'));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'page.css'));
	const nonce = Math.random().toString(36).slice(2);
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
</head>
<body>
<main id="app"></main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

async function answer(message) {
	switch (message.type) {
		case 'status':
			return admin.status(unlockToken);
		case 'unlock': {
			const result = await admin.unlock(message.password);
			unlockToken = result && result.unlock ? result.unlock : '';
			setTimeout(() => {
				unlockToken = '';
			}, 5 * 60 * 1000);
			return admin.status(unlockToken);
		}
		case 'lock':
			unlockToken = '';
			return admin.status('');
		case 'qr':
			return admin.qr(unlockToken, message.text);
		case 'setPassword':
			await admin.setPassword(message.password);
			if (!unlockToken) {
				const result = await admin.unlock(message.password).catch(() => null);
				unlockToken = result && result.unlock ? result.unlock : '';
			}
			return admin.status(unlockToken);
		case 'devices':
			return admin.devices();
		case 'disconnect':
			await admin.removeDevice(message.id);
			return admin.devices();
		case 'signOutAll':
			await admin.signOutAll();
			return admin.devices();
		case 'pause':
			return message.paused ? admin.pause() : admin.resume();
		case 'config':
			return admin.config(message.patch);
		case 'pair':
			await openPairPage();
			return null;
		case 'copy':
			await vscode.env.clipboard.writeText(message.text);
			return null;
		case 'hubStatus':
			return admin.hubStatus();
		case 'hubConnect':
			await vscode.workspace.getConfiguration('ggsRemote').update('hubUrl', message.url, vscode.ConfigurationTarget.Global);
			await vscode.workspace.getConfiguration('ggsRemote').update('hubJoinKey', message.joinKey || '', vscode.ConfigurationTarget.Global);
			return admin.hubConnect(message.url, message.joinKey, message.fingerprint);
		case 'hubDisconnect':
			await vscode.workspace.getConfiguration('ggsRemote').update('hubUrl', '', vscode.ConfigurationTarget.Global);
			return admin.hubDisconnect();
		case 'hubRelink':
			return admin.hubRelink();
		case 'hubExportKey':
			return admin.hubExportKey(message.password);
		case 'hubImportKey':
			return admin.hubImportKey(message.password, message.data);
		case 'restart':
			await admin.shutdown().catch(() => undefined);
			await ensureService();
			return admin.status(unlockToken);
		default:
			throw new Error(`unknown request: ${message.type}`);
	}
}

function showPage() {
	if (panel) {
		panel.reveal();
		return;
	}
	panel = vscode.window.createWebviewPanel('ggsRemote.page', 'Remote Access', vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [vscode.Uri.joinPath(vscode.Uri.file(extensionPath), 'media')]
	});
	panel.webview.html = pageHtml(panel.webview);
	panel.webview.onDidReceiveMessage(async (message) => {
		try {
			const result = await answer(message);
			panel && panel.webview.postMessage({ id: message.id, ok: true, result });
		} catch (error) {
			panel && panel.webview.postMessage({ id: message.id, ok: false, error: String((error && error.message) || error) });
		}
	});
	panel.onDidDispose(() => {
		panel = undefined;
		unlockToken = '';
	});
}

async function activate(context) {
	extensionPath = context.extensionPath;
	admin = createAdmin(extensionPath);
	const register = (id, run) => context.subscriptions.push(vscode.commands.registerCommand(id, run));
	register('ggsRemote.showPage', showPage);
	register('ggsRemote.copyLink', async () => {
		// The link shows only after the unlock (R19): the page asks for the password.
		const link = await firstLink().catch(() => null);
		if (link) {
			await vscode.env.clipboard.writeText(link);
			vscode.window.showInformationMessage(`Copied ${link}`);
		} else showPage();
	});
	register('ggsRemote.pair', () => openPairPage());
	register('ggsRemote.changePassword', () => openPairPage());
	register('ggsRemote.signOutAll', async () => {
		const yes = await vscode.window.showWarningMessage('Sign out every remote device?', { modal: true }, 'Sign Out All');
		if (yes) await admin.signOutAll();
	});
	register('ggsRemote.toggle', async () => {
		const status = await admin.status('');
		await (status && status.paused ? admin.resume() : admin.pause());
	});
	register('ggsRemote.restartService', async () => {
		await admin.shutdown().catch(() => undefined);
		await ensureService();
	});
	register('ggsRemote.uninstallService', async () => {
		const yes = await vscode.window.showWarningMessage(
			'Stop the GGS Remote background service and remove its login start? Your password and certificates stay.',
			{ modal: true },
			'Uninstall'
		);
		if (!yes) return;
		await admin.config({ autostart: false }).catch(() => undefined);
		await admin.shutdown().catch(() => undefined);
	});
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('ggsRemote')) void admin.config(configPatch()).catch((error) => vscode.window.showErrorMessage(`GGS Remote: ${error.message || error}`));
		})
	);
	await ensureService();
}

function deactivate() {
	// The daemon keeps running: it serves the phone whether or not a GGS window is open.
}

module.exports = { activate, deactivate };
