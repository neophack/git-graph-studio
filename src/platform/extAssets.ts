// An extension file as a `data:` URL — the bridge icons and README images cross into pages
// and views through. Extracted from extHost.ts so the editor, Source Control and tree views
// can resolve extension icons without importing the extension host (plan §5.4 — three of the
// 6-file cycle's edges were exactly this one function).

import { extReadFileBase64 } from './ipc/ext';
import { imageMime } from './markdown';

/** An extension package file's image MIME type: the shared table (markdown.ts), with the
 *  jpeg fallback an extension's odd-named icon file still needs to embed as a data URL. */
export function extImageMime(path: string): string {
	return imageMime(path) ?? 'image/jpeg';
}

/** Cached base64 reads of a file inside an installed extension, as a data URL. */
const dataUrlCache = new Map<string, Promise<string | null>>();

/** An extension file as a data URL (icons and README images cross the bridge this way), or null
 *  when the file cannot be read. Cached per extension id + path. */
export function extFileDataUrl(extId: string, relPath: string): Promise<string | null> {
	const key = `${extId}:${relPath}`;
	let pending = dataUrlCache.get(key);
	if (!pending) {
		pending = extReadFileBase64(extId, relPath)
			.then((base64) => `data:${extImageMime(relPath)};base64,${base64}`)
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
