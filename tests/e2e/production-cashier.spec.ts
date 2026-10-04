import { expect, test } from '@playwright/test';
import {
  attachCashierScreenshot,
  expectCashierAxeClean,
  expectCompactCashierFigure,
  expectNoRawCashierCents,
} from './support/cashierProductionCertification';

const DEFAULT_E2E_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const CASHIER_ROLES = ['Owner', 'Co Owner', 'Admin', 'Super Agent', 'Agent', 'Sub Agent'] as const;
// Production account membership is intentionally mutable. Exact wallet names
// are an optional environment contract; the maintained certificate below
// always proves the durable behavior: an owned union, at least two club
// wallets, alternate-club navigation, keyboard opening, right-click and hold.
const EXPECTED_WALLETS = (process.env.E2E_CASHIER_WALLETS || '')
  .split('|')
  .map((name) => name.trim())
  .filter(Boolean);

test.describe('Production Cashier Certification', () => {
  test.describe.configure({ timeout: 90_000 });

  test.skip(
    !process.env.SP_EMAIL || !process.env.SP_PASS,
    'Dedicated production credentials are required for the authenticated cashier canary.'
  );

  test('serves the redesigned Trade surface and opens its first visible tab', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 393, height: 852 });
    const clubId = process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
    const consoleErrors: Array<{ text: string; url: string }> = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push({ text: message.text(), url: message.location().url });
      }
    });

    await page.goto(`clubs/${clubId}/cashier`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    await expect(page.locator('[data-cashier-surface="trade"]')).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole('heading', { name: 'Every Chip. Accounted For.', exact: true })
    ).toBeVisible();

    const tablist = page.getByRole('tablist', { name: 'Cashier Actions' });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole('tab');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    if ((await tabs.count()) > 1) {
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false');
    }

    const reconciliation = page.locator('[data-cashier-recovery="true"]');
    await expect(reconciliation).toBeVisible();
    await expect(
      reconciliation.getByRole('heading', { name: 'Reconciliation Console', exact: true })
    ).toBeVisible();
    await expect(reconciliation.getByText('Online', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // WAIT FOR HYDRATION, DO NOT ASSERT AGAINST IT.
    //
    // The button is disabled while `loading || isHydrating || !clubUuid`, so
    // this assertion is really "the console finished loading". Every other
    // wait in this spec is given 30-60s because it is talking to real
    // production; this one inherited Playwright's 5s default, and 5s is not a
    // hydration budget - it is a race against a live network.
    //
    // It lost that race at 02:05, 02:18 and 03:03 UTC and won it at 14:48,
    // with no code change in between. That pattern is not a product bug, it is
    // a cold overnight path being slower than a warm afternoon one, and a spec
    // that reports it as a failure teaches everyone to ignore the cashier
    // canary. The assertion is unchanged - the console must end up usable -
    // only the patience is.
    await expect(reconciliation.getByRole('button', { name: 'Reconcile Now' })).toBeEnabled({
      timeout: 30_000,
    });
    // The synchronization message belongs to the hero's live status region;
    // the reconciliation console exposes the same successful state as its
    // verified timestamp. Scoping this assertion to the console looked for a
    // node that cannot exist and made a healthy production cashier fail its
    // canary after hydration completed.
    const cashierStatus = page
      .getByRole('region', { name: 'Every Chip. Accounted For.' })
      .getByRole('status');
    await expect(cashierStatus).toHaveText(
      /^(Balances Synchronized|Cashier Ready; Loading The Rest Of The Roster After [\d,]+ Members)$/,
      { timeout: 30_000 }
    );
    await expect(reconciliation.getByText('Not Yet Verified', { exact: true })).toHaveCount(0);
    // Role resolution can rebuild the visible tab set. The default must still
    // be the first available action after authoritative hydration completes.
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    if ((await tabs.count()) > 1) {
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false');
    }

    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    const cashierCritical = consoleErrors.filter(
      (message) =>
        !message.text.includes('[cashier-telemetry]') &&
        !message.text.includes('favicon') &&
        !message.url.includes('favicon')
    );
    expect(
      cashierCritical,
      cashierCritical.map((entry) => `${entry.url}: ${entry.text}`).join('\n')
    ).toEqual([]);

    const surface = page.locator('[data-cashier-surface="trade"]');
    await expectNoRawCashierCents(surface, 'Trade Cashier');
    const currentBalances = page.getByLabel('Current Cashier Balances').locator('strong');
    expectCompactCashierFigure(await currentBalances.nth(0).innerText(), 'Club Chips');
    expectCompactCashierFigure(await currentBalances.nth(1).innerText(), 'Agent Wallet');
    await expectCashierAxeClean(page, testInfo, '[data-cashier-surface="trade"]', 'trade-cashier');
    await attachCashierScreenshot(page, testInfo, 'trade-cashier');

    await page.getByRole('button', { name: /Open Another Club Cashier/ }).click();
    await expect(page.getByRole('listbox', { name: 'Club Cashiers' })).toBeVisible();
    await expectCashierAxeClean(page, testInfo, '#cashier-club-picker', 'trade-wallet-picker');
    await attachCashierScreenshot(page, testInfo, 'trade-wallet-picker');
  });

  test('opens the complete wallet directory by right-click and mobile hold', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto('.', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    const quickActions = page.getByRole('navigation', { name: 'Quick Actions' });
    await expect(quickActions).toBeVisible({ timeout: 60_000 });
    const cashierTile = quickActions.getByRole('button', { name: /^Cashier\b/ });
    await expect(cashierTile).toBeVisible();
    // The shell can paint before the wallet directory exposes its menu.
    await expect(cashierTile).toHaveAttribute('aria-haspopup', 'menu', { timeout: 30_000 });

    await cashierTile.click({ button: 'right' });
    const desktopMenu = page.getByRole('menu', { name: 'Open Cashier For' });
    await expect(desktopMenu).toBeVisible();
    const desktopItems = desktopMenu.getByRole('menuitem');
    await expect(desktopItems.first()).toBeVisible();
    const desktopLabels = (await desktopItems.allInnerTexts()).map((label) =>
      label.replace(/\s+/g, ' ').trim()
    );
    for (const wallet of EXPECTED_WALLETS) {
      expect(
        desktopLabels.some((label) => label.includes(wallet)),
        `maintained Cashier fixture is missing ${wallet}`
      ).toBe(true);
    }
    const unionIndex = desktopLabels.findIndex((label) => /Union Wallet/.test(label));
    expect(
      unionIndex,
      'maintained Cashier fixture exposes no owned union wallet'
    ).toBeGreaterThanOrEqual(0);
    expect(
      desktopLabels.filter((label) => !/Union Wallet/.test(label)).length,
      'maintained Cashier fixture needs at least two club wallets for navigation proof'
    ).toBeGreaterThanOrEqual(2);
    await testInfo.attach('cashier-wallet-directory.json', {
      body: JSON.stringify(
        {
          configuredExpected: EXPECTED_WALLETS,
          observed: desktopLabels,
          structuralMinimum: { ownedUnionWallets: 1, clubWallets: 2 },
        },
        null,
        2
      ),
      contentType: 'application/json',
    });

    await page.keyboard.press('Escape');
    await expect(desktopMenu).toBeHidden();
    await cashierTile.focus();
    await page.keyboard.press('ArrowDown');
    await expect(desktopMenu).toBeVisible();
    await expect(desktopItems.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(desktopMenu).toBeHidden();
    await page.setViewportSize({ width: 393, height: 852 });
    await cashierTile.scrollIntoViewIfNeeded();
    await cashierTile.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0 });
    await page.waitForTimeout(550);
    const mobileMenu = page.getByRole('menu', { name: 'Open Cashier For' });
    await expect(mobileMenu).toBeVisible();
    await cashierTile.dispatchEvent('pointerup', { pointerType: 'touch', button: 0 });

    const bounds = await mobileMenu.evaluate((menu) => {
      const box = menu.parentElement?.getBoundingClientRect() ?? menu.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewportWidth);
    await expectCashierAxeClean(page, testInfo, '[role="menu"]', 'mobile-wallet-directory');
    await attachCashierScreenshot(page, testInfo, 'mobile-wallet-directory');

    // Navigation is read-only. Choose a club other than the tile's current target.
    const tileLabel = (await cashierTile.getAttribute('aria-label')) || '';
    const targetName = tileLabel.match(/^Cashier For (.+?) \(Press/)?.[1] || '';
    const mobileLabels = (await mobileMenu.getByRole('menuitem').allInnerTexts()).map((label) =>
      label.replace(/\s+/g, ' ').trim()
    );
    const alternateClubIndex = mobileLabels.findIndex(
      (label) => !/Union Wallet/.test(label) && !label.includes(targetName)
    );
    expect(
      alternateClubIndex,
      'no deterministic alternate club wallet exists'
    ).toBeGreaterThanOrEqual(0);
    const beforeClubNavigation = page.url();
    await mobileMenu.getByRole('menuitem').nth(alternateClubIndex).click();
    await expect(page).toHaveURL(/\/clubs\/[^/]+\/cashier(?:[/?#]|$)/, { timeout: 30_000 });
    expect(page.url()).not.toBe(beforeClubNavigation);

    await page.goto('.', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const returnedTile = page
      .getByRole('navigation', { name: 'Quick Actions' })
      .getByRole('button', { name: /^Cashier\b/ });
    await expect(returnedTile).toHaveAttribute('aria-haspopup', 'menu', { timeout: 30_000 });
    await returnedTile.click({ button: 'right' });
    const returnedMenu = page.getByRole('menu', { name: 'Open Cashier For' });
    const union = returnedMenu.getByRole('menuitem').filter({ hasText: 'Union Wallet' }).first();
    await expect(union).toBeVisible();
    await union.click();
    await expect(page).toHaveURL(/\/unions\/[^/]+\/operations\?tab=wallet(?:&|$)/, {
      timeout: 30_000,
    });
  });

  test('certifies the Advanced Cashier and an open wallet without moving money', async ({
    page,
  }, testInfo) => {
    const clubId = process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto(`clubs/${clubId}/cashier-classic`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    const console = page.locator('main .sc').filter({ hasText: 'Club Arena Cashier' }).first();
    await expect(console).toBeVisible({ timeout: 60_000 });
    await expectNoRawCashierCents(page.locator('main'), 'Advanced Cashier');
    await expectCashierAxeClean(page, testInfo, 'main', 'advanced-cashier');
    await attachCashierScreenshot(page, testInfo, 'advanced-cashier');

    const agentWallet = page.getByRole('button', { name: /Agent Wallet/ }).first();
    await expect(agentWallet).toBeVisible();
    await agentWallet.click();
    const dialog = page.getByRole('dialog', { name: 'Agent Wallet Cashier' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expectNoRawCashierCents(dialog, 'Agent Wallet Cashier');
    await expectCashierAxeClean(page, testInfo, '[role="dialog"]', 'agent-wallet-cashier');
    await attachCashierScreenshot(page, testInfo, 'agent-wallet-cashier');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('records the maintained live role matrix constraint without impersonation', async ({
    page,
  }, testInfo) => {
    const clubId = process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
    await page.goto(`clubs/${clubId}/cashier`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const access = page.getByLabel('Current Cashier Balances').locator('strong').last();
    await expect(access).toBeVisible({ timeout: 60_000 });
    const observed = (await access.innerText()).trim();
    expect(CASHIER_ROLES).toContain(observed as (typeof CASHIER_ROLES)[number]);
    const missing = CASHIER_ROLES.filter((role) => role !== observed);
    const constraint = {
      expectedRoles: CASHIER_ROLES,
      observedRoles: [observed],
      missingRoles: missing,
      status: missing.length === 0 ? 'complete' : 'environment-constrained',
      reason:
        'The guarded production harness has one maintained read-only identity and does not impersonate or create money-bearing role identities. Source and server-contract role matrices remain separate CI evidence.',
    };
    if (missing.length > 0) {
      testInfo.annotations.push({
        type: 'constraint',
        description: `Live role identities unavailable: ${missing.join(', ')}`,
      });
    }
    await testInfo.attach('cashier-role-matrix-constraint.json', {
      body: JSON.stringify(constraint, null, 2),
      contentType: 'application/json',
    });
  });

  test('refreshes the visible commission summary through its scoped read contract', async ({
    page,
  }) => {
    // A cold route (60s), its read sequence (15s) and the next visible read
    // (30s plus request time) need room inside the complete test budget.
    test.setTimeout(150_000);
    const clubId = process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
    await page.goto(`clubs/${clubId}/agents`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    const summaryResponse = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith('/rpc/fn_get_agent_commission_summary'),
        { timeout: 50_000 }
      );
    const initial = summaryResponse();
    await page.getByRole('tab', { name: 'Commissions', exact: true }).click();
    const first = await initial;
    expect(first.status()).toBe(200);
    const request = first.request().postDataJSON();
    expect(request.p_club_id).toBe(clubId);
    expect(request.p_agent_id).toMatch(/^[0-9a-f-]{36}$/i);
    const assertSummary = async (response: typeof first) => {
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toEqual(request);
      const summary = await response.json();
      for (const key of ['total_earned', 'this_week', 'this_month', 'pending_payout']) {
        expect(['number', 'string']).toContain(typeof summary[key]);
        expect(String(summary[key]).trim()).not.toBe('');
        expect(Number.isFinite(Number(summary[key]))).toBe(true);
      }
      return summary;
    };
    await assertSummary(first);
    // The maintained production fixture is a reserved zero-balance staff
    // membership. Only read its own commission; never create an agent, grant
    // float, click a payout/send control or impersonate a real club member.
    const next = summaryResponse();
    const dashboard = page.locator('.agent-commission');
    await expect(
      dashboard.getByRole('region', { name: 'Automatic Weekly Settlement' })
    ).toBeVisible({ timeout: 30_000 });
    const refreshed = await assertSummary(await next);
    await expect(dashboard.locator('.summary-card.total .value')).toHaveText(
      Number(refreshed.total_earned).toLocaleString(),
      { timeout: 15_000 }
    );
  });
});
