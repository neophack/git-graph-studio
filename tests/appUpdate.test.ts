import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkForAppUpdate } from '../src/workbench/appUpdate';
import { backend } from './tauriMock';
import { flush, notificationButton, notifications } from './helpers';
import { updateSetting } from '../src/platform/settings';

/** The app's own update flow (src/workbench/appUpdate.ts over the scripted backend):
 *  the up-to-date answer, the confirm-and-download pass — mirror setting included —
 *  and the failure that stays a notification (the command sweep runs this command too). */
describe('the app update flow', () => {
	beforeEach(() => {
		backend.on('app_update_check', () => null);
		backend.on('app_update_install', () => ({ launched: false, path: '/tmp/ggs-setup.exe' }));
	});

	afterEach(() => {
		updateSetting('githubMirror', '');
	});

	it('an up-to-date check says so and installs nothing', async () => {
		await checkForAppUpdate();
		await flush();
		expect(notifications().join()).toContain('is the latest version');
		expect(backend.callsTo('app_update_install')).toEqual([]);
	});

	it('a newer release confirms and downloads this platform\'s installer', async () => {
		backend.on('app_update_check', () => ({
			current: '0.1.16', version: '0.2.0', releaseName: 'Git Graph Studio 0.2.0',
			publishedAt: '2026-11-09T00:00:00Z',
			downloadUrl: 'https://github.com/neophack/git-graph-studio/releases/download/v0.2.0/ggs_0.2.0_x64-setup.exe',
			fileName: 'ggs_0.2.0_x64-setup.exe'
		}));
		const pending = checkForAppUpdate();
		await flush();
		// The confirm dialog is a notification; the download starts on its Download pick.
		notificationButton('Download and Install')!.click();
		await pending;
		await flush();
		expect(backend.callsTo('app_update_install')).toEqual([
			{ downloadUrl: 'https://github.com/neophack/git-graph-studio/releases/download/v0.2.0/ggs_0.2.0_x64-setup.exe', mirror: null, onProgress: expect.anything() }
		]);
		expect(notifications().join()).toContain('was saved to');
	});

	it('the configured mirror rides the download request', async () => {
		backend.on('app_update_check', () => ({
			current: '0.1.16', version: '0.2.0', releaseName: null, publishedAt: '',
			downloadUrl: 'https://github.com/neophack/git-graph-studio/releases/download/v0.2.0/ggs_0.2.0_x64-setup.exe',
			fileName: 'ggs_0.2.0_x64-setup.exe'
		}));
		updateSetting('githubMirror', 'https://ghfast.top');
		const pending = checkForAppUpdate();
		await flush();
		notificationButton('Download and Install')!.click();
		await pending;
		await flush();
		expect(backend.callsTo('app_update_install')).toEqual([
			expect.objectContaining({ mirror: 'https://ghfast.top' })
		]);
	});

	it('a check that cannot answer stays a notification, never a throw', async () => {
		backend.on('app_update_check', () => { throw new Error('offline'); });
		await checkForAppUpdate();
		await flush();
		expect(notifications().join()).toContain('App update failed');
		expect(backend.callsTo('app_update_install')).toEqual([]);
	});
});
