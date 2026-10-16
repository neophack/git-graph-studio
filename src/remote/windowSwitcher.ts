// The window switcher inside the remote workbench (docs/ggs-remote-plan.md §13, R10/R12/R20/
// R21; docs/remote-client-plan.md §3.3): every GGS window on the PC with its content
// summary and state badge, switch (a full page load — the other window may run another
// version), close (unsaved files confirmed first) and restart. No "new window": a browser
// session switches between the windows the PC already opened — spawning is the picker's
// sandboxed SPAWN, never a session's (K4). Fed by the transport's live WINDOWS pushes.
import { quickInput, confirmDialog, type QuickPickItem } from '../platform/ui';
import { t, tf } from '../platform/i18n';
import { remoteEnv } from './session';
import type { InstanceInfo, Notice } from './transport';

function summaryLine(info: InstanceInfo): string {
	const s = info.summary ?? {};
	const tabs = s.tabs?.length ?? 0;
	return tf('remote.switcher.summary', tabs, s.dirty ?? 0, s.terminals ?? 0, s.scmChanges ?? 0);
}

export function switcherItems(list: InstanceInfo[], current: string): QuickPickItem[] {
	return list.map((info) => {
		const flags = [
			info.id === current ? t('remote.switcher.current') : null,
			info.state === 'unresponsive' ? t('remote.switcher.unresponsive') : null,
			info.minimized ? t('remote.switcher.minimized') : null,
			info.visible ? null : t('remote.switcher.hidden')
		].filter(Boolean);
		const active = info.summary?.tabs?.find((tab) => tab.active)?.path;
		return {
			label: info.title || info.id,
			description: [info.folders.join(' · '), ...flags].filter(Boolean).join(' — '),
			detail: [
				summaryLine(info),
				info.remoteSessions > 0 ? tf('remote.switcher.sessions', info.remoteSessions) : null,
				active
			].filter(Boolean).join(' · '),
			icon: info.state === 'unresponsive' ? 'warning' : info.id === current ? 'check' : 'window',
			value: `w:${info.id}`
		};
	});
}

function workbenchUrl(info: InstanceInfo): string {
	const env = remoteEnv();
	const base = new URL(env?.basePath ?? '/', location.href);
	return new URL(`w/${encodeURIComponent(info.id)}/v/${encodeURIComponent(info.version)}/remote.html`, base).href;
}

/** Leave this window for another of the PC's: the page reloads onto that instance. */
export function enterInstance(info: InstanceInfo): void {
	const transport = remoteEnv()?.transport;
	transport?.detach();
	transport?.shutdown();
	location.assign(workbenchUrl(info));
}

/** Open the switcher; the picked window loads in this tab. */
export async function openWindowSwitcher(): Promise<void> {
	const env = remoteEnv();
	if (!env) return;
	const transport = env.transport;
	const current = env.attached.instance;
	const picked = await quickInput({ title: t('remote.switcher.title'), items: switcherItems(transport.instances, current) });
	if (!picked) return;
	const id = picked.slice(2);
	const info = transport.instances.find((i) => i.id === id);
	if (!info) return;
	// The PC-window actions first (§6.8): hide or show the desktop window without ever
	// touching the session — "close on the PC" is exactly that, never the instance's exit
	// (K12). Entering a window remains the switcher's own row.
	const actions: QuickPickItem[] = [
		{ label: t('remote.switcher.open'), icon: 'arrow-right', value: 'open' }
	];
	if (id === current) {
		actions.push(
			{ label: t('remote.pcWindow.hide'), icon: 'close', value: 'hide' },
			{ label: t('remote.pcWindow.show'), icon: 'window', value: 'show' }
		);
	} else if (info.visible && !info.minimized) {
		actions.push({ label: t('remote.switcher.pcHide'), icon: 'close', value: 'hide' });
	} else {
		actions.push({ label: t('remote.switcher.pcShow'), icon: 'window', value: 'show' });
	}
	actions.push(
		{ label: t('remote.switcher.close'), icon: 'close', value: 'close' },
		{ label: t('remote.switcher.restart'), icon: 'refresh', value: 'restart' }
	);
	const action = await quickInput({ title: info.title || info.id, items: actions });
	if (action === 'open') enterInstance(info);
	else if (action === 'hide') transport.displayInstance(id, false);
	else if (action === 'show') transport.displayInstance(id, true);
	else if (action === 'close') transport.closeInstance(id, false);
	else if (action === 'restart' && (await confirmDialog(t('remote.switcher.restartConfirm'), t('remote.switcher.restart')))) transport.restartInstance(id);
}

/** The switcher's half of the lifecycle notices: the unsaved-files confirmation, and a new or
 *  restarted window opening as soon as it registered. */
export function watchLifecycle(): () => void {
	const env = remoteEnv();
	if (!env) return () => undefined;
	const transport = env.transport;
	let pendingOpen: string | null = null;
	const openWhenListed = (list: InstanceInfo[]) => {
		const info = pendingOpen ? list.find((i) => i.id === pendingOpen) : undefined;
		if (!info) return;
		pendingOpen = null;
		transport.detach();
		transport.shutdown();
		location.assign(workbenchUrl(info));
	};
	const offWindows = transport.onWindows(openWhenListed);
	const offNotice = transport.onNotice((notice: Notice) => {
		if (notice.kind === 'close-blocked' && notice.instance) {
			const instance = notice.instance;
			void confirmDialog(tf('remote.switcher.closeBlocked', (notice.dirty ?? []).join(', ')), t('remote.switcher.close')).then((yes) => {
				if (yes) transport.closeInstance(instance, true);
			});
		} else if (notice.kind === 'spawned' && notice.instance) {
			pendingOpen = notice.instance;
			openWhenListed(transport.instances);
		}
	});
	return () => {
		offWindows();
		offNotice();
	};
}
