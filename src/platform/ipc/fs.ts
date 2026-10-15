// The typed IPC seam of the workspace file services (plan §5.6): directory listings,
// file reads/writes (text, raw, base64, chunked), probes, mutations, backups, the file
// list every walk reuses, and the desktop transfer pair — the ggs-fs crate's commands
// behind the app's adapters. The result shapes live here once; the Explorer, the editors,
// the viewers and the compare tools all import them from this module.
import { invoke, type Channel } from './core';

/** One entry of a `list_dir` answer: name, workspace-absolute path, kind and size. */
export interface DirEntryInfo {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
}

/** One window of a paged listing (`list_dir_page`): the order `list_dir` spells, sliced,
 *  with the unfiltered total behind it. */
export interface DirPage {
	entries: DirEntryInfo[];
	total: number;
	offset: number;
	limit: number;
}

/** What `file_probe` learns from a file's first bytes before its body is read. */
export interface FileProbe {
	size: number;
	binary: boolean;
	/** The head shows minified-style unbroken runs: too few, too huge lines for the
	 *  line-windowed editor, which the open path then routes to the full editor. */
	longLines?: boolean;
}

/** A decoded text file: the contents (null when binary), and the encoding / line endings
 *  a write-back must reuse or the copy transcodes. */
export interface FileContents {
	contents: string | null;
	binary: boolean;
	size: number;
	encoding?: string;
	eol?: 'lf' | 'crlf';
}

/** One slab of `read_file_chunk`: raw bytes as base64. */
export interface FileChunk {
	size: number;
	base64: string;
}

/** One hot-exit backup `backup_list` carries. */
export interface BackupEntry {
	path: string;
	savedAt: number;
}

export const listDir = (path: string) => invoke<DirEntryInfo[]>('list_dir', { path });
export const listDirPage = (path: string, offset: number, limit: number) => invoke<DirPage>('list_dir_page', { path, offset, limit });
export const readFile = (path: string) => invoke<FileContents>('read_file', { path });
/** The raw-IPC read path: the payload is a length-prefixed binary the caller decodes —
 *  the JSON bridge re-escapes and re-copies the whole document on both sides. */
export const readFileRaw = (path: string, encoding?: string) => invoke<ArrayBuffer | Uint8Array>('read_file_raw', { path, encoding });
export const readFileBase64 = (path: string) => invoke<string>('read_file_base64', { path });
export const readFileChunk = (path: string, offset: number, len: number) => invoke<FileChunk>('read_file_chunk', { path, offset, len });
export const patchFile = (path: string, edits: { offset: number; byte: number }[]) => invoke('patch_file', { path, edits });
export const fileProbe = (path: string) => invoke<FileProbe>('file_probe', { path });
export const encodings = () => invoke<[string, string][]>('encodings');
/** Keys the current callers omit stay off the wire exactly as before (an `undefined`
 *  property would reach the recorded args of the scripted backend). */
export const writeFile = (path: string, contents: string, encoding?: string, eol?: string) =>
	invoke('write_file', { path, contents, ...(encoding !== undefined && { encoding }), ...(eol !== undefined && { eol }) });
export const createFile = (path: string) => invoke('create_file', { path });
export const createFolder = (path: string) => invoke('create_folder', { path });
export const renamePath = (from: string, to: string) => invoke('rename_path', { from, to });
export const deletePath = (path: string, permanent: boolean) => invoke('delete_path', { path, permanent });
export const copyInto = (sources: string[], destDir: string) => invoke<string[]>('copy_into', { sources, destDir });
/** The workspace file list every walk reuses (Quick Open, search, symbol tools); the
 *  repo-scoped form narrows to one root of a workspace. */
export const listFiles = (repo?: string) => invoke<string[]>('list_files', repo === undefined ? undefined : { repo });
export const backupWrite = (path: string, contents: string) => invoke('backup_write', { path, contents });
export const backupList = () => invoke<BackupEntry[]>('backup_list');
export const backupRead = (path: string) => invoke<string>('backup_read', { path });
export const backupClear = (path: string) => invoke('backup_clear', { path });
export const fsTransferCancel = () => invoke('fs_transfer_cancel');
/** The remote wire's confined chunked upload: the resume offset the backend reports for
 *  a partial upload, and one raw chunk with its confinement headers. */
export const fsUploadOffset = (path: string, size: number) => invoke<number>('fs_upload_offset', { path, size });
export const fsWriteChunk = (bytes: Uint8Array, headers: Record<string, string>) => invoke('fs_write_chunk', bytes, { headers });

/** One progress report of a desktop transfer (`fs_export` / `fs_import`). */
export interface TransferProgress {
	name: string;
	bytes: number;
	total: number;
}

/** What a desktop transfer settled on: the paths that landed, per-entry failures, and
 *  whether the Cancel action stopped it early. */
export interface TransferReport {
	landed: string[];
	failed: { name: string; error: string }[];
	cancelled: boolean;
}

/** The desktop transfer pair: picked sources copy into the target folder (the no-clobber
 *  ` (copy)` engine), a file/folder copies out to the save dialog's destination (a folder
 *  zips into it); progress streams over a Channel, Cancel rides `fsTransferCancel`. */
export const fsImport = (sources: string[], targetDir: string, onProgress: Channel<TransferProgress>) =>
	invoke<TransferReport>('fs_import', { sources, targetDir, onProgress });
export const fsExport = (path: string, dest: string, zip: boolean, onProgress: Channel<TransferProgress>) =>
	invoke<TransferReport>('fs_export', { path, dest, zip, onProgress });
