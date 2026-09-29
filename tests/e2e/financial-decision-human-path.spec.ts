import { expect, test, type BrowserContext, type Route } from '@playwright/test';

const jsonHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,apikey,content-type,prefer,x-client-info',
  'content-type': 'application/json',
};

const HARNESS_USER_ID = '11111111-2222-4333-8444-555555555555';

/**
 * The waitlist decision hands an authenticated player to a protected table
 * route. Leaving this suite signed out made that final assertion race
 * AuthGuard: depending on whether its async session check finished before the
 * Enter key, the same run either reached the held seat or bounced to login.
 *
 * Seed a complete, non-production Supabase session before application boot.
 * All REST/Auth traffic remains intercepted by noMoneyBackend, so this proves
 * the real protected-route handoff without creating a player, membership, or
 * financial write anywhere.
 */
async function seedHarnessSession(context: BrowserContext) {
  await context.addInitScript(
    ({ authKey, userId }) => {
      const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
      const encode = (value: object) =>
        btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      const accessToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
        aud: 'authenticated',
        email: 'phase-five-harness@smarter.poker',
        exp: expiresAt,
        role: 'authenticated',
        sub: userId,
      })}.test-signature`;
      const user = {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'phase-five-harness@smarter.poker',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Phase Five Harness' },
        created_at: new Date().toISOString(),
      };

      localStorage.setItem(
        authKey,
        JSON.stringify({
          access_token: accessToken,
          refresh_token: 'phase-five-harness-refresh-token',
          expires_at: expiresAt,
          expires_in: 24 * 60 * 60,
          token_type: 'bearer',
          user,
        })
      );
    },
    { authKey: 'smarter-poker-auth', userId: HARNESS_USER_ID }
  );
}

async function noMoneyBackend(route: Route) {
  if (route.request().method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: jsonHeaders });
    return;
  }
  const path = new URL(route.request().url()).pathname;
  if (path.includes('/auth/v1/')) {
    await route.fulfill({
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({ user: null }),
    });
    return;
  }
  const body = path.endsWith('/profiles') ? [{ is_vip: false, vip_expires_at: null }] : [];
  await route.fulfill({ status: 200, headers: jsonHeaders, body: JSON.stringify(body) });
}

test.beforeEach(async ({ context, page }) => {
  await context.route(/\/auth\/v1\/.*/, noMoneyBackend);
  await context.route(/\/rest\/v1\/.*/, noMoneyBackend);
  await seedHarnessSession(context);
  await page.goto('dev/financial-decisions');
});

test('Insurance remains recoverable after rejection and is single-flight at 375px', async ({
  page,
}) => {
  const dialog = page.getByRole('dialog', { name: 'All-In Insurance' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(box!.y + box!.height).toBeLessThanOrEqual(812);

  const insure = page.getByRole('button', { name: 'Insure' });
  const decline = page.getByRole('button', { name: 'No' });
  await expect(insure).toBeVisible();
  await expect(decline).toBeVisible();

  // Same-frame double activation reproduces the gap React state alone leaves.
  await insure.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByTestId('insurance-request-count')).toHaveText('1');
  await expect(insure).toBeDisabled();

  await expect(page.getByTestId('insurance-status')).toHaveText(
    'Insurance Request Rejected. Please Try Again.'
  );
  await expect(
    dialog,
    'a rejected purchase must leave a recoverable decision surface'
  ).toBeVisible();
  await expect(insure).toBeEnabled();
});

test('Escape uses the final decline path once, then Rabbit Hunt announces price and single-flights', async ({
  page,
}) => {
  const insuranceDialog = page.getByRole('dialog', { name: 'All-In Insurance' });
  await expect(insuranceDialog).toBeFocused();
  await insuranceDialog.press('Escape');
  await expect(page.getByTestId('decline-count')).toHaveText('1');
  await expect(page.getByRole('dialog', { name: 'All-In Insurance' })).toHaveCount(0);

  const rabbit = page.getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' });
  await expect(rabbit).toBeVisible();
  const rabbitBox = await rabbit.boundingBox();
  expect(rabbitBox).not.toBeNull();
  expect(rabbitBox!.x).toBeGreaterThanOrEqual(0);
  expect(rabbitBox!.x + rabbitBox!.width).toBeLessThanOrEqual(375);

  await rabbit.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  const rabbitButton = page.locator('.rabbit-hunt__button');
  await expect(rabbitButton).toBeDisabled();
  await expect(page.getByTestId('rabbit-request-count')).toHaveText('1');
  await expect(rabbitButton).toHaveCount(0);
});

test('A 60-second waitlist offer counts down, fits a phone, and hands off to the held seat', async ({
  page,
}) => {
  await page.getByRole('dialog', { name: 'All-In Insurance' }).press('Escape');
  await expect(page.getByRole('dialog', { name: 'All-In Insurance' })).toHaveCount(0);
  await page.getByTestId('waitlist-seat-offer').click();

  const card = page.getByTestId('waitlist-banner-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-label', 'Your Seat Is Held. Tap To Take It.');
  await expect(card.getByText('Phase Five Hold Table')).toBeVisible();

  // Measure the settled card, not the intentional overshoot in its 400ms
  // entrance animation. The animation briefly travels below its final fixed
  // position and made an otherwise-correct clearance check timing-dependent.
  await card.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });

  const box = await card.boundingBox();
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(viewport.width).toBe(375);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - 52 - 12);

  /* Dan 2026-09-23: the hold's clock is internal. The card says the seat is
     held and what to do; it prints no countdown, at any moment of the hold. */
  await expect(card).toContainText('Seat Held');
  await expect(card).toContainText('Tap To Take It');
  expect(await card.innerText()).not.toMatch(/\d:\d{2}/);
  await page.waitForTimeout(2_100);
  expect(await card.innerText()).not.toMatch(/\d:\d{2}/);

  const dismiss = card.getByRole('button', {
    name: 'Dismiss The Waitlist Notice For Phase Five Hold Table',
  });
  const dismissHitArea = await dismiss.evaluate((button) => {
    const pseudo = getComputedStyle(button, '::after');
    return { width: pseudo.width, height: pseudo.height };
  });
  expect(dismissHitArea).toEqual({ width: '44px', height: '44px' });

  await card.press('Enter');
  await expect(page).toHaveURL(/\/table\/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\?buyin=1$/);
});
