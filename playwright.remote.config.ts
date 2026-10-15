// The Playwright config for Remote Access's browser specs (docs/ggs-remote-plan.md §17.4):
// the three engines — Chromium, Firefox, WebKit — as the plan's matrix asks. Firefox and
// WebKit join only when their binaries are present (`npx playwright install firefox webkit`
// once per machine); a machine without them runs the chromium project alone instead of
// failing every launch. The phone and desktop shapes ride device descriptors inside the
// specs that care. The daemon-only specs need just the daemon binary; the workbench spec is
// gated behind GGS_REMOTE_E2E_FULL (it boots a real GGS instance). Nothing here runs on
// pull requests — `npm run test:e2e-remote` is explicit.
import { defineConfig, devices, firefox, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';

const projects = [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }];
for (const [name, type, descriptor] of [
	['firefox', firefox, 'Desktop Firefox'],
	['webkit', webkit, 'Desktop Safari']
] as const) {
	if (existsSync(type.executablePath())) projects.push({ name, use: { ...devices[descriptor] } });
}

export default defineConfig({
	testDir: 'tests/e2e/remote',
	timeout: 60_000,
	expect: { timeout: 10_000 },
	fullyParallel: true,
	// One retry per test: the three engines carry the odd first-launch flake (a pool race,
	// a cold profile), and a real failure reproduces.
	retries: 1,
	reporter: [['list']],
	use: {
		baseURL: 'http://127.0.0.1:1', // every spec overrides through its own daemon fixture
		// The daemon's shipping shape is TLS (self-signed): WebKit, unlike Chromium and
		// Firefox, grants plain-HTTP localhost no Secure-cookie exemption, and the session
		// cookie IS Secure — so the specs ride https with certificate errors ignored.
		ignoreHTTPSErrors: true,
		...devices['Desktop Chrome']
	},
	projects
});
