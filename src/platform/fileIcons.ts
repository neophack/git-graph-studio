// File-name → icon mapping: the codicon VS Code's generic icon set picks for a file, and the
// Seti-theme tint for it. Extracted from editor.ts so the Explorer and Source Control can
// decorate rows without importing the editor module (plan §5.4 — the 6-file cycle's
// `explorer → editor` and `scm → editor` icon edges).

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'toml', 'yaml', 'yml', 'xml', 'sql', 'lua', 'kt', 'swift', 'dart', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'ml', 'r', 'jl', 'nim', 'zig', 'vb', 'pl', 'gradle', 'cmake', 'mk', 'dockerfile', 'tf', 'proto', 'graphql', 'wasm']);
const MEDIA_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'avif', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'vsix']);
const BINARY_EXTENSIONS = new Set(['exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'node', 'class', 'pyc', 'wasm']);

/** Tint colors for file icons, mirroring VS Code's Seti icon theme per extension. */
const FILE_ICON_COLORS: Record<string, string> = {
	ts: '#519aba', tsx: '#519aba', md: '#519aba', go: '#519aba', c: '#557c93', cc: '#519aba', cpp: '#519aba',
	h: '#a074c4', hpp: '#a074c4', cs: '#519aba', css: '#519aba', scss: '#cc3e44', less: '#519aba',
	js: '#cbcb41', jsx: '#cbcb41', mjs: '#cbcb41', cjs: '#cbcb41', json: '#cbcb41', jsonc: '#cbcb41',
	py: '#3572a5', rs: '#d5a374', java: '#cc3e44', rb: '#cc3e44', php: '#a074c4', swift: '#ff6f61',
	kt: '#a97bff', dart: '#00b4ab', scala: '#cc3e44', clj: '#63ed69', ex: '#a074c4', exs: '#a074c4',
	erl: '#a074c4', hs: '#a074c4', ml: '#a074c4', r: '#3572a5', jl: '#a074c4', nim: '#ffe95c', zig: '#f69a50',
	vb: '#519aba', pl: '#519aba', gradle: '#00b4ab', cmake: '#6d8086', mk: '#6d8086', makefile: '#6d8086',
	sh: '#89e051', bash: '#89e051', zsh: '#89e051', ps1: '#4e9fdd', bat: '#c9c9c9', cmd: '#c9c9c9',
	html: '#e37933', htm: '#e37933', vue: '#41b883', svelte: '#ff3e00', xml: '#e37933', graphql: '#e37933',
	toml: '#6d8086', yaml: '#a074c4', yml: '#a074c4', sql: '#f29e74', lua: '#519aba', proto: '#a074c4',
	tf: '#519aba', wasm: '#a074c4', svg: '#a074c4', pdf: '#cc3e44', dockerfile: '#38b3f0',
	png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4', bmp: '#a074c4', ico: '#a074c4',
	webp: '#a074c4', avif: '#a074c4', mp3: '#a074c4', wav: '#a074c4', ogg: '#a074c4',
	mp4: '#a074c4', webm: '#a074c4', mov: '#a074c4',
	zip: '#a074c4', gz: '#a074c4', tgz: '#a074c4', bz2: '#a074c4', xz: '#a074c4', '7z': '#a074c4',
	rar: '#a074c4', tar: '#a074c4', jar: '#a074c4', vsix: '#a074c4',
	exe: '#a074c4', dll: '#a074c4', so: '#a074c4', dylib: '#a074c4', bin: '#a074c4', o: '#a074c4',
	a: '#a074c4', lib: '#a074c4', node: '#89e051', class: '#cc3e44', pyc: '#519aba',
};

/** The Seti-theme tint for a file name, or undefined to keep the theme's neutral icon color. */
export function fileIconColor(name: string): string | undefined {
	const dot = name.lastIndexOf('.');
	const ext = dot === -1 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase();
	return FILE_ICON_COLORS[ext];
}

/** A CAN trace (.blf / .asc), which opens in the raw frame view (`canRawView.ts`). */
export function isCanLog(name: string): boolean {
	const dot = name.lastIndexOf('.');
	const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
	return ext === 'blf' || ext === 'asc';
}

/** The codicon for a file name - the choice VS Code's generic (non-Seti) icon set makes. */
export function fileIcon(name: string): string {
	const dot = name.lastIndexOf('.');
	const ext = dot === -1 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase();
	if (ext === 'md' || ext === 'markdown') return 'markdown';
	if (ext === 'json' || ext === 'jsonc') return 'json';
	if (ext === 'pdf') return 'file-pdf';
	if (MEDIA_EXTENSIONS.has(ext)) return 'file-media';
	if (ARCHIVE_EXTENSIONS.has(ext)) return 'file-zip';
	if (BINARY_EXTENSIONS.has(ext)) return 'file-binary';
	if (CODE_EXTENSIONS.has(ext) || name.toLowerCase() === 'makefile') return 'file-code';
	return 'file';
}

/** Whether a path's extension is one the code editor shapes its language guesses on. */
export function isCodeExtension(path: string): boolean {
	const name = path.toLowerCase();
	const dot = name.lastIndexOf('.');
	const ext = dot === -1 ? name : name.slice(dot + 1);
	return CODE_EXTENSIONS.has(ext) || name.slice(name.lastIndexOf('/') + 1) === 'makefile';
}
