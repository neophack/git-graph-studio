// The Remote Access page (docs/ggs-remote-plan.md §14.3): status, then — only after the
// access password unlocks it (R19) — this PC's links with their QR codes; the devices
// signed in, the password, the certificate to install on a phone, and the service switches.
// Every request goes to extension.js, which answers through the daemon's admin API.
(function () {
	'use strict';
	const vscode = acquireVsCodeApi();
	const zh = (navigator.language || '').toLowerCase().startsWith('zh');
	const L = (en, cn) => (zh ? cn : en);
	const app = document.getElementById('app');
	let nextId = 1;
	const pending = new Map();

	window.addEventListener('message', (event) => {
		const message = event.data;
		const waiter = message && pending.get(message.id);
		if (!waiter) return;
		pending.delete(message.id);
		if (message.ok) waiter.resolve(message.result);
		else waiter.reject(new Error(message.error));
	});

	function request(type, extra) {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			vscode.postMessage(Object.assign({ id, type }, extra || {}));
		});
	}

	function el(tag, props, ...children) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(props || {})) {
			if (key === 'class') node.className = value;
			else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
			else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
		}
		for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
		return node;
	}

	function section(title, ...children) {
		return el('section', { class: 'card' }, el('h2', {}, title), ...children);
	}

	function ago(secs) {
		if (!secs) return L('never', '从未');
		const d = Math.max(0, Date.now() / 1000 - secs);
		if (d < 90) return `${Math.round(d)} s`;
		if (d < 5400) return `${Math.round(d / 60)} min`;
		return `${Math.round(d / 3600)} h`;
	}

	function passwordForm(label, button, onSubmit) {
		const input = el('input', { type: 'password', autocomplete: 'current-password', required: true });
		const error = el('p', { class: 'error' });
		const form = el('form', {}, el('label', {}, label), input, el('button', { class: 'primary' }, button), error);
		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			error.textContent = '';
			try {
				await onSubmit(input.value);
			} catch (e) {
				error.textContent = String(e.message || e);
			}
		});
		return form;
	}

	async function qrImage(text) {
		const svg = await request('qr', { text }).catch(() => null);
		if (!svg || typeof svg !== 'string') return el('div', { class: 'qr missing' });
		return el('img', { class: 'qr', alt: text, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
	}

	async function devicesList() {
		const list = el('ul', { class: 'devices' });
		const fill = (result) => {
			const devices = (result && result.devices) || [];
			list.replaceChildren(
				...(devices.length
					? devices.map((d) =>
							el(
								'li',
								{},
								el('span', {}, d.device),
								el('span', { class: 'muted' }, d.ip),
								el('span', { class: 'spacer' }),
								el('button', { onclick: async () => fill(await request('disconnect', { id: d.id })) }, L('Disconnect', '断开'))
							)
						)
					: [el('li', { class: 'muted' }, L('No device is signed in.', '没有已登录的设备。'))])
			);
		};
		fill(await request('devices').catch(() => null));
		return el(
			'div',
			{},
			list,
			el('button', { class: 'danger', onclick: async () => fill(await request('signOutAll')) }, L('Sign out all devices', '全部断开'))
		);
	}

	function toggle(label, checked, onChange) {
		const box = el('input', { type: 'checkbox' });
		box.checked = Boolean(checked);
		box.addEventListener('change', () => onChange(box.checked));
		return el('label', { class: 'check' }, box, ' ', label);
	}

	async function hubSection(status) {
		const hub = status.hub || { state: 'unconfigured' };
		const state = hub.state;
		const line = {
			unconfigured: L('Not connected to a relay.', '未连接中继服务器。'),
			'no-password': L('Set the access password first.', '请先设置访问密码。'),
			connecting: `${L('Connecting to', '正在连接')} ${hub.url || ''}`,
			online: `${L('Online', '在线')} — ${hub.publicBase || ''}`,
			rejected: `${L('Refused', '被拒绝')} (${hub.reason || ''})`,
			replaced: L('This PC’s key connected from elsewhere.', '此 PC 的密钥在别处连接了。')
		}[state] || state;
		const children = [el('p', {}, line)];
		if (state === 'online' && status.unlocked && hub.publicBase) {
			children.push(
				el('div', { class: 'link' }, await qrImage(hub.publicBase), el('code', {}, hub.publicBase), el('button', { onclick: () => request('copy', { text: hub.publicBase }) }, L('Copy', '复制')))
			);
		}
		const urlInput = el('input', { type: 'text', placeholder: 'https://remote.example.com', value: (hub.settings && hub.settings.url) || '' });
		const keyInput = el('input', { type: 'password', placeholder: L('server password (optional)', '服务器口令（可选）'), value: (hub.settings && hub.settings.joinKey) || '' });
		const error = el('p', { class: 'error' });
		children.push(
			el('form', {},
				el('label', {}, L('Relay server address or connect string', '中继服务器地址或连接串')),
				urlInput, ' ', keyInput, ' ',
				el('button', { class: 'primary', onclick: async (event) => {
					event.preventDefault();
					error.textContent = '';
					try {
						const result = await request('hubConnect', { url: urlInput.value.trim(), joinKey: keyInput.value });
						render({ ...status, hub: result && result.state ? result : hub });
					} catch (e) {
						error.textContent = String(e.message || e);
					}
				} }, L('Connect', '连接')),
				error
			),
			el('p', { class: 'muted' }, L('A relay of your own (ggs-remote-hub) carries this PC’s link through NAT; the access password still applies, the link is per-PC and cannot be guessed.', '自建的中继服务器（ggs-remote-hub）把此 PC 的链接带出内网；访问密码不变，链接每台 PC 独有、无法猜测。'))
		);
		if (state !== 'unconfigured') {
			children.push(el('div', { class: 'row' },
				el('button', { onclick: async () => render({ ...status, hub: await request('hubDisconnect') }) }, L('Disconnect', '断开')),
				el('button', { onclick: async () => {
					if (!window.confirm(L('Change this PC’s link? The old one stops working immediately.', '更换此 PC 的链接？旧链接立即失效。'))) return;
					await request('hubRelink').catch(() => undefined);
					render({ ...status, hub: await request('hubStatus').catch(() => hub) });
				} }, L('Change link', '更换链接'))
			));
			children.push(keyTools());
		}
		return section(L('Reach this PC from anywhere (relay)', '从任何地方访问此 PC（中继）'), ...children);
	}

	function keyTools() {
		const out = el('p', { class: 'muted' });
		const exportForm = passwordForm(L('Access password'), L('Export device key', '导出设备密钥'), async (password) => {
			const result = await request('hubExportKey', { password });
			out.textContent = '';
			out.append(el('code', {}, result && result.data || ''), ' ', el('button', { onclick: () => request('copy', { text: result.data }) }, L('Copy', '复制')));
		});
		const importForm = passwordForm(L('Access password of the export'), L('Import device key', '导入设备密钥'), async (password) => {
			const blob = window.prompt(L('Paste the exported key', '粘贴导出的密钥'));
			if (blob) await request('hubImportKey', { password, data: blob });
		});
		const wrap = el('details', {}, el('summary', { class: 'muted' }, L('Carry the link to another PC (export / import the device key)', '把链接带到另一台 PC（导出 / 导入设备密钥）')), exportForm, importForm, out);
		return wrap;
	}

	async function render(status) {
		if (!status) {
			try {
				status = await request('status');
			} catch (e) {
				app.replaceChildren(section(L('Remote Access', '远程访问'), el('p', { class: 'error' }, String(e.message || e)), el('button', { onclick: () => request('restart').then(render) }, L('Start the background service', '启动后台服务'))));
				return;
			}
		}
		const config = status.config || {};
		const head = section(
			L('Remote Access', '远程访问'),
			el(
				'p',
				{},
				status.paused ? L('Paused', '已暂停') : status.listening ? L('Listening', '监听中') : L('Not listening', '未监听'),
				` · ${L('port', '端口')} ${status.port} · ${L('remote sessions', '远程会话')} ${status.sessions} · ${L('windows', '窗口')} ${status.instances}`
			),
			el('p', { class: 'muted' }, L('Anyone with the password can do on this PC whatever you can — including running commands in a terminal. Share it only with people you trust.', '知道密码的人可以在这台 PC 上做你能做的一切——包括在终端里执行命令。只把密码告诉可信的人。'))
		);
		const parts = [head];
		if (!status.passwordSet) {
			parts.push(
				section(
					L('Set the access password', '设置访问密码'),
					passwordForm(L('New password (8+ characters)', '新密码（至少 8 个字符）'), L('Set password', '设置密码'), async (password) => render(await request('setPassword', { password })))
				)
			);
		} else if (!status.unlocked) {
			parts.push(
				section(
					L('Links and QR codes', '链接与二维码'),
					el('p', {}, L('Enter the access password to show this PC’s links.', '输入访问密码后显示此 PC 的链接。')),
					passwordForm(L('Access password', '访问密码'), L('Unlock', '解锁'), async (password) => render(await request('unlock', { password })))
				)
			);
		} else {
			const links = el('div', { class: 'links' });
			for (const link of status.links || []) {
				links.append(el('div', { class: 'link' }, await qrImage(link), el('code', {}, link), el('button', { onclick: () => request('copy', { text: link }) }, L('Copy', '复制'))));
			}
			parts.push(
				section(
					L('Links and QR codes', '链接与二维码'),
					links,
					el('p', { class: 'muted' }, status.lastForeignAccess ? `${L('Last remote access', '最近外来访问')}: ${ago(status.lastForeignAccess)}` : L('No other device has reached this PC yet. If a phone cannot connect, allow “ggs-remote” through the firewall for private networks.', '还没有其他设备访问过此 PC。若手机连不上，请在防火墙中允许 “ggs-remote” 访问专用网络。')),
					el('div', { class: 'row' }, el('button', { onclick: () => request('pair') }, L('Open the pairing page in the browser', '在浏览器中打开配对页')), el('button', { onclick: () => request('lock').then(render) }, L('Lock', '锁定')))
				)
			);
			if (status.tls && status.tls.mode === 'self-signed') {
				const first = (status.links || [])[0];
				parts.push(
					section(
						L('Trust this PC (once per device)', '信任此 PC（每台设备一次）'),
						el('p', {}, L('Install the certificate on the phone so the browser trusts the connection. Fingerprint:', '在手机上安装证书，浏览器才会信任连接。指纹：'), ' ', el('code', {}, status.tls.caFingerprint || '')),
						first ? el('p', {}, el('code', {}, `${first}ca.mobileconfig`), ' — iOS · ', el('code', {}, `${first}ca.crt`), ' — Android / desktop') : null,
						el('p', { class: 'muted' }, L('iOS: install the profile, then enable it under Settings → General → About → Certificate Trust Settings.', 'iOS：安装描述文件后，在“设置 → 通用 → 关于本机 → 证书信任设置”中开启。'))
					)
				);
			}
			parts.push(
				section(
					L('Change password', '修改密码'),
					passwordForm(L('New password', '新密码'), L('Save', '保存'), async (password) => render(await request('setPassword', { password })))
				)
			);
		}
		parts.push(section(L('Signed-in devices', '已登录的设备'), await devicesList()));
		parts.push(await hubSection(status));
		parts.push(
			section(
				L('Service', '服务'),
				toggle(L('Pause remote access', '暂停远程访问'), status.paused, (on) => request('pause', { paused: on }).then(() => render())),
				toggle(L('Start at login', '开机启动'), config.autostart, (on) => request('config', { patch: { autostart: on } })),
				toggle(L('Windows opened remotely also show on this desktop', '远程打开的窗口也在桌面显示'), config.spawnVisible, (on) => request('config', { patch: { spawnVisible: on } })),
				el('p', { class: 'muted' }, `GGS Remote ${status.version} · ${Math.round((status.rss || 0) / 1048576)} MB`),
				el('button', { onclick: () => request('restart').then(render) }, L('Restart the background service', '重启后台服务'))
			)
		);
		app.replaceChildren(...parts);
	}

	render();
})();
