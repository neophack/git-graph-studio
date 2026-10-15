// The ExtensionContext's persisted objects: Memento (global/workspace state),
// SecretStorage and EnvironmentVariableCollection.

import type { HostBridge, HostContext } from './bridge';
import { EventEmitter } from './types/events';
import { EnvironmentVariableMutatorType } from './types/enums';
import type { MarkdownString } from './types/values';
import { shimLogOnce } from './shimLog';

/** VS Code's Memento: key/value storage that survives restarts. `globalState` is shared by
 *  every window of the machine (as much as Studio's per-app localStorage is), `workspaceState`
 *  is per-workspace in VS Code and per-install here — both persisted through the host. */
export class Memento {
	constructor(private readonly ctx: HostContext, private readonly bridge: HostBridge, private readonly scope: 'global' | 'workspace') {}

	get<T = unknown>(key: string, defaultValue?: T): T | undefined {
		const value = this.ctx.state[this.scope][key];
		return (value as T | undefined) ?? defaultValue;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) delete this.ctx.state[this.scope][key];
		else this.ctx.state[this.scope][key] = value;
		await this.bridge.request('state.update', [this.scope, key, value]);
	}

	keys(): string[] {
		return Object.keys(this.ctx.state[this.scope]);
	}

	/** Settings Sync's key list (VS Code 1.52): there is no sync service, so the list is
	 *  accepted and has no further effect. */
	setKeysForSync(_keys: readonly string[]): void {}
}

/** `ExtensionContext.secrets`: values kept by the host per extension (the workbench's
 *  storage — not an OS keychain; noted in the log the first time a secret is stored). */
export class SecretStorage {
	private readonly changed = new EventEmitter<{ key: string }>();
	readonly onDidChange = this.changed.event;
	constructor(private readonly bridge: HostBridge) {}
	async get(key: string): Promise<string | undefined> {
		const value = await this.bridge.request('secrets.get', [key]);
		return typeof value === 'string' ? value : undefined;
	}
	async store(key: string, value: string): Promise<void> {
		await this.bridge.request('secrets.store', [key, String(value)]);
		this.changed.fire({ key });
	}
	async delete(key: string): Promise<void> {
		await this.bridge.request('secrets.delete', [key]);
		this.changed.fire({ key });
	}
	async keys(): Promise<string[]> {
		const keys = await this.bridge.request('secrets.keys', []);
		return Array.isArray(keys) ? (keys as string[]) : [];
	}
}

/** `ExtensionContext.environmentVariableCollection`: the mutations an extension wants in
 *  the terminals it did not create. The integrated terminal has no per-extension env
 *  layer, so the collection keeps its state (reads back what was written) and the first
 *  mutation is logged as not applied. */
export class EnvironmentVariableCollection {
	private readonly mutators = new Map<string, { value: string; type: EnvironmentVariableMutatorType; options: Record<string, unknown> }>();
	persistent = true;
	description: string | MarkdownString | undefined;
	constructor(private readonly extensionId: string) {}
	private note(): void {
		shimLogOnce(`envcollection:${this.extensionId}`, 'warn', 'environmentVariableCollection mutations are kept but not applied to terminals in this host');
	}
	replace(variable: string, value: string, options: Record<string, unknown> = {}): void {
		this.note();
		this.mutators.set(variable, { value, type: EnvironmentVariableMutatorType.Replace, options });
	}
	append(variable: string, value: string, options: Record<string, unknown> = {}): void {
		this.note();
		this.mutators.set(variable, { value, type: EnvironmentVariableMutatorType.Append, options });
	}
	prepend(variable: string, value: string, options: Record<string, unknown> = {}): void {
		this.note();
		this.mutators.set(variable, { value, type: EnvironmentVariableMutatorType.Prepend, options });
	}
	get(variable: string): { value: string; type: EnvironmentVariableMutatorType; options: Record<string, unknown> } | undefined {
		return this.mutators.get(variable);
	}
	forEach(callback: (variable: string, mutator: { value: string; type: EnvironmentVariableMutatorType; options: Record<string, unknown> }, collection: EnvironmentVariableCollection) => unknown): void {
		for (const [variable, mutator] of this.mutators) callback(variable, mutator, this);
	}
	delete(variable: string): void {
		this.mutators.delete(variable);
	}
	clear(): void {
		this.mutators.clear();
	}
	getScoped(_scope: unknown): EnvironmentVariableCollection {
		return this;
	}
	*[Symbol.iterator](): IterableIterator<[string, { value: string; type: EnvironmentVariableMutatorType; options: Record<string, unknown> }]> {
		yield* this.mutators;
	}
}
