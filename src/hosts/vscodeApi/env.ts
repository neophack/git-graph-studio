// The `env` namespace: app/host facts, the Claude conversation tap, clipboard,
// openExternal and the inert telemetry logger.

import { silentEvent } from './types/events';
import { Uri, uriWin32Active } from './types/uri';
import { UIKind } from './types/enums';
import type { ShimState } from './state';

export function buildEnv(s: ShimState) {
	return {
			language: s.ctx.language,
			appName: 'Git Graph Studio',
			appRoot: '',
			appHost: 'desktop',
			appVersion: s.ctx.appVersion ?? '1.0.0',
			uriScheme: 'ggs',
			uiKind: UIKind.Desktop,
			machineId: 'studio',
			sessionId: `${s.ctx.extensionId}-${Date.now().toString(36)}`,
			remoteName: undefined,
			isNewAppInstall: false,
			isTelemetryEnabled: false,
			logLevel: 3,
			onDidChangeLogLevel: silentEvent() as never,
			onDidChangeTelemetryEnabled: silentEvent() as never,
			onDidChangeShell: silentEvent() as never,
			// The conversation tap (the ggs.claudeTap.* command family's stream side):
			// the Claude Code chat traffic a subscribed extension mirrors, batched as the
			// host relays it. VS Code has no such surface — undefined there, and the
			// extension's own feature probe degrades to its other sources.
			onClaudeConversationTap: (listener: (item: { dir: 'in' | 'out'; kind: 'sdk' | 'permission' | 'rc' | 'gap'; panelId: number; sessionId: string | null; message: unknown }) => void) => s.claudeTapEmitterProxy.event(listener),
			get shell(): string {
				return (s.ctx.platform ?? (uriWin32Active() ? 'win32' : 'linux')) === 'win32' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : '/bin/bash';
			},
			getLanguage: () => s.ctx.language,
			openExternal: (uri: Uri | string) => s.bridge.request('openExternal', [typeof uri === 'string' ? uri : uri.toString(true)]) as Promise<boolean>,
			/** Nothing is forwarded or tunnelled: a URI is already reachable as-is here. */
			asExternalUri: async (uri: Uri) => uri,
			// VS Code's telemetry entry point — extensions call it during activation (cspell
			// logs its first usage event there). This host collects nothing.
			createTelemetryLogger: (_sender?: unknown, _configuration?: unknown) => ({
				logUsage: () => undefined,
				logError: () => undefined,
				sendEventData: () => undefined,
				sendErrorData: () => undefined,
				isUsageEnabled: false,
				isErrorsEnabled: false,
				onDidChangeEnableStates: silentEvent(),
				dispose: () => undefined
			}),
			clipboard: {
				writeText: (text: string) => s.bridge.request('clipboard.writeText', [text]) as Promise<void>,
				readText: () => s.bridge.request('clipboard.readText', []) as Promise<string>
			}
	};
}
