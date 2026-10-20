import { expect, test, type Locator, type TestInfo } from '@playwright/test';
import { isEngineHealthUnavailableDiagnostic } from './support/engineCutoverConsole';
import {
  BATCH_VERDICTS,
  batchVerdictFor,
  fundingCoverage,
  printedFundingFigure,
} from './support/cashierFundingVerdict';
import {
  attachCashierScreenshot,
  expectCashierAxeClean,
  expectCashierAmountPresets,
  cashierRosterWalletValue,
  expectCashierWalletBalance,
} from './support/cashierProductionCertification';

const DEFAULT_E2E_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const CASHIER_ROLES = ['Owner', 'Co Owner', 'Admin', 'Super Agent', 'Agent', 'Sub Agent'] as const;
// Production account membership is intentionally mutable. Exact wallet names
// are an optional environment contract; the maintained certificate below
// always proves the durable behavior: all wallets this account is eligible to
// see, at least two club wallets, alternate-club navigation, keyboard opening,
// right-click and hold. Union navigation is exercised when it owns a union.
const EXPECTED_WALLETS = (process.env.E2E_CASHIER_WALLETS || '')
  .split('|')
  .map((name) => name.trim())
  .filter(Boolean);

// The batch preview's status line is owed by the wallet that FUNDS the action:
// Send Out spends the agent wallet, Send Ticket the caller's own chips. The
// maintained read-only identity holds neither (it is never funded), so the
// verdict is read from the figure the dialog prints, never assumed. Both
// directions still fail: "Ready" over a short wallet, or "Insufficient" over a
// covering one. See support/cashierFundingVerdict.ts.
async function expectBatchVerdictFromFunding(
  dialog: Locator,
  fundingLabel: 'From Your Agent Wallet' | 'From Your Player Wallet',
  total: number,
  recipients: number,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  // The funding wallet prints as its own painted row (CashierWalletRow): a
  // region named by its label, holding the figure in its value element. Read
  // the figure from that element. The dialog's innerText is not a source: the
  // painted label is text-transform: uppercase and sits flush against the
  // figure, so a label-then-figure match on innerText finds nothing and every
  // run reported an empty figure (Post-Deploy E2E, 2026-10-15).
  const fundingRow = dialog.getByRole('region', { name: fundingLabel, exact: true });
  await expect(fundingRow).toBeVisible();
  const figure = printedFundingFigure(await fundingRow.locator('strong').allTextContents());
  const coverage = fundingCoverage(figure, total);
  const verdict = batchVerdictFor(coverage, recipients);
  await testInfo.attach(`${name}-funding-verdict.json`, {
    body: JSON.stringify(
      { fundingLabel, printedFigure: figure, total, coverage, verdict },
      null,
      2
    ),
    contentType: 'application/json',
  });
  expect(
    verdict,
    `${name}: the printed ${fundingLabel} figure "${figure}" cannot decide whether it covers ${total}`
  ).not.toBeNull();
  const status = dialog
    .getByRole('status')
    .filter({ hasText: new RegExp(BATCH_VERDICTS.join('|')) });
  await expect(status).toHaveText(verdict as string);
}

// `.all()` snapshots nth() locators over a LIVE `:checked` filter: unchecking
// the first shifts the rest down, so the second snapshot (nth(1)) never
// resolves and the test burns its whole 150s budget waiting for it. Uncheck the
// first match until none remain, and require each uncheck to land.
async function uncheckEveryRecipient(surface: Locator): Promise<void> {
  const checked = surface.locator('input[type="checkbox"][aria-label^="Include "]:checked');
  for (let remaining = await checked.count(); remaining > 0; remaining = await checked.count()) {
    await checked.first().uncheck();
    await expect(checked).toHaveCount(remaining - 1);
  }
}

test.describe('Production Cashier Certification', () => {
  test.describe.configure({ timeout: 90_000 });

  test.skip(
    !process.env.SP_EMAIL || !process.env.SP_PASS,
    'Dedicated production credentials are required for the authenticated cashier canary.'
  );

  test('serves the redesigned Trade surface and opens its first visible tab', async ({
    page,
  }, testInfo) => {
    // Existing route/hydration (up to 90s), plus the new readonly accounting
    // response (30s) and rendered/a11y proof need a 150s complete flow budget.
    test.setTimeout(150_000);
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
    await expect(page.locator('[data-cashier-mode="simple"]')).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Cashier Actions' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim Back', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send Ticket', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send Out', exact: true })).toBeVisible();
    await expect(page.locator('a[aria-label^="Manage "]').first()).toBeVisible({ timeout: 30_000 });
    for (const width of [375, 393]) {
      await page.setViewportSize({ width, height: 852 });
      const geometry = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        actions: Array.from(document.querySelectorAll('[data-cashier-mode="simple"] button'))
          .filter((button) =>
            ['Claim Back', 'Send Ticket', 'Send Out'].includes(button.textContent?.trim() || '')
          )
          .map((button) => {
            const rect = button.getBoundingClientRect();
            return { height: rect.height, top: rect.top, bottom: rect.bottom };
          }),
      }));
      expect(geometry.scroll).toBe(geometry.width);
      expect(geometry.actions).toHaveLength(3);
      for (const action of geometry.actions) {
        expect(action.height).toBeGreaterThanOrEqual(44);
        expect(action.top).toBeGreaterThanOrEqual(0);
        expect(action.bottom).toBeLessThanOrEqual(852);
      }
      await attachCashierScreenshot(page, testInfo, `simple-cashier-${width}`);
    }
    await page.getByRole('button', { name: /^Advanced(?: \([\d,]+\))?$/ }).click();
    // 2026-10-17: the "Wallet Command" title and its paragraph are gone; the
    // desk is still named for assistive technology, and the "?" explains it.
    await expect(page.getByRole('region', { name: 'Wallet Command' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Page Help', exact: true })).toBeVisible();

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
    const cashierStatus = page.getByRole('region', { name: 'Wallet Command' }).getByRole('status');
    // A first roster page is usable before the remaining pages have been
    // verified. Both witnesses must agree within the existing hydration budget;
    // a continuation warning or refused read must still fail certification.
    await expect
      .poll(
        async () => ({
          status: (await cashierStatus.allTextContents()).join(''),
          unverified: await reconciliation.getByText('Not Yet Refreshed', { exact: true }).count(),
        }),
        { timeout: 30_000 }
      )
      .toEqual({ status: 'Balances Synchronized', unverified: 0 });
    // Prove the actual new request and its rendered verdict, not a refresh-only
    // timestamp. The action reads a snapshot; never click a money control.
    const accountingResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/rpc/fn_cashier_conservation_report'),
      { timeout: 30_000 }
    );
    await reconciliation.getByRole('button', { name: 'Reconcile Now' }).click();
    const response = await accountingResponse;
    expect(response.status()).toBe(200);
    const requestedClub = response.request().postDataJSON().p_club_id;
    expect(requestedClub).toBe(clubId);
    const accounting = await response.json();
    expect(accounting.schema_version).toBe(1);
    expect(accounting.club_id).toBe(requestedClub);
    expect(accounting.scope).toBe('bank_and_player_baselines');
    expect(Number.isFinite(Date.parse(accounting.as_of))).toBe(true);
    expect(accounting.players.positions).toBe(
      accounting.players.checked + accounting.players.missing
    );
    const verdict =
      accounting.bank.status === 'attention' || accounting.players.status === 'attention'
        ? 'Discrepancies Found'
        : accounting.bank.status === 'incomplete' || accounting.players.status === 'incomplete'
          ? 'Coverage Incomplete'
          : 'Covered Balances Match';
    const report = page.getByRole('region', { name: 'Accounting Report' });
    await expect(report.getByRole('status')).toHaveText(verdict, { timeout: 15_000 });
    await expect(report.getByText(/Inventory Is Unverified/)).toBeVisible();
    await expect(
      report.getByText('This Report Does Not Move Chips Or Repair Balances.', { exact: false })
    ).toBeVisible();
    await testInfo.attach('cashier-accounting-snapshot.json', {
      body: JSON.stringify(accounting, null, 2),
      contentType: 'application/json',
    });
    // Role resolution can rebuild the visible tab set. The default must still
    // be the first available action after authoritative hydration completes.
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    if ((await tabs.count()) > 1) {
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false');
    }

    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    const engineHealthDiagnostics = consoleErrors.filter(isEngineHealthUnavailableDiagnostic);
    await testInfo.attach('cashier-engine-health-diagnostics.json', {
      body: JSON.stringify(engineHealthDiagnostics, null, 2),
      contentType: 'application/json',
    });
    const cashierCritical = consoleErrors.filter(
      (message) =>
        !isEngineHealthUnavailableDiagnostic(message) &&
        !message.text.includes('[cashier-telemetry]') &&
        !message.text.includes('favicon') &&
        !message.url.includes('favicon')
    );
    expect(
      cashierCritical,
      cashierCritical.map((entry) => `${entry.url}: ${entry.text}`).join('\n')
    ).toEqual([]);

    const surface = page.locator('[data-cashier-surface="trade"]');
    const currentBalances = page.getByLabel('Current Cashier Balances').locator('strong');
    await expectCashierWalletBalance(currentBalances.nth(0), 'Club Chips');
    await expectCashierWalletBalance(currentBalances.nth(1), 'Agent Wallet');
    const rosterWalletLabels = surface.getByText('Player Wallet', { exact: true });
    const rosterWalletCount = await rosterWalletLabels.count();
    expect(rosterWalletCount, 'Trade Cashier must expose player wallet balances').toBeGreaterThan(
      0
    );
    for (let index = 0; index < rosterWalletCount; index++) {
      await expectCashierWalletBalance(
        cashierRosterWalletValue(rosterWalletLabels.nth(index)),
        `Trade Player Wallet ${index + 1}`
      );
    }
    const aggregates = surface.locator('[class*="stripValue"]');
    await expectCashierWalletBalance(aggregates.nth(1), 'Downline Holdings');
    await expectCashierAxeClean(page, testInfo, '[data-cashier-surface="trade"]', 'trade-cashier');
    await attachCashierScreenshot(page, testInfo, 'trade-cashier');
    await expect(surface.locator('[data-cashier-layout="directory"]')).toHaveCount(1);
    await expect(surface.locator('.sc')).toHaveCount(0);
    const rosterSearch = page.getByRole('searchbox', { name: /^Search \d+ Members?$/ });
    await expect(rosterSearch).toBeVisible();
    await rosterSearch.fill('cashier-no-member-9284176');
    await expect(page.getByText('No Members Match That Search.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear Search', exact: true }).click();
    await expect(rosterSearch).toHaveValue('');
    await expect(rosterSearch).toBeFocused();
    await expect(page.getByText('No Members Match That Search.', { exact: true })).toHaveCount(0);
    const roleFilter = page.getByRole('combobox', { name: 'Filter Roster By Role' });
    await roleFilter.selectOption('player');
    await expect(roleFilter).toHaveValue('player');
    await page.getByRole('button', { name: 'Clear Filters', exact: true }).click();
    await expect(roleFilter).toHaveValue('all');
    await expect(rosterSearch).toBeFocused();
    // Dan 2026-10-15: one tap anywhere on a row checks it; Send Out opens the
    // dialog on the selection.
    const nativeSelect = surface.getByRole('checkbox', { name: /^Include / }).first();
    await expect(nativeSelect).toBeVisible();
    await nativeSelect.click();
    await expect(nativeSelect).toBeChecked();
    const sendOutAction = surface.getByRole('button', { name: 'Send Out', exact: true });
    await sendOutAction.click();
    const transferDialog = page.getByRole('dialog', { name: 'Send Out', exact: true });
    const singleAmount = transferDialog.getByRole('textbox', { name: 'Amount', exact: true });
    await expect(singleAmount).toHaveAttribute('inputmode', 'decimal');
    await singleAmount.fill('100000');
    await expect(singleAmount).toHaveValue('100,000');
    await singleAmount.fill('10.005');
    await expect(singleAmount).toHaveAttribute('aria-invalid', 'true');
    await expect(singleAmount).toHaveAccessibleDescription(
      /Enter The Amount As Digits, With Up To Two Decimals/
    );
    await singleAmount.fill('0.20');
    await expect(singleAmount).toHaveAttribute('aria-invalid', 'false');
    const selectedPlayer = transferDialog.getByRole('region', {
      name: 'Selected Player',
      exact: true,
    });
    await expect(selectedPlayer).toBeVisible();
    await expect(selectedPlayer).toContainText('ID');
    await expect(selectedPlayer).toContainText('Player Wallet');
    await expect(
      transferDialog.getByRole('region', { name: 'From Your Agent Wallet' })
    ).toBeVisible();
    const confirm = transferDialog.getByRole('button', { name: 'Confirm', exact: true });
    const close = transferDialog.getByRole('button', { name: 'Close', exact: true });
    await confirm.focus();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(confirm).toBeFocused();
    await transferDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(sendOutAction).toBeFocused();
    await expect(transferDialog).toHaveCount(0);
    // Preview only: certify the published individual-amount wiring without
    // spending real chips or issuing tickets against production players.
    const recipients = surface.locator('input[type="checkbox"][aria-label^="Include "]:enabled');
    await uncheckEveryRecipient(surface);
    await expect(recipients.nth(1)).toBeVisible();
    await recipients.nth(0).check();
    await recipients.nth(1).check();
    await surface.getByRole('button', { name: 'Send Out', exact: true }).click();
    await transferDialog.getByRole('textbox', { name: 'Amount', exact: true }).fill('10');
    const individualAmounts = transferDialog.getByRole('textbox', { name: /^Amount For / });
    await expect(individualAmounts).toHaveCount(2);
    await individualAmounts.nth(1).fill('0.20');
    await expect(transferDialog).toContainText('Total: 10.20');
    await expect(transferDialog).toContainText('2 Players ·');
    await expectBatchVerdictFromFunding(
      transferDialog,
      'From Your Agent Wallet',
      10.2,
      2,
      testInfo,
      'cashier-batch-send-out'
    );
    await expectCashierAxeClean(page, testInfo, '[role="dialog"]', 'cashier-batch-preview');
    await attachCashierScreenshot(page, testInfo, 'cashier-batch-individual-preview');
    await transferDialog.getByRole('button', { name: 'Send Ticket', exact: true }).click();
    const ticketDialog = page.getByRole('dialog', { name: 'Send Ticket', exact: true });
    // Dan 2026-10-15: a ticket is bought into one future or running tournament,
    // priced by the server and paid from the sender's player wallet.
    await expect(ticketDialog.getByRole('combobox', { name: 'Tournament' })).toBeVisible();
    await expect(
      ticketDialog.getByRole('region', { name: 'From Your Player Wallet' })
    ).toBeVisible();
    await expect(ticketDialog).toContainText('2 Players ·');
    await ticketDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await uncheckEveryRecipient(surface);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const directoryWidth = await surface
      .locator('[data-cashier-layout="directory"]')
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(directoryWidth).toBeGreaterThan(1000);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await attachCashierScreenshot(page, testInfo, 'trade-cashier-desktop');
    await page.setViewportSize({ width: 393, height: 852 });

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
      desktopLabels.filter((label) => !/Union Wallet/.test(label)).length,
      'maintained Cashier fixture needs at least two club wallets for navigation proof'
    ).toBeGreaterThanOrEqual(2);
    await testInfo.attach('cashier-wallet-directory.json', {
      body: JSON.stringify(
        {
          configuredExpected: EXPECTED_WALLETS,
          observed: desktopLabels,
          observedCounts: {
            ownedUnionWallets: desktopLabels.filter((label) => /Union Wallet/.test(label)).length,
            clubWallets: desktopLabels.filter((label) => !/Union Wallet/.test(label)).length,
          },
          structuralContract: {
            clubWallets: 'at least two maintained memberships',
            ownedUnionWallets: 'every owned union, when the account owns one',
          },
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
    // Opening by keyboard focuses the current wallet, which is not required
    // to be the first directory row. Prove focus entered exactly one wallet
    // item instead of coupling the certificate to mutable list ordering.
    await expect(desktopMenu.locator('[role="menuitem"]:focus')).toHaveCount(1);
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
    await expect(returnedMenu).toBeVisible();
    // Union wallets are conditional by product contract: owners see every
    // union they own, while club-only staff must not need a synthetic union
    // merely to use the Cashier. Exercise the live union route whenever this
    // maintained account owns one; deterministic unit coverage proves owned
    // unions are included and non-owned unions are excluded.
    if (unionIndex >= 0) {
      const union = returnedMenu.getByRole('menuitem').filter({ hasText: 'Union Wallet' }).first();
      await expect(union).toBeVisible();
      await union.click();
      await expect(page).toHaveURL(/\/unions\/[^/]+\/operations\?tab=wallet(?:&|$)/, {
        timeout: 30_000,
      });
    }
  });

  test('certifies the Advanced Cashier and an open wallet without moving money', async ({
    page,
  }, testInfo) => {
    test.setTimeout(150_000);
    const clubId = process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto(`clubs/${clubId}/cashier-classic`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    const console = page
      .locator('main [data-cashier-layout="directory"]')
      .filter({ has: page.getByRole('heading', { name: 'Cashier', exact: true }) });
    await expect(console).toHaveCount(1);
    await expect(console).toBeVisible({ timeout: 60_000 });
    const agentWallet = page.getByRole('button', { name: /Agent Wallet/ }).first();
    // The painted console precedes authoritative role and wallet hydration.
    // Inspect the loaded surface, retaining the existing thirty-second bound.
    await expect
      .poll(
        async () => ({
          loading: await console.getByText('Loading Your Cashier', { exact: true }).count(),
          walletVisible: await agentWallet.isVisible(),
          walletVerified: /\d/.test(
            (await agentWallet.locator('.dw__row-value').allTextContents()).join('')
          ),
        }),
        { timeout: 30_000 }
      )
      .toEqual({ loading: 0, walletVisible: true, walletVerified: true });
    const advancedWalletRows = page.locator(
      'main [data-wallet-key]:not([data-wallet-key="diamonds"]):not([data-wallet-key="backup_bbj"])'
    );
    const advancedWalletCount = await advancedWalletRows.count();
    expect(advancedWalletCount, 'Advanced Cashier must expose wallet balances').toBeGreaterThan(0);
    for (let index = 0; index < advancedWalletCount; index++) {
      const row = advancedWalletRows.nth(index);
      const key = await row.getAttribute('data-wallet-key');
      const value = row.locator('.dw__row-value');
      // Treasury data can legitimately be unreadable/not applicable. Primary
      // player, agent, promo and Club Bank wallets must verify, including zero.
      if (
        ['spins_wallet', 'rake_treasury'].includes(key || '') &&
        (await value.innerText()) === '-'
      ) {
        continue;
      }
      await expectCashierWalletBalance(value, `Advanced ${key} Wallet`);
    }
    await expectCashierWalletBalance(
      page.locator('main [data-wallet-key="diamonds"] .dw__row-value'),
      'Advanced Diamond Wallet',
      'diamonds'
    );
    const presets = console.locator('[class*="presetBtn"]');
    expectCashierAmountPresets(await presets.allInnerTexts());
    await expectCashierAxeClean(page, testInfo, 'main', 'advanced-cashier');
    await expect(page.locator('main .dw__row-picture').first()).not.toBeVisible();
    await expect(page.locator('main .dw__row-label').first()).toBeVisible();
    await expect(page.locator('main .dw__bbj-shell')).not.toBeVisible();
    await attachCashierScreenshot(page, testInfo, 'advanced-cashier');

    // Exercise every amount rail this real identity may use, without submitting.
    // Mounted tests cover all four actions even when production rights differ.
    const advancedTabs = page.getByRole('tablist', { name: 'Cashier Actions' });
    const observedAmountRails: string[] = [];
    for (const width of [375, 393]) {
      await page.setViewportSize({ width, height: 852 });
      for (const rail of ['Send', 'Distribute', 'Mint', 'Cash-Out']) {
        const tab = advancedTabs.getByRole('tab', { name: rail, exact: true });
        if ((await tab.count()) === 0) continue;
        await tab.click();
        const field = console.getByRole('textbox', {
          name: rail === 'Mint' ? 'Chips To Mint' : 'Amount',
          exact: true,
        });
        await expect(field).toBeVisible();
        await field.fill('100000');
        await expect(field).toHaveValue('100,000');
        await expect(field).toHaveAttribute('inputmode', rail === 'Mint' ? 'numeric' : 'decimal');
        await field.fill(rail === 'Mint' ? '1.5' : '10.005');
        await expect(field).toHaveAttribute('aria-invalid', 'true');
        await expect(field).toHaveAccessibleDescription(
          rail === 'Mint' ? 'Mint Whole Chips Only' : 'Chips Go To Two Decimal Places'
        );
        const feedback = console.locator('#cashier-amount-validation');
        await expect(feedback).toBeVisible();
        await expect(feedback).toHaveAttribute('role', 'status');
        await expect(feedback).not.toHaveAttribute('aria-label');
        const bounds = await field.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        const geometry = await page.evaluate(() => ({
          width: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
        await field.fill('10');
        await expect(field).toHaveAttribute('aria-invalid', 'false');
        await expect(feedback).toHaveCount(0);
        await field.fill('');
        observedAmountRails.push(`${width}:${rail}`);
      }
      await expectCashierAxeClean(page, testInfo, 'main', `advanced-amounts-${width}`);
    }
    expect(observedAmountRails).toContain('375:Send');
    expect(observedAmountRails).toContain('393:Send');
    await testInfo.attach('advanced-phone-amount-rails.json', {
      body: JSON.stringify({ observedAmountRails, physicalPhone: false }, null, 2),
      contentType: 'application/json',
    });
    // The tab set remains keyboard operable after the phone passes.
    const sendTab = advancedTabs.getByRole('tab', { name: 'Send', exact: true });
    await sendTab.focus();
    await page.keyboard.press('End');
    await expect(advancedTabs.getByRole('tab').last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(advancedTabs.getByRole('tab').first()).toBeFocused();
    await sendTab.click();

    // Read only the dedicated canary's identity, never its token or credentials.
    const ownerId = await page.evaluate(() => {
      const session = JSON.parse(localStorage.getItem('smarter-poker-auth') || 'null');
      return session?.user?.id || session?.currentSession?.user?.id || null;
    });
    expect(ownerId).toMatch(/^[0-9a-f-]{36}$/);
    const agentBalanceRead = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'GET' &&
          url.pathname.endsWith('/rest/v1/agents') &&
          url.searchParams.get('club_id') === `eq.${clubId}` &&
          url.searchParams.get('select') ===
            'agent_wallet_balance,promo_wallet_balance,is_prepaid,credit_limit,credit_used' &&
          url.searchParams.get('user_id') === `eq.${ownerId}` &&
          response.status() === 200
        );
      },
      { timeout: 30_000 }
    );
    await agentWallet.click();
    const dialog = page.getByRole('dialog', { name: 'Agent Wallet Cashier' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const agentAnswer = await (await agentBalanceRead).json();
    if (Array.isArray(agentAnswer)) expect(agentAnswer.length).toBeLessThanOrEqual(1);
    const agentRow = Array.isArray(agentAnswer) ? (agentAnswer[0] ?? null) : agentAnswer;
    const bankFigure = dialog.locator('.cbc-bank strong');
    if (agentRow === null) {
      // A successful absent agents row is an unfunded float, never an unread balance.
      await expect(bankFigure).toHaveText('No Agent Float Yet');
    } else {
      expect(typeof agentRow).toBe('object');
      expect(agentRow).toHaveProperty('agent_wallet_balance');
      // The authoritative balance reader coalesces SQL NULL to zero, but never a missing field.
      const rawHeld = agentRow.agent_wallet_balance;
      expect(rawHeld === null || typeof rawHeld === 'number' || typeof rawHeld === 'string').toBe(
        true
      );
      expect(rawHeld).not.toBe('');
      const held = Number(rawHeld);
      expect(Number.isFinite(held)).toBe(true);
      if (Math.abs(held) < 1_000_000) {
        await expect(bankFigure).toHaveText(
          held.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        );
      } else {
        await expect(bankFigure).toHaveText(/^-?\d+(?:\.\d)?[MB]$/);
      }
    }
    await expectCashierWalletBalance(
      dialog.locator('.cbc-bank > strong'),
      'Agent Wallet Cashier',
      'chips',
      {
        allowAbsentAgentFloat: true,
      }
    );
    await expectCashierAxeClean(page, testInfo, '[role="dialog"]', 'agent-wallet-cashier');
    await attachCashierScreenshot(page, testInfo, 'agent-wallet-cashier');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(agentWallet).toBeFocused();
  });

  test('records the maintained live role matrix constraint without impersonation', async ({
    page,
  }, testInfo) => {
    const clubId = process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
    await page.goto(`clubs/${clubId}/cashier`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.locator('[data-cashier-mode="simple"]')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: /^Advanced(?: \([\d,]+\))?$/ }).click();
    const access = page.getByLabel('Current Cashier Balances').locator('strong').last();
    await expect(access).toBeVisible({ timeout: 60_000 });
    // The visible metric intentionally reads "Synchronizing" during
    // authoritative hydration. Wait for the settled role instead of sampling
    // that legitimate loading state and misreporting it as invalid access.
    await expect(access).toHaveText(new RegExp(`^(${CASHIER_ROLES.join('|')})$`), {
      timeout: 60_000,
    });
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
