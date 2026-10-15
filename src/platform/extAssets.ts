// An extension file as a `data:` URL — the bridge icons and README images cross into pages
// and views through. Extracted from extHost.ts so the editor, Source Control and tree views
// can resolve extension icons without importing the extension host (plan §5.4 — three of the
// 6-file cycle's edges were exactly this one function).

import { invoke } from './ipc/core';
import { extReadFileBase64 } from './ipc/ext';

/** The data-URL MIME type of an image file inside an extension (icons, README images). */
export function imageMime(path: string): string {
	const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	return ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png'
		: ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp'
		: ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
}

/** Cached base64 reads of a file inside an installed extension, as a data URL. */
const dataUrlCache = new Map<string, Promise<string | null>>();

/** An extension file as a data URL (icons and README images cross the bridge this way), or null
 *  when the file cannot be read. Cached per extension id + path. */
export function extFileDataUrl(extId: string, relPath: string): Promise<string | null> {
	const key = `${extId}:${relPath}`;
	let pending = dataUrlCache.get(key);
	if (!pending) {
		pending = invoke<string>('ext_read_file_base64', { extId, relPath })
			.then((base64) => `data:${imageMime(relPath)};base64,${base64}`)
			.catch(() => null);
		dataUrlCache.set(key, pending);
	}
	return pending;
}

/** Drop one extension's cached package-file data URLs: an upgrade replaced its bytes on disk
 *  (and a moved icon must fall to the label-text fallback, not keep serving the retired
 *  version's image forever). The next read follows the install's new version. */
export function forgetExtDataUrls(extId: string): void {
	const prefix = `${extId}:`;
	for (const key of dataUrlCache.keys()) {
		if (key.startsWith(prefix)) dataUrlCache.delete(key);
	}
}
