// The AI provider bridge's frontend half (module 12): the model providers a bridged
// extension's backend runs under — the official Claude service or any
// Anthropic-compatible endpoint (DeepSeek, Zhipu GLM, Moonshot Kimi, a custom
// gateway). Everything lives in the backend's store under `~/.ggs/` (never Claude
// Code's own `~/.claude`), the API key sealed with AES-256-GCM and decrypted only at
// the backend's spawn; the plaintext never crosses this seam. This half is the store
// client (list / save / delete / activate), the sidebar switcher chip the claude view's
// header carries (quick pick: switch provider, or open the management page), and the
// `bridgedExtIds` knowledge — the app here names no extension id, the backend's answer
// says whose sidebar sections get the chip.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { commands } from './commands';
import { t, tf } from './i18n';
import { el, icon, notify, quickPick, type QuickPickItem } from './ui';

export interface ProviderProfile {
	id: string;
	preset: string;
	label: string;
	baseUrl: string | null;
	model: string | null;
	smallModel: string | null;
	hasKey: boolean;
	keyHint: string | null;
}

export interface ProviderPreset {
	id: string;
	label: string;
	official: boolean;
	baseUrl: string | null;
	models: string[];
}

export interface ProviderList {
	activeId: string | null;
	profiles: ProviderProfile[];
	presets: ProviderPreset[];
	/** The extension ids whose backends run under the active provider — the UI's
	 *  switcher affordances key on this, so the frontend names no extension id. */
	bridgedExtIds: string[];
}

/** One save's payload. `apiKey` is the only secret-bearing field and it travels once,
 *  into the backend's seal: `null` keeps the stored key, `''` clears it, a value
 *  replaces it. */
export interface ProviderDraft {
	id: string;
	preset: string;
	label: string;
	baseUrl: string;
	model: string;
	smallModel: string;
	apiKey: string | null;
}

/** Dispatched on document whenever the cached list changed (a save, delete or activate
 *  landed, here or in another window through the backend event). */
export const PROVIDERS_CHANGED_EVENT = 'ggs:providers-changed';

/** The backend's push of the same (`cmd_providers` emits it after a switch restarted
 *  the bridged backend): a switch in one window updates the chip in another. */
const BACKEND_PROVIDERS_EVENT = 'providers-changed';

/** A defaulting test layer (or a degraded backend) answers null — an empty store, not
 *  a render crash. */
function providersOrEmpty(list: ProviderList | null): ProviderList {
	return list ?? { activeId: null, profiles: [], presets: [], bridgedExtIds: [] };
}

let cache: ProviderList | null = null;
let loading: Promise<ProviderList | null> | null = null;

/** The last loaded store (null before the first load, and after a failed one). */
export function cachedProviders(): ProviderList | null {
	return cache;
}

/** The tests' isolation seam (the frontend counterpart of the backend's pinned store
 *  home): drop the cache so the next suite loads against its own scripted answers. */
export function resetProviderCacheForTests(): void {
	cache = null;
	loading = null;
}

export async function loadProviders(force = false): Promise<ProviderList | null> {
	if (cache !== null && !force) return cache;
	if (!force && loading !== null) return loading;
	loading = (async () => {
		try {
			const list = providersOrEmpty(await invoke<ProviderList | null>('provider_list'));
			// A changed answer announces itself — every surface (the page, the chips)
			// follows one propagation mechanism, whichever of them happened to refresh
			// (the backend's push lands on one window's chip; the page hears the echo).
			const changed = JSON.stringify(list) !== JSON.stringify(cache);
			cache = list;
			if (changed) document.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT, { bubbles: true }));
		} catch {
			// A load failure is not the user's action to be told about — the chip stays
			// hidden and the page shows its own error with a retry.
			return null;
		} finally {
			loading = null;
		}
		return cache;
	})();
	return loading;
}

function announce(list: ProviderList | null): void {
	cache = list;
	document.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT, { bubbles: true }));
}

export async function saveProvider(draft: ProviderDraft): Promise<ProviderList | null> {
	try {
		const list = await invoke<ProviderList | null>('provider_save', {
			profile: {
				id: draft.id,
				preset: draft.preset,
				label: draft.label,
				baseUrl: draft.baseUrl,
				model: draft.model,
				smallModel: draft.smallModel,
				apiKey: draft.apiKey
			}
		});
		announce(providersOrEmpty(list));
		return cache;
	} catch (error) {
		notify('error', t('providers.saveFailed') + String(error));
		return null;
	}
}

export async function deleteProvider(id: string): Promise<ProviderList | null> {
	try {
		const list = await invoke<ProviderList | null>('provider_delete', { id });
		announce(providersOrEmpty(list));
		return cache;
	} catch (error) {
		notify('error', t('providers.deleteFailed') + String(error));
		return null;
	}
}

/** Make one profile the provider the bridged backend runs under. The backend restarts
 *  the bridged extension's process so the new endpoint takes effect. */
export async function activateProvider(id: string): Promise<ProviderList | null> {
	try {
		const list = await invoke<ProviderList | null>('provider_activate', { id });
		announce(providersOrEmpty(list));
		const label = cache?.profiles.find((profile) => profile.id === id)?.label ?? id;
		notify('info', tf('providers.switched', label));
		return cache;
	} catch (error) {
		notify('error', t('providers.activateFailed') + String(error));
		return null;
	}
}

/** The chip's label: the active profile's name (the official service when nothing
 *  third-party is active). */
export function activeProviderLabel(list: ProviderList): string {
	const active = list.profiles.find((profile) => profile.id === list.activeId);
	if (!active || active.preset === 'official') return t('providers.preset.official');
	return active.label;
}

/** A profile's one-line description: the endpoint and model for a third-party profile,
 *  the sign-in hint for the official one. */
export function describeProvider(profile: ProviderProfile): string {
	if (profile.preset === 'official') return t('providers.official.description');
	const parts = [profile.baseUrl ?? '', profile.model ?? ''];
	if (profile.hasKey) parts.push(`••••${profile.keyHint ?? ''}`);
	else parts.push(t('providers.noKey'));
	return parts.filter((part) => part !== '').join(' · ');
}

/** The preset switch the Add flow pre-fills a draft from (endpoint, models). */
export function draftFromPreset(preset: ProviderPreset, takenIds: Set<string>): ProviderDraft {
	let id = preset.id;
	if (preset.id !== 'official') {
		let suffix = 2;
		while (takenIds.has(id)) id = `${preset.id}-${suffix++}`;
	}
	return {
		id,
		preset: preset.id,
		label: preset.id === 'official' ? t('providers.preset.official') : preset.label,
		baseUrl: preset.baseUrl ?? '',
		model: preset.models[0] ?? '',
		smallModel: preset.models[1] ?? preset.models[0] ?? '',
		apiKey: null
	};
}

/* ---------- The gateway probes and the cc-switch import ---------- */

/** One provider configuration found on this machine's cc-switch (or live Claude)
 *  configuration — the scan's answer, keys stripped (a `hasKey` flag stands in for
 *  what the import seals backend-side). */
export interface CcSwitchCandidate {
	id: string;
	label: string;
	baseUrl: string | null;
	model: string | null;
	hasKey: boolean;
	/** The configuration cc-switch (or Claude Code itself) currently points at. */
	current: boolean;
	/** Where it was found: `cc-switch` or `claude`. */
	source: string;
}

/** The connectivity probe's answer: reachability, the HTTP status, the round trip and
 *  a diagnosis the page renders verbatim. */
export interface ConnectionReport {
	ok: boolean;
	status: number;
	ms: number;
	message: string;
}

/** What a cc-switch (or live Claude) configuration on this machine would contribute.
 *  Missing files answer empty — the app may run where neither exists. */
export async function scanCcSwitch(): Promise<CcSwitchCandidate[]> {
	return (await invoke<CcSwitchCandidate[] | null>('provider_ccswitch_scan')) ?? [];
}

/** Import the named candidates (their keys are sealed in the backend, never crossing
 *  back). The candidate cc-switch points at is activated, which may restart the
 *  bridged backend; the changed store announces itself. */
export async function importCcSwitch(names: string[]): Promise<ProviderList | null> {
	try {
		const list = await invoke<ProviderList | null>('provider_import_ccswitch', { names });
		announce(providersOrEmpty(list));
		return cache;
	} catch (error) {
		notify('error', t('providers.ccswitch.importFailed') + String(error));
		return null;
	}
}

/** The gateway's model catalogue (`/v1/models`) for the form's suggestions. An empty
 *  `apiKey` makes the backend fall back to the named profile's stored key. Throws —
 *  the caller renders the failure inline, next to the button that asked. */
export async function fetchGatewayModels(baseUrl: string, apiKey: string, profileId: string | null): Promise<string[]> {
	const models = await invoke<string[] | null>('provider_fetch_models', { baseUrl, apiKey, profileId });
	return models ?? [];
}

/** The one-shot `/v1/messages` probe. Any HTTP answer is a report (a 401 is a
 *  diagnosis, not a crash); only a transport failure throws. */
export async function testGatewayConnection(baseUrl: string, apiKey: string, model: string, profileId: string | null): Promise<ConnectionReport> {
	return await invoke<ConnectionReport>('provider_test_connection', { baseUrl, apiKey, model, profileId });
}

/* ---------- The sidebar switcher ---------- */

/** The provider chip a bridged extension's sidebar section header carries: the active
 *  provider's name, one click away from the quick pick (switch, or open the management
 *  page). Hidden until the backend's `bridgedExtIds` names the extension — every other
 *  extension's section never sees it. Returns the disposer the workbench's section
 *  rebuild calls. */
export function mountProviderSwitcher(extId: string, host: HTMLElement): () => void {
	const label = el('span', 'label');
	const chip = el('button', 'provider-chip', [icon('cloud'), label]);
	chip.type = 'button';
	chip.hidden = true;
	chip.addEventListener('click', () => void pickProvider());
	host.appendChild(chip);

	const apply = (list: ProviderList | null): void => {
		const bridged = list !== null && list.bridgedExtIds.includes(extId);
		chip.hidden = !bridged;
		if (!bridged) return;
		chip.title = t('providers.chip.title');
		label.textContent = activeProviderLabel(list);
	};

	if (cache !== null) apply(cache);
	else void loadProviders().then(apply);
	const onChange = (): void => apply(cache);
	document.addEventListener(PROVIDERS_CHANGED_EVENT, onChange);
	// A switch in another window: the backend pushed, re-read and follow it.
	let unlisten: (() => void) | null = null;
	void listen(BACKEND_PROVIDERS_EVENT, () => void loadProviders(true).then(apply))
		.then((off) => {
			unlisten = off;
		})
		.catch(() => undefined);
	return () => {
		document.removeEventListener(PROVIDERS_CHANGED_EVENT, onChange);
		unlisten?.();
		chip.remove();
	};
}

/** The chip's quick pick: the profiles (the active one checked), then the management
 *  page entry. Picking the active profile is a no-op close. */
async function pickProvider(): Promise<void> {
	const list = await loadProviders();
	if (list === null) {
		notify('error', t('providers.loadFailed'));
		return;
	}
	const items: QuickPickItem[] = list.profiles.map((profile) => ({
		label: profile.label,
		description: describeProvider(profile),
		value: profile.id,
		...(profile.id === list.activeId ? { icon: 'check' } : {})
	}));
	items.push({ label: t('providers.manage'), icon: 'settings-gear', value: '__manage__' });
	const picked = await quickPick(items, t('providers.pick.placeholder'), t('providers.pick.title'));
	if (picked === null || picked === list.activeId) return;
	if (picked === '__manage__') {
		void commands.execute('ai.providers');
		return;
	}
	await activateProvider(picked);
}
