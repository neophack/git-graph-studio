// The display-language layer. Strings are keyed; `t(key)` resolves against the current locale
// (English by default) and falls back to the English text - and then to the key itself - so a
// missing translation never renders as a blank. `setLocale` just switches the table; callers
// that already rendered listen for the settings event and re-render.

export type Locale = 'en' | 'zh-cn';

import { en } from './i18n/en';
import { zhCn } from './i18n/zh-cn';

const TABLES: Record<Locale, typeof en> = { en, 'zh-cn': zhCn };

export const LOCALES: { id: Locale; label: string }[] = [
	{ id: 'en', label: 'English' },
	{ id: 'zh-cn', label: '中文（简体）' }
];

// Chinese labels for the command registry's English titles and categories, keyed by the English
// text. Registrations keep their English strings (they double as stable keys) and the display
// layer - menu items, the command palette - resolves them through this table, so a switch of
// locale relabels every entry point without re-registering anything.
const zhCnText: Record<string, string> = {
	'Run Module Self-Tests': '运行模块自测试',
	'Manage Model Providers': '管理模型供应商',
	AI: 'AI',
	'Show Extension Host Log': '显示扩展宿主日志',
	'Open Extension Host Log File': '打开扩展宿主日志文件',
	File: '文件',
	Edit: '编辑',
	// VS Code's Chinese language pack keeps the "Git" category name as-is.
	Git: 'Git',
	Selection: '选择',
	View: '查看',
	Go: '转到',
	Terminal: '终端',
	Preferences: '首选项',
	Help: '帮助',
	Extensions: '扩展',
	Analysis: '分析',
	'Module Analysis': '模块分析',
	'MCP Server': 'MCP 服务器',
	'Complexity & Hotspots': '复杂度与热点',
	'Dead Code': '死代码',
	'Security Scan': '安全扫描',
	'Import Graph': '导入依赖图',
	'Open Folder...': '打开文件夹...',
	'Open Workspace...': '打开工作区...',
	'Open File...': '打开文件...',
	'Open Recent': '打开最近的文件夹',
	'Clear Recently Opened': '清除最近打开的文件夹',
	'Close Folder': '关闭文件夹',
	'New File...': '新建文件...',
	'New Window': '新建窗口',
	Save: '保存',
	'Save All': '全部保存',
	'Close Editor': '关闭编辑器',
	'Close All Editors': '关闭所有编辑器',
	Close: '关闭',
	'Close Others': '关闭其他',
	'Close to the Right': '关闭到右侧',
	'Close Saved': '关闭已保存',
	'Close All': '全部关闭',
	'Copy Path': '复制路径',
	'Copy Relative Path': '复制相对路径',
	'Split Editor': '拆分编辑器',
	'Split Editor Down': '向下拆分编辑器',
	'Split Editor Orthogonal': '正交拆分编辑器',
	'Split Editor Left': '向左拆分编辑器',
	'Split Editor Right': '向右拆分编辑器',
	'Split Editor Up': '向上拆分编辑器',
	'Focus First Editor Group': '聚焦第一个编辑器组',
	'Focus Second Editor Group': '聚焦第二个编辑器组',
	'Focus Third Editor Group': '聚焦第三个编辑器组',
	'Focus Fourth Editor Group': '聚焦第四个编辑器组',
	'Focus Fifth Editor Group': '聚焦第五个编辑器组',
	'Focus Sixth Editor Group': '聚焦第六个编辑器组',
	'Focus Seventh Editor Group': '聚焦第七个编辑器组',
	'Focus Eighth Editor Group': '聚焦第八个编辑器组',
	'Focus Last Editor Group': '聚焦最后一个编辑器组',
	'Focus Next Editor Group': '聚焦下一个编辑器组',
	'Focus Previous Editor Group': '聚焦上一个编辑器组',
	'Focus Editor Group Above': '聚焦上方编辑器组',
	'Focus Editor Group Below': '聚焦下方编辑器组',
	'Focus Editor Group on the Left': '聚焦左侧编辑器组',
	'Focus Editor Group on the Right': '聚焦右侧编辑器组',
	'Move Editor into Group': '将编辑器移入组',
	'Move Editor into Next Group': '将编辑器移入下一组',
	'Move Editor into Previous Group': '将编辑器移入上一组',
	'Move Editor into Left Group': '将编辑器移入左侧组',
	'Move Editor into Right Group': '将编辑器移入右侧组',
	'Move Editor into Above Group': '将编辑器移入上方组',
	'Move Editor into Below Group': '将编辑器移入下方组',
	'Even Editor Group Widths': '平分编辑器组宽度',
	'Toggle Maximized Editor Group': '切换编辑器组最大化',
	'Minimize Other Editor Groups': '最小化其他编辑器组',
	'Join All Editor Groups': '合并所有编辑器组',
	'Reset Editor Groups': '重置编辑器组',
	'Close All Editors in Group': '关闭组内所有编辑器',
	'Close Editors in Other Groups': '关闭其他组中的编辑器',
	'Lock Editor Group': '锁定编辑器组',
	'Unlock Editor Group': '解锁编辑器组',
	'Reopen Closed Editor': '重新打开关闭的编辑器',
	'Editor Layout': '编辑器布局',
	Appearance: '外观',
	'Primary Side Bar': '主侧边栏',
	Panel: '面板',
	Settings: '设置',
	Exit: '退出',
	Undo: '撤销',
	Redo: '重做',
	Cut: '剪切',
	Copy: '复制',
	Paste: '粘贴',
	Find: '查找',
	Replace: '替换',
	'Replace in Files': '在文件中替换',
	'Select All': '全选',
	'Change All Occurrences': '更改所有出现',
	'Remove Bookmark': '移除书签',
	'Go to File...': '转到文件...',
	'Go to Line/Column...': '转到行/列...',
	'Command Palette...': '命令面板...',
	'Go Back': '后退',
	'Go Forward': '前进',
	'Go to Definition': '转到定义',
	'Next Editor': '下一个编辑器',
	'Previous Editor': '上一个编辑器',
	Explorer: '资源管理器',
	Search: '搜索',
	'Source Control': '源代码管理',
	'Compare Two Folders...': '比较两个文件夹...',
	'Compare Two Folders': '比较两个文件夹',
	'Compare Two Files': '比较两个文件',
	'Copy Left → Right': '从左复制到右',
	'Copy Right → Left': '从右复制到左',
	'Delete Left File': '删除左侧文件',
	'Delete Right File': '删除右侧文件',
	'Open to the Right': '在右侧打开',
	'Open to the Left': '在左侧打开',
	'Open Below': '在下方打开',
	'Open Above': '在上方打开',
	'Open in Hex Viewer': '在十六进制查看器中打开',
	'New Folder...': '新建文件夹...',
	'Reveal in File Explorer': '在文件资源管理器中显示',
	'Open in Integrated Terminal': '在集成终端中打开',
	'Rename...': '重命名...',
	Delete: '删除',
	'Go to Symbol in File...': '转到文件中的符号...',
	'Go to Symbol in Workspace...': '转到工作区中的符号...',
	'Find References': '查找引用',
	'Show Call Tree': '显示调用树',
	'Format Document': '格式化文档',
	'Editor': '编辑器',
	'Toggle Bookmark': '切换书签',
	'List Bookmarks': '列出书签',
	'Toggle Word Wrap': '切换自动换行',
	'Toggle Line Comment': '切换行注释',
	'Toggle Block Comment': '切换块注释',
	'Install Extension from VSIX...': '从 VSIX 安装扩展...',
	'Check for Extension Updates': '检查扩展更新',
	'Install from VSIX...': '从 VSIX 安装...',
	'Git: Open File History': 'Git: 打开文件历史',
	'Git: Toggle Blame': 'Git: 切换 Blame 注释',
	'Markdown: Open Preview': 'Markdown: 打开预览',
	'Markdown: Open Preview to the Side': 'Markdown: 在侧边打开预览',
	'Python: Run File in Terminal': 'Python: 在终端中运行文件',
	'File: Open in Hex Viewer': '文件: 在十六进制查看器中打开',
	'Initialize Repository': '初始化仓库',
	'Toggle Primary Side Bar': '切换主侧边栏',
	'Toggle Panel': '切换面板',
	Output: '输出',
	'Toggle Terminal': '切换终端',
	'New Terminal': '新建终端',
	'Kill the Active Terminal Instance': '终止活动终端实例',
	Welcome: '欢迎',
	'Keyboard Shortcuts': '键盘快捷键',
	'Keyboard Shortcuts Reference': '键盘快捷键参考',
	'Report Issue / Project Page': '报告问题 / 项目主页',
	'Open Developer Tools': '打开开发者工具',
	About: '关于',
	Clone: '克隆',
	Commit: '提交',
	'Commit & Push': '提交并推送',
	'Commit & Sync': '提交并同步',
	'Commit Staged': '提交已暂存',
	'Commit All': '提交全部',
	'Commit (Amend)': '提交（修订）',
	'Commit Staged (Amend)': '提交已暂存（修订）',
	Pull: '拉取',
	'Pull (Rebase)': '拉取（变基）',
	'Pull from...': '从...拉取',
	Push: '推送',
	'Push to...': '推送到...',
	'Push (Force With Lease)': '推送（强制但保留租约）',
	Sync: '同步',
	'Sync (Rebase)': '同步（变基）',
	Fetch: '抓取',
	'Fetch (Prune)': '抓取（清理）',
	'Fetch From...': '从...抓取',
	Changes: '更改',
	'Merge Changes': '合并更改',
	'Staged Changes': '暂存的更改',
	'Stage All Changes': '暂存所有更改',
	'Unstage All Changes': '取消暂存所有更改',
	'Discard All Changes': '放弃所有更改',
	'Stage Changes': '暂存更改',
	'Unstage Changes': '取消暂存更改',
	'Discard Changes': '放弃更改',
	'Stage Changes (Mark Resolved)': '暂存更改（标记为已解决）',
	'Open File': '打开文件',
	'Open Changes': '打开更改',
	'Open in Merge Editor': '在合并编辑器中打开',
	'View as List': '以列表查看',
	'View as Tree': '以树形查看',
	'View & Sort': '查看和排序',
	'Sort by Name': '按名称排序',
	'Sort by Path': '按路径排序',
	'Sort by Status': '按状态排序',
	'Pull, Push': '拉取, 推送',
	Branch: '分支',
	Remote: '远程',
	Tags: '标签',
	'Checkout to...': '检出到...',
	'Create Branch...': '创建分支...',
	'Create Branch From...': '从...创建分支...',
	'Rename Branch...': '重命名分支...',
	'Delete Branch...': '删除分支...',
	'Merge Branch...': '合并分支...',
	'Rebase Branch...': '变基分支...',
	'Add Remote...': '添加远程...',
	'Remove Remote': '移除远程',
	Stash: '贮藏',
	'Stash (Include Untracked)': '贮藏（含未跟踪文件）',
	'Apply Stash...': '应用贮藏...',
	'Apply Latest Stash': '应用最新贮藏',
	'Pop Stash...': '弹出贮藏...',
	'Pop Latest Stash': '弹出最新贮藏',
	'Drop Stash...': '丢弃贮藏...',
	'Create Tag': '创建标签',
	'Delete Tag': '删除标签',
	'Show Git Output': '显示 Git 输出',
	'Undo Last Commit': '撤销上次提交',
	'Amend Last Commit': '修订上次提交',
	'Fetch commit-msg Hook (Gerrit)': '获取 commit-msg 钩子（Gerrit）',
	'Reset Current Branch to Remote (Soft)': '重置当前分支到远程（软）',
	'Push to Gerrit Ref for Current Branch (refs/for/...)': '推送到当前分支的 Gerrit 引用（refs/for/...）',
	'Rebuild Symbol Index': '重建符号索引',
	Context: '上下文',
	'Symbol Database': '符号数据库',
	'Focus Next Part': '聚焦下一区域'
};

let current: Locale = 'en';
const localeListeners = new Set<() => void>();

/** Be told when the display language switches: static DOM built once registers here to
 *  relabel itself, so a language change lands on screen immediately (menus already
 *  re-render; this covers the built-once views). The handler lives for the app's
 *  lifetime — registering from a workbench-lifetime view never leaks. */
export function onLocaleChange(handler: () => void): () => void {
	localeListeners.add(handler);
	return () => localeListeners.delete(handler);
}


/** Merge more English→Chinese pairs into the text table: an extension's manifest translations,
 *  registered as its contributions are applied (a package's own package.nls.zh-cn titles
 *  travel inside its install). Later registrations win, so an upgrade re-labels. */
export function registerZhCnText(entries: Record<string, string>): void {
	Object.assign(zhCnText, entries);
}

export function locale(): Locale {
	return current;
}

export function setLocale(id: string): void {
	const next: Locale = id === 'zh-cn' ? 'zh-cn' : 'en';
	const changed = next !== current;
	current = next;
	// The DOM lang attribute carries the locale to CSS (the pane headers follow VS Code
	// in dropping their bold for the CJK scripts).
	document.documentElement.lang = current === 'zh-cn' ? 'zh-CN' : 'en';
	if (changed) for (const relabel of localeListeners) relabel();
}

/** A translation key, as `t` accepts it. */
export type LocaleKey = keyof typeof en;

/** Resolve a key against the current locale, falling back to English and then the key. */
export function t(key: keyof typeof en): string {
	return TABLES[current][key] ?? en[key] ?? key;
}

/** Resolve a key with `{0}`-style placeholders filled from `args` (same fallbacks as `t`). */
export function tf(key: keyof typeof en, ...args: (string | number)[]): string {
	return t(key).replace(/\{(\d+)\}/g, (_all, index: string) => String(args[Number(index)] ?? ''));
}

/** Translate a registered English command label (title or category) for the current locale;
 *  unrecognised text passes through unchanged, so untranslated entries stay in English. */
export function trText(text: string): string {
	return current === 'zh-cn' ? (zhCnText[text] ?? text) : text;
}
