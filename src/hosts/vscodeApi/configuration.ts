// The configuration-change event shape and its two constructors.

export interface ConfigurationChangeEvent {
	affectsConfiguration(section: string, scope?: unknown): boolean;
}

/** The keys whose values differ between two settings maps (added, removed or changed). */
export function changedSettingKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/** VS Code's section semantics: a change to `a.b.c` affects `a`, `a.b` and `a.b.c`, and a
 *  change to a whole section (`a.b`) affects every key under it. */
export function configurationChangeEvent(changed: string[]): ConfigurationChangeEvent {
	return {
		affectsConfiguration: (section: string) =>
			changed.some((key) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`))
	};
}
