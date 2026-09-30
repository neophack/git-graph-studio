// The upgrade-safety probe around the `vscode` namespace: values are identical, and an
// absent member — a future API an upgraded package reaches for, at the top level or one
// namespace down (`vscode.window.tabGroups`) — is NAMED in the log instead of failing
// silently as undefined. The interop keys bundlers probe with stay silent.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeVscodeNamespace } from '../src/vscodeNamespaceProbe';

describe('probeVscodeNamespace', () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	afterEach(() => {
		warnSpy.mockClear();
	});

	it('answers reads identically and stays silent for present members', () => {
		const raw = {
			version: '1.106.0',
			window: { createOutputChannel: (name: string) => ({ name }) }
		};
		const api = probeVscodeNamespace(raw);
		expect(api.version).toBe('1.106.0');
		const channel = (api.window as typeof raw.window).createOutputChannel('x');
		expect(channel.name).toBe('x');
		expect(warnSpy).not.toHaveBeenCalled();
		// Identity holds across reads (Map keys, === checks).
		expect(api.window).toBe(api.window);
	});

	it('names a missing top-level member and a missing nested member once each', () => {
		const api = probeVscodeNamespace({ window: {} });
		void (api as Record<string, unknown>).languageModelChat;
		void (api as { window: Record<string, unknown> }).window.tabGroups;
		void (api as Record<string, unknown>).languageModelChat; // deduplicated
		const messages = warnSpy.mock.calls.map((call) => String(call[0]));
		expect(messages.some((m) => m.includes('vscode.languageModelChat'))).toBe(true);
		expect(messages.some((m) => m.includes('vscode.window.tabGroups'))).toBe(true);
		expect(messages.filter((m) => m.includes('languageModelChat')).length).toBe(1);
	});

	it('a feature check ("in") answers false and is named', () => {
		const api = probeVscodeNamespace({});
		expect('lm' in api).toBe(false);
		expect('then' in api).toBe(false); // interop key: silent
		const messages = warnSpy.mock.calls.map((call) => String(call[0]));
		expect(messages.some((m) => m.includes('vscode.lm'))).toBe(true);
		expect(messages.every((m) => !m.includes('interop'))).toBe(true);
	});
});
