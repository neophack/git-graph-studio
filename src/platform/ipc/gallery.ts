// The typed IPC seam of the extension marketplace (plan §5.6): Open VSX — the featured
// ids, the exact-id lookup, asset fetches and the download-and-install that goes through
// exactly the path a picked `.vsix` takes. Every URL is confined to the gallery's own
// origin by the backend. The ggs-ext crate's gallery engine behind the app's adapters.
import { invoke } from './core';

/** One marketplace entry (`ext_gallery_lookup`), as the Extensions view renders it. */
export interface GalleryEntry {
	/** `{namespace}.{name}` — the same shape as an installed extension's id. */
	id: string;
	name: string;
	namespace: string;
	displayName: string | null;
	description: string | null;
	version: string;
	downloadCount: number;
	averageRating: number | null;
	verified: boolean;
	timestamp: string;
	iconUrl: string | null;
	/** The `.vsix` download URL (the gallery's own origin) — what `ext_gallery_install` takes. */
	downloadUrl: string;
}

export const extGalleryFeatured = () => invoke<string[]>('ext_gallery_featured');
export const extGalleryLookup = (gallery: string, id: string) => invoke<GalleryEntry>('ext_gallery_lookup', { gallery, id });
export const extGalleryAsset = (gallery: string, url: string) => invoke<string>('ext_gallery_asset', { gallery, url });
export const extGalleryInstall = (gallery: string, downloadUrl: string) =>
	invoke<import('./ext').ExtInfo>('ext_gallery_install', { gallery, downloadUrl });
