// The upgrade-safety probe around the `vscode` namespace a package receives.
//
// The namespace itself is a plain object: a member this host has not implemented is a
// plain `undefined` and a `'x' in vscode` feature check a plain `false` — a package
// version that reaches for a newer API (the claude-code upgrades this host rides on,
// or any modern extension) would fail somewhere deep in its bundle with nothing naming
// the gap. This probe changes no value: every read and every membership test answers
// exactly what the raw namespace answers — but an absent member is NAMED in the
// extension host log (once per name, `shimLogOnce`), so
// `scripts/probes/extension-compat.mjs` can aggregate the compatibility gaps of any
// package version — and of the host itself — before they ship to users.
//
// The well-known child namespaces (`window`, `workspace`, `commands`, …) are wrapped
// the same way, identity-stably (one proxy per namespace per raw object — `===` and
// Map keys keep working), so `vscode.window.tabGroups` is named exactly like a
// top-level gap.
//
// The exclusions are the keys bundler and interop machinery probes on a module object
// for (`then` by await, `default`/`__esModule` by CJS/ESM interop, `_`-prefixed
// internals like the shim's own `__mementos`): those are not API accesses, and logging
// them would be noise. They still forward untouched.

import { shimLogOnce } from './vscodeApi';

const INTEROP_KEYS = new Set(['then', 'default', '__esModule', 'nodeType', 'inspect', 'toString']);

/** The child namespaces of the `vscode` API that get the same treatment one level down. */
const NAMESPACE_KEYS = new Set([
	'window', 'workspace', 'commands', 'env', 'extensions', 'languages', 'debug',
	'tasks', 'scm', 'comments', 'notebooks', 'authentication', 'l10n', 'tests',
	'chat', 'lm', 'interactive', 'urls', 'ai'
]);

function isInteropKey(key: string): boolean {
	return key.startsWith('_') || INTEROP_KEYS.has(key);
}

/** One proxy per raw child object, for the session: identity stays stable. */
const wrappedChildren = new WeakMap<object, unknown>();

function probeChild(namespace: string, raw: object): unknown {
	const cached = wrappedChildren.get(raw);
	if (cached !== undefined) return cached;
	const proxy = new Proxy(raw, {
		get(target, property) {
			if (
				typeof property === 'string' &&
				!isInteropKey(property) &&
				!(property in target)
			) {
				shimLogOnce(
					`namespace:${namespace}.${property}`,
					'warn',
					`unsupported API vscode.${namespace}.${property}: this host does not serve it, the value is undefined`
				);
			}
			return Reflect.get(target, property, target);
		},
		has(target, property) {
			if (
				typeof property === 'string' &&
				!isInteropKey(property) &&
				!(property in target)
			) {
				shimLogOnce(
					`namespace:in:${namespace}.${property}`,
					'warn',
					`unsupported API vscode.${namespace}.${property}: the feature check answers false on this host`
				);
			}
			return Reflect.has(target, property);
		}
	});
	wrappedChildren.set(raw, proxy);
	return proxy;
}

/**
 * Wrap the `vscode` namespace so an absent member is logged (once per name) while
 * every read, and every `in` membership test, answers exactly the raw value.
 */
export function probeVscodeNamespace<T extends object>(api: T): T {
	return new Proxy(api, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (
				typeof property === 'string' &&
				NAMESPACE_KEYS.has(property) &&
				value !== null && typeof value === 'object'
			) {
				return probeChild(property, value as object);
			}
			if (
				typeof property === 'string' &&
				!isInteropKey(property) &&
				!(property in target)
			) {
				shimLogOnce(
					`namespace:${property}`,
					'warn',
					`unsupported API vscode.${property}: this host does not serve it, the value is undefined`
				);
			}
			return value;
		},
		has(target, property) {
			if (
				typeof property === 'string' &&
				!isInteropKey(property) &&
				!(property in target)
			) {
				shimLogOnce(
					`namespace:in:${property}`,
					'warn',
					`unsupported API vscode.${property}: the feature check answers false on this host`
				);
			}
			return Reflect.has(target, property);
		}
	});
}
