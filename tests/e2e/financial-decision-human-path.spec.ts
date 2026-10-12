import { expect, test, type BrowserContext, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';

for (const width of [375, 393, 1280]) {
  test(`Tournament Register clears the live footer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    const sheets = [
      'src/pages/tournament/TournamentDetails.css',
      'src/styles/tournament-lobby-3d.css',
    ]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${sheets}
      body { margin: 0; }
      #global-footer { position: fixed; bottom: 0; height: 132px; width: 100%; z-index: 1000; }
      </style>
      <section class="tournament-details" data-embedded="false" style="--details-h: 100dvh">
        <header class="details-header"><h1 class="tournament-name">Tournament</h1></header>
        <div class="details-content">Tournament Details</div>
        <div class="details-footer"><button class="btn-register" onclick="document.querySelector('output').textContent='Opened'">Register</button></div>
      </section><nav id="global-footer">Poker Arena</nav><output></output>`);
    for (const height of [132, 0, 66]) {
      await page.evaluate((value) => {
        document.documentElement.style.setProperty('--ca-bottom-chrome-h', `${value}px`);
        (document.querySelector('#global-footer') as HTMLElement).style.height = `${value}px`;
      }, height);
      // Mobile viewport and live footer changes can finish layout after setContent.
      // Require the rendered hit target and clearance together, retaining both
      // guards and a five-second budget inside the sixty-second case deadline.
      await expect(async () => {
        const hit = await page
          .getByRole('button', { name: 'Register', exact: true })
          .evaluate((el) => {
            const rect = el.getBoundingClientRect();
            const top = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2
            );
            const footer = document.querySelector('#global-footer')!.getBoundingClientRect();
            return { reachable: top === el, bottom: rect.bottom, footerTop: footer.top };
          });
        expect(hit.reachable, `Register is intercepted with ${height}px of footer`).toBe(true);
        expect(hit.bottom).toBeLessThanOrEqual(hit.footerTop);
      }).toPass({ timeout: 5_000 });
      await page.getByRole('button', { name: 'Register', exact: true }).click();
      await expect(page.locator('output')).toHaveText('Opened');
    }
    // The same shell inside a table's sheet owns a bounded parent; it must
    // keep that height even while the outer global footer is visible.
    await page.locator('.tournament-details').evaluate((el) => {
      el.setAttribute('data-embedded', 'true');
      (el as HTMLElement).style.setProperty('--details-h', '500px');
    });
    expect(
      await page.locator('.tournament-details').evaluate((el) => el.getBoundingClientRect().height)
    ).toBe(500);
  });
}

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

test('A queued place fits a phone and a seat offer removes it without a hold popup', async ({
  page,
}) => {
  await page.getByRole('dialog', { name: 'All-In Insurance' }).press('Escape');
  await expect(page.getByRole('dialog', { name: 'All-In Insurance' })).toHaveCount(0);
  await page.getByTestId('waitlist-join').click();

  const card = page.getByTestId('waitlist-banner-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('#1');
  await expect(card.getByText('Phase Five Hold Table')).toBeVisible();
  await card.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });

  const box = await card.boundingBox();
  const viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: window.innerHeight,
  }));
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(viewport.width).toBe(375);
  expect(viewport.scrollWidth).toBe(viewport.width);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - 52 - 12);

  const dismiss = card.getByRole('button', {
    name: 'Dismiss The Waitlist Notice For Phase Five Hold Table',
  });
  const dismissHitArea = await dismiss.evaluate((button) => {
    const pseudo = getComputedStyle(button, '::after');
    return { width: pseudo.width, height: pseudo.height };
  });
  expect(dismissHitArea).toEqual({ width: '44px', height: '44px' });

  // Dan 2026-10-12: a held seat needs no second card or take-seat prompt.
  // Verify the real mounted consumer handles the event and clears its queue.
  await page.getByTestId('waitlist-seat-offer').click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText('Seat Held', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Tap To Take It', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/dev\/financial-decisions$/);

  // A later genuine queue event must still work; dismiss is local UI only.
  await page.getByTestId('waitlist-join').click();
  await expect(card).toBeVisible();
  await dismiss.click();
  await expect(card).toHaveCount(0);
});
