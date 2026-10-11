// `@tauri-apps/plugin-dialog` for the remote workbench (§9.3): `open` / `save` browse the
// PC's file system in the remote file picker; the message boxes are the workbench's own.
import { confirmDialog, notify } from '../../ui';
import { t } from '../../i18n';
import { pickRemotePath } from '../remoteFilePicker';

export interface DialogFilter {
	name: string;
	extensions: string[];
}

export interface OpenDialogOptions {
	title?: string;
	filters?: DialogFilter[];
	defaultPath?: string;
	multiple?: boolean;
	directory?: boolean;
	recursive?: boolean;
	canCreateDirectories?: boolean;
}

export interface SaveDialogOptions {
	title?: string;
	filters?: DialogFilter[];
	defaultPath?: string;
	canCreateDirectories?: boolean;
}

export interface MessageDialogOptions {
	title?: string;
	kind?: 'info' | 'warning' | 'error';
	okLabel?: string;
}

export interface ConfirmDialogOptions extends MessageDialogOptions {
	cancelLabel?: string;
}

export async function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
	return pickRemotePath({
		title: options.title,
		defaultPath: options.defaultPath,
		directory: options.directory,
		multiple: options.multiple,
		filters: options.filters
	});
}

export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
	const name = options.defaultPath?.split(/[\/]/).pop() ?? '';
	const dir = options.defaultPath && name !== options.defaultPath ? options.defaultPath.slice(0, options.defaultPath.length - name.length) : undefined;
	const picked = await pickRemotePath({ title: options.title, defaultPath: dir, saveName: name, filters: options.filters });
	return typeof picked === 'string' ? picked : null;
}

export async function message(text: string, options?: string | MessageDialogOptions): Promise<'Ok'> {
	const kind = typeof options === 'object' ? (options.kind ?? 'info') : 'info';
	notify(kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : 'info', text);
	return 'Ok';
}

export async function ask(text: string, options?: string | ConfirmDialogOptions): Promise<boolean> {
	const ok = typeof options === 'object' && options.okLabel ? options.okLabel : t('remote.dialog.yes');
	return confirmDialog(text, ok);
}

export async function confirm(text: string, options?: string | ConfirmDialogOptions): Promise<boolean> {
	const ok = typeof options === 'object' && options.okLabel ? options.okLabel : t('remote.dialog.ok');
	return confirmDialog(text, ok);
}
