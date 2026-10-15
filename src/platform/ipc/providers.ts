// The typed IPC seam of the AI provider bridge (plan §5.6): the sealed store's list /
// save / delete / activate, the shell-environment refresh a Terminal Shell change rides,
// the connectivity probe and model catalogue reads, the cc-switch scan/import, the usage
// curve and the Claude MCP integration's status — the ggs-providers crate behind the
// app's cmd_providers adapters. `apiKey` is the only secret-bearing field and it travels
// once, into the backend's seal — never back out.
import { invoke } from './core';

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
	/** Whether a profile of this shape is usable without an API key — the chat pane's
	 *  set-key gate keys on it (a custom or NewAPI gateway may be keyless). */
	requiresKey: boolean;
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

/** What a cc-switch (or live Claude) configuration on this machine would contribute. */
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
 *  the diagnosis. */
export interface ConnectionReport {
	ok: boolean;
	status: number;
	ms: number;
	message: string;
}

/** One UTC hour of token usage as the redirected Claude state's transcripts aggregate
 *  it — tokens only, never money or durations. */
export interface UsageHour {
	startMs: number;
	cacheRead: number;
	cacheCreation: number;
	input: number;
	output: number;
}

export const providerList = () => invoke<ProviderList | null>('provider_list');
export const providerSave = (draft: ProviderDraft) =>
	invoke<ProviderList | null>('provider_save', {
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
export const providerDelete = (id: string) => invoke<ProviderList | null>('provider_delete', { id });
export const providerActivate = (id: string) => invoke<ProviderList | null>('provider_activate', { id });
export const providerCcswitchScan = () => invoke<CcSwitchCandidate[] | null>('provider_ccswitch_scan');
export const providerImportCcswitch = (names: string[]) => invoke<ProviderList | null>('provider_import_ccswitch', { names });
/** Both probes authenticate with the typed key or, untouched, the stored profile's
 *  decrypted one (`profileId` naming the stored one). */
export const providerFetchModels = (baseUrl: string, apiKey: string, profileId: string | null) =>
	invoke<string[] | null>('provider_fetch_models', { baseUrl, apiKey, profileId });
export const providerTestConnection = (baseUrl: string, apiKey: string, model: string, profileId: string | null) =>
	invoke<ConnectionReport>('provider_test_connection', { baseUrl, apiKey, model, profileId });
export const providerUsage = () => invoke<UsageHour[] | null>('provider_usage');
/** A Terminal Shell change rides this: the shell keys re-applied and the running
 *  bridged backends restarted onto them. */
export const providersShellRefresh = () => invoke<void>('providers_shell_refresh');
