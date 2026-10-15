// The `extensions` namespace and the Extension entries it answers: the
// extension's own entry (`context.extension` reports the same object) and the
// foreign ones (their exports live in their own hosts and are not reachable).

import { silentEvent } from './types/events';
import { Uri } from './types/uri';
import { ExtensionKind } from './types/enums';
import { shimLog, shimLogOnce } from './shimLog';
import type { HostContext } from './bridge';
import type { ShimState } from './state';

/** The extension's own `Extension<T>` entry — `context.extension` and
 *  `extensions.getExtension(id)` answer the same object, as in VS Code, so a package
 *  reading its own `packageJSON` off either (cspell's activate does) sees one shape. */
export function extensionEntry(context: HostContext): Record<string, unknown> {
	return {
		id: context.extensionId,
		extensionPath: context.extensionPath,
		extensionUri: Uri.file(context.extensionPath),
		extensionKind: ExtensionKind.Workspace,
		isActive: true,
		exports: undefined,
		packageJSON: context.packageJSON ?? {},
		activate: async () => undefined
	};
}

/** Another installed extension as `extensions.getExtension` reports it: its manifest
 *  and path are real; its `exports` live in its own host and cannot be reached from here
 *  (reading them is logged), and `activate()` asks the workbench to wake it. */
function foreignExtension(entry: { id: string; extensionPath: string; packageJSON: Record<string, unknown>; isActive: boolean }): Record<string, unknown> {
	return {
		id: entry.id,
		extensionPath: entry.extensionPath,
		extensionUri: Uri.file(entry.extensionPath),
		extensionKind: ExtensionKind.Workspace,
		packageJSON: entry.packageJSON,
		isActive: entry.isActive,
		get exports(): undefined {
			shimLogOnce(`exports:${entry.id}`, 'warn', `the exports of ${entry.id} are not reachable: every extension runs in its own host here`);
			return undefined;
		},
		activate: async () => {
			shimLogOnce(`activate:${entry.id}`, 'warn', `the exports of ${entry.id} are not reachable: every extension runs in its own host here`);
			return undefined;
		}
	};
}

export function buildExtensions(s: ShimState) {
	return {
			/** Every installed extension the host listed; `exports` of another extension do
			 *  not cross hosts (each runs in its own), and reading them is logged. */
			getExtension: (extensionId: string) => {
				if (typeof extensionId !== 'string') return undefined;
				if (extensionId.toLowerCase() === s.ctx.extensionId.toLowerCase()) return extensionEntry(s.ctx);
				const other = (s.ctx.extensions ?? []).find((entry) => entry.id.toLowerCase() === extensionId.toLowerCase());
				if (!other) {
					shimLog('debug', `extensions.getExtension(${extensionId}): not installed`);
					return undefined;
				}
				return foreignExtension(other);
			},
			get all(): unknown[] {
				const others = (s.ctx.extensions ?? []).filter((entry) => entry.id.toLowerCase() !== s.ctx.extensionId.toLowerCase()).map(foreignExtension);
				return [extensionEntry(s.ctx), ...others];
			},
			get allAcrossExtensionHosts(): unknown[] {
				return this.all;
			},
			onDidChange: silentEvent() as never
	};
}
