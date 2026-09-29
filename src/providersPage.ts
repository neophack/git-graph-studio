// The Model Providers page (module 12): the management half of the AI provider bridge —
// the profiles (`aiProviders.ts` is the store client), one row each, with the add /
// edit form (preset, endpoint, model ids, the API key that travels once into the
// backend's seal), activate, delete, and the storage notes: everything lives under
// ~/.ggs, the key is AES-256-GCM sealed at rest and decrypted only when the bridged
// backend spawns, and a switch restarts that backend. Opened as an editor tab (the
// `ai.providers` command, the sidebar chip's "Configure Providers…" entry); a lazy
// chunk, like the self-test and analysis pages.

import { t, tf } from './i18n';
import { actionButton, confirmDialog, el, icon, notify } from './ui';
import {
	PROVIDERS_CHANGED_EVENT,
	activateProvider,
	cachedProviders,
	deleteProvider,
	describeProvider,
	draftFromPreset,
	loadProviders,
	saveProvider,
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
			el('div', 'actions', [actionButton('add', t('providers.add'), () => this.startAdd())])
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

	private startAdd(): void {
		const presets = this.list?.presets ?? [];
		const preset = presets.find((candidate) => !candidate.official && candidate.id !== 'custom')
			?? presets.find((candidate) => candidate.id === 'custom')
			?? presets[0];
		if (!preset) return;
		this.keyValue = '';
		this.keyTouched = false;
		this.editing = draftFromPreset(preset, new Set((this.list?.profiles ?? []).map((profile) => profile.id)));
		this.render();
	}

	private startEdit(profile: ProviderProfile): void {
		this.keyValue = '';
		this.keyTouched = false;
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
			this.keyValue = '';
			this.keyTouched = false;
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
			}, 'https://api.example.com/anthropic'));
			const models = presets.find((preset) => preset.id === draft.preset)?.models ?? [];
			const hint = models.length > 0 ? models.join('  ·  ') : undefined;
			form.appendChild(this.field('providers.model', draft.model, (value) => {
				draft.model = value;
			}, hint));
			form.appendChild(this.field('providers.smallModel', draft.smallModel, (value) => {
				draft.smallModel = value;
			}, hint));

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
	private field(labelKey: 'providers.label' | 'providers.baseUrl' | 'providers.model' | 'providers.smallModel', value: string, onInput: (value: string) => void, placeholder?: string): HTMLElement {
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
}
