import {
  devices,
  expect,
  test,
  type BrowserContext,
  type Request,
  type Response,
} from '@playwright/test';

import { DAILY_MISSIONS_RESPONSE_TIMEOUT, DailyMissionsPage } from './support/DailyMissionsPage';
import {
  callServiceRpc,
  cleanupTemporaryCustomizationAccount,
  createTemporaryCustomizationAccount,
  readServiceRows,
  requireCustomizationCertificationEnvironment,
  type CustomizationCertificationEnvironment,
  type TemporaryCustomizationAccount,
} from './support/temporaryCustomizationAccount';

const CERTIFICATION_ENABLED = process.env.DAILY_MISSIONS_CERTIFICATION === '1';
const LOAD_BUDGET_MS = 12_000;
const DASHBOARD_RPC_BUDGET_MS = 8_000;

type JsonObject = Record<string, unknown>;

function exactQuery(select: string, column: string, value: string): URLSearchParams {
  return new URLSearchParams({ select, [column]: `eq.${value}` });
}

async function serviceRows<T>(
  environment: CustomizationCertificationEnvironment,
  table: string,
  userId: string,
  select = '*'
): Promise<T[]> {
  return readServiceRows<T>(environment, table, exactQuery(select, 'user_id', userId));
}

async function diamondBalance(
  environment: CustomizationCertificationEnvironment,
  userId: string
): Promise<number> {
  const rows = await readServiceRows<{ diamonds: number }>(
    environment,
    'profiles',
    exactQuery('diamonds', 'id', userId)
  );
  expect(rows).toHaveLength(1);
  return Number(rows[0].diamonds);
}

async function dashboardRevision(
  environment: CustomizationCertificationEnvironment,
  userId: string
): Promise<number> {
  const rows = await serviceRows<{ revision: number }>(
    environment,
    'daily_challenge_dashboard_revisions',
    userId,
    'revision'
  );
  expect(rows).toHaveLength(1);
  return Number(rows[0].revision);
}

async function playerWalletBalance(
  environment: CustomizationCertificationEnvironment,
  userId: string
): Promise<number> {
  const rows = await readServiceRows<{ balance: number }>(
    environment,
    'wallets',
    new URLSearchParams({
      select: 'balance',
      user_id: `eq.${userId}`,
      wallet_type: 'eq.PLAYER',
    })
  );
  return Number(rows[0]?.balance || 0);
}

function currentPeriodKeys(now = new Date()) {
  const daily = now.toISOString().split('T')[0];
  const monday = new Date(now);
  const day = monday.getUTCDay();
  monday.setUTCDate(monday.getUTCDate() - (day === 0 ? 6 : day - 1));
  return {
    daily,
    weekly: `W${monday.toISOString().split('T')[0]}`,
    monthly: `M${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
  };
}

async function completeEveryAssignedMission(
  environment: CustomizationCertificationEnvironment,
  account: TemporaryCustomizationAccount
) {
  const advanced = await callServiceRpc<Array<JsonObject>>(
    environment,
    'record_daily_challenge_event',
    {
      p_user_id: account.id,
      p_event_key: `certification:${account.id}:${Date.now()}`,
      p_amounts: {
        hands_played: 2_500,
        hands_won: 2_500,
        showdowns: 2_500,
        showdowns_won: 2_500,
        hands_won_no_showdown: 2_500,
        big_pots: 2_500,
        strong_hands: 2_500,
        chips_won: 1_000_000_000,
        tournaments_played: 2_500,
        friends_added: 2_500,
      },
      p_magnitudes: { big_pots: 1_000_000_000, strong_hands: 10 },
      p_occurred_at: new Date().toISOString(),
    },
    true
  );
  expect(advanced.length).toBeGreaterThanOrEqual(10);
}

async function signInContext(
  browserContext: BrowserContext,
  baseURL: string,
  account: TemporaryCustomizationAccount
) {
  return DailyMissionsPage.signIn(browserContext, baseURL, account);
}

test.describe('production Daily Missions certification', () => {
  test.skip(
    !CERTIFICATION_ENABLED,
    'Set DAILY_MISSIONS_CERTIFICATION=1 to create one isolated production fixture.'
  );
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  test('cold-loads once, settles every action exactly once, recovers, and leaves no fixture', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(600_000);
    if (!baseURL) throw new Error('A deployed BASE_URL is required.');

    const environment = requireCustomizationCertificationEnvironment();
    const contexts: BrowserContext[] = [];
    let account: TemporaryCustomizationAccount | null = null;
    const report: JsonObject = {};

    try {
      account = await createTemporaryCustomizationAccount(environment, 'missions', 7_000);
      const desktopContext = await browser.newContext({
        ...devices['Desktop Chrome'],
        baseURL,
        storageState: { cookies: [], origins: [] },
      });
      contexts.push(desktopContext);
      const missions = await signInContext(desktopContext, baseURL, account);
      const { page } = missions;

      await test.step('one-request cold load stays inside the production budget', async () => {
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const dashboardRequests: Request[] = [];
        const dashboardStartedAt = new Map<Request, number>();
        let dashboardRpcMs = Number.POSITIVE_INFINITY;
        let dashboardRpcStatus = 0;
        const onRequest = (request: Request) => {
          if (request.url().includes('/rest/v1/rpc/get_daily_challenge_dashboard')) {
            dashboardRequests.push(request);
            dashboardStartedAt.set(request, Date.now());
          }
        };
        const onResponse = (response: Response) => {
          const request = response.request();
          const startedAt = dashboardStartedAt.get(request);
          if (startedAt != null) {
            dashboardRpcMs = Date.now() - startedAt;
            dashboardRpcStatus = response.status();
          }
        };
        page.on('request', onRequest);
        page.on('response', onResponse);
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));

        const loadMs = await missions.open();
        page.off('request', onRequest);
        page.off('response', onResponse);
        report.coldLoadMs = loadMs;
        report.dashboardRpcMs = dashboardRpcMs;
        report.dashboardRpcStatus = dashboardRpcStatus;
        report.dashboardRequests = dashboardRequests.length;
        report.consoleErrors = consoleErrors;
        expect(loadMs).toBeLessThan(LOAD_BUDGET_MS);
        expect(dashboardRpcMs).toBeLessThan(DASHBOARD_RPC_BUDGET_MS);
        expect(dashboardRequests).toHaveLength(1);
        expect(dashboardRpcStatus).toBeGreaterThanOrEqual(200);
        expect(dashboardRpcStatus).toBeLessThan(300);
        // The app shell owns unrelated header/membership fetches and can log a
        // transient failure while the mission aggregate succeeds. Preserve
        // every entry in the artifact, but fail this page gate on its own
        // service/component namespace instead of coupling it to another route.
        expect(
          consoleErrors.filter((message) =>
            /DailyChallengesPage|DailyChallengeService|daily_mission/i.test(message)
          )
        ).toEqual([]);
        expect(pageErrors).toEqual([]);
        await expect(page.locator('main')).toHaveCount(1);
        await expect(page.locator('[id^="mission-card-"]')).not.toHaveCount(0);
      });

      await test.step('reroll confirmation charges ten diamonds exactly once', async () => {
        const balanceBefore = await diamondBalance(environment, account!.id);
        const reroll = await missions.firstRerollButton();
        await missions.placeControlInSafeViewport(reroll);
        await reroll.click();
        const confirmation = page.getByRole('group', { name: /^Confirm Reroll For / });
        await expect(confirmation).toBeVisible();
        const replace = confirmation.getByRole('button', { name: 'Replace' });
        let settled = false;
        for (let attempt = 1; attempt <= 3 && !settled; attempt += 1) {
          await replace.click({ timeout: 10_000 });
          settled = await expect
            .poll(() => diamondBalance(environment, account!.id), { timeout: 20_000 })
            .toBe(balanceBefore - 10)
            .then(() => true)
            .catch(() => false);
          if (!settled) {
            // A lost response leaves the guarded confirmation in place. The
            // same row/expected-challenge replay key makes a manual retry safe.
            await expect(replace).toBeEnabled({ timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT });
          }
        }
        expect(settled).toBe(true);
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(balanceBefore - 10);
        await expect(confirmation).toHaveCount(0, { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT });

        const receipts = await serviceRows<{ amount: number; reference_id: string }>(
          environment,
          'diamond_transactions',
          account!.id,
          'amount,reference_id'
        );
        const rerolls = receipts.filter((row) => row.reference_id?.startsWith('challenge_reroll:'));
        expect(rerolls).toHaveLength(1);
        expect(Number(rerolls[0].amount)).toBe(-10);
      });

      await test.step('freeze purchase serializes the click and charges the fixed price once', async () => {
        const balanceBefore = await diamondBalance(environment, account!.id);
        const buy = page.getByRole('button', { name: /Buy Streak Freeze/ });
        await expect(buy).toBeEnabled({ timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT });
        await missions.placeControlInSafeViewport(buy);
        let calls = 0;
        const onRequest = (request: Request) => {
          if (request.url().includes('/rest/v1/rpc/buy_streak_freeze')) calls += 1;
        };
        page.on('request', onRequest);
        const rpc = page.waitForResponse(
          (response) => response.url().includes('/rest/v1/rpc/buy_streak_freeze'),
          { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
        );
        await buy.dblclick();
        const response = await rpc;
        expect(response.ok()).toBe(true);
        await expect
          .poll(() => diamondBalance(environment, account!.id))
          .toBe(balanceBefore - 5_000);
        await expect
          .poll(async () => {
            const rows = await serviceRows<{ freezes_available: number }>(
              environment,
              'challenge_streak_state',
              account!.id,
              'freezes_available'
            );
            return Number(rows[0]?.freezes_available || 0);
          })
          .toBe(1);
        page.off('request', onRequest);
        expect(calls).toBe(1);

        const receipts = await serviceRows<{
          amount: number;
          reference_id: string;
          transaction_type: string;
        }>(
          environment,
          'diamond_transactions',
          account!.id,
          'amount,reference_id,transaction_type'
        );
        const freezes = receipts.filter((row) => row.transaction_type === 'streak_freeze');
        expect(freezes).toHaveLength(1);
        expect(Number(freezes[0].amount)).toBe(-5_000);
      });

      await test.step('realtime completion opens the vault without a reload', async () => {
        let navigations = 0;
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) navigations += 1;
        });
        // Realtime has no backlog. Prove the filtered channel has joined before
        // advancing contracts, then separately prove the server emitted its
        // revision cursor. This distinguishes a trigger regression from a
        // client subscription regression without adding UX polling.
        await expect(page.getByText('Live Now')).toBeVisible({
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        const dashboardStatuses: number[] = [];
        const onDashboardResponse = (response: Response) => {
          if (response.url().includes('/rest/v1/rpc/get_daily_challenge_dashboard')) {
            dashboardStatuses.push(response.status());
          }
        };
        page.on('response', onDashboardResponse);
        const revisionBefore = await dashboardRevision(environment, account!.id);
        const { error: forbidden } = await account!.client.rpc('bump_challenge_progress', {
          p_user_id: account!.id,
          p_amounts: { hands_played: 1_000_000 },
          p_magnitudes: {},
          p_daily_key: currentPeriodKeys().daily,
          p_weekly_key: currentPeriodKeys().weekly,
          p_monthly_key: currentPeriodKeys().monthly,
        });
        expect(forbidden, 'authenticated raw mission progress must be denied').toBeTruthy();
        const { error: assignmentForbidden } = await account!.client.rpc('assign_user_challenges', {
          p_assigned_date: currentPeriodKeys().daily,
          p_challenge_ids: [],
        });
        expect(
          assignmentForbidden,
          'authenticated caller-selected mission assignment must be denied'
        ).toBeTruthy();
        const assigned = await serviceRows<{ id: string }>(
          environment,
          'user_daily_challenges',
          account!.id,
          'id'
        );
        const { error: incrementForbidden } = await account!.client.rpc(
          'increment_challenge_progress',
          {
            p_user_id: account!.id,
            p_challenge_row_id: assigned[0].id,
            p_amount: 1_000_000,
            p_requirement: 1,
          }
        );
        expect(incrementForbidden, 'authenticated row progress must be denied').toBeTruthy();
        await completeEveryAssignedMission(environment, account!);
        await expect
          .poll(() => dashboardRevision(environment, account!.id), {
            timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
          })
          .toBeGreaterThan(revisionBefore);
        await expect
          .poll(() => dashboardStatuses.length, {
            message: 'the subscribed revision must trigger an authoritative dashboard receipt',
            timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
          })
          .toBeGreaterThan(0);
        expect(
          dashboardStatuses.some((status) => status >= 200 && status < 300),
          `dashboard reconciliation statuses: ${dashboardStatuses.join(', ')}`
        ).toBe(true);
        report.realtimeDashboardStatuses = dashboardStatuses;
        const claim = page.getByRole('button', { name: /^Claim (?:All|Next) / });
        await expect(claim).toBeVisible({ timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT });
        page.off('response', onDashboardResponse);
        expect(navigations).toBe(0);
      });

      await test.step('claim-all settles chips and diamonds once and replays its receipt', async () => {
        const payable = await serviceRows<{
          chip_reward_snapshot: number;
          diamond_reward_snapshot: number;
          completed: boolean;
          claimed: boolean;
        }>(
          environment,
          'user_daily_challenges',
          account!.id,
          'chip_reward_snapshot,diamond_reward_snapshot,completed,claimed'
        );
        const due = payable.filter((row) => row.completed && !row.claimed);
        const expectedChips = due.reduce(
          (total, row) => total + Number(row.chip_reward_snapshot || 0),
          0
        );
        const expectedDiamonds = due.reduce(
          (total, row) => total + Number(row.diamond_reward_snapshot || 0),
          0
        );
        const walletBefore = await playerWalletBalance(environment, account!.id);
        const diamondsBefore = await diamondBalance(environment, account!.id);
        const claim = page.getByRole('button', { name: /^Claim (?:All|Next) / });
        await missions.placeControlInSafeViewport(claim);
        let claimCalls = 0;
        const onRequest = (request: Request) => {
          if (request.url().includes('/rest/v1/rpc/claim_daily_challenges')) claimCalls += 1;
        };
        page.on('request', onRequest);
        const rpc = page.waitForResponse(
          (response) => response.url().includes('/rest/v1/rpc/claim_daily_challenges'),
          { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
        );
        await claim.dblclick();
        const response = await rpc;
        expect(response.ok()).toBe(true);
        const requestBody = response.request().postDataJSON() as {
          p_user_id: string;
          p_challenge_row_ids: string[];
          p_request_id: string;
        };
        expect(requestBody.p_challenge_row_ids.length).toBeGreaterThanOrEqual(10);

        const reward = page.getByRole('dialog', { name: 'Reward Settled' });
        await expect(reward).toBeVisible({ timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT });
        await expect(
          reward.getByText('Deposited Securely To Your Club Arena Balances')
        ).toBeVisible();
        await reward.getByRole('button', { name: 'Continue' }).click();
        await expect
          .poll(() => playerWalletBalance(environment, account!.id))
          .toBe(walletBefore + expectedChips);
        await expect
          .poll(() => diamondBalance(environment, account!.id))
          .toBe(diamondsBefore + expectedDiamonds);
        page.off('request', onRequest);
        expect(claimCalls).toBe(1);

        const { data: replay, error } = await account!.client.rpc(
          'claim_daily_challenges',
          requestBody
        );
        if (error) throw error;
        expect((replay as JsonObject).success).toBe(true);
        expect((replay as JsonObject).replayed).toBe(true);

        const batches = await serviceRows<{ request_id: string }>(
          environment,
          'daily_challenge_claim_batches',
          account!.id,
          'request_id'
        );
        expect(batches.filter((row) => row.request_id === requestBody.p_request_id)).toHaveLength(
          1
        );
        const creditKeys = await serviceRows<{ key: string }>(
          environment,
          'wallet_credit_idempotency',
          account!.id,
          'key'
        );
        expect(
          creditKeys.filter(
            (row) => row.key === `challenge_claim_batch:${requestBody.p_request_id}`
          )
        ).toHaveLength(1);
      });

      await test.step('disconnected alert preference can be turned off without requesting permission', async () => {
        const { error } = await account!.client
          .from('user_notification_preferences')
          .upsert(
            { user_id: account!.id, daily_mission_reminders: true },
            { onConflict: 'user_id' }
          );
        if (error) throw error;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Preference On, Device Disconnected')).toBeVisible({
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        await expect(page.getByRole('button', { name: 'Reconnect This Device' })).toBeVisible();
        const update = page.waitForResponse(
          (response) =>
            response.request().method() !== 'GET' &&
            response.url().includes('/rest/v1/user_notification_preferences'),
          { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
        );
        const turnOff = page.getByRole('button', { name: 'Turn Off Without Reconnecting' });
        await missions.placeControlInSafeViewport(turnOff);
        await turnOff.click();
        expect((await update).ok()).toBe(true);
        // Headless and policy-managed browsers can truthfully remain "Blocked
        // In Browser Settings" after opt-out. The stable UI contract is that
        // the preference-on recovery controls disappear and opt-in returns.
        await expect(page.getByRole('button', { name: 'Turn On Mission Alerts' })).toBeVisible();
        await expect(page.getByText('Preference On, Device Disconnected')).toHaveCount(0);
        const preferences = await serviceRows<{ daily_mission_reminders: boolean }>(
          environment,
          'user_notification_preferences',
          account!.id,
          'daily_mission_reminders'
        );
        expect(preferences).toHaveLength(1);
        expect(preferences[0].daily_mission_reminders).toBe(false);
      });

      await test.step('an injected dashboard outage fails visibly and retry restores the live board', async () => {
        let abortedAttempts = 0;
        await page.route('**/rest/v1/rpc/get_daily_challenge_dashboard', async (route) => {
          if (abortedAttempts < 3) {
            abortedAttempts += 1;
            await route.abort('failed');
            return;
          }
          await route.continue();
        });
        // Remount through the already-loaded SPA. page.route() deliberately
        // disables Chromium's HTTP cache, so a second full document navigation
        // here used to turn this RPC recovery assertion into an unrelated
        // 60-second asset-waterfall timeout on a busy production edge.
        await missions.navigateWithinArena('notifications');
        await expect(page.getByRole('heading', { name: 'Daily Missions', level: 1 })).toHaveCount(
          0
        );
        await missions.navigateWithinArena('challenges');
        await expect(page.getByRole('alert')).toContainText('Mission Network Unavailable', {
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        expect(abortedAttempts).toBe(3);
        await page.unroute('**/rest/v1/rpc/get_daily_challenge_dashboard');
        const recovered = page.waitForResponse(
          (response) => response.url().includes('/rest/v1/rpc/get_daily_challenge_dashboard'),
          { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
        );
        const retry = page.getByRole('button', { name: 'Retry Sync' });
        await missions.placeControlInSafeViewport(retry);
        await retry.click();
        expect((await recovered).ok()).toBe(true);
        await expect(page.getByRole('alert')).toHaveCount(0, {
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        await expect(
          page.getByRole('heading', { name: 'Choose Your Mission Cycle' })
        ).toBeVisible();
      });

      await test.step('mobile layout has no overflow, usable controls, and keyboard-correct tabs', async () => {
        const mobileContext = await browser.newContext({
          ...devices['iPhone 13'],
          baseURL,
          storageState: { cookies: [], origins: [] },
        });
        contexts.push(mobileContext);
        const mobile = await signInContext(mobileContext, baseURL, account!);
        await mobile.open();
        const mobilePage = mobile.page;
        const geometry = await mobilePage.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

        const alertButton = mobilePage.getByRole('button', { name: 'Turn On Mission Alerts' });
        const alertBox = await alertButton.boundingBox();
        expect(alertBox?.height || 0).toBeGreaterThanOrEqual(44);
        const dailyTab = mobilePage.getByRole('tab', { name: /^Daily/ });
        await dailyTab.focus();
        await dailyTab.press('ArrowRight');
        const weeklyTab = mobilePage.getByRole('tab', { name: /^Weekly/ });
        await expect(weeklyTab).toBeFocused();
        await expect(weeklyTab).toHaveAttribute('aria-selected', 'true');
        await expect(mobilePage.getByRole('tabpanel')).toHaveAttribute(
          'aria-labelledby',
          'mission-tab-weekly'
        );
      });

      const requiredOperationEvents = [
        'reroll_succeeded',
        'freeze_succeeded',
        'claim_all_succeeded',
      ];
      let operations: Array<{ event: string }> = [];
      // Product telemetry is deliberately fire-and-forget so it can never
      // delay an action. The certification must therefore wait for the
      // durable receipts instead of racing the final network microtask.
      await expect
        .poll(
          async () => {
            operations = await serviceRows<{ event: string }>(
              environment,
              'daily_mission_operations',
              account!.id,
              'event'
            );
            return requiredOperationEvents.filter(
              (event) => !operations.some((row) => row.event === event)
            );
          },
          { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
        )
        .toEqual([]);
      report.operationEvents = [...new Set(operations.map((row) => row.event))].sort();
      await test.info().attach('daily-missions-certification.json', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
      });
    } finally {
      for (const context of contexts.reverse()) {
        await context.close().catch(() => undefined);
      }
      if (account) {
        await cleanupTemporaryCustomizationAccount(environment, account);
      }
    }
  });
});
