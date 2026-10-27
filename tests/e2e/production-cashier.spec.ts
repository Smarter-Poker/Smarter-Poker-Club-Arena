import { readFile } from 'node:fs/promises';
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

  test('keeps the Arena home free of bottom cards on mobile and desktop', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto('.', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    const home = page.getByRole('main', { name: 'Poker Arena Home', exact: true });
    await expect(home).toBeVisible({ timeout: 60_000 });
    const clubCard = home.getByRole('button', { name: /Click To Enter Lobby/ }).first();
    await expect(clubCard).toBeVisible({ timeout: 60_000 });

    for (const viewport of [
      { width: 393, height: 852 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(home.getByRole('navigation', { name: 'Quick Actions' })).toHaveCount(0);
      await expect(home.getByRole('button', { name: 'Open Menu', exact: true })).toBeVisible();
      await expect(clubCard).toBeVisible();
      await attachCashierScreenshot(page, testInfo, `arena-home-clean-${viewport.width}`);
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
  test('reads Transaction History through the installed feed and scopes, with real receipts', async ({
    page,
  }, testInfo) => {
    // Cold route, scoped reads, one older page, search, receipts and four renders.
    test.setTimeout(360_000);
    await page.setViewportSize({ width: 393, height: 852 });
    const clubId = process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
    const read = (name: string, scope?: string) =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith(`/rpc/${name}`) &&
          (!scope || response.request().postDataJSON()?.p_scope === scope),
        { timeout: 50_000 }
      );
    await page.goto(`clubs/${clubId}/cashier`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.locator('[data-cashier-mode="simple"]')).toBeVisible({ timeout: 60_000 });
    const firstFeed = read('fn_cashier_history_feed');
    const firstSummary = read('fn_cashier_history_summary');
    await page.getByRole('button', { name: 'Transaction History', exact: true }).click();
    // The simple entry hides its tab strip but still names the history panel.
    const panel = page.getByRole('tabpanel', { name: 'Transaction History', exact: true });
    await expect(panel).toBeVisible();
    const feed = await firstFeed;
    expect(feed.status()).toBe(200);
    const request = feed.request().postDataJSON();
    expect(request).toMatchObject({
      p_club_id: clubId,
      p_limit: 51,
      p_before_at: null,
      p_before_id: null,
    });
    expect(request).not.toHaveProperty('p_offset');
    await expect(panel.getByRole('button', { name: 'Today', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(
      panel.getByRole('button', { name: 'Chip Movements', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      panel.getByRole('button', { name: 'Latest Transactions', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByRole('button', { name: 'Managed', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Games', exact: true })).toHaveCount(0);
    expect(request.p_from).toEqual(expect.any(String));
    await attachCashierScreenshot(page, testInfo, 'transaction-history-today-default-393');

    const rows = await feed.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(
      rows.some((row: { transaction_type: string }) =>
        [
          'buyin',
          'cashout',
          'tournament_buyin',
          'tournament_rebuy',
          'tournament_addon',
          'tournament_ticket_redeem',
        ].includes(row.transaction_type)
      )
    ).toBe(false);
    const summary = await firstSummary;
    expect(summary.status()).toBe(200);
    expect(summary.request().postDataJSON()).toMatchObject({
      p_club_id: clubId,
      p_scope: request.p_scope,
    });
    const totals = await summary.json();
    expect(['club', 'wallet', 'group']).toContain(totals.mode);
    const fields =
      totals.mode === 'club'
        ? ['entries', 'volume', 'cashouts_paid']
        : ['incoming', 'outgoing', 'net'];
    for (const field of fields) {
      expect(['number', 'string']).toContain(typeof totals[field]);
      expect(String(totals[field]).trim()).not.toBe('');
      expect(Number.isFinite(Number(totals[field]))).toBe(true);
    }
    await expect(panel).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    // A working history read is required here. A retryable error is useful UX,
    // but does not certify the installed history API as working.
    await expect(panel.getByRole('alert')).toHaveCount(0);
    if (rows.length > 50) {
      const nextPage = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith('/rpc/fn_cashier_history_feed') &&
          response.request().postDataJSON()?.p_before_id != null,
        { timeout: 30_000 }
      );
      await panel.getByRole('button', { name: 'Load 50 Older Entries', exact: true }).click();
      const older = await nextPage;
      expect(older.status()).toBe(200);
      expect(older.request().postDataJSON()).toMatchObject({
        p_before_at: rows[49].created_at,
        p_before_id: rows[49].id,
        p_scope: request.p_scope,
      });
      expect((await older.json()).length).toBeGreaterThan(0);
      await expect
        .poll(() => panel.getByRole('button', { name: /^Open Receipt For/ }).count())
        .toBeGreaterThan(50);
    }
    if (rows.length) {
      const visible = panel.getByRole('button', { name: /^Open Receipt For/ });
      await expect(visible.first()).toBeVisible();
      await visible.first().click();
      const receipt = page.getByRole('dialog', { name: 'Transaction Receipt' });
      await expect(receipt).toBeVisible();
      await expect(receipt.getByText('Recorded In Ledger', { exact: true })).toBeVisible();
      await expect(receipt.getByText(/^[0-9a-f-]{36}$/i)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(receipt).toBeHidden();
    } else {
      await expect(
        panel.getByText('No Transactions Match These Filters.', { exact: true })
      ).toBeVisible();
    }
    const allClub = panel.getByRole('button', { name: 'Club Transactions', exact: true });
    let approvedReceiptChecked = false;
    if (await allClub.count()) {
      expect(request.p_scope).toBe('club');
      await expect(allClub).toHaveAttribute('aria-pressed', 'true');
      expect(totals.mode).toBe('club');
      await expect(panel.getByLabel('Club Totals For These Filters')).toBeVisible();
      await expect(panel.getByLabel('Club Totals For These Filters')).not.toContainText('--');
      const historyRange = read('fn_cashier_history_feed', 'club');
      await panel.getByRole('button', { name: '30 Days', exact: true }).click();
      expect((await historyRange).status()).toBe(200);
      const cashouts = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith('/rpc/fn_cashier_history_feed') &&
          response.request().postDataJSON()?.p_kind === 'cashout',
        { timeout: 30_000 }
      );
      await panel.getByRole('button', { name: 'Cash-Outs', exact: true }).click();
      const cashoutResponse = await cashouts;
      expect(cashoutResponse.status()).toBe(200);
      const cashoutRows = await cashoutResponse.json();
      const approved = cashoutRows.find(
        (row: { transaction_type: string }) => row.transaction_type === 'cashout_approved'
      );
      // This maintained club already holds audited approvals. Their absence is
      // a missing proof, never a reason to manufacture a cash-out to test it.
      expect(approved).toBeTruthy();
      expect(approved.to_user_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(approved.to_name).toBeTruthy();
      expect(approved.invoice_number).toMatch(/^CA-/);
      await panel
        .getByRole('button', { name: /^Open Receipt For/ })
        .filter({ hasText: 'Cash-Out Accepted' })
        .first()
        .click();
      const accepted = page.getByRole('dialog', { name: 'Transaction Receipt' });
      await expect(accepted).toBeVisible();
      await expect(accepted.getByText(approved.id, { exact: true })).toBeVisible();
      await expect(accepted.getByText(approved.invoice_number, { exact: true })).toBeVisible();
      await expect(accepted).toContainText(approved.to_name);
      await expect(accepted).toContainText('Agent Wallet');
      await attachCashierScreenshot(page, testInfo, 'cash-out-actual-accepter-and-invoice');
      await page.keyboard.press('Escape');
      await expect(accepted).toBeHidden();
      approvedReceiptChecked = true;
      const ownFeed = read('fn_cashier_history_feed', 'mine');
      const ownSummary = read('fn_cashier_history_summary', 'mine');
      await panel.getByRole('button', { name: 'My Transactions', exact: true }).click();
      expect((await ownFeed).status()).toBe(200);
      const own = await ownSummary;
      expect(own.status()).toBe(200);
      expect((await own.json()).mode).toBe('wallet');
      await expect(panel.getByLabel('My Wallet Totals For These Filters')).toBeVisible();
      await expect(panel.getByLabel('My Wallet Totals For These Filters')).not.toContainText('--');
    } else {
      expect(request.p_scope).toBe('mine');
      expect(totals.mode).toBe('wallet');
      await expect(panel.getByLabel('My Wallet Totals For These Filters')).not.toContainText('--');
    }
    const searchText = '__cashier_readonly_history_probe__';
    const searched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/rpc/fn_cashier_history_feed') &&
        response.request().postDataJSON()?.p_search === searchText,
      { timeout: 30_000 }
    );
    await panel.getByRole('searchbox', { name: 'Search Transaction History' }).fill(searchText);
    const searchResponse = await searched;
    expect(searchResponse.status()).toBe(200);
    expect(await searchResponse.json()).toEqual([]);
    await expect(
      panel.getByText('Nothing Matches That Name Or Invoice Number.', { exact: true })
    ).toBeVisible();
    const restored = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/rpc/fn_cashier_history_feed') &&
        response.request().postDataJSON()?.p_search === null,
      { timeout: 30_000 }
    );
    await panel.getByRole('searchbox', { name: 'Search Transaction History' }).fill('');
    expect((await restored).status()).toBe(200);
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    // Read-only handoff through the real export control, using the reserved
    // identity's own book. No money is sent and no real member is impersonated.
    const exportResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/rpc/fn_cashier_history_feed') &&
        response.request().postDataJSON()?.p_limit === 251,
      { timeout: 30_000 }
    );
    const downloaded = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download These Transactions', exact: true }).click();
    const exportFeed = await exportResponse;
    expect(exportFeed.status()).toBe(200);
    expect(exportFeed.request().postDataJSON()).toMatchObject({
      p_club_id: clubId,
      p_scope: 'mine',
      p_search: null,
      p_before_at: null,
      p_before_id: null,
    });
    const download = await downloaded;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/^transaction-history-mine-.*\.csv$/);
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();
    const csv = await readFile(downloadedPath!, 'utf8');
    expect(csv.replace(/^\uFEFF/, '').split(/\r?\n/)[0]).toBe(
      'Date,Type,Direction,From,To,Chips,Route,Detail,Invoice,Cash-Out Status,Entry'
    );
    await testInfo.attach('cashier-own-history-export.csv', {
      path: downloadedPath!,
      contentType: 'text/csv',
    });
    for (const width of [375, 393, 768, 1440]) {
      await page.setViewportSize({ width, height: 852 });
      await expect(panel).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
      ).toBe(true);
      await attachCashierScreenshot(page, testInfo, `transaction-history-${width}`);
    }
    await testInfo.attach('cashier-history-installed-contract.json', {
      body: JSON.stringify(
        {
          scope: request.p_scope,
          summaryMode: totals.mode,
          rowsRead: rows.length,
          feedStatus: feed.status(),
          summaryStatus: summary.status(),
          searchStatus: searchResponse.status(),
          approvedReceiptChecked,
          roleCoverage:
            'Maintained read-only identity only; other roles qualified separately on PostgreSQL 17',
        },
        null,
        2
      ),
      contentType: 'application/json',
    });
  });
  test('offers reclaim return wallets and keeps promo in promo without moving chips', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 393, height: 852 });
    const clubId = process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
    await page.goto(`clubs/${clubId}/cashier`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const recipient = page.getByRole('checkbox', { name: /^Include / }).first();
    await expect(recipient).toBeVisible({ timeout: 60_000 });
    await recipient.check();
    await page.getByRole('button', { name: 'Claim Back', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Claim Back', exact: true });
    const source = dialog.getByRole('combobox', { name: 'Claim From', exact: true });
    const destination = dialog.getByRole('combobox', { name: 'Claim Back To', exact: true });
    await expect(source).toBeVisible();
    await source.selectOption('agent_wallet');
    await expect(destination.locator('option[value="agent_wallet"]')).toHaveCount(1);
    await expect(destination.locator('option[value="club_bank"]')).toHaveCount(1);
    await destination.selectOption('agent_wallet');
    await expect(destination).toHaveValue('agent_wallet');
    await attachCashierScreenshot(page, testInfo, 'claim-selected-agent-return-wallet-393');
    await source.selectOption('promo_wallet');
    await expect(destination.locator('option')).toHaveText([
      'My Promo Wallet',
      'Club Promo Wallet',
    ]);
    await expect(destination).toHaveValue('promo_wallet');
    await destination.selectOption('club_promo_wallet');
    await expect(destination).toHaveValue('club_promo_wallet');
    await attachCashierScreenshot(page, testInfo, 'claim-promo-return-wallets-393');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Read the club's actual promo figure through the same maintained identity.
    // Opening and switching accounts submits no chip movement.
    await page.goto(`clubs/${clubId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const openPromo = page.getByRole('button', { name: 'Open Promo Wallet', exact: true });
    await expect(openPromo).toBeVisible({ timeout: 60_000 });
    const promoRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/rpc/fn_club_money_panel') &&
        response.request().postDataJSON()?.p_club_id === clubId
    );
    await openPromo.click();
    const promoResponse = await promoRead;
    expect(promoResponse.status()).toBe(200);
    const money = await promoResponse.json();
    expect(money.authorized).toBe(true);
    expect(money.club_promo_wallet).not.toBeNull();
    const expectedPromo = Number(money.club_promo_wallet);
    expect(Number.isFinite(expectedPromo)).toBe(true);
    const promoDialog = page.getByRole('dialog', { name: 'Promo Wallet Cashier', exact: true });
    const promoFigure = promoDialog.locator('.cbc-bank strong');
    const printedPromo = expectedPromo.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    await expect(promoFigure).toHaveText(printedPromo, { timeout: 30_000 });
    const ownPromo = promoDialog.getByRole('radio').filter({ hasText: 'My Promo Float' });
    if (await ownPromo.count()) {
      const ownFigure = await ownPromo.locator('strong').innerText();
      await ownPromo.click();
      await expect(promoFigure).toHaveText(ownFigure);
      await promoDialog.getByRole('radio').filter({ hasText: 'Club Promo Wallet' }).click();
      await expect(promoFigure).toHaveText(printedPromo);
    }
    await attachCashierScreenshot(page, testInfo, 'live-promo-account-balances-393');
    await page.keyboard.press('Escape');
    await expect(promoDialog).toBeHidden();
    await page.getByRole('button', { name: 'Open Agent Wallet', exact: true }).click();
    const agentDialog = page.getByRole('dialog', { name: 'AGENT WALLET Cashier', exact: true });
    await agentDialog.getByRole('tab', { name: 'Claim Back', exact: true }).click();
    await agentDialog.getByRole('button', { name: 'Claim From My Wallets', exact: true }).click();
    const personal = agentDialog.getByRole('region', { name: 'Selected Player' });
    await expect(personal).toContainText('My Account');
    await expect(personal.getByRole('combobox', { name: 'Claim From' })).toHaveValue(
      'player_wallet'
    );
    await expect(personal.locator('strong').last()).toHaveText(/^\d[\d,]*\.\d{2}$/, {
      timeout: 30_000,
    });
    await expect(agentDialog.getByRole('textbox', { name: 'Chips To Claim Back' })).toBeVisible();
    await attachCashierScreenshot(page, testInfo, 'personal-wallet-claim-any-time-393');
    await page.keyboard.press('Escape');
    await expect(agentDialog).toBeHidden();
  });
});
