import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import {
  EngineSocketJournal,
  installLiveTablePresentationJournal,
  liveTablePresentationEvidence,
  whileConnectionBannerStaysHidden,
  type CausalHandCycle,
} from './support/liveTableRealtime';
import {
  CASH_SPECTATOR_ACTION,
  CASH_TABLE_CARD_SELECTOR,
  collectVisibleCashCandidates,
} from './support/cashTableCandidates';
import { createProgressSilenceGuard } from './support/progressSilence';
import { prepareCashLobbyActions } from './support/cashLobbyOverlays';
import { remainingObservationMs } from './support/observationDeadline';

const CERTIFICATION_ENABLED = process.env.LIVE_TABLE_REALTIME_CERTIFICATION === '1';
const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const UNION_ID = process.env.E2E_UNION_ID || 'fade0000-0000-0000-0000-000000000001';
const CLUB_LOBBY = `clubs/${CLUB_ID}`;
const PROJECT_NAME = 'webkit-live-table-realtime';
const ENGINE_HEALTH_URL = process.env.ENGINE_HEALTH_URL || 'https://engine.smarter.poker/health';
const EXPECTED_ENGINE_SHA = (process.env.EXPECTED_ENGINE_SHA || '').trim();
const CONNECT_DEADLINE_MS = 12_000;
const MAX_GAMEPLAY_SILENCE_MS = 45_000;
const CAUSAL_HAND_TIMEOUT_MS = 90_000;
const PRESENTATION_DEADLINE_MS = 3_000;
const TOURNAMENT_FORMATS = ['mtt', 'spin', 'sng'] as const;

type CertifiableGameFormat = 'cash' | (typeof TOURNAMENT_FORMATS)[number];

interface RunningTableCandidate {
  id: string;
  players: number;
  name: string;
  gameFormat: CertifiableGameFormat;
}

interface EngineTableLiveness {
  tableId: string;
  gameFormat: CertifiableGameFormat | null;
  clubId: string | null;
  seated: number;
  dealable: number;
  handCount: number;
  msSinceProgress: number;
  loopPhase: string;
  paused: boolean;
}

interface EngineHealth {
  version: string;
  releaseSha: string | null;
  liveness: string;
  activeTables: number;
  stalledTableCount: number;
  deadStalledCount: number;
  wholeFleetStalled: boolean;
  maintenance?: { active?: boolean; phase?: string | null } | null;
  equityGovernor?: { scale?: number; p50Ms?: number; p99Ms?: number } | null;
  telemetry?: { avgHandDurationMs?: number; avgHandsPerHour?: number } | null;
  tableLiveness: EngineTableLiveness[];
}

interface PreNavigationEngineEvidence {
  before: EngineHealth;
  after: EngineHealth;
  beforeTable: EngineTableLiveness;
  afterTable: EngineTableLiveness;
}

function requireCertificationConfiguration(testInfo: TestInfo, browserName: string): void {
  if (!CERTIFICATION_ENABLED) return;

  if (testInfo.project.name !== PROJECT_NAME || browserName !== 'webkit') {
    throw new Error(
      `Live-table continuity must run in --project=${PROJECT_NAME}; ` +
        `received project=${testInfo.project.name}, browser=${browserName}`
    );
  }
  if (process.env.E2E_REQUIRE_AUTH !== '1') {
    throw new Error('Set E2E_REQUIRE_AUTH=1 so a failed production login cannot become a skip');
  }
  if (!process.env.SP_EMAIL || !process.env.SP_PASS) {
    throw new Error('SP_EMAIL and SP_PASS must identify the isolated production E2E account');
  }
  if (!/^[0-9a-f]{40}$/.test(EXPECTED_ENGINE_SHA)) {
    throw new Error(
      'EXPECTED_ENGINE_SHA must name the exact Club Arena commit the production engine should serve'
    );
  }

  const rawBaseURL = testInfo.project.use.baseURL;
  if (typeof rawBaseURL !== 'string') throw new Error('The WebKit project has no BASE_URL');
  const baseURL = new URL(rawBaseURL);
  const normalizedPath = baseURL.pathname.replace(/\/+$/, '');
  if (baseURL.origin !== 'https://smarter.poker' || normalizedPath !== '/hub/club-arena') {
    throw new Error(
      'Live-table certification is fail-closed to https://smarter.poker/hub/club-arena/'
    );
  }
}

type LivenessScope = { tableIds: string[] } | { gameFormat: (typeof TOURNAMENT_FORMATS)[number] };

async function readEngineHealth(
  request: APIRequestContext,
  scope: LivenessScope
): Promise<EngineHealth> {
  const url = new URL(ENGINE_HEALTH_URL);
  url.searchParams.set('cb', String(Date.now()));
  if ('tableIds' in scope) {
    expect(scope.tableIds.length).toBeGreaterThan(0);
    expect(scope.tableIds.length).toBeLessThanOrEqual(32);
    url.searchParams.set('liveness_table_ids', scope.tableIds.join(','));
  } else {
    url.searchParams.set('liveness_format', scope.gameFormat);
    url.searchParams.set('liveness_club_ids', [CLUB_ID, UNION_ID].join(','));
  }
  const response = await request.get(url.toString(), {
    timeout: 15_000,
    headers: { 'cache-control': 'no-store' },
  });
  expect(response.status(), 'the public engine health endpoint did not answer 200').toBe(200);
  const health = (await response.json()) as EngineHealth;
  expect(health.liveness, 'the production engine did not report liveness=ok').toBe('ok');
  expect(health.stalledTableCount, 'production had stalled tables before observation').toBe(0);
  expect(health.deadStalledCount, 'production had dead stalled tables before observation').toBe(0);
  expect(health.wholeFleetStalled, 'production reported the whole fleet stalled').toBe(false);
  const observedReleaseSha = String(health.releaseSha || '').trim();
  expect(
    observedReleaseSha,
    'the production engine did not expose one full lowercase releaseSha'
  ).toMatch(/^[0-9a-f]{40}$/);
  expect(
    observedReleaseSha,
    `engine releaseSha ${observedReleaseSha || '(missing)'} did not exactly match ${EXPECTED_ENGINE_SHA}`
  ).toBe(EXPECTED_ENGINE_SHA);
  if (health.maintenance?.active) {
    throw new Error(
      `production engine is in scheduled maintenance (${health.maintenance.phase || 'unknown phase'}); ` +
        'live-table continuity must be certified after normal dealing resumes'
    );
  }
  expect(Array.isArray(health.tableLiveness), 'engine health omitted per-table liveness').toBe(
    true
  );
  expect(
    health.tableLiveness.length,
    'scoped health exceeded its public response bound'
  ).toBeLessThanOrEqual(32);
  expect(
    new Set(health.tableLiveness.map((t) => t.tableId)).size,
    'duplicate table progress evidence'
  ).toBe(health.tableLiveness.length);
  for (const table of health.tableLiveness) {
    expect(table.tableId, 'progress evidence omitted a table UUID').toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    for (const count of [table.seated, table.dealable, table.handCount]) {
      expect(Number.isSafeInteger(count), 'progress evidence omitted an integer counter').toBe(
        true
      );
      expect(count).toBeGreaterThanOrEqual(0);
    }
    expect(
      Number.isFinite(table.msSinceProgress),
      'progress evidence omitted its inactivity clock'
    ).toBe(true);
    expect(table.msSinceProgress).toBeGreaterThanOrEqual(0);
    expect(typeof table.paused).toBe('boolean');
    expect(typeof table.loopPhase).toBe('string');
    if ('tableIds' in scope)
      expect(scope.tableIds, 'health returned an unrequested table').toContain(table.tableId);
    else {
      expect(table.gameFormat).toBe(scope.gameFormat);
      expect([CLUB_ID, UNION_ID], 'health returned an out-of-scope tournament').toContain(
        table.clubId
      );
    }
  }
  return health;
}

function healthyRunningTable(
  health: EngineHealth,
  tableId: string,
  expectedFormat?: CertifiableGameFormat
): EngineTableLiveness | null {
  const table = health.tableLiveness.find((entry) => entry.tableId === tableId) || null;
  if (
    !table ||
    (expectedFormat !== undefined && table.gameFormat !== expectedFormat) ||
    table.paused ||
    table.seated < 2 ||
    table.dealable < 2 ||
    table.handCount < 1 ||
    table.msSinceProgress > MAX_GAMEPLAY_SILENCE_MS
  ) {
    return null;
  }
  return table;
}

async function visibleRunningCashCandidates(page: Page): Promise<RunningTableCandidate[]> {
  // Cluster game cards retain the representative table id. Their View/Watch
  // Game action uses the same spectator table route as manual cash tables.
  const candidates = await page
    .locator(CASH_TABLE_CARD_SELECTOR)
    .evaluateAll(collectVisibleCashCandidates, CASH_SPECTATOR_ACTION.source);
  return candidates.map((candidate) => ({ ...candidate, gameFormat: 'cash' }));
}

async function selectOccupiedRunningCashTable(
  page: Page,
  request: APIRequestContext
): Promise<{ candidate: RunningTableCandidate; health: EngineHealth; table: EngineTableLiveness }> {
  await page.goto(CLUB_LOBBY, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (/\/auth(?:\/|\?|$)/.test(page.url())) {
    throw new Error('Production redirected to auth despite the required authenticated state');
  }
  await expect(page.locator('.club-home'), 'the production club lobby did not render').toBeVisible({
    timeout: 30_000,
  });
  await prepareCashLobbyActions(page);

  await page
    .locator(
      '.club-home__games [data-testid="arena-lobby-game-card"], .club-home__games .empty-tables'
    )
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });

  const tabs: Array<string | null> = [null, 'NLH', 'PLO', 'LIMIT'];
  for (const tabName of tabs) {
    if (tabName) {
      const tab = page.getByRole('tab', { name: tabName, exact: true });
      await expect(tab, `${tabName} cash-game tab is missing`).toBeVisible({ timeout: 8_000 });
      await tab.click();
      await expect(tab, `${tabName} cash-game tab did not become active`).toHaveAttribute(
        'aria-selected',
        'true'
      );
      /* The lobby already holds every table in memory; this only yields one
         paint for React to replace the filtered rows after the tab click. */
      await page.waitForTimeout(100);
    }
    const candidates = await visibleRunningCashCandidates(page);
    if (candidates.length === 0) continue;
    for (let offset = 0; offset < candidates.length; offset += 32) {
      const batch = candidates.slice(offset, offset + 32);
      const health = await readEngineHealth(request, { tableIds: batch.map((c) => c.id) });
      for (const candidate of batch) {
        const table = healthyRunningTable(health, candidate.id, candidate.gameFormat);
        if (table) return { candidate, health, table };
      }
    }
  }

  throw new Error(
    'The fixture club exposed no occupied (2+ players), running cash table with a read-only View/Watch Table or Game action'
  );
}

async function proveTableProgressedBeforeNavigation(
  request: APIRequestContext,
  candidate: RunningTableCandidate,
  before: EngineHealth,
  beforeTable: EngineTableLiveness
): Promise<PreNavigationEngineEvidence> {
  let after = before;
  let afterTable = beforeTable;
  const continuouslyActive = createProgressSilenceGuard(MAX_GAMEPLAY_SILENCE_MS);
  await expect
    .poll(
      async () => {
        after = await readEngineHealth(request, { tableIds: [candidate.id] });
        if (
          !continuouslyActive(after.tableLiveness.find((table) => table.tableId === candidate.id))
        )
          return -1;
        const current = healthyRunningTable(after, candidate.id, candidate.gameFormat);
        if (!current) return -1;
        afterTable = current;
        return current.handCount;
      },
      {
        // A live hand can keep progressing beyond the 45s inactivity limit.
        // Wait for the next deal using the same full-hand bound as the socket proof.
        timeout: CAUSAL_HAND_TIMEOUT_MS,
        intervals: [2_000, 3_000, 5_000, 5_000],
        message:
          `table ${candidate.name} (${candidate.id}) existed before observation but did not start its next hand ` +
          `inside ${CAUSAL_HAND_TIMEOUT_MS}ms`,
      }
    )
    .toBeGreaterThan(beforeTable.handCount);
  return { before, after, beforeTable, afterTable };
}

/**
 * Pick only from tables that were live before the browser existed, then wait
 * for one of those exact tables to start its next hand. Selecting the first
 * table that progresses avoids making a natural table close look like a
 * transport failure while retaining the pre-navigation proof.
 */
async function selectProgressingTournamentTable(
  request: APIRequestContext,
  gameFormat: (typeof TOURNAMENT_FORMATS)[number],
  testInfo: TestInfo
): Promise<{ candidate: RunningTableCandidate; evidence: PreNavigationEngineEvidence }> {
  let before = await readEngineHealth(request, { gameFormat });
  /* The live SNG board is presently heads-up, so two seats is a real SNG,
     not an unstable fallback. Spins and MTTs retain a three-player floor to
     avoid selecting a table already on its terminal heads-up hand. */
  const minimumStableSeats = gameFormat === 'sng' ? 2 : 3;
  const readyTables = (health: EngineHealth): EngineTableLiveness[] =>
    health.tableLiveness
      .filter(
        (table) =>
          table.gameFormat === gameFormat &&
          (table.clubId === CLUB_ID || table.clubId === UNION_ID) &&
          healthyRunningTable(health, table.tableId, gameFormat) !== null &&
          table.seated >= minimumStableSeats &&
          table.dealable >= minimumStableSeats
      )
      .sort(
        (a, b) =>
          b.seated - a.seated ||
          (gameFormat === 'sng' ? a.handCount - b.handCount : 0) ||
          a.msSinceProgress - b.msSinceProgress ||
          a.tableId.localeCompare(b.tableId)
      );
  let baselines = readyTables(before);

  // A publisher can finish while natural tournament tables are still resuming.
  // Wait only for the same live-table prerequisites, before freezing identities.
  try {
    if (baselines.length === 0) {
      await expect
        .poll(
          async () => {
            before = await readEngineHealth(request, { gameFormat });
            baselines = readyTables(before);
            return baselines.length;
          },
          {
            timeout: CAUSAL_HAND_TIMEOUT_MS,
            intervals: [2_000, 3_000, 5_000, 5_000],
            message:
              `production exposed no already-running ${gameFormat.toUpperCase()} table with ` +
              `${minimumStableSeats}+ dealable players in fixture scope ${CLUB_ID}/${UNION_ID} ` +
              `inside ${CAUSAL_HAND_TIMEOUT_MS}ms`,
          }
        )
        .toBeGreaterThan(0);
    }
  } catch (error) {
    await testInfo.attach(`${gameFormat}-baseline-readiness-refusal`, {
      body: Buffer.from(
        JSON.stringify(
          {
            expectedVersion: EXPECTED_ENGINE_SHA,
            gameFormat,
            minimumStableSeats,
            fixtureClubIds: [CLUB_ID, UNION_ID],
            lastScopedHealth: before,
          },
          null,
          2
        )
      ),
      contentType: 'application/json',
    });
    throw error;
  }

  let after = before;
  let beforeTable: EngineTableLiveness | null = null;
  let afterTable: EngineTableLiveness | null = null;
  const continuouslyActive = createProgressSilenceGuard(MAX_GAMEPLAY_SILENCE_MS);
  await expect
    .poll(
      async () => {
        after = await readEngineHealth(request, { tableIds: baselines.map((t) => t.tableId) });
        for (const baseline of baselines) {
          if (
            !continuouslyActive(
              after.tableLiveness.find((table) => table.tableId === baseline.tableId)
            )
          )
            continue;
          const current = healthyRunningTable(after, baseline.tableId, gameFormat);
          if (current && current.handCount > baseline.handCount) {
            beforeTable = baseline;
            afterTable = current;
            return true;
          }
        }
        return false;
      },
      {
        timeout: CAUSAL_HAND_TIMEOUT_MS,
        intervals: [2_000, 3_000, 5_000, 5_000],
        message:
          `none of ${baselines.length} already-running ${gameFormat.toUpperCase()} tables ` +
          `started their next hand inside ${CAUSAL_HAND_TIMEOUT_MS}ms`,
      }
    )
    .toBe(true);

  if (!beforeTable || !afterTable) {
    throw new Error(`${gameFormat.toUpperCase()} progress poll completed without table evidence`);
  }
  const selectedBefore = beforeTable as EngineTableLiveness;
  const selectedAfter = afterTable as EngineTableLiveness;
  return {
    candidate: {
      id: selectedBefore.tableId,
      players: selectedBefore.seated,
      name: `${gameFormat.toUpperCase()} ${selectedBefore.tableId.slice(0, 8)}`,
      gameFormat,
    },
    evidence: { before, after, beforeTable: selectedBefore, afterTable: selectedAfter },
  };
}

function tableIdFromUrl(page: Page): string {
  const match = new URL(page.url()).pathname.match(/\/table\/([0-9a-f-]{8,})(?:\/|$)/i);
  if (!match) throw new Error(`View Table did not land on a table route (${page.url()})`);
  return match[1];
}

function compactHealthEvidence(
  health: EngineHealth,
  table: EngineTableLiveness
): Record<string, unknown> {
  return {
    version: health.version,
    releaseSha: health.releaseSha,
    liveness: health.liveness,
    activeTables: health.activeTables,
    stalledTableCount: health.stalledTableCount,
    deadStalledCount: health.deadStalledCount,
    wholeFleetStalled: health.wholeFleetStalled,
    maintenance: health.maintenance,
    equityGovernor: health.equityGovernor,
    telemetry: health.telemetry,
    table,
  };
}

async function expectNextHandPresentation(
  page: Page,
  cycle: CausalHandCycle,
  phase: string
): Promise<void> {
  const beginsAt = cycle.nextHandStartedAt - 250;
  const endsAt = cycle.nextHandStartedAt + PRESENTATION_DEADLINE_MS;
  await expect
    .poll(
      async () => {
        const evidence = await liveTablePresentationEvidence(page);
        return {
          deal: evidence.some(
            (entry) =>
              entry.kind === 'deal-animation' &&
              entry.at >= beginsAt &&
              entry.at <= endsAt &&
              (entry.cardCount || 0) >= 2
          ),
          dealer: evidence.some(
            (entry) =>
              entry.kind === 'dealer-button-moved' &&
              entry.at >= cycle.completedAt - 250 &&
              entry.at <= endsAt
          ),
        };
      },
      {
        timeout: PRESENTATION_DEADLINE_MS,
        intervals: [50, 100, 250],
        message:
          `${phase}: hand ${cycle.nextHandNumber} started, but its deal-card animation ` +
          'and dealer-button movement were not both observed',
      }
    )
    .toEqual({ deal: true, dealer: true });
}

function isSpectatorParticipationMutation(method: string, rawUrl: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const path = new URL(rawUrl).pathname.toLowerCase().replace(/\/+$/, '');
  return (
    /\/(?:action|leave|post-bb|rabbit-hunt)$/.test(path) ||
    /\/rest\/v1\/(?:table_seats|tournament_players|wallet_transactions)$/.test(path) ||
    /\/rpc\/(?:fn_take_seat_and_buy_in|fn_register_for_tournament|fn_unregister_from_tournament|fn_leave_seat_and_refund|atomic_table_rebuy|process_tournament_rebuy|fn_join_waitlist)$/.test(
      path
    )
  );
}

async function certifyReadOnlyTournamentFormat(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  gameFormat: (typeof TOURNAMENT_FORMATS)[number]
): Promise<void> {
  // Poker's action clock bounds each turn, not the whole hand. Keep the
  // existing runner's hard case limit and one fixed observation deadline;
  // live poker events still must satisfy the unchanged silence limit.
  const observationDeadline = Date.now() + testInfo.timeout;
  const selected = await selectProgressingTournamentTable(request, gameFormat, testInfo);
  const { candidate, evidence } = selected;
  await testInfo.attach(`${gameFormat}-engine-before-navigation`, {
    body: Buffer.from(
      JSON.stringify(
        {
          expectedVersion: EXPECTED_ENGINE_SHA,
          gameFormat,
          before: compactHealthEvidence(evidence.before, evidence.beforeTable),
          after: compactHealthEvidence(evidence.after, evidence.afterTable),
        },
        null,
        2
      )
    ),
    contentType: 'application/json',
  });

  const journal = new EngineSocketJournal(page);
  const context = page.context();
  let offline = false;
  const participationMutations: Array<{ method: string; path: string }> = [];
  page.on('request', (outgoing) => {
    if (!isSpectatorParticipationMutation(outgoing.method(), outgoing.url())) return;
    participationMutations.push({
      method: outgoing.method(),
      path: new URL(outgoing.url()).pathname,
    });
  });

  const navigationStartedAt = Date.now();
  const banner = page.getByTestId('table-connection-banner');
  try {
    /* Start all three protocol deadlines before navigation. Waiting to arm
       them until after the page mounted made a nominal 12-second deadline
       silently exclude document/chunk startup time. */
    const protocolReady = Promise.all([
      journal.waitForFrame(
        { direction: 'sent', tableId: candidate.id, type: 'SUBSCRIBE', since: navigationStartedAt },
        CONNECT_DEADLINE_MS,
        `${candidate.name} did not subscribe inside the navigation deadline`
      ),
      journal.waitForFrame(
        {
          direction: 'received',
          tableId: candidate.id,
          type: 'SUBSCRIBED',
          since: navigationStartedAt,
        },
        CONNECT_DEADLINE_MS,
        `${candidate.name} subscription was not acknowledged inside the navigation deadline`
      ),
      journal.waitForFrame(
        {
          direction: 'received',
          tableId: candidate.id,
          type: 'SNAPSHOT',
          since: navigationStartedAt,
        },
        CONNECT_DEADLINE_MS,
        `${candidate.name} did not receive an authoritative snapshot inside the navigation deadline`
      ),
    ]);

    await whileConnectionBannerStaysHidden(
      page,
      (async () => {
        await Promise.all([
          page.goto(`table/${candidate.id}`, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
          }),
          protocolReady,
        ]);
        if (/\/auth(?:\/|\?|$)/.test(page.url())) {
          throw new Error('Production redirected to auth despite the required authenticated state');
        }
        expect(tableIdFromUrl(page)).toBe(candidate.id);
        await expect(
          page.locator('.table-page'),
          `${candidate.name} table route never mounted`
        ).toBeVisible({ timeout: 20_000 });
        await expect(
          page.locator('.table-surface'),
          `${candidate.name} live felt never rendered`
        ).toBeVisible({ timeout: 20_000 });
      })(),
      `${candidate.name} initial live-table connection`
    );

    await expect(banner).toBeHidden();
    await expect
      .poll(() => page.locator('.seat[role="region"]').count(), {
        timeout: 10_000,
        message: `${candidate.name} did not render its occupied seats`,
      })
      .toBeGreaterThanOrEqual(2);
    await expect(
      page.locator('.header-hand-number, .table-brand__hand').first(),
      `${candidate.name} had no already-running hand number`
    ).toContainText(/\d+/, { timeout: 10_000 });

    await installLiveTablePresentationJournal(page);
    const progressStartedAt = Date.now();
    const cycle = await whileConnectionBannerStaysHidden(
      page,
      journal.waitForCausalHandCycle(
        candidate.id,
        progressStartedAt,
        remainingObservationMs(observationDeadline),
        MAX_GAMEPLAY_SILENCE_MS,
        `${candidate.name} did not progress through a hand and automatically start the next`
      ),
      `${candidate.name} live gameplay`
    );
    expect(cycle.maxObservedSilenceMs).toBeLessThanOrEqual(MAX_GAMEPLAY_SILENCE_MS);
    await expectNextHandPresentation(page, cycle, `${candidate.name} live gameplay`);
    await expect(banner).toBeHidden();

    expect(
      journal.openTransportUrls().every((url) => new URL(url).pathname === '/ws/multi'),
      `${candidate.name} bypassed the one-owner multiplexed transport`
    ).toBe(true);
    expect(journal.openTransportCount(), `${candidate.name} did not retain exactly one mux`).toBe(
      1
    );
    const preOutageTransports = journal.transportIdsOpenAt(Date.now());
    expect(
      preOutageTransports,
      `${candidate.name} did not have exactly one live transport before outage`
    ).toHaveLength(1);
    expect(
      journal.matchingFrames({
        direction: 'sent',
        tableId: candidate.id,
        type: 'SUBSCRIBE',
        since: navigationStartedAt,
      }),
      `${candidate.name} created duplicate table owners`
    ).toHaveLength(1);

    try {
      await context.setOffline(true);
      offline = true;
      await expect(
        banner,
        `${candidate.name} did not acknowledge the forced network loss`
      ).toBeVisible({ timeout: 10_000 });
      await expect(banner).toContainText(/Reconnecting|Connection Lost/i);
      await expect
        .poll(() => journal.areTransportsClosed(preOutageTransports), {
          timeout: 10_000,
          message: `${candidate.name} retained a half-open pre-outage transport`,
        })
        .toBe(true);

      const restoredAt = Date.now();
      await context.setOffline(false);
      offline = false;
      await Promise.all([
        journal.waitForFrame(
          { direction: 'sent', tableId: candidate.id, type: 'SUBSCRIBE', since: restoredAt },
          CONNECT_DEADLINE_MS,
          `${candidate.name} did not resubscribe after network restoration`
        ),
        journal.waitForFrame(
          {
            direction: 'received',
            tableId: candidate.id,
            type: 'SUBSCRIBED',
            since: restoredAt,
          },
          CONNECT_DEADLINE_MS,
          `${candidate.name} restored subscription was not acknowledged`
        ),
        journal.waitForFrame(
          { direction: 'received', tableId: candidate.id, type: 'SNAPSHOT', since: restoredAt },
          CONNECT_DEADLINE_MS,
          `${candidate.name} reconnect did not restore an authoritative snapshot`
        ),
        expect(
          banner,
          `${candidate.name} reconnect banner outlived the recovery boundary`
        ).toBeHidden({ timeout: CONNECT_DEADLINE_MS }),
      ]);

      const recoveredProgressStartedAt = Date.now();
      const recoveredCycle = await whileConnectionBannerStaysHidden(
        page,
        journal.waitForCausalHandCycle(
          candidate.id,
          recoveredProgressStartedAt,
          remainingObservationMs(observationDeadline),
          MAX_GAMEPLAY_SILENCE_MS,
          `${candidate.name} did not resume causal gameplay after reconnect`
        ),
        `${candidate.name} live gameplay after reconnect`
      );
      expect(recoveredCycle.maxObservedSilenceMs).toBeLessThanOrEqual(MAX_GAMEPLAY_SILENCE_MS);
      await expectNextHandPresentation(
        page,
        recoveredCycle,
        `${candidate.name} live gameplay after reconnect`
      );

      // Allow a delayed WebKit cleanup/retry to reveal duplicate mux owners.
      await page.waitForTimeout(2_000);
      expect(
        journal.matchingFrames({
          direction: 'sent',
          tableId: candidate.id,
          type: 'SUBSCRIBE',
          since: restoredAt,
        }),
        `${candidate.name} reconnect created duplicate table owners`
      ).toHaveLength(1);
      expect(
        journal.matchingFrames({
          direction: 'received',
          tableId: candidate.id,
          type: 'SUBSCRIBED',
          since: restoredAt,
        }),
        `${candidate.name} reconnect produced duplicate acknowledgements`
      ).toHaveLength(1);
      expect(
        journal.matchingFrames({
          direction: 'sent',
          tableId: candidate.id,
          type: 'UNSUBSCRIBE',
          since: restoredAt,
        }),
        `${candidate.name} stale owner unsubscribed the recovered table`
      ).toHaveLength(0);
      expect(
        journal.matchingFrames({
          direction: 'received',
          tableId: candidate.id,
          type: 'ERROR',
          since: restoredAt,
        }),
        `${candidate.name} engine refused the recovered subscription`
      ).toHaveLength(0);
      expect(
        journal.openTransportCount(),
        `${candidate.name} did not recover exactly one multiplexed transport`
      ).toBe(1);
      await expect(banner).toBeHidden();
    } finally {
      if (offline) {
        await context.setOffline(false).catch(() => {});
        offline = false;
      }
    }

    expect(
      journal.matchingFrames({
        direction: 'sent',
        tableId: candidate.id,
        type: 'UNSUBSCRIBE',
        since: navigationStartedAt,
      }),
      `${candidate.name} was unsubscribed while under observation`
    ).toHaveLength(0);
    expect(
      journal.matchingFrames({
        direction: 'received',
        tableId: candidate.id,
        type: 'ERROR',
        since: navigationStartedAt,
      }),
      `${candidate.name} received an engine refusal`
    ).toHaveLength(0);
    expect(
      journal.matchingFrames({
        direction: 'sent',
        tableId: candidate.id,
        type: 'ACTION',
        since: navigationStartedAt,
      }),
      `${candidate.name} spectator sent a gameplay action`
    ).toHaveLength(0);
    expect(
      participationMutations,
      `${candidate.name} spectator attempted to join, register, spend or leave`
    ).toEqual([]);
  } finally {
    if (offline) await context.setOffline(false).catch(() => {});
    await testInfo.attach(`${gameFormat}-live-table-realtime-summary`, {
      body: Buffer.from(JSON.stringify(journal.summary(candidate.id), null, 2)),
      contentType: 'application/json',
    });
    await testInfo.attach(`${gameFormat}-live-table-presentation-summary`, {
      body: Buffer.from(
        JSON.stringify(await liveTablePresentationEvidence(page).catch(() => []), null, 2)
      ),
      contentType: 'application/json',
    });
    await testInfo.attach(`${gameFormat}-spectator-mutation-summary`, {
      body: Buffer.from(JSON.stringify(participationMutations, null, 2)),
      contentType: 'application/json',
    });
  }
}

test.describe('production mobile WebKit live-table realtime continuity', () => {
  test.skip(
    !CERTIFICATION_ENABLED,
    'Set LIVE_TABLE_REALTIME_CERTIFICATION=1 with production E2E auth to run this disruptive network-continuity certification'
  );
  test.setTimeout(300_000);

  test.beforeEach(async ({ browserName }, testInfo) => {
    requireCertificationConfiguration(testInfo, browserName);
  });

  for (const gameFormat of TOURNAMENT_FORMATS) {
    test(`an already-running ${gameFormat.toUpperCase()} table stays realtime and recovers one owner`, async ({
      page,
      request,
    }, testInfo) => {
      // Baseline readiness must not consume the existing continuity proof budget.
      testInfo.setTimeout(testInfo.timeout + CAUSAL_HAND_TIMEOUT_MS);
      await certifyReadOnlyTournamentFormat(page, request, testInfo, gameFormat);
    });
  }

  test('an already-running table stays live and recovers one owner after a network loss', async ({
    page,
    context,
    request,
  }, testInfo) => {
    const journal = new EngineSocketJournal(page);
    const selected = await selectOccupiedRunningCashTable(page, request);
    const { candidate } = selected;
    // Keep the exact table identity even when the next-hand proof times out.
    await testInfo.attach('cash-selected-before-progress', {
      body: Buffer.from(
        JSON.stringify(
          {
            selectedAt: new Date().toISOString(),
            expectedVersion: EXPECTED_ENGINE_SHA,
            candidate,
            health: compactHealthEvidence(selected.health, selected.table),
          },
          null,
          2
        )
      ),
      contentType: 'application/json',
    });
    const engineBeforeNavigation = await proveTableProgressedBeforeNavigation(
      request,
      candidate,
      selected.health,
      selected.table
    );
    await testInfo.attach('engine-before-navigation', {
      body: Buffer.from(
        JSON.stringify(
          {
            expectedVersion: EXPECTED_ENGINE_SHA,
            before: compactHealthEvidence(
              engineBeforeNavigation.before,
              engineBeforeNavigation.beforeTable
            ),
            after: compactHealthEvidence(
              engineBeforeNavigation.after,
              engineBeforeNavigation.afterTable
            ),
          },
          null,
          2
        )
      ),
      contentType: 'application/json',
    });

    const card = page.locator(
      `[data-testid="arena-lobby-game-card"][data-kind="cash"][data-id="${candidate.id}"]`
    );
    const view = card.getByRole('button', { name: CASH_SPECTATOR_ACTION });
    await expect(
      view,
      `occupied table ${candidate.name} lost its visible read-only View/Watch Table or Game action`
    ).toBeVisible();

    const navigationStartedAt = Date.now();
    const banner = page.getByTestId('table-connection-banner');
    let tableId = candidate.id;

    try {
      const protocolReady = Promise.all([
        journal.waitForFrame(
          {
            direction: 'sent',
            tableId: candidate.id,
            type: 'SUBSCRIBE',
            since: navigationStartedAt,
          },
          CONNECT_DEADLINE_MS,
          'the warmed mobile client never subscribed to the selected table'
        ),
        journal.waitForFrame(
          {
            direction: 'received',
            tableId: candidate.id,
            type: 'SUBSCRIBED',
            since: navigationStartedAt,
          },
          CONNECT_DEADLINE_MS,
          'the engine never acknowledged the selected table subscription'
        ),
        journal.waitForFrame(
          {
            direction: 'received',
            tableId: candidate.id,
            type: 'SNAPSHOT',
            since: navigationStartedAt,
          },
          CONNECT_DEADLINE_MS,
          'the selected table never delivered an authoritative snapshot'
        ),
      ]);
      /* A real mux acknowledgement and authoritative snapshot must beat the
         banner's built-in 1.2s grace. Cached DOM or PING traffic cannot pass. */
      tableId = await whileConnectionBannerStaysHidden(
        page,
        (async () => {
          await Promise.all([
            page.waitForURL(/\/table\/[0-9a-f-]{8,}(?:[/?#]|$)/i, { timeout: 30_000 }),
            view.click(),
            protocolReady,
          ]);
          const selectedTableId = tableIdFromUrl(page);
          expect(
            selectedTableId,
            'the visible mobile card navigated to a different table than engine health certified'
          ).toBe(candidate.id);
          await expect(page.locator('.table-page'), 'the table route never mounted').toBeVisible({
            timeout: 20_000,
          });
          await expect(page.locator('.table-surface'), 'the live felt never rendered').toBeVisible({
            timeout: 20_000,
          });
          return selectedTableId;
        })(),
        'initial live-table connection'
      );
      await expect(banner).toBeHidden();
      expect(
        journal.openTransportUrls().every((url) => new URL(url).pathname === '/ws/multi'),
        'the production table bypassed the one-owner multiplexed transport'
      ).toBe(true);
      await expect
        .poll(() => page.locator('.seat[role="region"]').count(), {
          timeout: 10_000,
          message: 'the supposedly running table did not render two occupied seats',
        })
        .toBeGreaterThanOrEqual(2);
      await expect(
        page.locator('.header-hand-number, .table-brand__hand').first(),
        'the selected table had no already-running hand number'
      ).toContainText(/\d+/, { timeout: 10_000 });

      await installLiveTablePresentationJournal(page);

      /* Retained EVENT replay is explicitly excluded by its protocol marker.
         Prove action/street progress, completion, automatic next-hand start,
         and presentation of that next hand. */
      const initialProgressStartedAt = Date.now();
      const initialCycle = await whileConnectionBannerStaysHidden(
        page,
        journal.waitForCausalHandCycle(
          tableId,
          initialProgressStartedAt,
          CAUSAL_HAND_TIMEOUT_MS,
          MAX_GAMEPLAY_SILENCE_MS,
          'the connected table did not progress through a hand and automatically start the next'
        ),
        'live gameplay before the outage'
      );
      expect(initialCycle.maxObservedSilenceMs).toBeLessThanOrEqual(MAX_GAMEPLAY_SILENCE_MS);
      await expectNextHandPresentation(page, initialCycle, 'live gameplay before the outage');
      await expect(banner).toBeHidden();

      const preOutageTransports = journal.transportIdsOpenAt(Date.now());
      expect(
        preOutageTransports,
        'there was not exactly one live game transport before outage'
      ).toHaveLength(1);

      let offline = false;
      try {
        await context.setOffline(true);
        offline = true;
        await expect(banner, 'the table did not acknowledge the forced network loss').toBeVisible({
          timeout: 10_000,
        });
        await expect(banner).toContainText(/Reconnecting|Connection Lost/i);
        await expect
          .poll(() => journal.areTransportsClosed(preOutageTransports), {
            timeout: 10_000,
            message: 'the pre-outage game transport remained half-open',
          })
          .toBe(true);

        const restoredAt = Date.now();
        await context.setOffline(false);
        offline = false;

        await Promise.all([
          journal.waitForFrame(
            { direction: 'sent', tableId, type: 'SUBSCRIBE', since: restoredAt },
            CONNECT_DEADLINE_MS,
            'the WebKit client did not resubscribe after network restoration'
          ),
          journal.waitForFrame(
            { direction: 'received', tableId, type: 'SUBSCRIBED', since: restoredAt },
            CONNECT_DEADLINE_MS,
            'the restored subscription was not acknowledged'
          ),
          journal.waitForFrame(
            { direction: 'received', tableId, type: 'SNAPSHOT', since: restoredAt },
            CONNECT_DEADLINE_MS,
            'reconnect did not restore an authoritative table snapshot'
          ),
          expect(
            banner,
            'the reconnect banner outlived the 12-second recovery boundary'
          ).toBeHidden({ timeout: CONNECT_DEADLINE_MS }),
        ]);

        const recoveredProgressStartedAt = Date.now();
        const recoveredCycle = await whileConnectionBannerStaysHidden(
          page,
          journal.waitForCausalHandCycle(
            tableId,
            recoveredProgressStartedAt,
            CAUSAL_HAND_TIMEOUT_MS,
            MAX_GAMEPLAY_SILENCE_MS,
            'the restored table did not progress through a hand and automatically start the next'
          ),
          'live gameplay after reconnect'
        );
        expect(recoveredCycle.maxObservedSilenceMs).toBeLessThanOrEqual(MAX_GAMEPLAY_SILENCE_MS);
        await expectNextHandPresentation(page, recoveredCycle, 'live gameplay after reconnect');
        await expect(banner).toBeHidden();

        /* Give a delayed StrictMode cleanup/reconnect ladder time to expose
           itself, then assert the exact ownership shape rather than merely a
           visible felt. */
        await page.waitForTimeout(2_000);
        const subscriptions = journal.matchingFrames({
          direction: 'sent',
          tableId,
          type: 'SUBSCRIBE',
          since: restoredAt,
        });
        const acknowledgements = journal.matchingFrames({
          direction: 'received',
          tableId,
          type: 'SUBSCRIBED',
          since: restoredAt,
        });
        const staleUnsubscribes = journal.matchingFrames({
          direction: 'sent',
          tableId,
          type: 'UNSUBSCRIBE',
          since: restoredAt,
        });
        const refusals = journal.matchingFrames({
          direction: 'received',
          tableId,
          type: 'ERROR',
          since: restoredAt,
        });

        expect(subscriptions, 'reconnect created duplicate table owners').toHaveLength(1);
        expect(acknowledgements, 'one subscribe produced duplicate acknowledgements').toHaveLength(
          1
        );
        expect(staleUnsubscribes, 'a stale owner unsubscribed the restored table').toHaveLength(0);
        expect(refusals, 'the engine refused the restored table subscription').toHaveLength(0);
        expect(
          journal.openTransportCount(),
          `expected one live game transport, got ${journal.openTransportUrls().join(', ')}`
        ).toBe(1);
        await expect(banner).toBeHidden();
      } finally {
        if (offline) await context.setOffline(false).catch(() => {});
      }
    } finally {
      await testInfo.attach('live-table-realtime-summary', {
        body: Buffer.from(JSON.stringify(journal.summary(tableId), null, 2)),
        contentType: 'application/json',
      });
      await testInfo.attach('live-table-presentation-summary', {
        body: Buffer.from(
          JSON.stringify(await liveTablePresentationEvidence(page).catch(() => []), null, 2)
        ),
        contentType: 'application/json',
      });
    }
  });
});
