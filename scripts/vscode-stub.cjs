// The `vscode` module as seen by the extension's compiled src/config.ts when it is bundled for
// the app (scripts/prepare.mjs): every configuration read answers with the override the app
// stored for that key, or the setting's declared default. Nothing else of the API is touched by
// config.ts beyond the enum values referenced below.

const overrides = (globalThis.__gitGraphStudioOverrides = globalThis.__gitGraphStudioOverrides || {});

// The display language `vscode.env.language` reports: the workbench's persisted locale (the same
// "ggstudio.appSettings" localStorage record src/settings.ts writes) so the extension's
// "auto" interface language follows the app's setting, falling back to the browser language.
function workbenchLanguage() {
	try {
		const raw = localStorage.getItem('ggstudio.appSettings');
		const locale = raw ? JSON.parse(raw).locale : null;
		if (typeof locale === 'string' && locale !== '') return locale;
	} catch {
		// Malformed record: fall through to the browser language.
	}
	return typeof navigator !== 'undefined' ? navigator.language : 'en';
}

const configuration = {
	get: (key, defaultValue) => (Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : defaultValue),
	has: (key) => Object.prototype.hasOwnProperty.call(overrides, key),
	inspect: () => undefined,
	update: async () => {}
};

module.exports = {
	env: { get language() { return workbenchLanguage(); } },
	workspace: {
		getConfiguration: () => configuration,
		workspaceFolders: []
	},
	window: { activeColorTheme: { kind: 2 } },
	Uri: { file: (path) => ({ fsPath: path, path }) },
	ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 }
};
