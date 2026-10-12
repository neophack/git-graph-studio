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

	/** A modal popup — the sandboxed webview swallows `alert()`, and a wrong password is
	 *  too easy to miss as an inline line (the owner's direction, 2026-10-12). */
	function popup(text) {
		const overlay = el(
			'div',
			{ class: 'popup-overlay' },
			el(
				'div',
				{ class: 'popup' },
				el('p', {}, String(text)),
				el('button', { class: 'primary', onclick: () => overlay.remove() }, 'OK')
			)
		);
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) overlay.remove();
		});
		document.body.append(overlay);
	}

	/** The compact one-line password form (flat and VS Code-shaped, 2026-10-12): the label
	 *  rides as the input's placeholder and aria-label, the button shares the row. */
	function passwordForm(label, button, onSubmit) {
		const input = el('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: label, 'aria-label': label });
		const error = el('p', { class: 'error' });
		const form = el('form', { class: 'pw-row' }, input, el('button', { class: 'primary' }, button), error);
		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			error.textContent = '';
			try {
				await onSubmit(input.value);
			} catch (e) {
				error.textContent = String(e.message || e);
				popup(e.message || e);
			}
		});
		return form;
	}

	async function qrImage(text) {
		const svg = await request('qr', { text }).catch(() => null);
		if (!svg || typeof svg !== 'string') return el('div', { class: 'qr missing' });
		return el('img', { class: 'qr', alt: text, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
	}

	/** Re-fetch the status shortly after an action that the daemon completes asynchronously
	 *  (the hub tunnel coming online once the password lands). */
	function refreshSoon() {
		setTimeout(() => render(), 1500);
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

	/** The security sandbox (§24): remote sessions drive OS-sandboxed windows. The
	 * status carries what this host can enforce (status.sandbox), the config carries
	 * what is asked for; the intranet level says when the host degrades it to off. */
	async function sandboxSection(status, config) {
		const sb = status.sandbox || {};
		const cfg = config.sandbox || {};
		const patch = (sandbox) => request('config', { patch: { sandbox } }).then(() => render());
		const select = el('select');
		for (const [value, label] of [
			['off', L('No network (offline)', '断网（无网络）')],
			['intranet', L('Intranet only (private ranges)', '仅内网（私网地址段）')],
			['internet', L('Internet + intranet', '外网 + 内网')],
		]) {
			const option = el('option', { value }, label);
			if ((cfg.network || 'internet') === value) option.selected = true;
			if (value === 'intranet' && sb.intranetSupported === false) {
				option.disabled = true;
				option.textContent += L(' — not on this computer', ' — 此电脑不支持');
			}
			select.append(option);
		}
		select.addEventListener('change', () =>
			patch({ enabled: Boolean(cfg.enabled), network: select.value, root: cfg.root || null })
		);
		const rootInput = el('input', {
			type: 'text',
			placeholder: sb.root || '',
			value: cfg.root || '',
			'aria-label': L('Sandbox root folder', '沙箱根目录'),
		});
		const notes = [
			L(
				'While the sandbox is on, a remote session sees and drives sandboxed windows only; the folders it opens live under the sandbox root, and neither this PC’s ~/.ggs (settings, AI provider keys, Claude state) nor the rest of the disk is readable from inside. Enforcing engine: the Microsoft eXecution Container (mxc).',
				'沙箱开启时，远程会话只能看到和操作沙箱窗口；打开的目录都在沙箱根之下，沙箱内读不到此 PC 的 ~/.ggs（设置、AI 供应商密钥、Claude 状态）和磁盘其余内容。执行引擎：Microsoft eXecution Container（mxc）。'
			),
			L(
				'Honest limits: environment variables are inherited, and an agent’s build tools (npm, cargo…) run with the network level set here. A sandboxed window has its own empty settings, extensions and AI providers — configure them inside it.',
				'如实说明：环境变量会被继承；智能体的构建工具（npm、cargo…）按此处设置的网络级别联网。沙箱窗口有自己的空白设置、扩展和 AI 供应商——需在沙箱内配置。'
			),
		];
		if (sb.supported === false) {
			notes.unshift(
				el('strong', {}, L('This computer cannot run the sandbox: ', '此电脑无法运行沙箱：'), (sb.reason || '').toString())
			);
		}
		if (sb.degraded) {
			notes.unshift(
				el('strong', {}, L('This computer’s sandbox cannot express “intranet only” — the level is enforced as no network.', '此电脑的沙箱无法表达“仅内网”——该档位按断网执行。'))
			);
		}
		return section(
			L('Security sandbox', '安全沙箱'),
			toggle(L('Remote sessions drive sandboxed windows only', '远程会话只操作沙箱窗口'), Boolean(cfg.enabled), (on) =>
				patch({ enabled: on, network: cfg.network || 'internet', root: cfg.root || null })
			),
			el('label', { class: 'check' }, select, ' ', L('Network access of a sandboxed window', '沙箱窗口的网络访问')),
			el('div', { class: 'row' },
				rootInput,
				el('button', {
					onclick: () => patch({ enabled: Boolean(cfg.enabled), network: cfg.network || 'internet', root: rootInput.value.trim() || null }),
				}, L('Set root', '设置根目录'))
			),
			el('p', { class: 'muted' }, L('Sandbox root: ', '沙箱根目录：'), el('code', {}, sb.root || '')),
			sb.tier ? el('p', { class: 'muted' }, `${L('Sandbox backend', '沙箱后端')}: ${sb.backend} (${sb.tier})`) : null,
			...notes.map((note) => el('p', { class: 'muted' }, note))
		);
	}

	function toggle(label, checked, onChange) {
		const box = el('input', { type: 'checkbox' });
		box.checked = Boolean(checked);
		box.addEventListener('change', () => onChange(box.checked));
		return el('label', { class: 'check' }, box, ' ', label);
	}

	function hubStateLine(hub) {
		const state = hub && hub.state;
		return (
			{
				unconfigured: L('Not connected to a relay.', '未连接中继服务器。'),
				'no-password': L('Saved. It connects once the access password is set.', '已保存。设置访问密码后自动连接。'),
				connecting: `${L('Connecting to', '正在连接')} ${(hub && hub.url) || ''}`,
				online: `${L('Online', '在线')} — ${(hub && hub.publicBase) || ''}`,
				rejected: `${L('Refused', '被拒绝')} (${(hub && hub.reason) || ''})`,
				replaced: L('This PC’s key connected from elsewhere.', '此 PC 的密钥在别处连接了。')
			}[state] || String(state || '')
		);
	}

	/** The relay server configuration: shown on the password screens (where it is first
	 *  needed) and in the relay section below. Saving persists it; with no password set yet
	 *  the daemon holds it until the password lands, then connects. */
	function serverForm(status, buttonLabel) {
		const hub = status.hub || {};
		const settings = hub.settings || {};
		const urlInput = el('input', { type: 'text', placeholder: 'https://remote.example.com', value: settings.url || '' });
		const keyInput = el('input', { type: 'password', placeholder: L('server password (optional)', '服务器口令（可选）'), value: settings.joinKey || '' });
		const error = el('p', { class: 'error' });
		return el(
			'form',
			{},
			el('label', {}, L('Relay server address or connect string', '中继服务器地址或连接串')),
			urlInput,
			' ',
			keyInput,
			' ',
			el(
				'button',
				{ class: 'primary', onclick: async (event) => {
					event.preventDefault();
					error.textContent = '';
					try {
						const result = await request('hubConnect', { url: urlInput.value.trim(), joinKey: keyInput.value });
						// hubStatus answers with the settings too, so the form keeps what it saved.
						render({ ...status, hub: await request('hubStatus').catch(() => result) });
						refreshSoon();
					} catch (e) {
						error.textContent = String(e.message || e);
					}
				} },
				buttonLabel || L('Connect', '连接')
			),
			error,
			el('p', { class: 'muted' }, hubStateLine(hub))
		);
	}

	async function hubSection(status) {
		const hub = status.hub || { state: 'unconfigured' };
		const children = [
			el('p', {}, hubStateLine(hub)),
			serverForm(status),
			el('p', { class: 'muted' }, L('A relay of your own (ggs-remote-hub) carries this PC’s link through NAT; the access password still applies, the link is per-PC and cannot be guessed. While it is set and online, only its QR code is shown above — the LAN codes hide.', '自建的中继服务器（ggs-remote-hub）把此 PC 的链接带出内网；访问密码不变，链接每台 PC 独有、无法猜测。设置并在线时，上方只显示它的二维码——局域网的会隐藏。'))
		];
		if (hub.state !== 'unconfigured') {
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
					passwordForm(L('New password (8+ characters)', '新密码（至少 8 个字符）'), L('Set password', '设置密码'), async (password) => {
						render(await request('setPassword', { password }));
						refreshSoon();
					}),
					el('p', { class: 'muted' }, L('A relay server (ggs-remote-hub) is optional: with one the phone works from any network. While it is set and online, only its QR code is shown below — the LAN codes hide.', '中继服务器（ggs-remote-hub）是可选的：配置后手机在任何网络都能访问。设置并在线时，下方只显示中继的二维码——局域网的二维码会隐藏。')),
					serverForm(status, L('Save server', '保存服务器'))
				)
			);
		} else if (!status.unlocked) {
			parts.push(
				section(
					L('Links and QR codes', '链接与二维码'),
					el('p', {}, L('Enter the access password to show this PC’s links.', '输入访问密码后显示此 PC 的链接。')),
					passwordForm(L('Access password', '访问密码'), L('Unlock', '解锁'), async (password) => render(await request('unlock', { password }))),
					el('p', { class: 'muted' }, L('A relay server (ggs-remote-hub) is optional: with one the phone works from any network. While it is set and online, only its QR code is shown below — the LAN codes hide.', '中继服务器（ggs-remote-hub）是可选的：配置后手机在任何网络都能访问。设置并在线时，下方只显示中继的二维码——局域网的二维码会隐藏。')),
					serverForm(status, L('Save server', '保存服务器'))
				)
			);
		} else {
			const hubBase = status.hub && status.hub.state === 'online' && status.hub.publicBase;
			const links = el('div', { class: 'links' });
			for (const link of status.links || []) {
				links.append(
					el(
						'div',
						{ class: 'link' },
						hubBase && link === hubBase ? el('span', { class: 'tag' }, L('Server', '服务器')) : null,
						await qrImage(link),
						el('code', {}, link),
						el('button', { onclick: () => request('copy', { text: link }) }, L('Copy', '复制'))
					)
				);
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
				const first = (status.lanLinks || status.links || [])[0];
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
		parts.push(await sandboxSection(status, config));
		parts.push(
			section(
				L('Service', '服务'),
				toggle(L('Pause remote access', '暂停远程访问'), status.paused, (on) => request('pause', { paused: on }).then(() => render())),
				toggle(L('Start at login', '开机启动'), config.autostart, (on) => request('config', { patch: { autostart: on } })),
				toggle(L('Windows opened remotely also show on this desktop', '远程打开的窗口也在桌面显示'), config.spawnVisible, (on) => request('config', { patch: { spawnVisible: on } })),
				toggle(L('Folder input on the window page', '窗口页显示路径输入框'), config.folderInput, (on) => request('config', { patch: { folderInput: on } })),
				el('p', { class: 'muted' }, `GGS Remote ${status.version} · ${Math.round((status.rss || 0) / 1048576)} MB`),
				el('button', { onclick: () => request('restart').then(render) }, L('Restart the background service', '重启后台服务'))
			)
		);
		app.replaceChildren(...parts);
	}

	render();
})();
