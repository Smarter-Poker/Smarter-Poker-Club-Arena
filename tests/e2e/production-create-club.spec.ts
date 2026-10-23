import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const certificationEnabled = process.env.E2E_NEW_CLUB_CERT === '1';
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('Production Create A Club Certificate', () => {
  // A retry is a second real side effect, not another observation. The
  // workflow also passes --retries=0 so manual and hosted invocations agree.
  test.describe.configure({ retries: 0 });
  test.skip(!certificationEnabled, 'Runs only with an isolated production certification account.');

  test('a brand-new player creates and opens a real standalone club', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
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
    await expect(dialog.getByText('Club Crest Vault', { exact: true })).toBeHidden();
    await expect(dialog.getByLabel('Club Name', { exact: true })).toBeHidden();
    const defaultsScreenshot = 'test-results/create-club-defaults-mobile.png';
    await page.screenshot({ path: defaultsScreenshot, fullPage: true });
    await testInfo.attach('Default Create Club Screen', {
      path: defaultsScreenshot,
      contentType: 'image/png',
    });
    // The production fixture needs its guarded retirement name. This optional
    // customization is fixture identification, not a required user step.
    await dialog.getByRole('button', { name: 'Customize Club (Optional)', exact: true }).click();
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
    const defaultResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/rest/v1/rpc/fn_complete_club_opening_setup'),
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
    // Returning from optional tools must not replay the one-shot invite intent.
    const clubLocation = new URL(page.url());
    clubLocation.searchParams.delete('invite');
    const createdClubUrl = clubLocation.toString();
    const defaults = await defaultResponse;
    const openingReceipt = await defaults.json();
    expect(
      defaults.ok(),
      `default opening RPC must succeed: ${JSON.stringify(openingReceipt)}`
    ).toBe(true);
    expect(defaults.request().postDataJSON().p_operation_id).not.toBe(
      response.request().postDataJSON().p_request_id
    );
    expect(defaults.request().postDataJSON()).toMatchObject({
      p_rake_percent: -1,
      p_rake_cap_bb: -1,
      p_bbj_seed: 100,
      p_spin_seed: 200,
      p_promo_enabled: false,
      p_promo_budget: 0,
      p_leaderboard_rewards_enabled: false,
      p_leaderboard_prize_budget: 0,
      p_leaderboard_overlay_enabled: false,
    });
    expect(openingReceipt.success).toBe(true);
    expect(Number(openingReceipt.club_bank_after)).toBe(99700);
    const invite = page.getByRole('dialog', { name: 'Your Club Is Created', exact: true });
    await expect(invite).toBeVisible();
    const inviteInput = invite.getByLabel('Your Invite Link', { exact: true });
    await expect(inviteInput).toHaveValue(/^https:\/\/smarter\.poker\/i\/[A-HJ-NP-Z2-9]{7}$/);
    await expect(invite.getByRole('button', { name: 'Send Link', exact: true })).toBeEnabled();
    await page.screenshot({
      path: 'test-results/create-club-send-link-mobile.png',
      fullPage: true,
    });
    await testInfo.attach('Immediate Send Link', {
      path: 'test-results/create-club-send-link-mobile.png',
      contentType: 'image/png',
    });
    // Desktop Chromium exposes the supported clipboard fallback. Exercise the
    // real button and clipboard without sending a message to any recipient.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(page.url()).origin,
    });
    expect(await page.evaluate(() => typeof navigator.share)).toBe('undefined');
    const shortUrl = await inviteInput.inputValue();
    await invite.getByRole('button', { name: 'Send Link', exact: true }).click();
    await expect(invite.getByRole('button', { name: 'Link Copied', exact: true })).toBeVisible();
    const copiedInvite = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedInvite).toContain(shortUrl);
    expect(copiedInvite).toContain(`Invited You To Join ${clubName} On Smarter.Poker!`);
    expect(copiedInvite).toMatch(/Club ID: \S+/);
    const copiedScreenshot = 'test-results/create-club-link-copied-mobile.png';
    await page.screenshot({ path: copiedScreenshot, fullPage: true });
    await testInfo.attach('Send Link Clipboard Result', {
      path: copiedScreenshot,
      contentType: 'image/png',
    });
    await invite.getByRole('button', { name: 'Open Club', exact: true }).click();
    await page.getByText('Customize Club (Optional)', { exact: true }).click();

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
      welcome.getByText('Daily 25 Chip Freezeout · 7 PM UTC', { exact: true })
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

    // The default journey is complete. Advanced funding remains an explicit opt-in.
    const forbiddenSetupRequests: string[] = [];
    await page.route(
      /\/rest\/v1\/rpc\/(?:fn_complete_club_opening_setup|fn_save_leaderboard_reward_setup)(?:\?|$)/,
      async (route) => {
        forbiddenSetupRequests.push(new URL(route.request().url()).pathname);
        await route.abort('blockedbyclient');
      }
    );
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
    await page.getByText('Customize Club (Optional)', { exact: true }).click();
    await expect(page.getByText('New Club Opening Checklist', { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    // The disposable owner has a real banner door, independent of game setup.
    await page.getByRole('button', { name: 'Open Menu', exact: true }).first().click();
    await page.getByRole('button', { name: /^Banner Displays\b/ }).click();
    await expect(page).toHaveURL(/\/banner-displays$/);
    const bannerInput = page.getByLabel('Choose Banner Image', { exact: true });
    await expect(bannerInput).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Save Banner', exact: true })).toBeDisabled();
    await page.screenshot({ path: 'test-results/banner-displays-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: 'test-results/banner-displays-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 393, height: 852 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(1);

    const adminUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!adminUrl || !serviceKey)
      throw new Error('The Isolated Banner Certificate Requires Its Configured Cleanup Access');
    const admin = createClient(adminUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // A tiny isolated PNG proves upload without depending on a retired house banner.
    const fixtureImage = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAYAAAABCAYAAAD9yd/wAAAAD0lEQVR4nGOQKP/0HxsGALIJDwGvxefVAAAAAElFTkSuQmCC',
      'base64'
    );
    await expect(page.getByText('No Club Banner Set.', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save Ad Visibility', exact: true })).toHaveCount(
      0
    );
    let bannerUploadCount = 0;
    page.on('response', (response) => {
      if (
        response.request().method() === 'POST' &&
        response.url().includes('/storage/v1/object/club-assets/club-cards/')
      )
        bannerUploadCount += 1;
    });
    let uploadedPath: string | null = null;
    let savedClubId: string | null = null;
    let originalSettings: Record<string, unknown> | null | undefined;
    const cleanupErrors: string[] = [];
    try {
      await bannerInput.setInputFiles({
        name: 'banner-certificate.png',
        mimeType: 'image/png',
        buffer: fixtureImage,
      });
      await expect(page.getByRole('button', { name: 'Save Banner', exact: true })).toBeEnabled();
      const uploadResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('/storage/v1/object/club-assets/club-cards/')
      );
      const updateResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname.endsWith('/rest/v1/clubs')
      );
      await page.getByRole('button', { name: 'Save Banner', exact: true }).click();
      const upload = await uploadResponse;
      uploadedPath = decodeURIComponent(
        new URL(upload.url()).pathname.split('/object/club-assets/')[1]
      );
      expect(upload.ok()).toBe(true);
      const update = await updateResponse;
      expect(update.ok()).toBe(true);
      expect(Object.keys(update.request().postDataJSON())).toEqual(['banner_url']);
      const savedBanner = await update.json();
      originalSettings = savedBanner.settings;
      expect(typeof savedBanner.id).toBe('string');
      savedClubId = savedBanner.id;
      expect(savedBanner.banner_url).toContain(uploadedPath);
      await expect(page.getByRole('button', { name: 'Save Banner', exact: true })).toBeDisabled();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByAltText('Club Lobby Banner Preview')).toHaveAttribute(
        'src',
        savedBanner.banner_url,
        { timeout: 30_000 }
      );
      await page.getByRole('button', { name: 'Back To Club', exact: true }).click();
      await expect(page.locator('.club-lobby-command-top__campaign-button img')).toHaveAttribute(
        'src',
        savedBanner.banner_url,
        { timeout: 30_000 }
      );
      await page.goto(`./clubs/${createdClubRef}/banner-displays`, {
        waitUntil: 'domcontentloaded',
      });
      await page.getByRole('button', { name: 'Remove Club Banner', exact: true }).click();
      const resetResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname.endsWith('/rest/v1/clubs')
      );
      await page.getByRole('button', { name: 'Save Banner', exact: true }).click();
      const reset = await resetResponse;
      expect(reset.ok()).toBe(true);
      expect((await reset.json()).banner_url).toBeNull();

      expect(reset.request().postDataJSON()).toEqual({ banner_url: null });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByText('No Club Banner Set.', { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await expect(page.getByAltText('Club Lobby Banner Preview')).toHaveCount(0);
      await expect(page.getByRole('switch')).toHaveCount(0);
      await page.screenshot({ path: 'test-results/rotating-banners-mobile.png', fullPage: true });
      await page.getByRole('button', { name: 'Back To Club', exact: true }).click();
      await expect(page.locator('.club-lobby-command-top__campaign-button img')).toHaveCount(0);
      await expect(page.locator('.ad-rotator--lobby-strip')).toHaveCount(0);
      await expect(page.locator('img[src*="shark-club-championship-ad"]')).toHaveCount(0);
      expect(bannerUploadCount, 'Only The Top Club Banner May Upload An Image').toBe(1);
    } finally {
      // Delete only this exact disposable club's image, including a failed
      // persistence attempt. Never leave an auth-owned object blocking teardown.
      if (savedClubId) {
        const { error } = await admin
          .from('clubs')
          .update({
            banner_url: null,
            ...(originalSettings === undefined ? {} : { settings: originalSettings }),
          })
          .eq('id', savedClubId);
        if (error) cleanupErrors.push(error.message);
      }
      if (uploadedPath) {
        const { error } = await admin.storage.from('club-assets').remove([uploadedPath]);
        if (error) cleanupErrors.push(error.message);
      }
    }

    expect(cleanupErrors, 'The Disposable Banner Image Must Be Removed').toEqual([]);

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
