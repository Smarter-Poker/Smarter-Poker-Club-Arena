/**
 * A BRAND-NEW PLAYER ON AN iPHONE GETS THROUGH COMPLETE YOUR PROFILE
 * (post-deploy certification, 2026-10-17).
 *
 * Two referred players on iPhone Safari picked an avatar, tapped ENTER ARENA
 * and nothing happened: TapHaptic's invisible switch over the plate was the
 * click's activation target, so the submit plate never submitted. Every other
 * certification account is normalized past this gate, so nothing in CI ever
 * stood where they stood. This spec does, on real WebKit with an iPhone
 * profile, from an account created exactly as a new sign-up arrives (alias
 * chosen, no arena avatar), and taps where a finger lands.
 *
 * It never presses Join: the account is retired by `cleanup-first-run` and
 * must leave no membership behind.
 */
import { expect, test } from '@playwright/test';

const DEFAULT_E2E_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
/** Generous for a cold phone on a CI runner; the defect was "never". */
const FINISH_BUDGET_MS = 8_000;

const email = process.env.FIRST_RUN_EMAIL;
const password = process.env.FIRST_RUN_PASS;
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const publishableKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

// A fresh browser: never the shared certification account's stored session.
test.use({ storageState: { cookies: [], origins: [] } });

test('a new iPhone player picks an avatar and ENTER ARENA lets them in', async ({ page }) => {
  // A cold production journey: sign in, terms, the avatar gallery, the gate,
  // then a reload. Playwright's default 30 s covers the whole test, and the
  // first live run (2026-10-17) passed the gate in 1881 ms and then ran out of
  // test time on the reload, before the durability check could answer. The
  // ENTER ARENA budget below is still FINISH_BUDGET_MS; only the journey
  // around it gets room.
  test.setTimeout(180_000);
  test.skip(
    !email || !password || !supabaseUrl || !publishableKey,
    'FIRST_RUN_EMAIL/FIRST_RUN_PASS and the Supabase publishable config are required.'
  );

  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publishableKey!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  expect(res.ok, `password grant failed: ${res.status}`).toBe(true);
  const stored = JSON.stringify({
    ...session,
    expires_at: Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600),
  });
  await page.addInitScript((value) => {
    if (!localStorage.getItem('smarter-poker-auth'))
      localStorage.setItem('smarter-poker-auth', value);
  }, stored);

  await page.goto(`invite/${DEFAULT_E2E_CLUB_ID}?ref=1`, { waitUntil: 'domcontentloaded' });

  // The terms gate comes first for a brand-new account. Wait for whichever
  // door is actually up (isVisible does not wait, so it raced the terms).
  const terms = page.locator('[role="dialog"][aria-labelledby="tos-title"]');
  const gate = page.getByRole('heading', { name: 'Complete Your Profile' });
  await expect(terms.or(gate).first()).toBeVisible({ timeout: 45_000 });
  if (await terms.isVisible()) {
    await terms.getByRole('checkbox').first().check({ force: true });
    await terms.getByRole('button', { name: /Accept/ }).tap();
  }

  await expect(gate).toBeVisible({ timeout: 30_000 });
  // One first-run prompt at a time: the welcome waits behind the gate.
  await expect(page.locator('[aria-labelledby="club-arena-welcome-title"]')).toHaveCount(0);

  const enterArena = page.getByRole('button', { name: 'Enter Arena' });
  // The condition that broke it: on an iPhone the plate carries the switch.
  await expect(enterArena.locator('input[data-tap-haptic]')).toHaveCount(1);

  // Pick an avatar, exactly as both players did.
  await page.getByRole('button', { name: /^(?:Select|Change) Avatar$/ }).tap();
  const gallery = page.getByRole('dialog', { name: 'Avatar Gallery' });
  await expect(gallery).toBeVisible({ timeout: 30_000 });
  await gallery.locator('.ag-grid .ag-item:not(.ag-item--locked)').first().tap();
  await gallery.locator('button.ag-apply').tap({ timeout: 60_000 });
  await expect(gallery).toBeHidden({ timeout: 20_000 });

  // A finger on ENTER ARENA lands on the switch. The profile must save, once,
  // and the gate must come down within the budget.
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      /\/rest\/v1\/profiles\?/.test(r.url()) &&
      r.status() < 300 &&
      /username/.test(r.request().postData() || ''),
    { timeout: FINISH_BUDGET_MS }
  );
  const tappedAt = Date.now();
  await enterArena.tap();
  await saved;
  await expect(gate).toBeHidden({ timeout: FINISH_BUDGET_MS });
  console.log(`[first-run] ENTER ARENA to through: ${Date.now() - tappedAt} ms`);

  // Then, and only then, the welcome.
  await expect(page.locator('[aria-labelledby="club-arena-welcome-title"]')).toBeVisible({
    timeout: 15_000,
  });

  // And it is durable: a reload finds the gate decided "complete".
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.locator('[data-profile-gate-status]:not([data-profile-gate-status="pending"])')
  ).toHaveAttribute('data-profile-gate-status', 'complete', { timeout: 60_000 });
});
