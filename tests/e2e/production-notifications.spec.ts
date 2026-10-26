import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import {
  deleteServiceRows,
  insertServiceRows,
  readServiceRows,
  requireCustomizationCertificationEnvironment,
  updateServiceRows,
} from './support/temporaryCustomizationAccount';
import { diamondInvitation, registerDiamondInvitationDismissal } from './support/cashLobbyOverlays';
import { recordNonVerdict } from './support/nonVerdict';

/**
 * A PUBLISH THAT LANDS MID-RUN IS NOT A FAILED PROOF (2026-10-26). Each proof
 * below certifies the ONE release production served when it began, and reads
 * build-info again when it ends. Post-deploy run 40242809027 failed here with
 * "Expected 09ea5c49... Received 96818b8b...": a newer publish landed while the
 * proof ran, every product assertion had passed, and the run reported the
 * notifications surface as broken. A changed release means this run neither
 * certifies nor condemns either one, so it is recorded as a named non-verdict
 * (support/nonVerdict.ts) after cleanup - never as a pass and never as a
 * defect. assert-e2e-actually-ran.mjs still fails a file in which every proof
 * stood down, so a run that verified nothing cannot report success.
 */
async function servedRelease(page: Page): Promise<string> {
  const response = await page.request.get('build-info.json');
  expect(response.ok()).toBe(true);
  const sha = (await response.json()).ca_sha;
  expect(sha).toMatch(/^[a-f0-9]{40}$/);
  return sha;
}

async function standDownIfReplaced(
  testInfo: TestInfo,
  proof: string,
  began: string,
  ended: string | undefined
): Promise<void> {
  if (ended === undefined || ended === began) return;
  const description = await recordNonVerdict(testInfo, {
    title: `The ${proof} could not certify one release`,
    detail: `production served ${began} when it began and ${ended} when it ended; a publish landed mid-run, so neither release is certified or condemned by this run`,
    evidence: { began, ended },
    tag: 'release-replaced-mid-run',
  });
  test.skip(true, description);
}

/** Real inbox/feed/mutations, exclusively the workflow's disposable account. */
test('published notifications retain pending signals and confirm durable actions', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const accountPath = process.env.E2E_TEST_ACCOUNT_FILE;
  if (!accountPath) throw new Error('The isolated post-deploy account record is required.');
  const account = JSON.parse(readFileSync(accountPath, 'utf8')) as { id?: string; email?: string };
  if (
    !account.id ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(account.id) ||
    !account.email?.startsWith('ca-customization-cert-postdeploy-') ||
    !account.email.endsWith('@example.invalid') ||
    account.email !== process.env.SP_EMAIL
  )
    throw new Error('Notification proof refuses an account outside its owning workflow.');
  const environment = requireCustomizationCertificationEnvironment();
  const id = randomUUID();
  const query = new URLSearchParams({ id: `eq.${id}`, user_id: `eq.${account.id}` });
  const title = `Notification Proof ${id.slice(0, 8)}`;
  const selected = await servedRelease(page);
  let served: string | undefined;
  let releaseDelete: (() => void) | undefined;
  try {
    console.log('[notification-proof] Create The Reserved Inbox Signal');
    await insertServiceRows(environment, 'notifications', {
      id,
      user_id: account.id,
      type: 'notification_certification',
      title,
      message: 'This Signal Belongs Only To The Disposable Publication Proof Account.',
      action_url: '/hub/club-arena/settings?tab=notifications',
      read: false,
      is_read: false,
    });
    console.log('[notification-proof] Read The Published Inbox');
    await page.goto('notifications', { waitUntil: 'domcontentloaded' });
    const row = page.locator(`[data-notif-id="${id}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    console.log('[notification-proof] Check Mobile And Desktop Fit');
    for (const width of [375, 393, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
      ).toBe(true);
    }
    await page.setViewportSize({ width: 375, height: 900 });
    const pending = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let deleteCalls = 0;
    await page.route('**/api/notifications/delete', async (route) => {
      const body = route.request().postDataJSON();
      if (body?.id !== id) return route.continue();
      deleteCalls++;
      await pending;
      await route.fulfill({ status: 503, json: { success: false } });
    });
    console.log('[notification-proof] Begin The Delayed Dismissal');
    await row.getByRole('button', { name: `Dismiss ${title}`, exact: true }).click();
    await expect(row).toHaveAttribute('aria-busy', 'true');
    await expect(row.getByRole('button', { name: `Dismiss ${title}`, exact: true })).toBeDisabled();
    await expect(row).toHaveCSS('opacity', '1');
    await expect(row).toBeVisible();
    // Pending UI precedes the authenticated request. Observe its receipt,
    // rather than assuming that rendering has finished the session read.
    await expect
      .poll(() => deleteCalls, {
        timeout: 10_000,
        message: 'The Reserved Dismissal Must Reach Its Owning Route Exactly Once.',
      })
      .toBe(1);
    console.log('[notification-proof] Capture The Pending Signal');
    await page.screenshot({
      path: testInfo.outputPath('notification-pending-mobile.png'),
      fullPage: true,
    });
    console.log('[notification-proof] Refuse The Delayed Dismissal');
    releaseDelete();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Dismissal Could Not Be Confirmed' })
    ).toBeVisible();
    await expect(row).toBeVisible();
    await page.unroute('**/api/notifications/delete');

    console.log('[notification-proof] Refuse The Read Action');
    await page.route('**/api/notifications/mark-read', (route) =>
      route.fulfill({ status: 503, json: { success: false } })
    );
    await page.getByRole('button', { name: 'Mark All Read', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Read Status Could Not Be Confirmed' })
    ).toBeVisible();
    await expect(row).toHaveClass(/ca-notif__row--unread/);
    const unchanged = await readServiceRows<{ read: boolean }>(environment, 'notifications', query);
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0].read).toBe(false);
    console.log('[notification-proof] Confirm The Durable Read');
    await page.unroute('**/api/notifications/mark-read');
    await page.getByRole('button', { name: 'Mark All Read', exact: true }).click();
    await expect(row).not.toHaveClass(/ca-notif__row--unread/);
    await expect
      .poll(async () => {
        const rows = await readServiceRows<{ read: boolean }>(environment, 'notifications', query);
        return rows[0]?.read;
      })
      .toBe(true);
    console.log('[notification-proof] Confirm The Read After Reload');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/ca-notif__row--unread/);
    await row.getByRole('button', { name: `Dismiss ${title}`, exact: true }).click();
    console.log('[notification-proof] Confirm The Durable Dismissal');
    await expect(row).toHaveCount(0);
    expect(await readServiceRows(environment, 'notifications', query)).toHaveLength(0);
    console.log('[notification-proof] Confirm Alert Controls And Release Identity');
    await page.getByRole('button', { name: 'Alert Controls', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\?tab=notifications$/);
    served = await servedRelease(page);
    if (served === selected)
      await testInfo.attach('notification-live-proof', {
        body: JSON.stringify({
          clientSha: selected,
          widths: [375, 393, 1440],
          pendingVisible: true,
          refusalVisible: true,
          readConfirmed: true,
          dismissalConfirmed: true,
        }),
        contentType: 'application/json',
      });
  } finally {
    console.log('[notification-proof] Remove The Reserved Signal');
    releaseDelete?.();
    await deleteServiceRows(environment, 'notifications', query);
    expect(await readServiceRows(environment, 'notifications', query)).toHaveLength(0);
  }
  await standDownIfReplaced(testInfo, 'notification proof', selected, served);
});

/** Exact published popup and durable receipts, only in the owning private club. */
test('published club news appears once per new message across fresh browser contexts', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const accountPath = process.env.E2E_TEST_ACCOUNT_FILE;
  const clubId = process.env.E2E_TEMPLATE_CLUB_ID;
  if (!accountPath || !clubId)
    throw new Error('The owned account and private template club are required.');
  const account = JSON.parse(readFileSync(accountPath, 'utf8')) as {
    id: string;
    email: string;
    password: string;
    templateFixtureRequest?: { requestId?: string; clubId?: string };
  };
  if (
    !account.email?.startsWith('ca-customization-cert-postdeploy-') ||
    !account.email.endsWith('@example.invalid') ||
    account.email !== process.env.SP_EMAIL ||
    account.templateFixtureRequest?.clubId !== clubId ||
    !account.templateFixtureRequest.requestId
  )
    throw new Error(
      'Club news proof refuses any club outside its isolated account creation receipt.'
    );
  const environment = requireCustomizationCertificationEnvironment();
  const clubs = await readServiceRows<{
    id: string;
    name: string;
    owner_id: string;
    is_public: boolean;
    requires_approval: boolean;
    lobby_message: string | null;
  }>(
    environment,
    'clubs',
    new URLSearchParams({
      id: `eq.${clubId}`,
      select: 'id,name,owner_id,is_public,requires_approval,lobby_message',
    })
  );
  expect(clubs).toHaveLength(1);
  const club = clubs[0];
  expect(club.owner_id).toBe(account.id);
  expect(club.is_public).toBe(false);
  expect(club.requires_approval).toBe(true);
  expect(club.name).toBe(
    `Crest Cert Template ${account.templateFixtureRequest.requestId.slice(0, 8)}`
  );
  const owners = await readServiceRows<{ user_id: string; chip_balance: number }>(
    environment,
    'club_members',
    new URLSearchParams({
      club_id: `eq.${clubId}`,
      select: 'user_id,chip_balance',
    })
  );
  expect(owners).toHaveLength(1);
  expect(owners[0].user_id).toBe(account.id);
  expect(Number(owners[0].chip_balance)).toBe(0);
  const receipts = await readServiceRows<{ club_id: string }>(
    environment,
    'club_creation_requests',
    new URLSearchParams({
      user_id: `eq.${account.id}`,
      request_id: `eq.${account.templateFixtureRequest.requestId}`,
      select: 'club_id',
    })
  );
  expect(receipts).toEqual([{ club_id: clubId }]);
  const client = createClient(environment.supabaseUrl, environment.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const login = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (login.error || login.data.user?.id !== account.id)
    throw new Error('The reserved club-news account could not authenticate as itself.');
  const newsId = randomUUID();
  const suffix = String(Number.parseInt(newsId.slice(0, 8), 16));
  const first = `Club News First ${suffix}`;
  const changed = `Club News Changed ${suffix}`;
  const postTitle = `Club Announcement ${suffix}`;
  const postBody = `New Announcement Body ${suffix}`;
  const editedBody = `Changed Announcement Body ${suffix}`;
  const announcementQuery = new URLSearchParams({ id: `eq.${newsId}`, club_id: `eq.${clubId}` });
  const clientSha = await servedRelease(page);
  if (process.env.LIVE_SHA) expect(clientSha).toBe(process.env.LIVE_SHA);
  let served: string | undefined;
  const failures: unknown[] = [];
  let secondContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let wroteMessage = false;
  const invitationOwners: Array<{
    document: typeof page;
    owner: Awaited<ReturnType<typeof registerDiamondInvitationDismissal>>;
  }> = [];
  const ownInvitation = async (document: typeof page) => {
    const owner = await registerDiamondInvitationDismissal(document, {
      onFailure: (error) => failures.push(error),
    });
    invitationOwners.push({ document, owner });
  };
  const save = async (message: string) => {
    const { data, error } = await client.rpc('fn_set_club_lobby_message', {
      p_club_id: clubId,
      p_message: message,
    });
    if (error || data?.ok !== true)
      throw new Error('The isolated club message write was not confirmed.');
  };
  const open = async (document: typeof page) => {
    const response = document.waitForResponse(
      (candidate) => {
        if (
          candidate.request().method() !== 'POST' ||
          !candidate.url().includes('/rest/v1/rpc/fn_claim_club_entry_news')
        )
          return false;
        return candidate.request().postDataJSON()?.p_club_id === clubId;
      },
      { timeout: 30_000 }
    );
    const [claim] = await Promise.all([
      response,
      document.goto(`clubs/${clubId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
    ]);
    expect(claim.ok()).toBe(true);
    const result = await claim.json();
    expect(result.ok).toBe(true);
    return result as {
      should_show: boolean;
      message: string;
      announcements: Array<{ id: string; content: string }>;
    };
  };
  const popup = (document: typeof page) =>
    document.getByRole('dialog', { name: `Club Message From ${club.name}`, exact: true });
  const silent = async (document: typeof page) => {
    const result = await open(document);
    expect(result.should_show).toBe(false);
    expect(result.announcements).toEqual([]);
    await expect(popup(document)).toHaveCount(0);
  };
  try {
    // Register restoration before sending a write with a possibly unknown response.
    await ownInvitation(page);
    wroteMessage = true;
    await save(first);
    const initial = await open(page);
    expect(initial.should_show).toBe(true);
    expect(initial.message).toBe(first);
    await expect(popup(page).getByText(first, { exact: true })).toBeVisible();
    await expect(popup(page).getByRole('button', { name: /do not show again/i })).toHaveCount(0);
    await page.setViewportSize({ width: 393, height: 852 });
    await page.screenshot({
      path: testInfo.outputPath('club-news-once-mobile.png'),
      fullPage: true,
    });
    await popup(page).getByRole('button', { name: 'Enter Lobby', exact: true }).click();
    await expect(popup(page)).toBeHidden();
    await silent(page);

    // Carry only this synthetic player's authentication into a cold device,
    // plus the device-local welcome acceptance that global setup seeded: that
    // first-run overlay otherwise stacks above the club message and covers its
    // Close control. Neither key holds club-news state, which lives server-side.
    const coldDeviceKeys = new Set(['smarter-poker-auth', 'club_arena_welcome_accepted']);
    const state = await page.context().storageState();
    secondContext = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      viewport: { width: 393, height: 852 },
      storageState: {
        cookies: state.cookies,
        origins: state.origins.map((origin) => ({
          ...origin,
          localStorage: origin.localStorage.filter((item) => coldDeviceKeys.has(item.name)),
        })),
      },
    });
    const second = await secondContext.newPage();
    await ownInvitation(second);
    await silent(second);
    await save(first); // saving identical copy must not reopen the popup
    await silent(second);
    await save(changed);
    const updated = await open(second);
    expect(updated.should_show).toBe(true);
    expect(updated.message).toBe(changed);
    await expect(popup(second).getByText(changed, { exact: true })).toBeVisible();
    await popup(second).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(popup(second)).toBeHidden();
    await silent(page);

    await insertServiceRows(environment, 'club_announcements', {
      id: newsId,
      club_id: clubId,
      author_id: account.id,
      title: postTitle,
      content: postBody,
      is_pinned: false,
      is_active: true,
    });
    const announcement = await open(page);
    expect(announcement.should_show).toBe(false);
    expect(announcement.announcements.map((post) => post.id)).toContain(newsId);
    await expect(popup(page).getByText(postBody, { exact: true })).toBeVisible();
    await popup(page).getByRole('button', { name: 'Enter Lobby', exact: true }).click();
    await silent(second);
    await updateServiceRows(environment, 'club_announcements', announcementQuery, {
      content: editedBody,
    });
    const edited = await open(second);
    expect(edited.announcements.find((post) => post.id === newsId)?.content).toBe(editedBody);
    await expect(popup(second).getByText(editedBody, { exact: true })).toBeVisible();
    await popup(second).getByRole('button', { name: 'Close', exact: true }).click();
    await silent(page);
    served = await servedRelease(page);
    if (served === clientSha)
      await testInfo.attach('club-news-once-live-proof', {
        body: JSON.stringify({
          clientSha,
          onceAcrossColdContexts: true,
          unchangedSaveSilent: true,
          changedMessageShownOnce: true,
          newAndEditedAnnouncementShownOnce: true,
          noOptOut: true,
        }),
        contentType: 'application/json',
      });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const { document, owner } of invitationOwners) {
      try {
        await document.removeLocatorHandler(diamondInvitation(document));
        await owner.idle();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await secondContext?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await deleteServiceRows(environment, 'club_announcements', announcementQuery);
      expect(
        await readServiceRows(environment, 'club_announcements', announcementQuery)
      ).toHaveLength(0);
    } catch (error) {
      failures.push(error);
    }
    try {
      if (wroteMessage) {
        await save(club.lobby_message || '');
        const restored = await readServiceRows<{ lobby_message: string | null }>(
          environment,
          'clubs',
          new URLSearchParams({ id: `eq.${clubId}`, select: 'lobby_message' })
        );
        expect(restored[0]?.lobby_message).toBe(club.lobby_message);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) failures.push(error);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Published club-news proof or isolated cleanup failed.');
  await standDownIfReplaced(testInfo, 'club-news proof', clientSha, served);
});
