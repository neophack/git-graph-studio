// The Model Providers page (module 12): the management half of the AI provider bridge —
// the profiles (`aiProviders.ts` is the store client), one row each, with the add /
// edit form (preset, endpoint, model ids, the API key that travels once into the
// backend's seal), activate, delete, and the storage notes: everything lives under
// ~/.ggs, the key is AES-256-GCM sealed at rest and decrypted only when the bridged
// backend spawns, and a switch restarts that backend. Opened as an editor tab (the
// `ai.providers` command, the sidebar chip's "Configure Providers…" entry); a lazy
// chunk, like the self-test and analysis pages.

import { t, tf } from './i18n';
import { actionButton, confirmDialog, el, icon, notify, quickPick } from './ui';
import {
	PROVIDERS_CHANGED_EVENT,
	activateProvider,
	cachedProviders,
	deleteProvider,
	describeProvider,
	draftFromPreset,
	fetchGatewayModels,
	importCcSwitch,
	loadProviders,
	saveProvider,
	scanCcSwitch,
	testGatewayConnection,
	type ConnectionReport,
	type ProviderDraft,
	type ProviderList,
	type ProviderPreset,
	type ProviderProfile
} from './aiProviders';

/** The built-in presets' display names (the backend's English labels are the fallback
 *  for a preset this build does not know). */
const PRESET_LABELS: Record<string, () => string> = {
	official: () => t('providers.preset.official'),
	deepseek: () => t('providers.preset.deepseek'),
	glm: () => t('providers.preset.glm'),
	kimi: () => t('providers.preset.kimi'),
	newapi: () => t('providers.preset.newapi'),
	custom: () => t('providers.preset.custom')
};

function presetLabel(preset: ProviderPreset): string {
	return (PRESET_LABELS[preset.id] ?? (() => preset.label))();
}

/** Mount the page into its editor tab's pane. Returns the disposer the tab's close
 *  runs (the store-change listener must not outlive the page). */
export function mountProvidersPage(container: HTMLElement): () => void {
	return new ProvidersPage(container).dispose;
}

class ProvidersPage {
	private readonly body: HTMLElement;
	private list: ProviderList | null = null;
	private failed = false;
	private editing: ProviderDraft | null = null;
	/** The form's key field, tracked beside the draft: untouched keeps the stored key
	 *  (`null` over the seam), touched sends what it holds (an empty string clears). */
	private keyValue = '';
	private keyTouched = false;
	/** The gateway probe's last answer (the form's result line). */
	private testResult: ConnectionReport | 'testing' | 'error' | null = null;
	private testError = '';
	/** The model catalogue a Fetch brought in (the model fields' placeholder). */
	private fetchedModels: string[] = [];

	/** The store changed under us (a switch from the sidebar chip, another window):
	 *  follow it while the tab lives; the disposer ends the listening. */
	private readonly onStoreChange = (): void => {
		this.list = cachedProviders();
		this.render();
	};

	constructor(private readonly container: HTMLElement) {
		container.classList.add('an-page', 'providers-page');
		container.appendChild(el('div', 'an-header', [
			icon('cloud'),
			el('span', 'an-title', [t('providers.title')]),
			el('div', 'actions', [
				actionButton('cloud-download', t('providers.import'), () => void this.importCcSwitch()),
				actionButton('add', t('providers.add'), () => this.startAdd())
			])
		]));
		this.body = el('div', 'an-list');
		container.appendChild(this.body);
		document.addEventListener(PROVIDERS_CHANGED_EVENT, this.onStoreChange);
		this.list = cachedProviders();
		this.render();
		if (this.list === null) void this.load();
	}

	/** The tab's disposer (wired to `Editor.onClose`): drop the store listener. */
	dispose = (): void => {
		document.removeEventListener(PROVIDERS_CHANGED_EVENT, this.onStoreChange);
	};

	private async load(): Promise<void> {
		this.failed = false;
		this.render();
		const list = await loadProviders(true);
		if (list === null) this.failed = true;
		else this.list = list;
		this.render();
	}

	/** A fresh form carries none of the previous form's probe state. */
	private resetFormProbeState(): void {
		this.keyValue = '';
		this.keyTouched = false;
		this.testResult = null;
		this.testError = '';
		this.fetchedModels = [];
	}

	private startAdd(): void {
		const presets = this.list?.presets ?? [];
		const preset = presets.find((candidate) => !candidate.official && candidate.id !== 'custom')
			?? presets.find((candidate) => candidate.id === 'custom')
			?? presets[0];
		if (!preset) return;
		this.resetFormProbeState();
		this.editing = draftFromPreset(preset, new Set((this.list?.profiles ?? []).map((profile) => profile.id)));
		this.render();
	}

	private startEdit(profile: ProviderProfile): void {
		this.resetFormProbeState();
		this.editing = {
			id: profile.id,
			preset: profile.preset,
			label: profile.label,
			baseUrl: profile.baseUrl ?? '',
			model: profile.model ?? '',
			smallModel: profile.smallModel ?? '',
			apiKey: null
		};
		this.render();
	}

	private async remove(profile: ProviderProfile): Promise<void> {
		if (!(await confirmDialog(tf('providers.deleteConfirm', profile.label), t('providers.delete')))) return;
		const list = await deleteProvider(profile.id);
		if (list !== null) notify('info', tf('providers.deleted', profile.label));
	}

	/** The cc-switch migration: scan (keys stay in the backend), confirm, import. The
	 *  candidate cc-switch points at is activated by the import itself. */
	private async importCcSwitch(): Promise<void> {
		let candidates;
		try {
			candidates = await scanCcSwitch();
		} catch (error) {
			notify('error', t('providers.scanFailed') + String(error));
			return;
		}
		if (candidates.length === 0) {
			notify('info', t('providers.ccswitch.none'));
			return;
		}
		const names = candidates.map((candidate) => candidate.label).join(' · ');
		if (!(await confirmDialog(tf('providers.ccswitch.confirm', String(candidates.length), names), t('providers.import')))) return;
		const list = await importCcSwitch(candidates.map((candidate) => candidate.id));
		if (list !== null) notify('info', tf('providers.ccswitch.imported', String(candidates.length)));
	}

	/** The probes' key arguments: an empty apiKey makes the backend fall back to the
	 *  named profile's stored key — an edit of an existing provider tests with the
	 *  key it already has. */
	private probeArgs(): { apiKey: string; profileId: string | null } {
		return { apiKey: this.keyTouched ? this.keyValue : '', profileId: this.editing?.id ?? null };
	}

	/** Test Connection: the probe's report rendered on the form's result line. */
	private async runTest(): Promise<void> {
		if (this.editing === null) return;
		this.testResult = 'testing';
		this.render();
		const { apiKey, profileId } = this.probeArgs();
		try {
			this.testResult = await testGatewayConnection(this.editing.baseUrl, apiKey, this.editing.model, profileId);
		} catch (error) {
			this.testResult = 'error';
			this.testError = String(error);
		}
		this.render();
	}

	/** Fetch Models: the gateway's catalogue becomes the model fields' pick list,
	 *  and a quick pick lands the main model in one click. */
	private async runFetchModels(): Promise<void> {
		if (this.editing === null) return;
		const { apiKey, profileId } = this.probeArgs();
		let models: string[];
		try {
			models = await fetchGatewayModels(this.editing.baseUrl, apiKey, profileId);
		} catch (error) {
			notify('error', t('providers.models.failed') + String(error));
			return;
		}
		if (models.length === 0) {
			notify('info', t('providers.models.empty'));
			return;
		}
		this.fetchedModels = models;
		// Re-render before the pick: the fields' dropdowns must already carry the
		// catalogue, whatever the pick below does (a dismissed pick leaves it there).
		this.render();
		const picked = await quickPick(
			models.map((id) => ({ label: id, value: id })),
			t('providers.models.pick'),
			t('providers.model')
		);
		if (picked !== null && this.editing !== null) {
			this.editing.model = picked;
			if (!this.editing.smallModel) this.editing.smallModel = picked;
			this.render();
		}
	}

	private async submit(): Promise<void> {
		if (this.editing === null) return;
		const list = await saveProvider({ ...this.editing, apiKey: this.keyTouched ? this.keyValue : null });
		if (list === null) return; // the backend's message is already in a notification
		this.editing = null;
		notify('info', t('providers.saved'));
		this.render();
	}

	render(): void {
		this.body.replaceChildren();
		if (this.editing !== null) {
			this.renderForm();
			return;
		}
		if (this.failed) {
			const row = el('div', 'an-empty', [
				t('providers.loadFailed') + ' ',
				actionButton('refresh', t('providers.retry'), () => void this.load())
			]);
			this.body.appendChild(row);
			return;
		}
		if (this.list === null) {
			this.body.appendChild(el('div', 'an-empty', [`${t('providers.loading')}…`]));
			return;
		}
		if (this.list.profiles.length === 0) {
			this.body.appendChild(el('div', 'an-empty', [t('providers.empty')]));
			return;
		}
		this.body.appendChild(el('div', 'an-section', [t('providers.section.profiles')]));
		for (const profile of this.list.profiles) this.body.appendChild(this.renderRow(profile));
		for (const note of ['providers.note.state', 'providers.note.key', 'providers.note.restart'] as const) {
			this.body.appendChild(el('div', 'an-empty an-note', [t(note)]));
		}
	}

	private renderRow(profile: ProviderProfile): HTMLElement {
		const active = profile.id === this.list?.activeId;
		const row = el('div', `an-row${active ? ' provider-row-active' : ''}`);
		row.append(
			icon(profile.preset === 'official' ? 'rocket' : 'globe'),
			el('span', 'label', [profile.label]),
			el('span', 'description', [describeProvider(profile)]),
			el('span', 'tail', [active ? t('providers.active') : ''])
		);
		const actions = el('span', 'tail actions');
		if (!active) actions.appendChild(actionButton('play', t('providers.activate'), () => void activateProvider(profile.id)));
		actions.appendChild(actionButton('edit', t('providers.edit'), () => this.startEdit(profile)));
		if (profile.preset !== 'official') actions.appendChild(actionButton('trash', t('providers.delete'), () => void this.remove(profile)));
		row.appendChild(actions);
		return row;
	}

	/** The add / edit form. The official preset carries no endpoint — its fields stay
	 *  off the form entirely. */
	private renderForm(): void {
		const draft = this.editing!;
		const presets = this.list?.presets ?? [];
		const official = presets.find((preset) => preset.id === draft.preset)?.official ?? draft.preset === 'official';
		const form = el('div', 'providers-form');

		const presetRow = el('div', 'providers-field', [el('label', '', [t('providers.preset')])]);
		const presetSelect = el('select', 'input') as HTMLSelectElement;
		for (const preset of presets) {
			const option = el('option') as HTMLOptionElement;
			option.value = preset.id;
			option.textContent = presetLabel(preset);
			presetSelect.appendChild(option);
		}
		presetSelect.value = draft.preset;
		// Changing the preset refills the endpoint fields from its shape — the natural
		// "switch DeepSeek → GLM" flow keeps the record's id and the user's name, and
		// clears the key field.
		presetSelect.addEventListener('change', () => {
			const next = presets.find((preset) => preset.id === presetSelect.value);
			if (!next) return;
			this.resetFormProbeState();
			const refilled = draftFromPreset(next, new Set());
			this.editing = { ...refilled, id: draft.id, label: draft.label };
			this.render();
		});
		presetRow.appendChild(presetSelect);
		form.appendChild(presetRow);

		form.appendChild(this.field('providers.label', draft.label, (value) => {
			draft.label = value;
		}));
		if (!official) {
			form.appendChild(this.field('providers.baseUrl', draft.baseUrl, (value) => {
				draft.baseUrl = value;
			}, draft.preset === 'newapi' ? 'https://your-newapi.example.com' : 'https://api.example.com/anthropic'));
			const models = this.candidateModels();
			const hint = models.length > 0 ? models.join('  ·  ') : undefined;
			form.appendChild(this.modelField('providers.model', draft.model, (value) => {
				draft.model = value;
			}, models, hint));
			form.appendChild(this.modelField('providers.smallModel', draft.smallModel, (value) => {
				draft.smallModel = value;
			}, models, hint));

			// The gateway tools: one probe (its report on the result line below) and the
			// catalogue fetch. Both ride the form's endpoint, not the stored profile's.
			const tools = el('div', 'providers-form-actions');
			tools.appendChild(actionButton('plug', t('providers.test'), () => void this.runTest()));
			tools.appendChild(actionButton('list-tree', t('providers.fetchModels'), () => void this.runFetchModels()));
			form.appendChild(tools);
			form.appendChild(this.renderTestResult());

			const keyRow = el('div', 'providers-field', [el('label', '', [t('providers.apiKey')])]);
			const existing = this.list?.profiles.find((profile) => profile.id === draft.id);
			const key = el('input', 'input') as HTMLInputElement;
			key.type = 'password';
			key.spellcheck = false;
			key.placeholder = existing?.hasKey
				? tf('providers.apiKey.keep', `••••${existing.keyHint ?? ''}`)
				: t('providers.apiKey.placeholder');
			key.value = this.keyValue;
			key.addEventListener('input', () => {
				this.keyValue = key.value;
				this.keyTouched = true;
			});
			keyRow.appendChild(key);
			form.appendChild(keyRow);
		}

		const buttons = el('div', 'providers-form-actions');
		const save = el('button', 'button primary', [t('providers.save')]);
		save.addEventListener('click', () => void this.submit());
		const cancel = el('button', 'button secondary', [t('providers.cancel')]);
		cancel.addEventListener('click', () => {
			this.editing = null;
			this.render();
		});
		buttons.append(save, cancel);
		form.appendChild(buttons);
		this.body.appendChild(el('div', 'an-section', [draft.id && this.list?.profiles.some((p) => p.id === draft.id) ? t('providers.edit.title') : t('providers.add')]));
		this.body.appendChild(form);
	}

	/** One labelled text field bound to the draft. */
	private field(labelKey: 'providers.label' | 'providers.baseUrl', value: string, onInput: (value: string) => void, placeholder?: string): HTMLElement {
		const row = el('div', 'providers-field', [el('label', '', [t(labelKey)])]);
		const input = el('input', 'input') as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.value = value;
		if (placeholder !== undefined) input.placeholder = placeholder;
		input.addEventListener('input', () => onInput(input.value));
		row.appendChild(input);
		return row;
	}

	/** The model ids both model fields offer as their pick list: the gateway's fetched
	 *  catalogue first (the endpoint's live truth), then the preset's suggestions,
	 *  deduplicated. */
	private candidateModels(): string[] {
		const presetModels = this.list?.presets.find((preset) => preset.id === this.editing?.preset)?.models ?? [];
		const merged: string[] = [];
		for (const id of [...this.fetchedModels, ...presetModels]) {
			if (!merged.includes(id)) merged.push(id);
		}
		return merged;
	}

	/** One model field: free text over a pick list. The dropdown rides the candidate
	 *  models (preset suggestions plus whatever a Fetch brought in); typing stays
	 *  possible — the catalogues move faster than any app's list. */
	private modelField(labelKey: 'providers.model' | 'providers.smallModel', value: string, onInput: (value: string) => void, candidates: string[], placeholder?: string): HTMLElement {
		const row = el('div', 'providers-field', [el('label', '', [t(labelKey)])]);
		const combo = el('div', 'providers-combo');
		const input = el('input', 'input') as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.value = value;
		if (placeholder !== undefined) input.placeholder = placeholder;
		input.addEventListener('input', () => onInput(input.value));
		combo.appendChild(input);
		if (candidates.length > 0) {
			combo.appendChild(actionButton('chevron-down', t('providers.model.pick'), () => {
				void (async () => {
					const picked = await quickPick(
						candidates.map((id) => ({ label: id, value: id })),
						t('providers.model.pick'),
						t(labelKey)
					);
					// The form may have re-rendered (or closed) while the pick was open —
					// a detached input keeps its value harmlessly, but the draft stays.
					if (picked === null) return;
					onInput(picked);
					if (input.isConnected) input.value = picked;
				})();
			}));
		}
		row.appendChild(combo);
		return row;
	}

	/** The Test Connection line: the probe's report, or the transport error, or
	 *  nothing yet. */
	private renderTestResult(): HTMLElement {
		const line = el('div', 'providers-test-result');
		if (this.testResult === 'testing') {
			line.textContent = `${t('providers.testing')}…`;
		} else if (this.testResult === 'error') {
			line.textContent = this.testError;
			line.classList.add('providers-test-bad');
		} else if (this.testResult !== null) {
			const report = this.testResult;
			line.textContent = report.ok
				? tf('providers.test.ok', String(report.ms))
				: `${t('providers.test.problem')} ${report.message}`;
			line.classList.add(report.ok ? 'providers-test-ok' : 'providers-test-bad');
		} else {
			line.hidden = true;
		}
		return line;
	}
}
