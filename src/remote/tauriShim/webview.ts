// `@tauri-apps/api/webview` for the remote workbench (§9.3): files dropped onto the page are
// uploaded into the open folder first, then reported in the desktop's drop-event shape —
// paths on the PC — so the workbench opens them exactly as a desktop drop.
import { uploadFile } from '../transfer';
import { invoke } from './core';

type DragDropPayload = { type: 'enter' | 'over' | 'drop' | 'leave'; paths?: string[]; position?: { x: number; y: number } };
type DragDropHandler = (event: { payload: DragDropPayload }) => void;

async function dropFolder(): Promise<string | null> {
	try {
		const status = await invoke<{ folders?: string[] }>('remote_host_status');
		return status.folders?.[0] ?? null;
	} catch {
		return null;
	}
}

function onDragDropEvent(handler: DragDropHandler): Promise<() => void> {
	const over = (event: DragEvent) => {
		if (!event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		handler({ payload: { type: 'over', position: { x: event.clientX, y: event.clientY } } });
	};
	const leave = () => handler({ payload: { type: 'leave' } });
	const drop = async (event: DragEvent) => {
		const files = [...(event.dataTransfer?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		const dir = await dropFolder();
		if (!dir) return;
		const paths: string[] = [];
		for (const file of files) paths.push(await uploadFile(file, dir));
		handler({ payload: { type: 'drop', paths, position: { x: event.clientX, y: event.clientY } } });
	};
	window.addEventListener('dragover', over);
	window.addEventListener('dragleave', leave);
	window.addEventListener('drop', drop);
	return Promise.resolve(() => {
		window.removeEventListener('dragover', over);
		window.removeEventListener('dragleave', leave);
		window.removeEventListener('drop', drop);
	});
}

const webview = { label: 'main', onDragDropEvent };

export function getCurrentWebview(): typeof webview {
	return webview;
}
