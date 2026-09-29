// The AI provider bridge's vitest (module 12): the store client and the sidebar chip
// (the switcher's quick pick) plus the Model Providers page, everything over the
// scripted `tauriMock` backend. The sealing itself is backend-side and tested beside
// the command (src-tauri/src/cmd_providers.rs); what this suite pins is the seam
// contract — the key travels only inside `provider_save`'s arguments, and never comes
// back in a `provider_list` answer (a `hasKey` flag and the last four characters stand
// in for it).

import { beforeEach, describe, expect, it } from 'vitest';

import { click, flush, notifications, notificationButton, texts, type } from './helpers';
import { backend } from './tauriMock';

let mountProvidersPage: typeof import('../src/providersPage').mountProvidersPage;
let mountProviderSwitcher: typeof import('../src/aiProviders').mountProviderSwitcher;
let resetProviderCacheForTests: typeof import('../src/aiProviders').resetProviderCacheForTests;

async function modules(): Promise<void> {
	({ mountProvidersPage } = await import('../src/providersPage'));
	({ mountProviderSwitcher, resetProviderCacheForTests } = await import('../src/aiProviders'));
}

function host(): HTMLElement {
	const element = document.createElement('div');
	document.body.appendChild(element);
	return element;
}

/** The seeded store shape the backend answers `provider_list` with. */
function providerListAnswer(): Record<string, unknown> {
	return {
		activeId: 'official',
		profiles: [
			{ id: 'official', preset: 'official', label: 'Official Claude', baseUrl: null, model: null, smallModel: null, hasKey: false, keyHint: null },
			{ id: 'deepseek', preset: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', smallModel: 'deepseek-chat', hasKey: true, keyHint: 'abcd' }
		],
		presets: [
			{ id: 'official', label: 'Official Claude', official: true, baseUrl: null, models: [] },
			{ id: 'deepseek', label: 'DeepSeek', official: false, baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-chat', 'deepseek-reasoner'] },
			{ id: 'glm', label: 'Zhipu GLM', official: false, baseUrl: 'https://open.bigmodel.cn/api/anthropic', models: ['glm-4.6', 'glm-4.5-air'] },
			{ id: 'custom', label: 'Custom (Anthropic-compatible)', official: false, baseUrl: null, models: [] }
		],
		bridgedExtIds: ['Anthropic.claude-code']
	};
}

/** The management page's text inputs in form order: name, base URL, model, background
 *  model, API key (the preset select is not a text input). */
function formInputs(): HTMLInputElement[] {
	return [...document.querySelectorAll<HTMLInputElement>('.providers-form input.input')];
}

function actionByTitle(title: string, root: ParentNode = document): HTMLElement | null {
	return [...root.querySelectorAll<HTMLElement>('.action-btn, .button')].find((button) => button.title === title || button.textContent === title) ?? null;
}

describe('the Model Providers page', () => {
	beforeEach(async () => {
		await modules();
		resetProviderCacheForTests();
		backend.on('provider_list', () => providerListAnswer());
	});

	it('lists the profiles, the active one marked, keys shown as hints only', async () => {
		mountProvidersPage(host());
		await flush();
		const rows = texts('.an-row .label');
		expect(rows).toEqual(['Official Claude', 'DeepSeek']);
		// The masked key, never a value the page could leak: the hint the backend sent.
		expect(texts('.an-row .description')[1]).toContain('••••abcd');
		expect(texts('.an-row .tail')[0]).toContain('Active');
		// The official row offers no delete; the third-party one offers activate.
		expect(actionByTitle('Delete', document.querySelector('.an-row')!)).toBeNull();
		expect(actionByTitle('Activate')).not.toBeNull();
	});

	it('saves an edit: an untouched key field keeps the stored one, a typed one travels once', async () => {
		backend.on('provider_save', ({ profile }) => {
			const answer = providerListAnswer();
			const saved = (answer.profiles as Record<string, unknown>[]).find((candidate) => candidate['id'] === profile.id)!;
			Object.assign(saved, { label: profile.label, model: profile.model, smallModel: profile.smallModel });
			return answer;
		});
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Edit', [...document.querySelectorAll('.an-row')][1]!));
		await flush();
		let [name, baseUrl, model, smallModel, apiKey] = formInputs();
		expect(name.value).toBe('DeepSeek');
		expect(apiKey.placeholder).toContain('••••abcd');
		// A relabel and a new model, the key untouched: `apiKey: null` — keep.
		type(name, 'DeepSeek (team)');
		type(model, 'deepseek-reasoner');
		click(document.querySelector('.providers-form-actions .button.primary')!);
		await flush();
		expect(backend.callsTo('provider_save')).toEqual([{
			profile: {
				id: 'deepseek', preset: 'deepseek', label: 'DeepSeek (team)',
				baseUrl: 'https://api.deepseek.com/anthropic',
				model: 'deepseek-reasoner', smallModel: 'deepseek-chat',
				apiKey: null
			}
		}]);

		// Typed key: exactly what was typed, once, inside the save.
		click(actionByTitle('Edit', [...document.querySelectorAll('.an-row')][1]!));
		await flush();
		[, , , , apiKey] = formInputs();
		type(apiKey, 'sk-new-key');
		click(document.querySelector('.providers-form-actions .button.primary')!);
		await flush();
		const second = backend.callsTo('provider_save')[1]!.profile as Record<string, unknown>;
		expect(second['apiKey']).toBe('sk-new-key');
		// The second edit started from the relabel the first save returned.
		expect(second['label']).toBe('DeepSeek (team)');
	});

	it('adds a profile from a preset, taking over the endpoint and model suggestions', async () => {
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Add Provider'));
		await flush();
		const [name, baseUrl, model] = formInputs();
		expect(name.value).toBe('DeepSeek');
		expect(baseUrl.value).toBe('https://api.deepseek.com/anthropic');
		expect(model.value).toBe('deepseek-chat');
		const [apiKey] = formInputs().slice(4);
		type(apiKey, 'sk-brand-new');
		click(document.querySelector('.providers-form-actions .button.primary')!);
		await flush();
		const profile = backend.callsTo('provider_save')[0]!.profile as Record<string, unknown>;
		expect(profile['id']).toBe('deepseek-2'); // the taken id got its suffix
		expect(profile['apiKey']).toBe('sk-brand-new');
	});

	it('activates a profile through the backend and follows the switch', async () => {
		let answer = providerListAnswer();
		backend.on('provider_activate', ({ id }) => {
			answer = { ...answer, activeId: String(id) };
			return answer;
		});
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Activate'));
		await flush();
		expect(backend.callsTo('provider_activate')).toEqual([{ id: 'deepseek' }]);
		expect(notifications()[0]).toContain('DeepSeek');
		// The page follows the announced switch: DeepSeek is the active row now (its
		// first tail is the status; the second carries the row's actions).
		const deepseekRow = [...document.querySelectorAll('.an-row')][1]!;
		expect(deepseekRow.querySelector('.tail')!.textContent).toContain('Active');
		// The active row offers no activate; the official row it displaced now does.
		expect(deepseekRow.querySelector('[title="Activate"]')).toBeNull();
		expect([...document.querySelectorAll('.an-row')][0]!.querySelector('[title="Activate"]')).not.toBeNull();
	});

	it('reports a failed switch and keeps the page as it was', async () => {		backend.on('provider_activate', () => {
			throw new Error('the backend refused to stop');
		});
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Activate'));
		await flush();
		expect(backend.callsTo('provider_activate')).toEqual([{ id: 'deepseek' }]);
		expect(notifications()[0]).toContain('Could not switch the provider');
		// Nothing announced: the official row is still the active one.
		expect(texts('.an-row .tail')[0]).toContain('Active');
	});

	it('deletes a profile behind a confirmation', async () => {
		backend.on('provider_delete', () => ({ ...providerListAnswer(), profiles: providerListAnswer().profiles.slice(0, 1) }));
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Delete', [...document.querySelectorAll('.an-row')][1]!));
		await flush();
		expect(backend.callsTo('provider_delete')).toEqual([]); // nothing before the confirm
		click(notificationButton('Delete'));
		await flush();
		expect(backend.callsTo('provider_delete')).toEqual([{ id: 'deepseek' }]);
		expect(texts('.an-row .label')).toEqual(['Official Claude']);
	});

	it('shows a load failure with a retry that recovers', async () => {		let broken = true;
		backend.on('provider_list', () => {
			if (broken) throw new Error('the store is unreadable');
			return providerListAnswer();
		});
		mountProvidersPage(host());
		await flush();
		expect(texts('.an-empty')[0]).toContain('Could not read the provider store');
		// Nothing re-throws when the store changes while broken — the page just re-renders.
		document.dispatchEvent(new CustomEvent('ggs:providers-changed'));
		await flush();

		broken = false;
		click(actionByTitle('Retry'));
		await flush();
		expect(texts('.an-row .label')).toEqual(['Official Claude', 'DeepSeek']);
	});

	it('follows a store change announced from outside (the sidebar chip, another window)', async () => {
		let answer = providerListAnswer();
		backend.on('provider_list', () => answer);
		mountProvidersPage(host());
		// The chip registers the backend's `providers-changed` listener; the page
		// follows the announce that fan-outs from it.
		const chipSlot = host();
		const disposeChip = mountProviderSwitcher('Anthropic.claude-code', chipSlot);
		await flush();
		expect(texts('.an-row .tail')[0]).toContain('Active'); // the official service starts active

		// Another window switched to DeepSeek and the backend pushed the change.
		answer = { ...providerListAnswer(), activeId: 'deepseek' };
		backend.emit('providers-changed', null);
		await flush();
		// Both surfaces followed without a reload: the page's active row and the chip.
		expect([...document.querySelectorAll('.an-row')][1]!.querySelector('.tail')!.textContent).toContain('Active');
		expect(chipSlot.querySelector('.provider-chip .label')!.textContent).toBe('DeepSeek');
		disposeChip();
	});

	it('collapses the form to the name field for the official preset', async () => {
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Add Provider'));
		await flush();
		const select = document.querySelector<HTMLSelectElement>('.providers-field select')!;
		select.value = 'official';
		select.dispatchEvent(new Event('change'));
		await flush();
		// No endpoint, no models, no key field: the official service needs a sign-in,
		// not a configuration.
		expect(formInputs().length).toBe(1);
		expect(formInputs()[0].value).toBe('DeepSeek'); // the label survives the preset switch
		click(document.querySelector('.providers-form-actions .button.primary')!);
		await flush();
		const profile = backend.callsTo('provider_save')[0]!.profile as Record<string, unknown>;
		expect(profile).toMatchObject({ id: 'deepseek-2', preset: 'official', baseUrl: '', apiKey: null });
	});
});

describe('the sidebar provider chip', () => {
	beforeEach(async () => {
		await modules();
		resetProviderCacheForTests();
		backend.on('provider_list', () => providerListAnswer());
	});

	it('rides only a bridged extension\'s section, labels the active provider, and switches through the quick pick', async () => {
		const bridged = host();
		const other = host();
		const disposeBridged = mountProviderSwitcher('Anthropic.claude-code', bridged);
		const disposeOther = mountProviderSwitcher('some.other.ext', other);
		await flush();
		const chip = bridged.querySelector<HTMLButtonElement>('.provider-chip')!;
		expect(chip.hidden).toBe(false);
		expect(chip.querySelector('.label')!.textContent).toBe('Official Claude');
		expect((other.querySelector('.provider-chip') as HTMLButtonElement).hidden).toBe(true);

		backend.on('provider_activate', ({ id }) => ({ ...providerListAnswer(), activeId: String(id) }));
		click(chip);
		await flush();
		const rows = [...document.querySelectorAll('.quick-input .row')];
		expect(rows.map((row) => row.querySelector('.label')!.textContent)).toEqual(
			['Official Claude', 'DeepSeek', 'Configure Providers…']);
		click(rows[1]!);
		await flush();
		expect(backend.callsTo('provider_activate')).toEqual([{ id: 'deepseek' }]);
		// The chip followed the switch without remounting.
		expect(chip.querySelector('.label')!.textContent).toBe('DeepSeek');
		disposeBridged();
		disposeOther();
	});

	it('stays hidden when the store cannot be read, and appears once a read succeeds', async () => {
		let broken = true;
		backend.on('provider_list', () => {
			if (broken) throw new Error('the store is unreadable');
			return providerListAnswer();
		});
		const slot = host();
		const dispose = mountProviderSwitcher('Anthropic.claude-code', slot);
		await flush();
		const chip = slot.querySelector<HTMLButtonElement>('.provider-chip')!;
		expect(chip.hidden).toBe(true);

		// The backend's push after a fix (or another window's switch) re-reads and shows.
		broken = false;
		backend.emit('providers-changed', null);
		await flush();
		expect(chip.hidden).toBe(false);
		expect(chip.querySelector('.label')!.textContent).toBe('Official Claude');
		dispose();
	});

	it('picks the active provider as a no-op close', async () => {
		const slot = host();
		const dispose = mountProviderSwitcher('Anthropic.claude-code', slot);
		await flush();
		click(slot.querySelector('.provider-chip')!);
		await flush();
		const rows = [...document.querySelectorAll('.quick-input .row')];
		click(rows[0]!); // the active one
		await flush();
		expect(backend.callsTo('provider_activate')).toEqual([]);
		dispose();
	});
});

describe('the gateway tools and the cc-switch import', () => {
	beforeEach(async () => {
		await modules();
		resetProviderCacheForTests();
		backend.on('provider_list', () => providerListAnswer());
	});

	function openEditForm(): void {
		click(actionByTitle('Edit', [...document.querySelectorAll('.an-row')][1]!));
	}

	it('tests the connection and renders the probe report on the form', async () => {
		backend.on('provider_test_connection', ({ baseUrl, apiKey, model, profileId }) => {
			expect(baseUrl).toBe('https://api.deepseek.com/anthropic');
			// An untouched key field falls back to the profile's stored key, backend-side.
			expect(apiKey).toBe('');
			expect(profileId).toBe('deepseek');
			expect(model).toBe('deepseek-chat');
			return { ok: true, status: 200, ms: 42, message: 'reachable' };
		});
		mountProvidersPage(host());
		await flush();
		openEditForm();
		await flush();
		click(actionByTitle('Test Connection'));
		await flush();
		const line = document.querySelector('.providers-test-result')!;
		expect(line.classList.contains('providers-test-ok')).toBe(true);
		expect(line.textContent).toContain('42');
		// A diagnosed failure renders as the problem it is.
		backend.on('provider_test_connection', () => ({ ok: false, status: 401, ms: 7, message: 'the gateway rejected the API key (HTTP 401)' }));
		click(actionByTitle('Test Connection'));
		await flush();
		const bad = document.querySelector('.providers-test-result')!;
		expect(bad.classList.contains('providers-test-bad')).toBe(true);
		expect(bad.textContent).toContain('401');
	});

	it('fetches the model catalogue and lands a pick in the model field', async () => {
		backend.on('provider_fetch_models', () => ['glm-4.6', 'claude-sonnet-4-5', 'deepseek-r1']);
		mountProvidersPage(host());
		await flush();
		openEditForm();
		await flush();
		click(actionByTitle('Fetch Models'));
		await flush();
		const rows = [...document.querySelectorAll('.quick-input .row')];
		expect(rows.map((row) => row.querySelector('.label')!.textContent)).toEqual(
			['glm-4.6', 'claude-sonnet-4-5', 'deepseek-r1']);
		click(rows[2]!);
		await flush();
		const model = [...document.querySelectorAll('.providers-form input.input')][2]!;
		expect(model.value).toBe('deepseek-r1');
	});

	it('imports the cc-switch configuration after a confirmation, keys never round-tripping', async () => {
		const candidates = [
			{ id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', hasKey: true, current: true, source: 'cc-switch' }
		];
		backend.on('provider_ccswitch_scan', () => candidates);
		let importNames: unknown = null;
		backend.on('provider_import_ccswitch', ({ names }) => {
			importNames = names;
			return { ...providerListAnswer(), activeId: 'deepseek' };
		});
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Import from cc-switch'));
		await flush();
		// The confirm carries the count and names; nothing imported before it.
		expect(backend.callsTo('provider_import_ccswitch')).toEqual([]);
		click(notificationButton('Import from cc-switch'));
		await flush();
		expect(importNames).toEqual(['deepseek']);
		expect(notifications().some((message) => message.includes('Imported 1'))).toBe(true);
	});

	it('says so when there is nothing to import', async () => {
		backend.on('provider_ccswitch_scan', () => []);
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Import from cc-switch'));
		await flush();
		expect(notifications()[0]).toContain('No importable configuration');
		expect(backend.callsTo('provider_import_ccswitch')).toEqual([]);
	});
});
