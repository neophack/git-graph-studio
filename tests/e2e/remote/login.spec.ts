// login.spec.ts (docs/ggs-remote-plan.md §17.4): the daemon's own login page — the redirect
// from `/`, the wrong-password lockout, the signed-in road to the window picker, and the
// cookie's flags.
import { test, expect } from './daemon.fixture';

test('an anonymous visit lands on the login page', async ({ page, daemon }) => {
	await page.goto(daemon.baseURL);
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.locator('#password')).toBeVisible();
});

test('a wrong password is refused and repetition locks the door', async ({ page, daemon }) => {
	await page.goto(`${daemon.baseURL}/login`);
	for (let i = 0; i < 5; i++) {
		await page.locator('#password').fill('not-the-password');
		await page.locator('button[type=submit], form button.primary').first().click();
	}
	// The rate limiter's answer renders on the page (§7.6: the fifth failure locks 60 s).
	await expect(page.locator('.error, [role=alert]').first()).toBeVisible({ timeout: 15_000 });
	await expect(page).toHaveURL(/\/login/);
});

test('the right password reaches the window picker', async ({ page, daemon }) => {
	await page.goto(`${daemon.baseURL}/login`);
	await page.locator('#password').fill('e2e-probe-kayak-42');
	await page.locator('button[type=submit], form button.primary').first().click();
	await expect(page).toHaveURL(/\/windows/, { timeout: 15_000 });
	// No window is registered: the page says so and offers the folder-path row — the one
	// spawn door from the remote side (the standalone "new window" button is gone since
	// 2026-10-12; the row was restored 2026-10-16, docs/ggs-remote-plan.md §3.3).
	await expect(page.locator('#empty')).toBeVisible();
	await expect(page.locator('#open-folder')).toBeVisible();
	await expect(page.locator('#open-go')).toBeVisible();
});

test('the session cookie is HttpOnly and SameSite=Strict', async ({ request, daemon }) => {
	const response = await request.post(`${daemon.baseURL}/api/login`, {
		headers: { 'content-type': 'application/json' },
		data: { password: 'e2e-probe-kayak-42', device: 'flags' }
	});
	expect(response.status()).toBe(200);
	const cookie = response.headers()['set-cookie'] ?? '';
	expect(cookie).toContain('ggsr=');
	expect(cookie.toLowerCase()).toContain('httponly');
	expect(cookie.toLowerCase()).toContain('samesite=strict');
});

test('an api call without a session is refused', async ({ request, daemon }) => {
	const response = await request.get(`${daemon.baseURL}/api/session`);
	expect(response.status()).toBe(401);
});
