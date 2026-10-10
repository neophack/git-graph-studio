// GGS Bash (module 18), frontend half: the Terminal Shell setting — its registration
// (both options, GGS Bash the default), the shell choice riding every `pty_create`,
// and the switch reaching the backend (`providers_shell_refresh`, which re-applies the
// bridged claude-code environment and restarts the running backend). The shell itself
// is Rust: its suite lives beside `src-tauri/src/ggs_bash/`.

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTING_DEFS, settings, updateSetting } from '../src/settings';
import { setLocale, t } from '../src/i18n';
import { backend } from './tauriMock';

beforeEach(() => {
	backend.reset();
	setLocale('en');
	settings.terminalShell = 'powershell';
});

describe('the Terminal Shell setting', () => {
	it('offers both shells, defaulting to GGS Bash', () => {
		const def = SETTING_DEFS.find((d) => d.key === 'terminalShell')!;
		expect(def.kind).toBe('enum');
		expect(def.options?.map((option) => option.value)).toEqual(['powershell', 'ggsBash']);
		// GGS Bash is the default (the owner's 2026-10-10 direction).
		expect(DEFAULT_SETTINGS.terminalShell).toBe('ggsBash');
	});

	it('labels both options in every language table', () => {
		expect(t('settings.terminalShell.powershell')).toBe('PowerShell');
		expect(t('settings.terminalShell.ggsBash')).toBe('GGS Bash');
		setLocale('zh-cn');
		expect(t('settings.terminalShell.ggsBash')).toBe('GGS Bash');
		expect(t('settings.terminalShell')).not.toBe('settings.terminalShell');
	});

	it('switching shells reaches the backend: the bridged environment is re-applied', () => {
		backend.on('providers_shell_refresh', () => null);
		updateSetting('terminalShell', 'ggsBash');
		expect(settings.terminalShell).toBe('ggsBash');
		expect(backend.callsTo('providers_shell_refresh')).toHaveLength(1);
		// A no-op change (same value) never fires the restart.
		updateSetting('terminalShell', 'ggsBash');
		expect(backend.callsTo('providers_shell_refresh')).toHaveLength(1);
		// The choice persists through the user-level settings file the backend reads.
		expect(backend.callsTo('settings_write').length).toBeGreaterThanOrEqual(1);
		const written = backend.callsTo('settings_write').at(-1)!.contents as string;
		expect(JSON.parse(written).terminalShell).toBe('ggsBash');
	});

	it('other settings leave the shell choice alone', () => {
		backend.on('providers_shell_refresh', () => null);
		updateSetting('minimap', !settings.minimap);
		expect(backend.callsTo('providers_shell_refresh')).toHaveLength(0);
		expect(settings.terminalShell).toBe('powershell');
	});
});
