// `@tauri-apps/api/app` for the remote workbench (§9.3): the instance's version (ATTACHED).
import { remoteEnv } from '../session';

export async function getVersion(): Promise<string> {
	return remoteEnv()?.attached.version ?? '0.0.0';
}

export async function getName(): Promise<string> {
	return 'Git Graph Studio';
}

export async function getTauriVersion(): Promise<string> {
	return '2';
}

export async function getIdentifier(): Promise<string> {
	return 'com.gitgraph.studio';
}

export async function show(): Promise<void> {}
export async function hide(): Promise<void> {}
