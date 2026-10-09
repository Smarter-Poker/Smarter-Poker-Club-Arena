import { expect, test } from '@playwright/test';

const certificationEnabled = process.env.E2E_NEW_CLUB_CERT === '1';
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('Production Create A Club Certificate', () => {
  // A retry is a second real side effect, not another observation. The
  // workflow also passes --retries=0 so manual and hosted invocations agree.
  test.describe.configure({ retries: 0 });
  test.skip(!certificationEnabled, 'Runs only with an isolated production certification account.');

  test('a brand-new player creates and opens a real standalone club', async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 393, height: 852 });
    const stamp = `${Date.now()}`.slice(-9);
    const clubName = `Crest Cert ${stamp}`;

    await page.goto('./', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page).not.toHaveURL(/\/auth(?:\/|$)/, { timeout: 30_000 });

    // The carousel also exposes a Create A Club CTA. Target the keyboard-enabled
    // action-bar control so this certificate proves the primary entry point.
    const createDoor = page.getByTitle('Create A Club (C)', { exact: true });
    await expect(createDoor).toBeVisible({ timeout: 60_000 });
    await expect(createDoor).toBeEnabled();
    await createDoor.click();

    const dialog = page.getByRole('dialog', { name: 'Create A Club', exact: true });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText('Club Crest Vault', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('radio')).toHaveCount(10);

    await dialog.getByLabel('Club Name', { exact: true }).fill(clubName);
    await dialog
      .getByLabel('Description (Optional)', { exact: true })
      .fill('Disposable End-To-End Club Creation Certificate');
    await dialog.getByRole('radio', { name: 'Spade Society', exact: true }).click();

    const discoverable = dialog.getByRole('switch', {
      name: 'Discoverable In Club Arena',
      exact: true,
    });
    const approval = dialog.getByRole('switch', {
      name: 'Review Join Requests',
      exact: true,
    });
    await expect(discoverable).toHaveAttribute('aria-checked', 'true');
    await expect(approval).toHaveAttribute('aria-checked', 'false');
    await approval.click();
    await expect(approval).toHaveAttribute('aria-checked', 'true');

    await expect(dialog.getByText('Name Available', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByText(/Club Slot(?:s)? Remaining/)).toBeVisible({ timeout: 30_000 });

    await dialog
      .getByRole('checkbox', {
        name: 'I Confirm I Can Manage This Club And Accept The Club Arena Terms.',
        exact: true,
      })
      .click();
    const submit = dialog.getByRole('button', { name: 'Create Club', exact: true });
    await expect(submit).toBeEnabled();

    // This screenshot is an artifact of the exact page state that will submit,
    // at the Club Arena mobile acceptance width.
    await page.screenshot({ path: 'test-results/create-club-ready-mobile.png', fullPage: true });

    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/rest/v1/rpc/fn_create_club_atomic'),
      { timeout: 60_000 }
    );
    await submit.click();
    const response = await createResponse;
    expect(response.ok(), `create RPC returned ${response.status()}`).toBe(true);
    const responseBody = (await response.json()) as unknown;
    const createdClub = (Array.isArray(responseBody) ? responseBody[0] : responseBody) as {
      id?: unknown;
      slug?: unknown;
    } | null;
    const createdClubRef =
      typeof createdClub?.slug === 'string' && createdClub.slug.length > 0
        ? createdClub.slug
        : typeof createdClub?.id === 'string'
          ? createdClub.id
          : '';
    expect(createdClubRef, 'create RPC did not return a club route identity').not.toBe('');

    await expect(page).toHaveURL(
      new RegExp(`/clubs/${escapeRegExp(createdClubRef)}(?:[/?#]|$)`, 'i'),
      { timeout: 60_000 }
    );
    const createdClubUrl = page.url();
    await expect(page.getByText(clubName, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('New Club Opening Checklist', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    // Prove the painted opening-bank command, not the hidden screen-reader
    // wallet announcement that happens to contain the same number.
    // The club starts at 100K, then the atomic welcome transaction moves the
    // reviewed 100 BBJ seed and 200 Spins seed into their club-owned reserves.
    await expect(page.getByLabel(/^99\.7K Club Bank Chips$/)).toBeVisible({
      timeout: 60_000,
    });
    const welcome = page.getByRole('region', { name: 'Opening Welcome Package', exact: true });
    await expect(welcome).toBeVisible({ timeout: 60_000 });
    await expect(welcome.getByText('Bad Beat Jackpot', { exact: true })).toBeVisible();
    await expect(welcome.getByText('Spins', { exact: true })).toBeVisible();
    await expect(welcome.getByText('Enabled', { exact: true })).toHaveCount(2);
    await expect(welcome.getByText('Owner Acceptance Required', { exact: true })).toBeVisible();
    await expect(welcome.getByText('9 Preloaded', { exact: true })).toBeVisible();
    await expect(
      welcome.getByText('Daily $25 Freezeout · 7 PM UTC', { exact: true })
    ).toBeVisible();
    await expect(welcome.getByText('Preloaded', { exact: true })).toBeVisible();
    await expect(
      welcome.getByText('Acceptance Is Never Automatic', { exact: false })
    ).toBeVisible();
    await expect(
      welcome.getByRole('checkbox', {
        name: /I Have Read And Agree To These Wallet Obligations/i,
      })
    ).toBeVisible();

    // Package-backed work is already done even if the general lobby queries
    // arrive later. The receipt, not a timing race, resolves these rows.
    for (const label of [
      'Open Your First NLH Table',
      'Open Your First PLO Table',
      'Open Your First Limit Table',
      'Schedule Your First MTT',
      'Launch Your First Spin',
      'Launch Your First Heads Up Game',
    ]) {
      const task = page.getByText(label, { exact: true }).locator('xpath=ancestor::article');
      await expect(task.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    }

    // Diamond Spins is enabled for a new club and can legitimately offer its
    // first-run door here. Dismiss it before opening setup so its modal exit
    // animation cannot intercept the checklist control.
    const diamondSpins = page.getByRole('dialog', { name: /Diamond Spins/i });
    if (await diamondSpins.isVisible()) {
      await diamondSpins.getByRole('button', { name: 'Not Now', exact: true }).click();
      await expect(diamondSpins).toBeHidden();
    }
    await page.getByRole('button', { name: 'Start Setup', exact: true }).click();
    const wizard = page.getByRole('dialog', {
      name: new RegExp(`Open ${escapeRegExp(clubName)}`, 'i'),
    });
    await expect(wizard).toBeVisible();
    await wizard.getByRole('button', { name: 'Continue Opening Setup', exact: true }).click();
    // The field is named "Club Tag Line"; its live character counter is the
    // accessible description. The prefix match also accepts an older bundle.
    await wizard
      .getByRole('textbox', { name: /^Club Tag Line\b/i })
      .fill('Production Certificate Club');
    await wizard.getByRole('button', { name: 'Continue Opening Setup', exact: true }).click();
    await wizard.getByRole('button', { name: 'Continue Opening Setup', exact: true }).click();
    await expect(wizard.getByText(/Already Enabled And Funded BBJ/i)).toBeVisible();
    // The choice includes explanatory child text, so its accessible name is
    // "Not Now Record The Decision Without Funding". Target the stable
    // decision prefix while preserving the semantic disabled-state proof.
    await expect(wizard.getByRole('button', { name: /^Not Now\b/i })).toBeDisabled();
    // Inspect the changed funding flow without committing opening setup. The
    // existing cleanup requires the welcome club to remain pristine.
    const forbiddenSetupRequests: string[] = [];
    await page.route(
      /\/rest\/v1\/rpc\/(?:fn_complete_club_opening_setup|fn_save_leaderboard_reward_setup)(?:\?|$)/,
      async (route) => {
        forbiddenSetupRequests.push(new URL(route.request().url()).pathname);
        await route.abort('blockedbyclient');
      }
    );
    await wizard.getByRole('button', { name: 'Continue Opening Setup', exact: true }).click();
    await expect(wizard.getByText(/Already Opened The Spin And Heads-Up Boards/i)).toBeVisible();
    await wizard.getByRole('button', { name: 'Continue Opening Setup', exact: true }).click();
    await wizard.getByRole('button', { name: /^Not Now\b/i }).click();
    await wizard.getByRole('button', { name: 'Continue Opening Setup', exact: true }).click();
    await expect(wizard.getByRole('button', { name: /^Display Only\b/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await wizard.getByRole('button', { name: /^Pay Weekly Prizes\b/i }).click();
    await wizard
      .getByLabel('Suggested Leaderboard Prize Budgets', { exact: true })
      .getByRole('button', { name: '500 Chips', exact: true })
      .click();
    const transfer = wizard.getByRole('checkbox', {
      name: 'Transfer Exactly 500 Chips From The Club Bank Into The Club Promo Wallet For Leaderboard Prizes',
      exact: true,
    });
    await expect(transfer).toHaveAttribute('aria-checked', 'false');
    await expect(
      wizard.getByRole('button', { name: 'Continue Opening Setup', exact: true })
    ).toBeDisabled();
    await transfer.click();
    await wizard.getByRole('button', { name: 'Continue Opening Setup', exact: true }).click();
    await expect(
      wizard.getByText('500 Chips / Week, Promo Wallet Funded', { exact: true })
    ).toBeVisible();
    await expect(
      wizard.getByText('Unpaid Until The Promo Wallet Is Funded', { exact: true })
    ).toBeVisible();
    await expect(
      wizard.getByRole('button', { name: 'Open Club And Complete Opening Setup', exact: true })
    ).toBeEnabled();
    await page.screenshot({
      path: 'test-results/create-club-leaderboard-review-mobile.png',
      fullPage: true,
    });
    await wizard.getByRole('button', { name: 'Close Opening Wizard', exact: true }).click();
    await page.screenshot({ path: 'test-results/create-club-opened-mobile.png', fullPage: true });

    // Follow the actual hamburger owner door, not a manually constructed URL.
    await page.getByRole('button', { name: 'Open Menu', exact: true }).first().click();
    await page.getByRole('button', { name: /^Leaderboard Prize Setup\b/ }).click();
    const prizeWizard = page.getByRole('dialog', { name: 'Leaderboard Prize Setup', exact: true });
    await expect(prizeWizard).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/leaderboard\?[^#]*club=/);
    await prizeWizard.getByRole('button', { name: /^No Prizes Right Now\b/ }).click();
    await prizeWizard.getByRole('button', { name: 'Review Disabled Plan', exact: true }).click();
    await expect(
      prizeWizard.getByRole('button', { name: 'Publish Prize Program', exact: true })
    ).toBeEnabled();
    await prizeWizard.getByRole('button', { name: 'Back', exact: true }).click();
    await prizeWizard.getByRole('button', { name: /^Yes, Show Prizes\b/ }).click();
    await prizeWizard.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      prizeWizard.getByRole('heading', { name: 'Funding Source Confirmed', exact: true })
    ).toBeVisible();
    await expect(prizeWizard.getByText(`${clubName} Promo Wallet`, { exact: true })).toBeVisible();
    await expect(prizeWizard.getByRole('switch')).toHaveCount(0);
    await prizeWizard.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      prizeWizard.getByRole('group', { name: 'Suggested Prize Splits', exact: true })
    ).toBeVisible();
    await prizeWizard.getByRole('button', { name: /^Custom\b/ }).click();
    await prizeWizard.getByLabel('Weekly Prize For Rank 1', { exact: true }).fill('1');
    // This untouched welcome club has no Promo funds. A positive custom plan
    // must remain blocked even though its Club Bank holds opening capital.
    await expect(prizeWizard.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    await page.screenshot({
      path: 'test-results/create-club-prize-setup-mobile.png',
      fullPage: true,
    });
    await prizeWizard.getByRole('button', { name: 'Close Prize Setup', exact: true }).click();
    await expect(prizeWizard).toBeHidden();
    expect(
      forbiddenSetupRequests,
      'read-only wizard review must not submit setup or prize publication'
    ).toEqual([]);

    // Restore the observed club route after the hamburger's leaderboard trip.
    await page.goto(createdClubUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.getByText('New Club Opening Checklist', { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    // Prove the owner-facing lifecycle all the way through the published UI.
    // A pristine welcome club deliberately owns preloaded games and 100K of
    // opening capital, so the impact RPC must identify the guarded welcome
    // unwind instead of disabling the Retire control as if this were a used
    // club. The server repeats every proof under locks before changing state.
    await page.goto(`./clubs/${createdClubRef}/settings`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const openRetirement = page.getByRole('button', { name: 'Retire Club', exact: true });
    await expect(openRetirement).toBeVisible({ timeout: 60_000 });
    await openRetirement.click();

    const retirement = page.getByRole('dialog', { name: 'Retire Club', exact: true });
    await expect(retirement).toBeVisible({ timeout: 30_000 });
    // A pristine welcome club names 100,000 twice: the verified opening grant
    // and the canonical wallet total. Prove each line on its own so the
    // locator is never ambiguous.
    await expect(
      retirement.getByText(/^Exact Unused Welcome Package Verified - .*100,000-Chip Grant/)
    ).toBeVisible({ timeout: 30_000 });
    await expect(retirement.getByText(/^100,000 Chips Or Credit Across Canonical/)).toBeVisible({
      timeout: 30_000,
    });
    await retirement.getByLabel('Type The Club Name To Confirm:', { exact: true }).fill(clubName);
    const confirmRetirement = retirement.getByRole('button', {
      name: 'Retire Club',
      exact: true,
    });
    await expect(confirmRetirement).toBeEnabled({ timeout: 30_000 });
    await page.screenshot({
      path: 'test-results/create-club-retire-ready-mobile.png',
      fullPage: true,
    });

    // Stop at the enabled confirmation. Committing the owner retirement here
    // would cancel the opening board through atomic_cancel_tournament, whose
    // receipts are immutable financial records: the fixture could then never
    // be erased and every later certificate would inherit it. The commit path
    // of that same unwind is proved by the rollback-only reset probe in
    // scripts/ci/certify-club-create.mjs, which forces the deferred receipt
    // constraint before its ROLLBACK. The pristine fixture is retired by the
    // workflow's guarded cleanup step.
    await retirement.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(retirement).toBeHidden({ timeout: 30_000 });
  });
});
