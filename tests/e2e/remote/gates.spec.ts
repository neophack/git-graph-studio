// gates.spec.ts (docs/ggs-remote-plan.md §17.4): the public listener's two gates — no
// password set yet, and paused — plus the paths that must stay public through both.
import { test, expect, startDaemon, homeFor } from './daemon.fixture';

test('without a password the public port only says to set one on the PC', async ({ page }) => {
	const daemon = await startDaemon(homeFor('no-password'), { password: null });
	try {
		const response = await page.goto(daemon.baseURL);
		expect(response?.status()).toBeGreaterThan(399);
		await expect(page.locator('body')).toContainText(/password|密码/i);
		// Through the gate the API stays shut too. (The certificate download's public path
		// is exercised by the LAN suite; this fixture runs tls "none", which has no CA.)
		const session = await page.request.get(`${daemon.baseURL}/api/session`);
		expect([401, 403, 423, 503]).toContain(session.status());
	} finally {
		daemon.kill();
	}
});

test('paused answers nothing but the paused page', async ({ page }) => {
	const daemon = await startDaemon(homeFor('paused'), { paused: true });
	try {
		await page.goto(daemon.baseURL);
		await expect(page.locator('body')).toContainText(/paused|已暂停/i);
		const api = await page.request.get(`${daemon.baseURL}/api/session`);
		expect([401, 403, 423, 503]).toContain(api.status());
	} finally {
		daemon.kill();
	}
});

test('a path traversal against the asset routes is refused', async ({ request }) => {
	const daemon = await startDaemon(homeFor('traversal'));
	try {
		for (const path of [
			'/w/A/v/1/..%2f..%2fetc%2fpasswd',
			'/w/A/v/1/..%5c..%5csecret',
			'/w/A/ggs/t/../x'
		]) {
			const response = await request.get(`${daemon.baseURL}${path}`);
			expect(response.status(), path).toBeGreaterThanOrEqual(400);
		}
	} finally {
		daemon.kill();
	}
});
