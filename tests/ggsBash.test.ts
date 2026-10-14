// GGS Bash (module 18), frontend half: the Terminal Shell setting — its registration
// (PowerShell, GGS Bash and Git Bash, GGS Bash the default), the shell choice riding
// every `pty_create`, and the switch reaching the backend
// (`providers_shell_refresh`, which re-applies the bridged claude-code environment
// and restarts the running backend). The shell itself is Rust: its suite lives
// beside `src-tauri/src/ggs_bash/`.

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTING_DEFS, migrateStoredSettings, settings, updateSetting } from '../src/platform/settings';
import { setLocale, t } from '../src/platform/i18n';
import { backend } from './tauriMock';

beforeEach(() => {
	backend.reset();
	setLocale('en');
	settings.terminalShell = 'powershell';
});

describe('the Terminal Shell setting', () => {
	it('offers every shell, defaulting to Git Bash', () => {
		const def = SETTING_DEFS.find((d) => d.key === 'terminalShell')!;
		expect(def.kind).toBe('enum');
		expect(def.options?.map((option) => option.value)).toEqual(['powershell', 'ggsBash', 'gitBash']);
		// Git Bash is the default (the owner's 2026-10-13 direction; GGS Bash stood
		// as it until then, and stands in wherever no Git Bash is installed).
		expect(DEFAULT_SETTINGS.terminalShell).toBe('gitBash');
		// A stored old default follows the current one: a store from the GGS Bash era
		// pins the default of the day, not a pick.
		expect(migrateStoredSettings({ terminalShell: 'ggsBash' }).terminalShell).toBe('gitBash');
		expect(migrateStoredSettings({ terminalShell: 'powershell' }).terminalShell).toBe('powershell');
	});

	it('labels every option in every language table', () => {
		expect(t('settings.terminalShell.powershell')).toBe('PowerShell');
		expect(t('settings.terminalShell.ggsBash')).toBe('GGS Bash');
		expect(t('settings.terminalShell.gitBash')).toBe('Git Bash');
		setLocale('zh-cn');
		expect(t('settings.terminalShell.ggsBash')).toBe('GGS Bash');
		expect(t('settings.terminalShell.gitBash')).toBe('Git Bash');
		expect(t('settings.terminalShell')).not.toBe('settings.terminalShell');
	});

	it('switching shells writes the choice to disk before the backend refresh', async () => {
		backend.on('providers_shell_refresh', () => null);
		backend.on('settings_write', () => null);
		updateSetting('terminalShell', 'ggsBash');
		expect(settings.terminalShell).toBe('ggsBash');
		// The refresh rides a promise chain behind the settings write (a microtask
		// later), so the backend's restart thread reads the NEW choice from
		// ~/.ggs/settings.json — never the stale one it would race otherwise.
		await flushMicrotasks();
		expect(backend.callsTo('providers_shell_refresh')).toHaveLength(1);
		const calls = backend.calls.map((call) => call.command);
		const write = calls.indexOf('settings_write');
		const refresh = calls.indexOf('providers_shell_refresh');
		expect(write).toBeGreaterThanOrEqual(0);
		expect(refresh).toBeGreaterThan(write);
		const written = backend.callsTo('settings_write').at(-1)!.contents as string;
		expect(JSON.parse(written).terminalShell).toBe('ggsBash');
		// A no-op change (same value) never fires the restart.
		updateSetting('terminalShell', 'ggsBash');
		await flushMicrotasks();
		expect(backend.callsTo('providers_shell_refresh')).toHaveLength(1);
	});

	it('other settings leave the shell choice alone', () => {
		backend.on('providers_shell_refresh', () => null);
		updateSetting('minimap', !settings.minimap);
		expect(backend.callsTo('providers_shell_refresh')).toHaveLength(0);
		expect(settings.terminalShell).toBe('powershell');
	});
});

/** Let the shell switch's write-then-refresh promise chain settle: the mock's invokes
 *  resolve synchronously, so one microtask turn per link is enough. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}
