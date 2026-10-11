// The daemon pages' strings (en / zh-cn), picked from the browser language. Plain ES module,
// no build step (docs/ggs-remote-plan.md §5 web/).
const STRINGS = {
	en: {
		title: 'Git Graph Studio Remote',
		password: 'Access password',
		remember: 'Keep me signed in on this device (30 days)',
		device: 'Device name (optional)',
		signIn: 'Sign in',
		wrongPassword: 'Wrong password.',
		locked: 'Too many attempts. Try again in {n} s.',
		failed: 'Sign-in failed: {msg}',
		'reason.password-changed': 'The password was changed. Please sign in again.',
		'reason.credentials-changed': 'The password was changed. Please sign in again.',
		'reason.revoked': 'This device was signed out.',
		'reason.expired': 'Your session expired. Please sign in again.',
		'reason.link-changed': 'The link of this PC changed.',
		windows: 'Windows on this PC',
		noWindows: 'No Git Graph Studio window is running.',
		newWindow: 'New window',
		folderOptional: 'Folder to open (optional)',
		open: 'Open',
		close: 'Close',
		restart: 'Restart',
		details: 'Contents',
		unresponsive: 'Not responding',
		hidden: 'Not on the desktop',
		sessions: '{n} remote',
		terminals: '{n} terminals',
		unsaved: '{n} unsaved',
		changes: '{n} changes',
		noTabs: 'No open editors',
		uptime: 'up {t}',
		closeBlocked: 'These files have unsaved changes:\n\n{files}\n\nClose anyway and lose them?',
		restartConfirm: 'Restart this window? Unsaved changes will be lost.',
		spawnFailed: 'Could not open a new window: {msg}',
		restartFailed: 'Could not restart: {msg}',
		autoEnter: 'Enter automatically when only one window runs',
		settings: 'This device',
		signOut: 'Sign out',
		changePassword: 'Change password',
		currentPassword: 'Current password',
		newPassword: 'New password',
		save: 'Save',
		devices: 'Signed-in devices',
		thisDevice: 'this device',
		disconnect: 'Disconnect',
		connecting: 'Connecting…',
		reconnecting: 'Connection lost — reconnecting…',
		weak: 'Choose a stronger password (8+ characters, not a common one).',
		saved: 'Saved.',
		'notice.paused': 'Remote access is paused on this PC.',
		'notice.no-password': 'Set an access password on the PC first (GGS Remote tray menu → Change Password, or the Remote Access page in Git Graph Studio).',
		retrying: 'This page retries every 15 seconds.',
		pairTitle: 'Pair a phone or another computer',
		pairLocked: 'Enter the access password to show the links and QR codes.',
		unlock: 'Unlock',
		setFirst: 'Set the access password for remote access.',
		setPassword: 'Set password',
		links: 'Scan one of these from the phone (same network):',
		caTitle: 'Trust this PC (once per device)',
		caText: 'Install the certificate so the browser trusts the connection. Fingerprint:',
		caIos: 'iPhone / iPad profile',
		caOther: 'Certificate (Android, desktop)',
		caIosSteps: 'iOS: install the profile, then enable it under Settings → General → About → Certificate Trust Settings.',
		firewall: 'No other device has reached this PC yet. If the phone cannot connect, allow “ggs-remote” through the firewall for private networks.',
		lastForeign: 'Last remote access: {t}',
		never: 'never',
		relocked: 'Locked again after 5 minutes.',
		warning: 'Anyone with the password can do on this PC whatever you can — including running commands in a terminal. Share it only with people you trust.'
	},
	'zh-cn': {
		title: 'Git Graph Studio 远程访问',
		password: '访问密码',
		remember: '在此设备上保持登录（30 天）',
		device: '设备名称（可选）',
		signIn: '登录',
		wrongPassword: '密码错误。',
		locked: '尝试次数过多，请 {n} 秒后再试。',
		failed: '登录失败：{msg}',
		'reason.password-changed': '密码已更新，请重新登录。',
		'reason.credentials-changed': '密码已更新，请重新登录。',
		'reason.revoked': '此设备已被断开。',
		'reason.expired': '会话已过期，请重新登录。',
		'reason.link-changed': '此 PC 的链接已更换。',
		windows: '此 PC 上的窗口',
		noWindows: '没有正在运行的 Git Graph Studio 窗口。',
		newWindow: '新窗口',
		folderOptional: '要打开的文件夹（可选）',
		open: '打开',
		close: '关闭',
		restart: '重启',
		details: '内容',
		unresponsive: '无响应',
		hidden: '未在桌面显示',
		sessions: '{n} 个远程',
		terminals: '{n} 个终端',
		unsaved: '{n} 个未保存',
		changes: '{n} 个变更',
		noTabs: '没有打开的编辑器',
		uptime: '已运行 {t}',
		closeBlocked: '以下文件有未保存的修改：\n\n{files}\n\n仍要关闭并丢弃这些修改吗？',
		restartConfirm: '重启此窗口？未保存的修改将丢失。',
		spawnFailed: '无法打开新窗口：{msg}',
		restartFailed: '无法重启：{msg}',
		autoEnter: '只有一个窗口时自动进入',
		settings: '此设备',
		signOut: '退出登录',
		changePassword: '修改密码',
		currentPassword: '当前密码',
		newPassword: '新密码',
		save: '保存',
		devices: '已登录的设备',
		thisDevice: '本设备',
		disconnect: '断开',
		connecting: '正在连接…',
		reconnecting: '连接已断开，正在重连…',
		weak: '请设置更强的密码（至少 8 个字符，且不是常见密码）。',
		saved: '已保存。',
		'notice.paused': '此 PC 已暂停远程访问。',
		'notice.no-password': '请先在 PC 上设置访问密码（GGS Remote 托盘菜单 → 修改密码，或 Git Graph Studio 的“远程访问”页面）。',
		retrying: '此页面每 15 秒自动重试。',
		pairTitle: '配对手机或其他电脑',
		pairLocked: '输入访问密码后显示链接与二维码。',
		unlock: '解锁',
		setFirst: '请设置远程访问密码。',
		setPassword: '设置密码',
		links: '在同一网络下用手机扫描其中一个：',
		caTitle: '信任此 PC（每台设备一次）',
		caText: '安装证书后浏览器才会信任连接。指纹：',
		caIos: 'iPhone / iPad 描述文件',
		caOther: '证书（Android、桌面）',
		caIosSteps: 'iOS：安装描述文件后，在“设置 → 通用 → 关于本机 → 证书信任设置”中开启。',
		firewall: '还没有其他设备访问过此 PC。若手机连不上，请在防火墙中允许 “ggs-remote” 访问专用网络。',
		lastForeign: '最近外来访问：{t}',
		never: '从未',
		relocked: '5 分钟后已重新上锁。',
		warning: '知道密码的人可以在这台 PC 上做你能做的一切——包括在终端里执行命令。只把密码告诉可信的人。'
	}
};

const lang = (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';

export function t(key, vars) {
	let text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
	for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
	return text;
}

/** Fill every `[data-i18n]` element's text. */
export function translate(root = document) {
	document.documentElement.lang = lang === 'zh-cn' ? 'zh-CN' : 'en';
	for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
	for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}

export function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === 'class') node.className = value;
		else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
		else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
	}
	for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
	return node;
}

export async function postJson(url, body) {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'same-origin',
		body: JSON.stringify(body ?? {})
	});
	let data = null;
	try {
		data = await response.json();
	} catch {
		data = null;
	}
	return { ok: response.ok, status: response.status, data };
}
