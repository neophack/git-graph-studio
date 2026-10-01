// The AI provider bridge's vitest (module 12): the store client and the sidebar chip
// (the switcher's quick pick), the Model Providers page, the chat pane's gate (the
// set-key page over a keyless third-party provider's chat) and the token-usage curve —
// everything over the scripted `tauriMock` backend. The sealing itself is backend-side
// and tested beside the command (src-tauri/src/cmd_providers.rs); what this suite pins
// is the seam contract — the key travels only inside `provider_save`'s arguments, and
// never comes back in a `provider_list` answer (a `hasKey` flag and the last four
// characters stand in for it).

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { click, flush, notifications, notificationButton, texts, type } from './helpers';
import { backend } from './tauriMock';

let mountProvidersPage: typeof import('../src/providersPage').mountProvidersPage;
let mountProviderSwitcher: typeof import('../src/aiProviders').mountProviderSwitcher;
let resetProviderCacheForTests: typeof import('../src/aiProviders').resetProviderCacheForTests;
let mountUsagePanel: typeof import('../src/providerUsageView').mountUsagePanel;
let formatTokens: typeof import('../src/providerUsageView').formatTokens;
let mountProviderPaneGate: typeof import('../src/providerUsageView').mountProviderPaneGate;

async function modules(): Promise<void> {
	({ mountProvidersPage } = await import('../src/providersPage'));
	({ mountProviderSwitcher, resetProviderCacheForTests } = await import('../src/aiProviders'));
	({ mountUsagePanel, formatTokens, mountProviderPaneGate } = await import('../src/providerUsageView'));
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
			{ id: 'deepseek', preset: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro', smallModel: 'deepseek-flash', hasKey: true, keyHint: 'abcd' }
		],
		presets: [
			{ id: 'official', label: 'Official Claude', official: true, baseUrl: null, models: [], requiresKey: false },
			{ id: 'deepseek', label: 'DeepSeek', official: false, baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-v4-pro', 'deepseek-flash'], requiresKey: true },
			{ id: 'glm', label: 'Zhipu GLM', official: false, baseUrl: 'https://open.bigmodel.cn/api/anthropic', models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'], requiresKey: true },
			{ id: 'custom', label: 'Custom (Anthropic-compatible)', official: false, baseUrl: null, models: [], requiresKey: false }
		],
		bridgedExtIds: ['Anthropic.claude-code']
	};
}

/** The store with the keyless third-party provider active — the gate's state. */
function keylessListAnswer(): Record<string, unknown> {
	const answer = providerListAnswer();
	(answer['profiles'] as Record<string, unknown>[])[1] = {
		id: 'deepseek', preset: 'deepseek', label: 'DeepSeek',
		baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro', smallModel: 'deepseek-flash',
		hasKey: false, keyHint: null
	};
	answer['activeId'] = 'deepseek';
	return answer;
}

/** A usage answer with one shaped hour at today's local midnight (the bucket the
 *  jsdom hover — a zero-width layout — always lands on) and a sprinkle yesterday. */
function usageAnswer(): Record<string, unknown>[] {
	const midnight = new Date();
	midnight.setHours(0, 0, 0, 0);
	return [
		{ startMs: midnight.getTime(), cacheRead: 1_234_000, cacheCreation: 500, input: 400, output: 12_000 },
		{ startMs: midnight.getTime() - 86_400_000, cacheRead: 900, cacheCreation: 0, input: 100, output: 2_000 }
	];
}

/** The management page's text inputs in form order: name, base URL, model, background
 *  model, API key (the preset select is not a text input). */
function formInputs(): HTMLInputElement[] {
	return [...document.querySelectorAll<HTMLInputElement>('.providers-form input.input')];
}

function actionByTitle(title: string, root: ParentNode = document): HTMLElement | null {
	return [...root.querySelectorAll<HTMLElement>('.action-btn, .button')].find((button) => button.title === title || button.textContent === title) ?? null;
}

function rows(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('.prov-row')];
}

describe('the Model Providers page', () => {
	beforeEach(async () => {
		await modules();
		resetProviderCacheForTests();
		backend.on('provider_list', () => providerListAnswer());
		backend.on('provider_usage', () => []);
	});

	it('lists the profiles, the active one marked, keys shown as hints only', async () => {
		mountProvidersPage(host());
		await flush();
		expect(texts('.prov-row .name')).toEqual(['Official Claude', 'DeepSeek']);
		// The masked key, never a value the page could leak: the hint the backend sent.
		expect(texts('.prov-row .key-chip')[1]).toContain('••••abcd');
		expect(texts('.prov-row .status')[0]).toContain('Active');
		// The official row offers no delete; the third-party one offers activate.
		expect(actionByTitle('Delete', rows()[0]!)).toBeNull();
		expect(actionByTitle('Activate')).not.toBeNull();
	});

	it('rides the usage curve card above the list — tokens, never money', async () => {
		backend.on('provider_usage', () => usageAnswer());
		mountProvidersPage(host());
		await flush();
		expect(document.querySelector('.prov-usage-card .usage-panel')).not.toBeNull();
		expect(document.querySelector('.usage-line')).not.toBeNull();
		// The range's total is token-shaped (1.2M + 12k + the small change), no currency.
		expect(texts('.prov-usage-card .usage-total')[0]).toContain('Total 1.2M');
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
		click(actionByTitle('Edit', rows()[1]!));
		await flush();
		let [name, baseUrl, model, smallModel, apiKey] = formInputs();
		expect(name.value).toBe('DeepSeek');
		expect(apiKey.placeholder).toContain('••••abcd');
		// A relabel and a new model, the key untouched: `apiKey: null` — keep.
		type(name, 'DeepSeek (team)');
		type(model, 'deepseek-flash');
		click(document.querySelector('.providers-form-actions .button.primary')!);
		await flush();
		expect(backend.callsTo('provider_save')).toEqual([{
			profile: {
				id: 'deepseek', preset: 'deepseek', label: 'DeepSeek (team)',
				baseUrl: 'https://api.deepseek.com/anthropic',
				model: 'deepseek-flash', smallModel: 'deepseek-flash',
				apiKey: null
			}
		}]);

		// Typed key: exactly what was typed, once, inside the save.
		click(actionByTitle('Edit', rows()[1]!));
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
		expect(model.value).toBe('deepseek-v4-pro');
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
		// The page follows the announced switch: DeepSeek is the active row now.
		expect(rows()[1]!.querySelector('.status')!.textContent).toContain('Active');
		// The active row offers no activate; the official row it displaced now does.
		expect(rows()[1]!.querySelector('[title="Activate"]')).toBeNull();
		expect(rows()[0]!.querySelector('[title="Activate"]')).not.toBeNull();
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
		expect(texts('.prov-row .status')[0]).toContain('Active');
	});

	it('deletes a profile behind a confirmation', async () => {
		backend.on('provider_delete', () => ({ ...providerListAnswer(), profiles: providerListAnswer().profiles.slice(0, 1) }));
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Delete', rows()[1]!));
		await flush();
		expect(backend.callsTo('provider_delete')).toEqual([]); // nothing before the confirm
		click(notificationButton('Delete'));
		await flush();
		expect(backend.callsTo('provider_delete')).toEqual([{ id: 'deepseek' }]);
		expect(texts('.prov-row .name')).toEqual(['Official Claude']);
	});

	it('shows a load failure with a retry that recovers', async () => {		let broken = true;
		backend.on('provider_list', () => {
			if (broken) throw new Error('the store is unreadable');
			return providerListAnswer();
		});
		mountProvidersPage(host());
		await flush();
		expect(texts('.prov-empty')[0]).toContain('Could not read the provider store');
		// Nothing re-throws when the store changes while broken — the page just re-renders.
		document.dispatchEvent(new CustomEvent('ggs:providers-changed'));
		await flush();

		broken = false;
		click(actionByTitle('Retry'));
		await flush();
		expect(texts('.prov-row .name')).toEqual(['Official Claude', 'DeepSeek']);
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
		expect(texts('.prov-row .status')[0]).toContain('Active'); // the official service starts active

		// Another window switched to DeepSeek and the backend pushed the change.
		answer = { ...providerListAnswer(), activeId: 'deepseek' };
		backend.emit('providers-changed', null);
		await flush();
		// Both surfaces followed without a reload: the page's active row and the chip.
		expect(rows()[1]!.querySelector('.status')!.textContent).toContain('Active');
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
		const quickRows = [...document.querySelectorAll('.quick-input .row')];
		click(quickRows[0]!); // the active one
		await flush();
		expect(backend.callsTo('provider_activate')).toEqual([]);
		dispose();
	});
});

describe('the token-usage curve', () => {
	beforeEach(async () => {
		await modules();
		resetProviderCacheForTests();
		backend.on('provider_list', () => providerListAnswer());
		backend.on('provider_usage', () => usageAnswer());
	});

	it('formats token counts without any money shape', () => {
		expect(formatTokens(0)).toBe('0');
		expect(formatTokens(999)).toBe('999');
		expect(formatTokens(1_200)).toBe('1.2k');
		expect(formatTokens(12_000)).toBe('12k');
		expect(formatTokens(1_234_000)).toBe('1.2M');
	});

	it('draws the range as a curve with its total, and switches today / 7 days / 30 days', async () => {
		const slot = host();
		const dispose = mountUsagePanel(slot);
		await flush();
		// The curve itself: one smooth line over the buckets, an area under it.
		expect(slot.querySelector('.usage-line')).not.toBeNull();
		expect((slot.querySelector('.usage-line') as SVGPathElement).getAttribute('d')).toMatch(/^M/);
		expect(slot.querySelector('.usage-area')).not.toBeNull();
		// Today's total: the midnight bucket's tokens alone (yesterday's day-bucket
		// totals land outside today's range).
		expect(texts('.usage-total')[0]).toBe('Total 1.2M');

		const ranges = [...slot.querySelectorAll<HTMLButtonElement>('.usage-range')];
		expect(ranges.map((button) => button.textContent)).toEqual(['Today', '7 days', '30 days']);
		click(ranges[1]!); // 7 days — yesterday's sprinkle joins the total
		await flush();
		expect(ranges[1]!.classList.contains('active')).toBe(true);
		expect(ranges[0]!.classList.contains('active')).toBe(false);
		expect(texts('.usage-total')[0]).toBe('Total 1.2M');
		click(ranges[2]!); // 30 days
		await flush();
		expect(ranges[2]!.classList.contains('active')).toBe(true);
		dispose();
	});

	it('hovers into the breakdown: cache hits, cache writes, uncached input, output — never money or durations', async () => {
		const slot = host();
		const dispose = mountUsagePanel(slot);
		await flush();
		const svg = slot.querySelector('.usage-chart svg')!;
		// A zero-width jsdom layout anchors the hover to the first bucket — today's
		// midnight, whose numbers the fixture shaped.
		svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0 }));
		await flush();
		const tooltip = slot.querySelector<HTMLElement>('.usage-tooltip')!;
		expect(tooltip.hidden).toBe(false);
		const rows = [...tooltip.querySelectorAll('.row')].map((row) => row.textContent);
		expect(rows[0]).toContain('Cache hits');
		expect(rows[0]).toContain('1.2M');
		expect(rows[1]).toContain('Cache writes');
		expect(rows[2]).toContain('Uncached input');
		expect(rows[3]).toContain('Output');
		expect(rows[3]).toContain('12k');
		// Nothing in the panel names money or durations anywhere.
		for (const text of [...texts('.usage-panel', slot), ...rows]) {
			expect(text).not.toMatch(/\$|¥|cost|USD|duration|ms\b/i);
		}
		svg.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
		expect(tooltip.hidden).toBe(true);
		dispose();
	});

	it('never flickers: the pointer crossing the tooltip\u2019s own box keeps the hover alive', async () => {
		const slot = host();
		const dispose = mountUsagePanel(slot);
		await flush();
		const svg = slot.querySelector('.usage-chart svg')!;
		svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0 }));
		await flush();
		const tooltip = slot.querySelector<HTMLElement>('.usage-tooltip')!;
		expect(tooltip.hidden).toBe(false);
		const title = tooltip.querySelector('.title')!;
		// A move inside the same bucket keeps the built tooltip — no per-pixel rebuild.
		svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 3 }));
		expect(tooltip.querySelector('.title')).toBe(title);
		// The flicker loop this pins: the tooltip overlays the chart, so the pointer lands
		// inside its box and the chart\u2019s own mouseleave fires — a move that arrives via
		// the tooltip itself must still drive the hover (the listeners ride the chart
		// host, of which the tooltip is a child), and re-entering shows it again.
		svg.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
		expect(tooltip.hidden).toBe(true);
		tooltip.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 4 }));
		expect(tooltip.hidden).toBe(false);
		expect(tooltip.querySelector('.title')?.textContent).toBeTruthy();
		// The other half of the fix: the tooltip is pointer-transparent, so a real
		// browser keeps targeting the chart under it (jsdom does no hit-testing — the
		// stylesheet carries the rule, pinned here; the vm pool's import.meta.url is no
		// file: URL, so the path rides the run's cwd).
		const css = readFileSync('src/shell.css', 'utf8');
		expect(css).toMatch(/\.usage-tooltip\s*\{[^}]*pointer-events:\s*none/);
		dispose();
	});

	it('says so when the range is empty, and reports a failed read with a working retry', async () => {
		let broken = false;
		backend.on('provider_usage', () => {
			if (broken) throw new Error('the transcripts are unreadable');
			return [];
		});
		const slot = host();
		const dispose = mountUsagePanel(slot);
		await flush();
		// No transcripts is a state, not a failure: the honest empty curve. (The panel
		// carries two .usage-empty rows — the error one and the empty one; only the
		// state that holds speaks.)
		const spoken = texts('.usage-empty', slot).filter((text) => text !== '');
		expect(spoken[0]).toContain('No token usage in this range');

		broken = true;
		document.dispatchEvent(new CustomEvent('ggs:providers-changed'));
		await flush();
		expect(texts('.usage-empty', slot).filter((text) => text !== '')[0]).toContain('Could not read the usage history');

		broken = false;
		backend.on('provider_usage', () => usageAnswer());
		click(slot.querySelector('.usage-empty .action-btn')!);
		await flush();
		expect(slot.querySelector('.usage-line')).not.toBeNull();
		dispose();
	});

	it('collapses in its compact form (the chat pane strip) without losing the data', async () => {
		const slot = host();
		const dispose = mountUsagePanel(slot, { compact: true });
		await flush();
		const body = slot.querySelector<HTMLElement>('.usage-body')!;
		expect(body.hidden).toBe(false);
		click(slot.querySelector('.usage-collapse')!);
		expect(body.hidden).toBe(true);
		click(slot.querySelector('.usage-collapse')!);
		expect(body.hidden).toBe(false);
		expect(slot.querySelector('.usage-line')).not.toBeNull(); // the redraw after expand
		dispose();
	});
});

describe('the chat pane gate (the login page it replaces)', () => {
	beforeEach(async () => {
		await modules();
		resetProviderCacheForTests();
		backend.on('provider_list', () => providerListAnswer());
		backend.on('provider_usage', () => usageAnswer());
	});

	it('shows the set-key page over a keyless third-party provider, and the strip once the key lands', async () => {
		backend.on('provider_list', () => keylessListAnswer());
		backend.on('provider_save', ({ profile }) => {
			// The save answers the store the backend would: the key present, the
			// provider still the active one.
			expect(profile['apiKey']).toBe('sk-typed-once');
			return { ...providerListAnswer(), activeId: 'deepseek' };
		});
		const pane = host();
		const dispose = mountProviderPaneGate('Anthropic.claude-code', pane);
		await flush();

		const gate = pane.querySelector<HTMLElement>('.provider-gate')!;
		expect(gate).not.toBeNull();
		expect(gate.textContent).toContain('Set the DeepSeek API key');
		const key = gate.querySelector<HTMLInputElement>('input')!;
		expect(key.type).toBe('password');

		type(key, 'sk-typed-once');
		click([...gate.querySelectorAll<HTMLElement>('.button')].find((button) => button.textContent === 'Save & Open Chat')!);
		await flush();
		// The save carried the whole active profile with the typed key — the backend's
		// restart rides the same env change.
		const saved = backend.callsTo('provider_save')[0]!.profile as Record<string, unknown>;
		expect(saved).toMatchObject({
			id: 'deepseek', preset: 'deepseek', label: 'DeepSeek',
			baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-typed-once'
		});
		// The announced store flipped the gate into the usage strip, by itself.
		expect(pane.querySelector('.provider-gate')).toBeNull();
		expect(pane.querySelector('.provider-usage-strip')).not.toBeNull();
		expect(pane.querySelector('.usage-panel')).not.toBeNull();
		dispose();
	});

	it('carries the usage strip above the chat while a keyed provider is active', async () => {
		backend.on('provider_list', () => ({ ...providerListAnswer(), activeId: 'deepseek' }));
		const pane = host();
		const dispose = mountProviderPaneGate('Anthropic.claude-code', pane);
		await flush();
		expect(pane.querySelector('.provider-gate')).toBeNull();
		expect(pane.querySelector('.provider-usage-strip')).not.toBeNull();
		dispose();
		// The strip's teardown returns the pane to the chat alone.
		await flush();
		expect(pane.querySelector('.provider-usage-strip')).toBeNull();
	});

	it('never gates the official service, a keyless custom gateway, or another extension', async () => {
		backend.on('provider_list', () => ({
			...keylessListAnswer(),
			profiles: [
				...(keylessListAnswer().profiles as Record<string, unknown>[]).slice(0, 1),
				{ id: 'gateway', preset: 'custom', label: 'Local proxy', baseUrl: 'http://127.0.0.1:8080', model: 'glm-5.3', smallModel: null, hasKey: false, keyHint: null }
			],
			activeId: 'gateway'
		}));
		const bridged = host();
		const other = host();
		const disposeBridged = mountProviderPaneGate('Anthropic.claude-code', bridged);
		const disposeOther = mountProviderPaneGate('some.other.ext', other);
		await flush();
		// A keyless custom gateway may be exactly how the chat runs — no gate over it.
		expect(bridged.querySelector('.provider-gate')).toBeNull();
		expect(bridged.querySelector('.provider-usage-strip')).toBeNull();
		// And the official service needs a sign-in, not a key.
		backend.on('provider_list', () => providerListAnswer());
		document.dispatchEvent(new CustomEvent('ggs:providers-changed'));
		await flush();
		expect(bridged.querySelector('.provider-gate')).toBeNull();
		// Another extension's pane is never the bridge's to gate, whatever the store.
		expect(other.querySelector('.provider-gate')).toBeNull();
		expect(other.querySelector('.provider-usage-strip')).toBeNull();
		disposeBridged();
		disposeOther();
	});
});

describe('the gateway tools and the cc-switch import', () => {
	beforeEach(async () => {
		await modules();
		resetProviderCacheForTests();
		backend.on('provider_list', () => providerListAnswer());
		backend.on('provider_usage', () => []);
	});

	function openEditForm(): void {
		click(actionByTitle('Edit', rows()[1]!));
	}

	it('tests the connection and renders the probe report on the form', async () => {
		backend.on('provider_test_connection', ({ baseUrl, apiKey, profileId, model }) => {
			expect(baseUrl).toBe('https://api.deepseek.com/anthropic');
			// An untouched key field falls back to the profile's stored key, backend-side.
			expect(apiKey).toBe('');
			expect(profileId).toBe('deepseek');
			expect(model).toBe('deepseek-v4-pro');
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
		const quickRows = [...document.querySelectorAll('.quick-input .row')];
		expect(quickRows.map((row) => row.querySelector('.label')!.textContent)).toEqual(
			['glm-4.6', 'claude-sonnet-4-5', 'deepseek-r1']);
		click(quickRows[2]!);
		await flush();
		const model = [...document.querySelectorAll('.providers-form input.input')][2]!;
		expect(model.value).toBe('deepseek-r1');
	});

	it('offers every model box its own dropdown — a pick lands in that field alone', async () => {
		mountProvidersPage(host());
		await flush();
		openEditForm();
		await flush();
		// Both model boxes (model, background model) carry a dropdown over their input.
		const combos = [...document.querySelectorAll('.providers-combo')];
		expect(combos.length).toBe(2);
		click(combos[0]!.querySelector('.action-btn')!);
		await flush();
		let quickRows = [...document.querySelectorAll('.quick-input .row')];
		expect(quickRows.map((row) => row.querySelector('.label')!.textContent)).toEqual(
			['deepseek-v4-pro', 'deepseek-flash']);
		click(quickRows[1]!); // the main model
		await flush();
		// The pick did not re-render the form (the other box's button stays live), and
		// writing the main model leaves the background model untouched.
		click(combos[1]!.querySelector('.action-btn')!);
		await flush();
		quickRows = [...document.querySelectorAll('.quick-input .row')];
		click(quickRows[0]!); // the background model
		await flush();
		const [, , model, smallModel] = formInputs();
		expect(model.value).toBe('deepseek-flash');
		expect(smallModel.value).toBe('deepseek-v4-pro');
		// The picks travel into the save.
		click(document.querySelector('.providers-form-actions .button.primary')!);
		await flush();
		const profile = backend.callsTo('provider_save')[0]!.profile as Record<string, unknown>;
		expect(profile).toMatchObject({ model: 'deepseek-flash', smallModel: 'deepseek-v4-pro' });
	});

	it('offers the GLM preset its current lineup without any fetch — and the fetched catalogue rides first', async () => {
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Add Provider'));
		await flush();
		const select = document.querySelector<HTMLSelectElement>('.providers-field select')!;
		select.value = 'glm';
		select.dispatchEvent(new Event('change'));
		await flush();
		// The draft took the preset's head: the current flagship main, its Flash variant
		// as the background model — no manual typing anywhere.
		const [, , model, smallModel] = formInputs();
		expect(model.value).toBe('glm-5.3');
		expect(smallModel.value).toBe('glm-5.3-flash');
		// The dropdown carries the preset's whole list.
		click(document.querySelectorAll('.providers-combo .action-btn')[0]!);
		await flush();
		let quickRows = [...document.querySelectorAll('.quick-input .row')];
		expect(quickRows.map((row) => row.querySelector('.label')!.textContent)).toEqual(
			['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx']);
		click(quickRows[2]!);
		await flush();
		expect(formInputs()[2]!.value).toBe('glm-5.3-flashx');

		// A fetch merges the endpoint's live catalogue ahead of the preset list — the
		// re-render the fetch triggers rebuilds the boxes over the merged candidates.
		backend.on('provider_fetch_models', () => ['glm-5.4', 'glm-5.3']);
		click(actionByTitle('Fetch Models'));
		await flush();
		const fetchRows = [...document.querySelectorAll('.quick-input .row')];
		expect(fetchRows.map((row) => row.querySelector('.label')!.textContent)).toEqual(
			['glm-5.4', 'glm-5.3']);
		click(fetchRows[0]!);
		await flush();
		expect(formInputs()[2]!.value).toBe('glm-5.4');
		click(document.querySelectorAll('.providers-combo .action-btn')[1]!);
		await flush();
		const merged = [...document.querySelectorAll('.quick-input .row')];
		expect(merged.map((row) => row.querySelector('.label')!.textContent)).toEqual(
			['glm-5.4', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx']);
	});

	it('shows no dropdown when nothing is known yet — the custom preset before any fetch', async () => {
		mountProvidersPage(host());
		await flush();
		click(actionByTitle('Add Provider'));
		await flush();
		const select = document.querySelector<HTMLSelectElement>('.providers-field select')!;
		select.value = 'custom';
		select.dispatchEvent(new Event('change'));
		await flush();
		expect(document.querySelectorAll('.providers-combo .action-btn').length).toBe(0);
		expect(document.querySelectorAll('.providers-combo').length).toBe(2); // the inputs stay
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
