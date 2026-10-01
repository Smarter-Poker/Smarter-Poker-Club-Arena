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
    await expect(page.getByText(clubName, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('New Club Opening Checklist', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    // Prove the painted opening-bank command, not the hidden screen-reader
    // wallet announcement that happens to contain the same number.
    await expect(page.getByLabel(/^100K Club Bank Chips$/)).toBeVisible({
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
    await page.screenshot({ path: 'test-results/create-club-opened-mobile.png', fullPage: true });
  });
});
