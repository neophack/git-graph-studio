// The built-in command surface the host itself serves: vscode.diff / vscode.open over provider schemes, VS Code's placement shapes.

import { ExtensionHost } from './extensionHost';





/** The builtinCommands concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const builtinCommandsMethods: ThisType<ExtensionHost> = {
	async resolveVscodeUri(uri: unknown): Promise<{ scheme: string; name: string; fsPath: string; label: string; content?: string; local?: boolean }> {
		const value = (uri ?? {}) as { scheme?: unknown; path?: unknown; fsPath?: unknown; query?: unknown };
		const scheme = typeof value.scheme === 'string' && value.scheme !== '' ? value.scheme : 'file';
		const path = typeof value.path === 'string' ? value.path : '';
		if (scheme === 'file') {
			const fsPath = typeof value.fsPath === 'string' && value.fsPath !== '' ? value.fsPath : path;
			return { scheme, name: fsPath.split(/[\\/]/).pop() || fsPath, fsPath, label: fsPath, local: true };
		}
		const handle = this.docProviders.get(scheme);
		if (handle) {
			const text = await this.callFrame(handle, 'docProvider.provide', [value]) as string | null | undefined;
			return { scheme, name: path.split('/').pop() || scheme, fsPath: path, label: path, content: text ?? '' };
		}
		// A file-system provider's scheme (claude-code's diff sides): the same ask-back,
		// the frame's provider answering `readFile` and the frame decoding to text.
		const fsHandle = this.fsProviders.get(scheme);
		if (!fsHandle) throw new Error(`no text-document content provider is registered for the ${scheme} scheme`);
		const fsText = await this.callFrame(fsHandle, 'fsProvider.read', [value]) as string | null | undefined;
		return { scheme, name: path.split('/').pop() || scheme, fsPath: path, label: path, content: fsText ?? '' };
	},

	async openVscodeDiff(left: unknown, right: unknown, title: unknown, column: unknown): Promise<void> {
		if (!left || !right) return;
		const [l, r] = await Promise.all([this.resolveVscodeUri(left), this.resolveVscodeUri(right)]);
		const serial = this.nextExtDocSerial++;
		this.onOpenDiff?.({
			id: `ext-diff-${serial}`,
			title: typeof title === 'string' && title !== '' ? title : `${r.name} (${l.scheme === 'file' ? l.name : l.label} → ${r.scheme === 'file' ? r.name : r.label})`,
			left: l.local === true
				? { revision: '', path: l.fsPath, label: l.name, exists: true, local: true }
				: { revision: '', path: l.label, label: l.name, exists: true, content: l.content ?? '' },
			right: r.local === true
				? { revision: '', path: r.fsPath, label: r.name, exists: true, local: true }
				: { revision: '', path: r.label, label: r.name, exists: true, content: r.content ?? '' }
		}, ExtensionHost.placementOf(column));
	},

	async openVscodeDocument(uri: unknown, column: unknown): Promise<void> {
		if (!uri) return;
		const placement = ExtensionHost.placementOf(column);
		const resolved = await this.resolveVscodeUri(uri);
		if (resolved.local === true) {
			this.onOpenFile?.(resolved.fsPath, undefined, undefined, placement);
			return;
		}
		const serial = this.nextExtDocSerial++;
		this.onOpenContent?.(resolved.name || `document-${serial}`, resolved.label, resolved.content ?? '', placement);
	},
};
