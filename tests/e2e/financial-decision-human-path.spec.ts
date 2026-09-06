import { expect, test, type Route } from '@playwright/test';

const jsonHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,apikey,content-type,prefer,x-client-info',
  'content-type': 'application/json',
};

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
  await expect(card).toHaveAttribute(
    'aria-label',
    /Your Seat Is Held For \d+ More Seconds\. Tap To Take It\./
  );
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

  const countdown = page.getByTestId('waitlist-hold-countdown');
  const readSeconds = async () =>
    Number(((await countdown.innerText()).match(/:(\d{2})/) ?? [])[1]);
  const first = await readSeconds();
  await page.waitForTimeout(2_100);
  const later = await readSeconds();
  expect(first).toBeGreaterThan(later);
  expect(first - later).toBeLessThanOrEqual(4);

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
