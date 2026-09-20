import {
  devices,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Response,
  type WebSocketRoute,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';

import { DAILY_MISSIONS_RESPONSE_TIMEOUT, DailyMissionsPage } from './support/DailyMissionsPage';
import {
  callServiceRpc,
  cleanupTemporaryCustomizationAccount,
  createTemporaryCustomizationAccount,
  deleteServiceRows,
  insertServiceRows,
  readServiceRows,
  requireCustomizationCertificationEnvironment,
  type CustomizationCertificationEnvironment,
  type TemporaryCustomizationAccount,
} from './support/temporaryCustomizationAccount';

const CERTIFICATION_ENABLED = process.env.DAILY_MISSIONS_CERTIFICATION === '1';
const LOAD_BUDGET_MS = 12_000;
const DASHBOARD_RPC_BUDGET_MS = 8_000;
const TTFB_BUDGET_MS = 2_500;
const FCP_BUDGET_MS = 3_500;
const LCP_BUDGET_MS = 4_000;
const CLS_BUDGET = 0.1;
const INITIAL_MISSION_ART_BUDGET_BYTES = 180_000;
const WARM_NAVIGATION_BUDGET_MS = 3_000;
// The Daily Missions page owns no repair timer. The missed-frame step holds a
// healthy socket with the revision frames suppressed for longer than the
// 15 s cursor poll this page used to run, and proves that no revision cursor
// read is issued until a lifecycle event (the reconnect) asks for one.
const NO_POLL_QUIET_WINDOW_MS = 20_000;
const REVISION_CURSOR_PATH = '/rest/v1/daily_challenge_dashboard_revisions';

type JsonObject = Record<string, unknown>;

const BANNED_UI_DASHES = /[\u2012-\u2015]/;
const COPY_ATTRIBUTES = [
  'alt',
  'aria-description',
  'aria-label',
  'aria-valuetext',
  'placeholder',
  'title',
] as const;

type RuntimeCopyEntry = {
  source: string;
  value: string;
};

async function expectNoAxeViolations(
  page: Page,
  selector: string,
  surfaceName: string
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.flatMap((node) => node.target.map(String)),
    })),
    `${surfaceName} has WCAG A or AA violations`
  ).toEqual([]);
}

function lowercaseWordStarts(value: string): string[] {
  const offenders = new Set<string>();
  const wordStart = /(^|[^A-Za-z0-9'\u2019])([a-z])/g;

  for (const match of value.matchAll(wordStart)) {
    const boundary = match[1];
    const index = (match.index ?? 0) + boundary.length;
    // Apostrophes inside contractions and possessives do not open a new word.
    if (
      (boundary === "'" || boundary === '\u2019') &&
      index >= 2 &&
      /[A-Za-z0-9]/.test(value[index - 2])
    ) {
      continue;
    }
    const token = value.slice(index).match(/^[A-Za-z][A-Za-z0-9'\u2019/-]*/)?.[0];
    if (token) offenders.add(token);
  }

  return [...offenders];
}

async function runtimeCopyEntries(surface: Locator): Promise<RuntimeCopyEntry[]> {
  return surface.evaluate((root, attributes) => {
    const element = root as HTMLElement;
    const entries: RuntimeCopyEntry[] = element.innerText
      .split(/\n+/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({ source: 'Visible Text', value }));
    const nodes = [element, ...element.querySelectorAll<HTMLElement>('*')];

    for (const node of nodes) {
      if (node.closest('[hidden], [aria-hidden="true"]')) continue;
      for (const attribute of attributes) {
        const value = node.getAttribute(attribute)?.trim();
        if (value) {
          entries.push({
            source: `${node.tagName.toLowerCase()}[${attribute}]`,
            value,
          });
        }
      }
    }

    return entries;
  }, COPY_ATTRIBUTES);
}

async function expectCertifiedDailyChallengeCopy(surface: Locator, label: string): Promise<void> {
  await expect(surface).toBeVisible();
  const entries = await runtimeCopyEntries(surface);
  expect(entries.length, `${label} must expose player-facing copy to certify`).toBeGreaterThan(0);

  const bannedDashes = entries.filter(({ value }) => BANNED_UI_DASHES.test(value));
  expect(bannedDashes, `${label} contains a banned U+2012-U+2015 dash`).toEqual([]);

  const lowercaseStarts = entries.flatMap(({ source, value }) =>
    lowercaseWordStarts(value).map((word) => ({ source, value, word }))
  );
  expect(lowercaseStarts, `${label} contains words that do not start with a capital`).toEqual([]);
}

function isDailyMissionRevisionFrame(message: string | Buffer): boolean {
  try {
    const frame = JSON.parse(typeof message === 'string' ? message : message.toString('utf8'));
    const event = Array.isArray(frame) ? frame[3] : frame?.event;
    const payload = Array.isArray(frame) ? frame[4] : frame?.payload;
    const change = payload?.data ?? payload;
    return (
      event === 'broadcast' &&
      (payload?.event === 'daily_mission_revision_changed' ||
        change?.event === 'daily_mission_revision_changed')
    );
  } catch {
    return false;
  }
}

function realtimeFrameDescriptor(message: string | Buffer): string {
  try {
    const frame = JSON.parse(typeof message === 'string' ? message : message.toString('utf8'));
    const event = Array.isArray(frame) ? frame[3] : frame?.event;
    const payload = Array.isArray(frame) ? frame[4] : frame?.payload;
    const change = payload?.data ?? payload;
    return [event || 'unknown', payload?.event, change?.schema, change?.table, change?.type]
      .filter(Boolean)
      .join(':');
  } catch {
    return 'non-json';
  }
}

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
      p_values: {
        big_pots: Array.from({ length: 2_500 }, () => 1_000_000_000),
        strong_hands: Array.from({ length: 2_500 }, () => 10),
      },
      p_occurred_at: new Date().toISOString(),
    },
    true
  );
  // Earlier certified actions can complete one of the assigned contracts
  // before this catch-all event. The RPC returns only rows advanced by this
  // event, not the complete assigned set. The authoritative total is checked
  // immediately afterward from user_daily_challenges.
  expect(
    advanced.length,
    'the catch-all mission event must advance at least one contract'
  ).toBeGreaterThan(0);
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
    let certificationHandHistoryId: string | null = null;
    let compatibilityCycleRowId: string | null = null;
    let receiptBearingUiRowId: string | null = null;
    const report: JsonObject = {};
    const cleanupErrors: string[] = [];

    try {
      account = await createTemporaryCustomizationAccount(environment, 'missions', 7_000);
      const desktopContext = await browser.newContext({
        ...devices['Desktop Chrome'],
        baseURL,
        storageState: { cookies: [], origins: [] },
      });
      contexts.push(desktopContext);
      let observedRevisionFrames = 0;
      let blockedRevisionFrames = 0;
      let blockRevisionFrames = false;
      let blockAllRealtimeFrames = false;
      const observedRealtimeFrames = new Set<string>();
      let interceptedRealtimeSockets = 0;
      // Every routed realtime socket keeps its server-side handle. Closing that
      // side is how a step interrupts the live connection the way a realtime
      // restart would: Playwright forwards the closure to the page's WebSocket
      // and supabase-js owns the reconnect and rejoin that follow.
      const routedRealtimeServers: WebSocketRoute[] = [];
      await desktopContext.routeWebSocket(/\/realtime\/v1\/websocket/, (socket) => {
        interceptedRealtimeSockets += 1;
        const server = socket.connectToServer();
        routedRealtimeServers.push(server);
        server.onMessage((message) => {
          if (observedRealtimeFrames.size < 30) {
            observedRealtimeFrames.add(realtimeFrameDescriptor(message));
          }
          if (blockAllRealtimeFrames) return;
          if (isDailyMissionRevisionFrame(message)) {
            observedRevisionFrames += 1;
            if (blockRevisionFrames) {
              blockedRevisionFrames += 1;
              return;
            }
          }
          socket.send(message);
        });
      });
      const missions = await signInContext(desktopContext, baseURL, account);
      const { page } = missions;

      await test.step('one-request cold load stays inside the production budget', async () => {
        await page.addInitScript(() => {
          const metrics = { lcp: 0, cls: 0 };
          Object.defineProperty(window, '__dailyMissionVitals', {
            configurable: true,
            value: metrics,
          });
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) metrics.lcp = entry.startTime;
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch {
            // The assertions below fail closed when this browser cannot report LCP.
          }
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                const shift = entry as PerformanceEntry & {
                  value: number;
                  hadRecentInput: boolean;
                };
                if (!shift.hadRecentInput) metrics.cls += shift.value;
              }
            }).observe({ type: 'layout-shift', buffered: true });
          } catch {
            // The assertions below fail closed when this browser cannot report CLS.
          }
        });
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const dashboardRequests: Request[] = [];
        type DashboardAttempt = {
          url: string;
          status: number | null;
          failure: string | null;
        };
        const dashboardAttempts = new Map<Request, DashboardAttempt>();
        const dashboardStartedAt = new Map<Request, number>();
        let dashboardRpcMs = Number.POSITIVE_INFINITY;
        let dashboardRpcStatus = 0;
        const onRequest = (request: Request) => {
          if (
            new URL(request.url()).pathname.endsWith(
              '/rest/v1/rpc/get_daily_challenge_dashboard_v3'
            )
          ) {
            dashboardRequests.push(request);
            dashboardStartedAt.set(request, Date.now());
            dashboardAttempts.set(request, {
              url: request.url(),
              status: null,
              failure: null,
            });
          }
        };
        const onResponse = (response: Response) => {
          const request = response.request();
          const startedAt = dashboardStartedAt.get(request);
          if (startedAt != null) {
            dashboardRpcMs = Date.now() - startedAt;
            dashboardRpcStatus = response.status();
            const attempt = dashboardAttempts.get(request);
            if (attempt) attempt.status = response.status();
          }
        };
        const onRequestFailed = (request: Request) => {
          const attempt = dashboardAttempts.get(request);
          if (attempt) attempt.failure = request.failure()?.errorText || 'request failed';
        };
        page.on('request', onRequest);
        page.on('response', onResponse);
        page.on('requestfailed', onRequestFailed);
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));

        const loadMs = await missions.open();
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('requestfailed', onRequestFailed);
        report.coldLoadMs = loadMs;
        report.dashboardRpcMs = dashboardRpcMs;
        report.dashboardRpcStatus = dashboardRpcStatus;
        report.dashboardRequests = dashboardRequests.length;
        report.dashboardAttempts = [...dashboardAttempts.values()];
        report.consoleErrors = consoleErrors;
        expect(loadMs).toBeLessThan(LOAD_BUDGET_MS);
        expect(dashboardRpcMs).toBeLessThan(DASHBOARD_RPC_BUDGET_MS);
        expect(dashboardRequests, JSON.stringify([...dashboardAttempts.values()])).toHaveLength(1);
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

        await page.waitForTimeout(750);
        const vitals = await page.evaluate(() => {
          const navigation = performance.getEntriesByType(
            'navigation'
          )[0] as PerformanceNavigationTiming;
          const paint = performance.getEntriesByName('first-contentful-paint')[0];
          const observed = (
            window as typeof window & {
              __dailyMissionVitals?: { lcp: number; cls: number };
            }
          ).__dailyMissionVitals;
          const missionArt = performance
            .getEntriesByType('resource')
            .filter((entry) =>
              /\/images\/challenges\/daily-missions-(?:casino|diamond)/.test(entry.name)
            )
            .map((entry) => {
              const resource = entry as PerformanceResourceTiming;
              return {
                name: new URL(resource.name).pathname.split('/').pop() || resource.name,
                bytes: resource.encodedBodySize,
              };
            });
          return {
            ttfb: navigation.responseStart - navigation.requestStart,
            fcp: paint?.startTime ?? 0,
            lcp: observed?.lcp ?? 0,
            cls: observed?.cls ?? Number.POSITIVE_INFINITY,
            missionArt,
            missionArtBytes: missionArt.reduce((total, asset) => total + asset.bytes, 0),
          };
        });
        report.webVitals = vitals;
        expect(vitals.ttfb).toBeGreaterThan(0);
        expect(vitals.ttfb).toBeLessThan(TTFB_BUDGET_MS);
        expect(vitals.fcp).toBeGreaterThan(0);
        expect(vitals.fcp).toBeLessThan(FCP_BUDGET_MS);
        expect(vitals.lcp).toBeGreaterThan(0);
        expect(vitals.lcp).toBeLessThan(LCP_BUDGET_MS);
        expect(vitals.cls).toBeLessThanOrEqual(CLS_BUDGET);
        expect(vitals.missionArt.map((asset) => asset.name)).toEqual(
          expect.arrayContaining([
            'daily-missions-casino-v2.webp',
            'daily-missions-diamond-96-v1.webp',
          ])
        );
        expect(vitals.missionArtBytes).toBeGreaterThan(0);
        expect(vitals.missionArtBytes).toBeLessThan(INITIAL_MISSION_ART_BUDGET_BYTES);
      });

      await test.step('warm in-app return restores the ledger inside its route budget', async () => {
        await missions.navigateWithinArena('notifications');
        await expect(page.getByRole('heading', { name: 'Daily Challenges', level: 1 })).toHaveCount(
          0
        );

        const dashboard = missions.dashboardResponses();
        const startedAt = Date.now();
        await missions.navigateWithinArena('challenges');
        const response = await dashboard;
        await expect(page.getByRole('heading', { name: 'Daily Challenges', level: 1 })).toBeVisible(
          {
            timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
          }
        );
        await expect(page.locator('#daily-missions')).toHaveAttribute('aria-busy', 'false');
        const warmNavigationMs = Date.now() - startedAt;
        expect(response.ok()).toBe(true);
        expect(warmNavigationMs).toBeLessThan(WARM_NAVIGATION_BUDGET_MS);
        report.warmNavigationMs = warmNavigationMs;
      });

      await test.step('every mission card has a continuous frame and a live icon instrument', async () => {
        const cards = page.locator('article[id^="mission-card-"]');
        const icons = cards.locator('[data-mission-icon][data-icon-state]');
        const cardCount = await cards.count();
        await expect(icons).toHaveCount(cardCount);
        expect(cardCount).toBeGreaterThan(0);

        const frameProof = await cards.evaluateAll((nodes) =>
          nodes.map((node) => {
            const card = node as HTMLElement;
            const frame = card.querySelector<HTMLElement>(':scope > span[aria-hidden="true"]');
            if (!frame) throw new Error('Mission card is missing its continuous frame rail.');
            const cardRect = card.getBoundingClientRect();
            const frameRect = frame.getBoundingClientRect();
            const background = getComputedStyle(frame).backgroundImage;
            return {
              edgeOffsets: [
                frameRect.top - cardRect.top,
                cardRect.right - frameRect.right,
                cardRect.bottom - frameRect.bottom,
                frameRect.left - cardRect.left,
              ],
              railLayers: background.split('linear-gradient').length - 1,
            };
          })
        );
        for (const proof of frameProof) {
          expect(proof.railLayers).toBeGreaterThanOrEqual(6);
          for (const offset of proof.edgeOffsets) expect(Math.abs(offset)).toBeLessThanOrEqual(1);
        }

        const readMotion = () =>
          icons.evaluateAll((nodes) =>
            nodes.map((node) => {
              const animations = node.getAnimations({ subtree: true }).map((animation) => ({
                name:
                  'animationName' in animation
                    ? String((animation as CSSAnimation).animationName)
                    : '',
                currentTime:
                  typeof animation.currentTime === 'number'
                    ? animation.currentTime
                    : Number(animation.currentTime ?? 0),
                playState: animation.playState,
              }));
              const card = node.closest<HTMLElement>('[data-mission-state]');
              return {
                type: node.getAttribute('data-mission-icon'),
                state: node.getAttribute('data-icon-state'),
                progress: card
                  ? getComputedStyle(card).getPropertyValue('--mission-progress').trim()
                  : '',
                animations,
              };
            })
          );

        const before = await readMotion();
        for (const icon of before) {
          expect(icon.type).toBeTruthy();
          expect(['active', 'complete']).toContain(icon.state);
          expect(icon.progress).toMatch(/^\d+(?:\.\d+)?%$/);
          for (const channel of [
            'missionCircuitSignal',
            'missionFacetSweep',
            'missionPulseRing',
            'missionScannerOrbit',
          ]) {
            expect(icon.animations.some(({ name }) => name.includes(channel))).toBe(true);
          }
          expect(
            icon.animations.find(({ name }) => name.includes('missionScannerOrbit'))?.playState
          ).toBe('running');
        }

        await page.waitForTimeout(240);
        const after = await readMotion();
        expect(after).toHaveLength(before.length);
        for (let index = 0; index < before.length; index += 1) {
          const beforeScanner = before[index].animations.find(({ name }) =>
            name.includes('missionScannerOrbit')
          );
          const afterScanner = after[index].animations.find(({ name }) =>
            name.includes('missionScannerOrbit')
          );
          expect(afterScanner?.currentTime ?? 0).toBeGreaterThan(
            (beforeScanner?.currentTime ?? 0) + 100
          );
        }
      });

      await test.step('every challenge cycle is a durable direct subpage with certified copy', async () => {
        const waitForCycle = async (cycle: 'daily' | 'weekly' | 'monthly') => {
          const title = `${cycle[0].toUpperCase()}${cycle.slice(1)} Challenges`;
          await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
          });
          await expect(page).toHaveTitle(`${title} | Smarter Poker`);
          const surface = page.locator('#daily-missions');
          await expect(surface).toHaveAttribute('aria-busy', 'false', {
            timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
          });
          await expect(surface).toHaveAttribute('data-mission-cycle', cycle);
          await expect(
            page.getByRole('tab', { name: new RegExp(`^${cycle}`, 'i') })
          ).toHaveAttribute('aria-selected', 'true');
          await expectCertifiedDailyChallengeCopy(surface, `${cycle} Challenge Subpage`);
        };

        const dailyURL = new URL('challenges/daily', baseURL);
        await page.goto(dailyURL.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        await waitForCycle('daily');
        await expect(page).toHaveURL(dailyURL.toString());

        const weeklyURL = new URL('challenges/weekly', baseURL);
        weeklyURL.searchParams.set('source', 'certification');
        weeklyURL.hash = 'mission-board-title';
        await page.goto(weeklyURL.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        await waitForCycle('weekly');
        await expect(page).toHaveURL(weeklyURL.toString());

        const monthlyURL = new URL('challenges/monthly', baseURL);
        await page.goto(monthlyURL.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        await waitForCycle('monthly');
        await expect(page).toHaveURL(monthlyURL.toString());

        await page.goBack({
          waitUntil: 'domcontentloaded',
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        await waitForCycle('weekly');
        await expect(page).toHaveURL(weeklyURL.toString());

        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        await waitForCycle('weekly');
        await expect(page).toHaveURL(weeklyURL.toString());

        await missions.chooseTier('Monthly');
        await waitForCycle('monthly');
        await expect(page).toHaveURL(monthlyURL.toString());
        await page.goBack();
        await waitForCycle('weekly');
        await expect(page).toHaveURL(weeklyURL.toString());

        const malformedURL = new URL('challenges/not-a-cycle', baseURL);
        const challengesURL = new URL('challenges', baseURL);
        await page.goto(malformedURL.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        await page.waitForURL(
          (url) => url.pathname === challengesURL.pathname && url.search === '' && url.hash === '',
          { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
        );
        await waitForCycle('daily');

        // Leave the stateful certification on its canonical base route before
        // the first economy mutation, so later assertions do not inherit a
        // history-only navigation or a fragment scroll position.
        await missions.open();
        await expect(page).toHaveURL(challengesURL.toString());
      });

      await test.step('the settled-hand trigger preserves mixed exact threshold candidates', async () => {
        certificationHandHistoryId = randomUUID();
        const occurredAt = new Date().toISOString();
        const handNumber =
          1_700_000_000 +
          (Number.parseInt(certificationHandHistoryId.replaceAll('-', '').slice(0, 7), 16) %
            100_000_000);
        const amounts = {
          hands_played: 1,
          hands_won: 1,
          hands_won_no_showdown: 1,
          chips_won: 600,
          big_pots: 2,
          strong_hands: 2,
        };
        const magnitudes = { big_pots: 500, strong_hands: 7 };
        const thresholdValues = { big_pots: [499, 500], strong_hands: [6, 7] };

        const inserted = await insertServiceRows<{ id: string }>(environment, 'hand_history', {
          id: certificationHandHistoryId,
          table_id: null,
          tournament_id: null,
          hand_number: handNumber,
          game_variant: 'nlh',
          small_blind: 1,
          big_blind: 2,
          pot_size: 600,
          rake_amount: 0,
          community_cards: [],
          winners: [],
          players: [],
          actions: [],
          started_at: occurredAt,
          ended_at: occurredAt,
          has_human: false,
          daily_mission_events: [
            {
              user_id: account!.id,
              amounts,
              magnitudes,
              values: thresholdValues,
            },
          ],
        });
        expect(inserted).toHaveLength(1);
        expect(inserted[0]).toMatchObject({ id: certificationHandHistoryId });

        const eventKey = `hand:${certificationHandHistoryId}`;
        await expect
          .poll(
            async () => {
              const receipts = await serviceRows<{
                event_key: string;
                amounts: JsonObject;
                magnitudes: JsonObject;
                threshold_values: JsonObject;
              }>(
                environment,
                'daily_challenge_progress_events',
                account!.id,
                'event_key,amounts,magnitudes,threshold_values'
              );
              return receipts.find((receipt) => receipt.event_key === eventKey) ?? null;
            },
            { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
          )
          .toEqual({ event_key: eventKey, amounts, magnitudes, threshold_values: thresholdValues });
      });

      await test.step('reroll confirmation charges one Diamond exactly once', async () => {
        const balanceBefore = await diamondBalance(environment, account!.id);
        const reroll = await missions.firstRerollButton();
        const desktopViewport = page.viewportSize();
        if (!desktopViewport) throw new Error('Daily Missions certification requires a viewport.');

        await page.setViewportSize({ width: 320, height: 568 });
        await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
        await missions.placeControlInSafeViewport(reroll);
        await reroll.click();
        const zoomedConfirmation = page.getByRole('group', { name: /^Confirm Reroll For / });
        await expect(zoomedConfirmation).toBeVisible();
        const zoomedGeometry = await zoomedConfirmation.evaluate((group) => {
          const bounds = group.getBoundingClientRect();
          return {
            documentOverflow:
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
            groupInsideViewport: bounds.left >= -1 && bounds.right <= innerWidth + 1,
            descendantOffenders: Array.from(group.querySelectorAll<HTMLElement>('*'))
              .filter((node) => {
                const nodeBounds = node.getBoundingClientRect();
                // SVG paint definitions (`defs`, gradients, and stops) have no
                // rendered box and report a 0x0 rectangle at document origin.
                // They power the live control icons but cannot overflow the
                // confirmation. Keep checking every rendered HTML/SVG box.
                if (nodeBounds.width === 0 && nodeBounds.height === 0) return false;
                return nodeBounds.left < bounds.left - 1 || nodeBounds.right > bounds.right + 1;
              })
              .map((node) => {
                const nodeBounds = node.getBoundingClientRect();
                return {
                  element: node.tagName.toLowerCase(),
                  label: node.getAttribute('aria-label') || (node.textContent || '').trim(),
                  left: nodeBounds.left,
                  right: nodeBounds.right,
                  groupLeft: bounds.left,
                  groupRight: bounds.right,
                };
              }),
          };
        });
        expect(zoomedGeometry).toEqual({
          documentOverflow: 0,
          groupInsideViewport: true,
          descendantOffenders: [],
        });
        await zoomedConfirmation.getByRole('button', { name: 'Keep It' }).click();
        await expect(zoomedConfirmation).toHaveCount(0);
        await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
        await page.setViewportSize(desktopViewport);

        await missions.placeControlInSafeViewport(reroll);
        await reroll.click();
        const confirmation = page.getByRole('group', { name: /^Confirm Reroll For / });
        await expect(confirmation).toBeVisible();
        await expectCertifiedDailyChallengeCopy(confirmation, 'Reroll Confirmation');
        const replace = confirmation.getByRole('button', { name: 'Replace' });
        const rerollResponse = page.waitForResponse(
          (response) => response.url().includes('/rest/v1/rpc/reroll_daily_challenge'),
          { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
        );
        const globalBalanceRefresh = page.waitForResponse(
          (response) => {
            const url = new URL(response.url());
            return (
              response.request().method() === 'GET' &&
              url.pathname.endsWith('/rest/v1/profiles') &&
              (url.searchParams.get('select') || '').includes('diamonds')
            );
          },
          { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
        );
        blockAllRealtimeFrames = true;
        let response: Response;
        try {
          await replace.dblclick({ timeout: 10_000 });
          response = await rerollResponse;
          expect((await globalBalanceRefresh).ok()).toBe(true);
        } finally {
          blockAllRealtimeFrames = false;
        }
        expect(response.ok()).toBe(true);
        const receipt = (await response.json()) as JsonObject;
        expect(
          receipt,
          `The Reroll RPC Returned An Unsettled Receipt: ${JSON.stringify(receipt)}`
        ).toMatchObject({
          success: true,
          alreadyRerolled: false,
          diamondsSpent: 1,
        });
        const requestBody = response.request().postDataJSON() as {
          p_user_id: string;
          p_challenge_row_id: string;
          p_expected_challenge_id: string;
          p_cost: number;
          p_request_id: string;
        };
        expect(requestBody.p_cost).toBe(1);
        expect(requestBody.p_request_id).toMatch(/^[0-9a-f-]{36}$/i);
        receiptBearingUiRowId = requestBody.p_challenge_row_id;
        expect(receipt.requestId).toBe(requestBody.p_request_id);
        expect(receipt.diamondBalance).toBe(balanceBefore - 1);
        await expect
          .poll(() => diamondBalance(environment, account!.id), {
            timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
          })
          .toBe(balanceBefore - 1);
        await expect(confirmation).toHaveCount(0, { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT });

        const { data: replay, error: replayError } = await account!.client.rpc(
          'reroll_daily_challenge',
          requestBody
        );
        if (replayError) throw replayError;
        expect(replay).toMatchObject({
          success: true,
          alreadyRerolled: true,
          requestId: requestBody.p_request_id,
          diamondsSpent: 0,
          refreshRequired: true,
        });
        expect(replay).not.toHaveProperty('challenge');
        expect(replay).not.toHaveProperty('diamondBalance');
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(balanceBefore - 1);

        const settledChallengeId = receipt.challengeId;
        expect(typeof settledChallengeId).toBe('string');
        const laterRequest = {
          p_user_id: account!.id,
          p_challenge_row_id: requestBody.p_challenge_row_id,
          p_expected_challenge_id: settledChallengeId as string,
          p_cost: 1,
          p_request_id: randomUUID(),
        };
        const { data: laterReroll, error: laterRerollError } = await account!.client.rpc(
          'reroll_daily_challenge',
          laterRequest
        );
        if (laterRerollError) throw laterRerollError;
        expect(laterReroll).toMatchObject({
          success: true,
          alreadyRerolled: false,
          requestId: laterRequest.p_request_id,
          diamondsSpent: 1,
        });
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(balanceBefore - 2);

        const { data: delayedReplay, error: delayedReplayError } = await account!.client.rpc(
          'reroll_daily_challenge',
          requestBody
        );
        if (delayedReplayError) throw delayedReplayError;
        expect(delayedReplay).toEqual({
          success: true,
          alreadyRerolled: true,
          requestId: requestBody.p_request_id,
          diamondsSpent: 0,
          refreshRequired: true,
        });
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(balanceBefore - 2);

        const receipts = await serviceRows<{ amount: number; reference_id: string }>(
          environment,
          'diamond_transactions',
          account!.id,
          'amount,reference_id'
        );
        const rerolls = receipts.filter(
          (row) => row.reference_id === `challenge_reroll:${requestBody.p_request_id}`
        );
        expect(rerolls).toHaveLength(1);
        expect(Number(rerolls[0].amount)).toBe(-1);
        const replayReceipts = await serviceRows<{ request_id: string }>(
          environment,
          'daily_challenge_reroll_receipts',
          account!.id,
          'request_id'
        );
        expect(
          replayReceipts.filter((row) => row.request_id === requestBody.p_request_id)
        ).toHaveLength(1);

        const compatibilityRows = await serviceRows<{
          id: string;
          challenge_id: string;
          completed: boolean;
          claimed: boolean;
        }>(environment, 'user_daily_challenges', account!.id, 'id,challenge_id,completed,claimed');
        const compatibilityCandidates = compatibilityRows.filter(
          (row) => !row.completed && !row.claimed && row.id !== requestBody.p_challenge_row_id
        );
        expect(compatibilityCandidates.length).toBeGreaterThanOrEqual(4);

        const cycled = compatibilityCandidates[2];
        compatibilityCycleRowId = cycled.id;
        const cycledReceiptRequestId = randomUUID();
        const compatibilityBalance = await diamondBalance(environment, account!.id);
        await insertServiceRows(environment, 'daily_challenge_reroll_receipts', {
          user_id: account!.id,
          request_id: cycledReceiptRequestId,
          challenge_row_id: cycled.id,
          expected_challenge_id: cycled.challenge_id,
          cost: 1,
          result: {
            success: true,
            requestId: cycledReceiptRequestId,
            alreadyRerolled: false,
            challengeId: cycled.challenge_id,
            diamondBalance: compatibilityBalance,
            diamondsSpent: 1,
          },
        });
        const { data: cycledReplay, error: cycledReplayError } = await account!.client.rpc(
          'reroll_daily_challenge',
          {
            p_user_id: account!.id,
            p_challenge_row_id: cycled.id,
            p_expected_challenge_id: cycled.challenge_id,
            p_cost: 1,
          }
        );
        if (cycledReplayError) throw cycledReplayError;
        expect(cycledReplay).toMatchObject({
          success: true,
          alreadyRerolled: true,
          diamondsSpent: 0,
        });
        await expect
          .poll(() => diamondBalance(environment, account!.id))
          .toBe(compatibilityBalance);

        const historical = compatibilityCandidates[0];
        const historicalRequestId = randomUUID();
        await insertServiceRows(environment, 'daily_challenge_reroll_receipts', {
          user_id: account!.id,
          request_id: historicalRequestId,
          challenge_row_id: historical.id,
          expected_challenge_id: historical.challenge_id,
          cost: 10,
          result: {
            success: true,
            requestId: historicalRequestId,
            alreadyRerolled: false,
            challengeId: historical.challenge_id,
            diamondBalance: compatibilityBalance,
            diamondsSpent: 10,
          },
        });
        const { data: historicalReplay, error: historicalReplayError } = await account!.client.rpc(
          'reroll_daily_challenge',
          {
            p_user_id: account!.id,
            p_challenge_row_id: historical.id,
            p_expected_challenge_id: historical.challenge_id,
            p_cost: 10,
            p_request_id: historicalRequestId,
          }
        );
        if (historicalReplayError) throw historicalReplayError;
        expect(historicalReplay).toMatchObject({
          success: true,
          alreadyRerolled: true,
          requestId: historicalRequestId,
          diamondsSpent: 0,
        });
        await expect
          .poll(() => diamondBalance(environment, account!.id))
          .toBe(compatibilityBalance);

        const historicalMoveRequest = {
          p_user_id: account!.id,
          p_challenge_row_id: historical.id,
          p_expected_challenge_id: historical.challenge_id,
          p_cost: 1,
          p_request_id: randomUUID(),
        };
        const { data: historicalMove, error: historicalMoveError } = await account!.client.rpc(
          'reroll_daily_challenge',
          historicalMoveRequest
        );
        if (historicalMoveError) throw historicalMoveError;
        expect(historicalMove).toMatchObject({
          success: true,
          alreadyRerolled: false,
          requestId: historicalMoveRequest.p_request_id,
          diamondsSpent: 1,
        });
        const postHistoricalBalance = compatibilityBalance - 1;
        await expect
          .poll(() => diamondBalance(environment, account!.id))
          .toBe(postHistoricalBalance);

        const { data: historicalCompatibilityReplay, error: historicalCompatibilityReplayError } =
          await account!.client.rpc('reroll_daily_challenge', {
            p_user_id: account!.id,
            p_challenge_row_id: historical.id,
            p_expected_challenge_id: historical.challenge_id,
            p_cost: 10,
          });
        if (historicalCompatibilityReplayError) throw historicalCompatibilityReplayError;
        expect(historicalCompatibilityReplay).toMatchObject({
          success: true,
          alreadyRerolled: true,
          diamondsSpent: 0,
        });
        await expect
          .poll(() => diamondBalance(environment, account!.id))
          .toBe(postHistoricalBalance);

        const stale = compatibilityCandidates[1];
        const staleRequestId = randomUUID();
        const { data: stalePrice, error: stalePriceError } = await account!.client.rpc(
          'reroll_daily_challenge',
          {
            p_user_id: account!.id,
            p_challenge_row_id: stale.id,
            p_expected_challenge_id: stale.challenge_id,
            p_cost: 10,
            p_request_id: staleRequestId,
          }
        );
        if (stalePriceError) throw stalePriceError;
        expect(stalePrice).toMatchObject({
          success: false,
          error: 'reroll price changed; refresh and try again',
        });
        await expect
          .poll(() => diamondBalance(environment, account!.id))
          .toBe(postHistoricalBalance);
        const staleReceipts = await serviceRows<{ request_id: string }>(
          environment,
          'daily_challenge_reroll_receipts',
          account!.id,
          'request_id'
        );
        expect(staleReceipts.some((row) => row.request_id === staleRequestId)).toBe(false);

        const journalOnly = compatibilityCandidates[3];
        const journalReference = `challenge_reroll:${journalOnly.id}:${journalOnly.challenge_id}`;
        const journalBalanceBefore = await diamondBalance(environment, account!.id);
        const journalDebit = await callServiceRpc<JsonObject>(environment, 'deduct_diamonds', {
          p_user_id: account!.id,
          p_amount: 10,
          p_description: 'Daily Challenge Reroll Compatibility Certification',
          p_transaction_type: 'challenge_reroll',
          p_source: 'daily_challenge_reroll',
          p_metadata: {
            challenge_row_id: journalOnly.id,
            from_challenge_id: journalOnly.challenge_id,
            certification: 'daily_mission_legacy_journal_replay',
          },
          p_reference_id: journalReference,
          p_cooldown_seconds: 0,
        });
        expect(journalDebit).toMatchObject({ success: true, charged: 10 });
        await expect
          .poll(() => diamondBalance(environment, account!.id))
          .toBe(journalBalanceBefore - 10);

        const journalMoveRequest = {
          p_user_id: account!.id,
          p_challenge_row_id: journalOnly.id,
          p_expected_challenge_id: journalOnly.challenge_id,
          p_cost: 1,
          p_request_id: randomUUID(),
        };
        const { data: journalMove, error: journalMoveError } = await account!.client.rpc(
          'reroll_daily_challenge',
          journalMoveRequest
        );
        if (journalMoveError) throw journalMoveError;
        expect(journalMove).toMatchObject({
          success: true,
          alreadyRerolled: false,
          diamondsSpent: 1,
        });
        const postJournalBalance = journalBalanceBefore - 11;
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(postJournalBalance);

        const { data: journalReplay, error: journalReplayError } = await account!.client.rpc(
          'reroll_daily_challenge',
          {
            p_user_id: account!.id,
            p_challenge_row_id: journalOnly.id,
            p_expected_challenge_id: journalOnly.challenge_id,
            p_cost: 10,
          }
        );
        if (journalReplayError) throw journalReplayError;
        expect(journalReplay).toMatchObject({
          success: true,
          alreadyRerolled: true,
          diamondsSpent: 0,
        });
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(postJournalBalance);

        const journalRows = await serviceRows<{
          amount: number;
          transaction_type: string;
          type: string;
          source: string | null;
          metadata: JsonObject;
          reference_id: string;
        }>(
          environment,
          'diamond_transactions',
          account!.id,
          'amount,transaction_type,type,source,metadata,reference_id'
        );
        expect(journalRows.filter((row) => row.reference_id === journalReference)).toEqual([
          expect.objectContaining({
            amount: -10,
            transaction_type: 'daily_challenge_reroll',
            type: 'daily_challenge_reroll',
            source: null,
            metadata: expect.objectContaining({
              challenge_row_id: journalOnly.id,
              from_challenge_id: journalOnly.challenge_id,
            }),
          }),
        ]);
      });

      await test.step('legacy reroll defaults to one diamond and requires price-bound replay proof', async () => {
        const assignments = await serviceRows<{
          id: string;
          challenge_id: string;
          completed: boolean;
          claimed: boolean;
        }>(environment, 'user_daily_challenges', account!.id, 'id,challenge_id,completed,claimed');
        const candidate = assignments.find(
          (row) =>
            !row.completed &&
            !row.claimed &&
            row.id !== compatibilityCycleRowId &&
            row.id !== receiptBearingUiRowId
        );
        expect(candidate).toBeTruthy();
        expect(candidate!.id).not.toBe(compatibilityCycleRowId);
        expect(candidate!.id).not.toBe(receiptBearingUiRowId);
        const balanceBefore = await diamondBalance(environment, account!.id);
        const legacyRequest = {
          p_user_id: account!.id,
          p_challenge_row_id: candidate!.id,
          p_expected_challenge_id: candidate!.challenge_id,
        };
        const { data: freshLegacy, error: freshLegacyError } = await account!.client.rpc(
          'reroll_daily_challenge',
          legacyRequest
        );
        if (freshLegacyError) throw freshLegacyError;
        expect(freshLegacy).toMatchObject({
          success: true,
          alreadyRerolled: false,
          diamondsSpent: 1,
        });
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(balanceBefore - 1);

        const { data: exactReplay, error: exactReplayError } = await account!.client.rpc(
          'reroll_daily_challenge',
          legacyRequest
        );
        if (exactReplayError) throw exactReplayError;
        expect(exactReplay).toMatchObject({
          success: true,
          alreadyRerolled: true,
          diamondsSpent: 0,
        });
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(balanceBefore - 1);

        const { data: oldPriceReplay, error: oldPriceReplayError } = await account!.client.rpc(
          'reroll_daily_challenge',
          { ...legacyRequest, p_cost: 10 }
        );
        if (oldPriceReplayError) throw oldPriceReplayError;
        expect(oldPriceReplay).toEqual({
          success: false,
          error: 'challenge changed; refresh and try again',
        });
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(balanceBefore - 1);

        const inventedExpectedId = `never-settled-${randomUUID()}`;
        const { data: inventedReplay, error: inventedReplayError } = await account!.client.rpc(
          'reroll_daily_challenge',
          { ...legacyRequest, p_expected_challenge_id: inventedExpectedId }
        );
        if (inventedReplayError) throw inventedReplayError;
        expect(inventedReplay).toEqual({
          success: false,
          error: 'challenge changed; refresh and try again',
        });
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(balanceBefore - 1);

        const { data: invalidPrice, error: invalidPriceError } = await account!.client.rpc(
          'reroll_daily_challenge',
          { ...legacyRequest, p_cost: -2147483648 }
        );
        if (invalidPriceError) throw invalidPriceError;
        expect(invalidPrice).toEqual({
          success: false,
          error: 'reroll price changed; refresh and try again',
        });
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(balanceBefore - 1);
      });

      await test.step('different-card rerolls serialize across concurrent tabs', async () => {
        const assignments = await serviceRows<{
          id: string;
          challenge_id: string;
          completed: boolean;
          claimed: boolean;
        }>(environment, 'user_daily_challenges', account!.id, 'id,challenge_id,completed,claimed');
        const candidates = assignments.filter((row) => !row.completed && !row.claimed).slice(0, 2);
        expect(candidates).toHaveLength(2);
        const balanceBefore = await diamondBalance(environment, account!.id);
        const requests = candidates.map((row) => ({
          p_user_id: account!.id,
          p_challenge_row_id: row.id,
          p_expected_challenge_id: row.challenge_id,
          p_cost: 1,
          p_request_id: randomUUID(),
        }));
        const results = await Promise.all(
          requests.map((request) => account!.client.rpc('reroll_daily_challenge', request))
        );
        for (const [index, result] of results.entries()) {
          if (result.error) throw result.error;
          expect(result.data).toMatchObject({
            success: true,
            alreadyRerolled: false,
            requestId: requests[index].p_request_id,
            diamondsSpent: 1,
          });
        }
        const replacementIds = results.map(
          (result) => (result.data as JsonObject).challengeId as string
        );
        expect(new Set(replacementIds).size).toBe(2);
        await expect.poll(() => diamondBalance(environment, account!.id)).toBe(balanceBefore - 2);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Live Now')).toBeVisible({
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
      });

      await test.step('freeze purchase confirms the ledger and charges the fixed price once', async () => {
        const balanceBefore = await diamondBalance(environment, account!.id);
        const buy = page.getByRole('button', { name: /Buy Streak Freeze/ });
        await expect(buy).toBeEnabled({ timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT });
        const desktopViewport = page.viewportSize();
        if (!desktopViewport) throw new Error('Daily Missions certification requires a viewport.');
        await page.setViewportSize({ width: 390, height: 320 });
        await missions.placeControlInSafeViewport(buy);
        let calls = 0;
        const onRequest = (request: Request) => {
          if (request.url().includes('/rest/v1/rpc/buy_streak_freeze')) calls += 1;
        };
        page.on('request', onRequest);

        await buy.click();
        const confirmation = page.getByRole('dialog', { name: 'Secure A Streak Freeze?' });
        await expect(confirmation).toBeVisible();
        await expect(confirmation.getByText('Vault Price')).toBeVisible();
        await expect(confirmation.getByText('5,000 Diamonds', { exact: true })).toBeVisible();
        await expect(
          confirmation.getByText(`${(balanceBefore - 5_000).toLocaleString()} Diamonds`, {
            exact: true,
          })
        ).toBeVisible();
        await expect(page.locator('#daily-missions')).toHaveAttribute('inert', '');
        await expectCertifiedDailyChallengeCopy(confirmation, 'Streak Freeze Confirmation');
        await expectNoAxeViolations(
          page,
          '[aria-labelledby="freeze-purchase-title"]',
          'Streak Freeze Confirmation'
        );

        const heading = confirmation.getByRole('heading', { name: 'Secure A Streak Freeze?' });
        const keepDiamonds = confirmation.getByRole('button', { name: 'Keep My Diamonds' });
        const confirmPurchase = confirmation.getByRole('button', { name: 'Buy Streak Freeze' });
        await expect(heading).toBeFocused();

        const backgroundScrollPosition = await page.evaluate(() => window.scrollY);
        await page.mouse.move(4, 4);
        await page.mouse.wheel(0, 900);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(backgroundScrollPosition);
        await page.mouse.wheel(0, -900);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(backgroundScrollPosition);

        const readDialogGeometry = () =>
          confirmation.evaluate((dialog) => {
            const card = dialog.querySelector<HTMLElement>('[data-dialog-card="fixed-frame"]');
            const frame = dialog.querySelector<HTMLElement>('[data-dialog-frame="fixed"]');
            const scrollPanel = dialog.querySelector<HTMLElement>('[data-dialog-scroll="true"]');
            const title = dialog.querySelector<HTMLElement>('#freeze-purchase-title');
            if (!card || !frame || !scrollPanel || !title) {
              throw new Error('The fixed-frame Daily Mission dialog contract is incomplete.');
            }
            const rectangle = (element: HTMLElement) => {
              const rect = element.getBoundingClientRect();
              return {
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                left: rect.left,
              };
            };
            const cardRect = rectangle(card);
            const frameRect = rectangle(frame);
            return {
              windowScrollY: window.scrollY,
              overlayScrollTop: (dialog as HTMLElement).scrollTop,
              cardScrollTop: card.scrollTop,
              panelScrollTop: scrollPanel.scrollTop,
              card: cardRect,
              frame: frameRect,
              panel: rectangle(scrollPanel),
              title: rectangle(title),
              frameOffsets: {
                top: frameRect.top - cardRect.top,
                right: cardRect.right - frameRect.right,
                bottom: cardRect.bottom - frameRect.bottom,
                left: frameRect.left - cardRect.left,
              },
            };
          });

        const beforeReverseTab = await readDialogGeometry();
        expect(beforeReverseTab.panelScrollTop).toBe(0);
        expect(beforeReverseTab.cardScrollTop).toBe(0);
        expect(beforeReverseTab.overlayScrollTop).toBe(0);
        expect(beforeReverseTab.title.top).toBeGreaterThanOrEqual(beforeReverseTab.panel.top);
        expect(beforeReverseTab.title.bottom).toBeLessThanOrEqual(beforeReverseTab.panel.bottom);
        for (const offset of Object.values(beforeReverseTab.frameOffsets)) {
          expect(Math.abs(offset)).toBeLessThanOrEqual(2);
        }

        await page.keyboard.press('Shift+Tab');
        await expect(confirmPurchase).toBeFocused();
        const afterReverseTab = await readDialogGeometry();
        expect(afterReverseTab.panelScrollTop).toBeGreaterThan(0);
        expect(afterReverseTab.cardScrollTop).toBe(0);
        expect(afterReverseTab.overlayScrollTop).toBe(0);
        expect(afterReverseTab.windowScrollY).toBe(beforeReverseTab.windowScrollY);
        for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
          expect(afterReverseTab.frameOffsets[edge]).toBeCloseTo(
            beforeReverseTab.frameOffsets[edge],
            1
          );
        }

        await page.keyboard.press('Tab');
        await expect(keepDiamonds).toBeFocused();

        await keepDiamonds.click();
        await expect(confirmation).toHaveCount(0);
        await expect(page.locator('#daily-missions')).not.toHaveAttribute('inert', '');
        await expect(page.locator('#daily-missions')).not.toHaveAttribute('aria-hidden', 'true');
        await expect(buy).toBeFocused();
        expect(calls, 'dismissing the confirmation must not call the purchase RPC').toBe(0);
        expect(await diamondBalance(environment, account!.id)).toBe(balanceBefore);
        await page.setViewportSize(desktopViewport);

        await buy.click();
        await expect(confirmation).toBeVisible();
        const rpc = page.waitForResponse(
          (response) => response.url().includes('/rest/v1/rpc/buy_streak_freeze'),
          { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
        );
        await confirmation.getByRole('button', { name: 'Buy Streak Freeze' }).dblclick();
        const response = await rpc;
        expect(response.ok()).toBe(true);
        await expect(confirmation).toHaveCount(0);
        await expect(page.locator('#daily-missions')).not.toHaveAttribute('inert', '');
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

      await test.step('a missed realtime completion still opens the vault without a reload', async () => {
        let navigations = 0;
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) navigations += 1;
        });
        // Every read of the durable per-user revision cursor the page issues.
        // The page has no repair timer, so this count may only move when a
        // lifecycle event (a new SUBSCRIBED generation or a tab resume) asks
        // for one bounded read.
        let cursorReads = 0;
        const onCursorRead = (request: Request) => {
          if (new URL(request.url()).pathname.endsWith(REVISION_CURSOR_PATH)) cursorReads += 1;
        };
        page.on('request', onCursorRead);
        // Realtime has no backlog. Prove the browser has joined through an
        // intercepted socket before advancing contracts, then suppress every
        // revision frame. This is intentionally protocol-agnostic: Supabase can
        // encode Phoenix frames as arrays or objects, and parsing one transport
        // shape here previously let the supposed outage test receive the real
        // change. While the socket, join and heartbeat stay healthy the page
        // owes nothing and must issue no cursor read: there is no watchdog and
        // no poll. Catch-up is owned by the reconnect lifecycle, so the step
        // then drops the live socket from the server side. supabase-js
        // reconnects and rejoins, the new SUBSCRIBED generation performs one
        // bounded cursor read, sees a newer revision, loads the dashboard once
        // and opens the vault while no realtime delivery can help it, without
        // navigation or a manual reload.
        await expect(page.getByText('Live Now')).toBeVisible({
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        expect(interceptedRealtimeSockets).toBeGreaterThan(0);
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
        try {
          await expect
            .poll(() => observedRevisionFrames, { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT })
            .toBeGreaterThan(0);
        } catch (error) {
          throw new Error(
            `No Daily Mission revision frame was observed before the missed-frame test. Observed: ${
              [...observedRealtimeFrames].join(', ') || 'none'
            }`,
            { cause: error }
          );
        }
        blockedRevisionFrames = 0;
        const socketsAtBlock = interceptedRealtimeSockets;
        const cursorReadsAtBlock = cursorReads;
        blockRevisionFrames = true;
        try {
          await completeEveryAssignedMission(environment, account!);
          const completed = await serviceRows<{ id: string; completed: boolean }>(
            environment,
            'user_daily_challenges',
            account!.id,
            'id,completed'
          );
          expect(completed.length).toBeGreaterThanOrEqual(10);
          expect(completed.every((row) => row.completed)).toBe(true);
          await expect
            .poll(() => dashboardRevision(environment, account!.id), {
              timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
            })
            .toBeGreaterThan(revisionBefore);
          try {
            await expect
              .poll(() => blockedRevisionFrames, { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT })
              .toBeGreaterThan(0);
          } catch (error) {
            throw new Error(
              `No Daily Mission revision frame crossed the routed socket. Observed: ${
                [...observedRealtimeFrames].join(', ') || 'none'
              }`,
              { cause: error }
            );
          }
          // The completion frame is gone and the socket, join and heartbeat
          // are all healthy, so no lifecycle event has happened. Hold that
          // state for longer than the repair interval this page used to run
          // and prove the durable cursor is not being polled.
          await page.waitForTimeout(NO_POLL_QUIET_WINDOW_MS);
          expect(
            cursorReads - cursorReadsAtBlock,
            'revision cursor reads were issued while the routed socket stayed healthy ' +
              `(routed sockets at block: ${socketsAtBlock}, now: ${interceptedRealtimeSockets})`
          ).toBe(0);

          // Interrupt the live connection from the server side of every routed
          // socket, the way a realtime restart would. The client must observe a
          // dropped link and own the reconnect: a new routed socket proves the
          // reconnect happened, and the rejoin's SUBSCRIBED status is the only
          // thing allowed to read the cursor.
          const socketsBeforeInterruption = interceptedRealtimeSockets;
          const cursorReadsBeforeInterruption = cursorReads;
          for (const server of routedRealtimeServers.splice(0)) {
            try {
              await server.close({ code: 1012, reason: 'Certification Realtime Interruption' });
            } catch {
              // A side the client already closed is not an interruption failure.
              // The reconnect proof below is what decides that.
            }
          }
          await expect
            .poll(() => interceptedRealtimeSockets, { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT })
            .toBeGreaterThan(socketsBeforeInterruption);
          const claim = page.getByRole('button', { name: /^Claim (?:All|Next) / });
          await expect(claim).toBeVisible({ timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT });
          await expect(page.getByText('Live Now')).toBeVisible({
            timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
          });
          const catchUpReads = cursorReads - cursorReadsBeforeInterruption;
          expect(
            catchUpReads,
            'the rejoin must perform a bounded revision cursor read'
          ).toBeGreaterThan(0);
          expect(
            catchUpReads,
            'the rejoin must not turn the revision cursor into a poll'
          ).toBeLessThanOrEqual(2);
          report.reconnectCursorReads = catchUpReads;
        } finally {
          blockRevisionFrames = false;
          page.off('request', onCursorRead);
        }
        expect(navigations).toBe(0);
        report.interceptedRealtimeSockets = interceptedRealtimeSockets;
        report.blockedRevisionFrames = blockedRevisionFrames;
      });

      await test.step('individual claim settles its exact receipt once through the card control', async () => {
        const walletBefore = await playerWalletBalance(environment, account!.id);
        const diamondsBefore = await diamondBalance(environment, account!.id);
        const claim = page.getByRole('button', { name: /^Claim Reward For / }).first();
        await missions.placeControlInSafeViewport(claim);
        await expect(claim).toBeVisible();

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
          p_challenge_row_ids: string[];
        };
        expect(requestBody.p_challenge_row_ids).toHaveLength(1);

        const receipt = (await response.json()) as JsonObject;
        const challengeDiamonds = Number(receipt.challengeDiamonds || 0);
        const milestoneDiamonds = Number(receipt.milestoneDiamonds || 0);
        const diamondsCredited = Number(receipt.diamondsCredited || 0);
        expect(challengeDiamonds).toBeGreaterThan(0);
        expect(diamondsCredited).toBe(challengeDiamonds + milestoneDiamonds);

        const reward = page.getByRole('dialog', { name: 'Reward Settled' });
        await expect(reward).toBeVisible({ timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT });
        await expect(
          reward.getByText(`Total Credited: +${diamondsCredited.toLocaleString()} Diamonds`)
        ).toBeVisible();
        await expectCertifiedDailyChallengeCopy(reward, 'Individual Reward Settlement Dialog');
        await expectNoAxeViolations(
          page,
          '[aria-labelledby="challenge-reward-title"]',
          'Individual Reward Settlement Dialog'
        );
        await reward.getByRole('button', { name: 'Continue' }).click();

        await expect.poll(() => playerWalletBalance(environment, account!.id)).toBe(walletBefore);
        await expect
          .poll(() => diamondBalance(environment, account!.id))
          .toBe(diamondsBefore + diamondsCredited);
        page.off('request', onRequest);
        expect(claimCalls).toBe(1);
      });

      await test.step('claim-all settles diamonds once, never mints chips, and replays its receipt', async () => {
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
        const legacyChipPromise = due.reduce(
          (total, row) => total + Number(row.chip_reward_snapshot || 0),
          0
        );
        const expectedDiamonds = due.reduce(
          (total, row) => total + Number(row.diamond_reward_snapshot || 0),
          0
        );
        const walletBefore = await playerWalletBalance(environment, account!.id);
        const diamondsBefore = await diamondBalance(environment, account!.id);
        expect(legacyChipPromise, 'new mission assignments must never promise chip rewards').toBe(
          0
        );
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
        expect(requestBody.p_challenge_row_ids).toHaveLength(due.length);

        const reward = page.getByRole('dialog', { name: 'Reward Settled' });
        await expect(reward).toBeVisible({ timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT });
        await expect(reward.getByText('Added To Your Club Arena Diamond Balance')).toBeVisible();
        await expectCertifiedDailyChallengeCopy(reward, 'Reward Settlement Dialog');
        await expectNoAxeViolations(
          page,
          '[aria-labelledby="challenge-reward-title"]',
          'Claim All Reward Settlement Dialog'
        );
        await reward.getByRole('button', { name: 'Continue' }).click();
        await expect.poll(() => playerWalletBalance(environment, account!.id)).toBe(walletBefore);
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
        expect(Number((replay as JsonObject).chips || 0)).toBe(0);

        const batches = await serviceRows<{ request_id: string }>(
          environment,
          'daily_challenge_claim_batches',
          account!.id,
          'request_id'
        );
        expect(batches.filter((row) => row.request_id === requestBody.p_request_id)).toHaveLength(
          1
        );
        const diamondReceipts = await serviceRows<{
          amount: number;
          reference_id: string;
          transaction_type: string;
        }>(
          environment,
          'diamond_transactions',
          account!.id,
          'amount,reference_id,transaction_type'
        );
        const claimReceipts = diamondReceipts.filter(
          (row) =>
            row.reference_id === `challenge_claim_batch:${requestBody.p_request_id}:diamonds` &&
            row.transaction_type === 'daily_challenge_claim'
        );
        expect(claimReceipts).toHaveLength(1);
        expect(Number(claimReceipts[0].amount)).toBe(expectedDiamonds);
      });

      await test.step('reset alert reaches notifications and push exactly once, then opt-out works', async () => {
        const { error } = await account!.client
          .from('user_notification_preferences')
          .upsert(
            { user_id: account!.id, daily_mission_reminders: true },
            { onConflict: 'user_id' }
          );
        if (error) throw error;

        const cycleDate = currentPeriodKeys().daily;
        const inserted = await callServiceRpc<number>(
          environment,
          'enqueue_daily_mission_reset_notifications',
          { p_cycle_date: cycleDate, p_limit: 5000 },
          true
        );
        expect(Number(inserted)).toBe(1);
        const replayedInsert = await callServiceRpc<number>(
          environment,
          'enqueue_daily_mission_reset_notifications',
          { p_cycle_date: cycleDate, p_limit: 5000 },
          true
        );
        expect(Number(replayedInsert)).toBe(0);

        const notifications = await serviceRows<{
          id: string;
          type: string;
          title: string;
          message: string;
          action_url: string;
          data: JsonObject;
        }>(environment, 'notifications', account!.id, 'id,type,title,message,action_url,data');
        const resetNotifications = notifications.filter(
          (row) =>
            row.type === 'daily_challenge' &&
            row.data?.source === 'club_arena_daily_missions' &&
            row.data?.cycle_date === cycleDate
        );
        expect(resetNotifications).toHaveLength(1);
        expect(resetNotifications[0]).toMatchObject({
          title: 'Daily Missions Are Live',
          message: 'A Fresh Set Of Poker Missions And Rewards Is Ready In Club Arena.',
          action_url: '/hub/club-arena/challenges',
        });
        const pushRows = await readServiceRows<{
          related_entity_id: string;
          event: string;
          title: string;
          body: string;
          url: string;
        }>(environment, 'push_outbox', exactQuery('*', 'recipient_user_id', account!.id));
        expect(
          pushRows.filter((row) => row.related_entity_id === resetNotifications[0].id)
        ).toEqual([
          expect.objectContaining({
            event: 'daily_challenge',
            title: 'Daily Missions Are Live',
            body: 'A Fresh Set Of Poker Missions And Rewards Is Ready In Club Arena.',
            url: '/hub/club-arena/challenges',
          }),
        ]);

        // The recovery contract is specifically preference-on with this
        // browser disconnected. A reused CI worker can retain a root-scoped
        // push subscription even though this test creates a fresh account and
        // browser context, so make the device state explicit before reloading.
        // This does not alter the account preference or the delivery receipts
        // certified above.
        await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration('/');
          const subscription = await registration?.pushManager.getSubscription();
          if (subscription) await subscription.unsubscribe();
        });
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
        await expect(page.getByRole('button', { name: 'Turn On Challenge Alerts' })).toBeVisible();
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
        let recoveryArmed = false;
        let releaseRecovery!: () => void;
        const retryClicked = new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        });
        await page.route('**/rest/v1/rpc/get_daily_challenge_dashboard_v3', async (route) => {
          if (!recoveryArmed) {
            abortedAttempts += 1;
            await route.abort('failed');
            return;
          }
          // Hold any automatic recovery request until the manual click has
          // happened, so it cannot remove the Retry button before the click.
          await retryClicked;
          await route.continue();
        });
        // Remount through the already-loaded SPA. page.route() deliberately
        // disables Chromium's HTTP cache, so a second full document navigation
        // here used to turn this RPC recovery assertion into an unrelated
        // 60-second asset-waterfall timeout on a busy production edge.
        await missions.navigateWithinArena('notifications');
        await expect(page.getByRole('heading', { name: 'Daily Challenges', level: 1 })).toHaveCount(
          0
        );
        await missions.navigateWithinArena('challenges');
        await expect(page.getByRole('alert')).toContainText('Challenge Ledger Unavailable', {
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        await expect(page.getByText('Spendable Balance', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: '0 Day Streak' })).toHaveCount(0);
        // The first dashboard exhausts its three network attempts. A joined
        // channel may make another legitimate recovery attempt, so the outage
        // must remain active instead of expiring after a fixed request count.
        expect(abortedAttempts).toBeGreaterThanOrEqual(3);
        const recovered = page.waitForResponse(
          (response) => response.url().includes('/rest/v1/rpc/get_daily_challenge_dashboard'),
          { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
        );
        const retry = page.getByRole('button', { name: 'Retry Challenge Ledger' });
        await missions.placeControlInSafeViewport(retry);
        recoveryArmed = true;
        try {
          await retry.click();
        } finally {
          releaseRecovery();
        }
        expect((await recovered).ok()).toBe(true);
        await expect(page.getByRole('alert')).toHaveCount(0, {
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
        await expect(page.getByRole('heading', { name: 'Daily Challenge Ledger' })).toBeVisible();
        await page.unroute('**/rest/v1/rpc/get_daily_challenge_dashboard_v3');
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

        const alertButton = mobilePage.getByRole('button', { name: 'Turn On Challenge Alerts' });
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
        'claim_succeeded',
        'claim_all_succeeded',
        // The missed-frame step drops the live socket. Both realtime events
        // are unsampled, so their receipts prove the interruption reached the
        // page's subscription lifecycle and that the rejoin recovered it.
        'realtime_degraded',
        'realtime_recovered',
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
      if (certificationHandHistoryId) {
        await deleteServiceRows(
          environment,
          'hand_history',
          new URLSearchParams({ id: `eq.${certificationHandHistoryId}` })
        ).catch((error) => cleanupErrors.push(`hand history: ${(error as Error).message}`));
        await readServiceRows<{ id: string }>(
          environment,
          'hand_history',
          new URLSearchParams({ select: 'id', id: `eq.${certificationHandHistoryId}`, limit: '1' })
        )
          .then((rows) => {
            if (rows.length > 0) cleanupErrors.push('hand history: exact fixture row remains');
          })
          .catch((error) =>
            cleanupErrors.push(`hand history verification: ${(error as Error).message}`)
          );
      }
      if (account) {
        await cleanupTemporaryCustomizationAccount(environment, account).catch((error) =>
          cleanupErrors.push(`account: ${(error as Error).message}`)
        );
      }
    }
    expect(cleanupErrors, 'Daily Missions certification cleanup failed').toEqual([]);
  });
});
