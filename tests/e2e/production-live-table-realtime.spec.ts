import {
  devices,
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  EngineSocketJournal,
  installLiveTablePresentationJournal,
  liveTablePresentationEvidence,
  whileConnectionBannerStaysHidden,
  whileInitialTableConnects,
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
import { assertInitialTableOwnership, classifyUnsubscribes } from './support/initialTableOwnership';
import {
  classifyCaseFailure,
  classifyBoardEnding,
  decideReselection,
  HAND_BOUNDARY_EVENT_TYPES,
  orderByEndurance,
  selectableWhileRunning,
  type TournamentBoardFacts,
} from './support/tournamentBoardEnding';
import { remainingInitialTableReadinessMs } from './support/initialTableReadiness';
import {
  createHudClockReader,
  hudEventObservationMs,
  MTT_HUD_LEVEL_CAP_MS,
  mttCaseTimeoutMs,
  observeHudLevels,
  selectableHudClock,
  sharedNaturalLevel,
  waitForSharedNaturalLevel,
  type HudClock,
  type HudLevel,
} from './support/tournamentHudWitness';

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
/** Cash only: named failures must fire before the case's own timeout can. */
const CASH_CASE_TAIL_MS = 15_000;
/** Cash tables raced for the pre-navigation "next hand started" proof. */
const CASH_PROGRESS_CANDIDATES = 8;
const PRESENTATION_DEADLINE_MS = 3_000;
const TOURNAMENT_FORMATS = ['mtt', 'spin', 'sng'] as const;

type BoardReader = Awaited<ReturnType<typeof createHudClockReader>>;

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

interface OccupiedCashTable {
  candidate: RunningTableCandidate;
  table: EngineTableLiveness;
}

/**
 * Every occupied, running cash table the first productive lobby tab exposes
 * (at most CASH_PROGRESS_CANDIDATES), each with the liveness it had when it
 * was chosen. A cash hand is not short: measured 2026-09-29 over 20,488 hands
 * in three hours, p50 30s, p90 87s, p99 149s, max 300s. One table chosen alone
 * and asked to deal its NEXT hand inside 90s is in a long hand a large share of
 * the time through nobody's fault; tournaments already race several tables and
 * keep whichever deals first, and cash now does the same.
 */
async function selectOccupiedRunningCashTables(
  page: Page,
  request: APIRequestContext
): Promise<{ tables: OccupiedCashTable[]; health: EngineHealth }> {
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
    const tables: OccupiedCashTable[] = [];
    let lastHealth: EngineHealth | null = null;
    for (let offset = 0; offset < candidates.length; offset += 32) {
      const batch = candidates.slice(offset, offset + 32);
      const health = await readEngineHealth(request, { tableIds: batch.map((c) => c.id) });
      lastHealth = health;
      for (const candidate of batch) {
        const table = healthyRunningTable(health, candidate.id, candidate.gameFormat);
        if (table && tables.length < CASH_PROGRESS_CANDIDATES) tables.push({ candidate, table });
      }
      if (tables.length >= CASH_PROGRESS_CANDIDATES) break;
    }
    if (tables.length > 0 && lastHealth) return { tables, health: lastHealth };
  }

  throw new Error(
    'The fixture club exposed no occupied (2+ players), running cash table with a read-only View/Watch Table or Game action'
  );
}

async function proveTableProgressedBeforeNavigation(
  request: APIRequestContext,
  contenders: readonly OccupiedCashTable[],
  before: EngineHealth,
  deadline: number
): Promise<PreNavigationEngineEvidence & { selected: OccupiedCashTable }> {
  let after = before;
  let winner: { contender: OccupiedCashTable; table: EngineTableLiveness } | null = null;
  const continuouslyActive = createProgressSilenceGuard(MAX_GAMEPLAY_SILENCE_MS);
  const budget = Math.min(CAUSAL_HAND_TIMEOUT_MS, remainingObservationMs(deadline));
  await expect
    .poll(
      async () => {
        after = await readEngineHealth(request, {
          tableIds: contenders.map((contender) => contender.candidate.id),
        });
        for (const contender of contenders) {
          const id = contender.candidate.id;
          // A table that ever sat silent past the limit is excluded for good,
          // exactly as a tournament baseline is; it can never be the witness.
          if (!continuouslyActive(after.tableLiveness.find((table) => table.tableId === id)))
            continue;
          const current = healthyRunningTable(after, id, contender.candidate.gameFormat);
          if (current && current.handCount > contender.table.handCount) {
            winner = { contender, table: current };
            return true;
          }
        }
        return false;
      },
      {
        // The first of several occupied tables to deal its next hand wins. A
        // live hand can outlast the 45s inactivity limit; the same full-hand
        // bound as the socket proof applies to the group, not to one table.
        timeout: budget,
        intervals: [2_000, 3_000, 5_000, 5_000],
        message: `none of ${contenders.length} occupied cash table(s) (${contenders
          .map((contender) => contender.candidate.id)
          .join(', ')}) started their next hand inside ${budget}ms`,
      }
    )
    .toBe(true);
  const picked = winner as { contender: OccupiedCashTable; table: EngineTableLiveness } | null;
  if (!picked) throw new Error('cash progress poll completed without table evidence');
  return {
    before,
    after,
    beforeTable: picked.contender.table,
    afterTable: picked.table,
    selected: picked.contender,
  };
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
  testInfo: TestInfo,
  options: {
    /** Read-only database witness; present only where a board can end while watched (SNG). */
    boardReader?: BoardReader;
    /**
     * Read-only clock witness; present only for the MTT. A table is selectable
     * only if its tournament can yield the eligible natural HUD clock the case
     * needs after recovery (see selectableHudClock), so the case never chooses
     * a field that is in its add-on period, on a break or about to break.
     */
    hudReader?: BoardReader;
    /** Boards this case already watched to a natural ending. */
    excludeTableIds?: readonly string[];
    /** The case's one fixed deadline; selection may spend only what remains of it. */
    deadline: number;
  }
): Promise<{
  candidate: RunningTableCandidate;
  evidence: PreNavigationEngineEvidence;
  boardFacts: TournamentBoardFacts | null;
}> {
  const excluded = new Set(options.excludeTableIds ?? []);
  const pollBudgetMs = () =>
    Math.min(CAUSAL_HAND_TIMEOUT_MS, remainingObservationMs(options.deadline));
  /* A board that already finished, or is one hand from finishing, is not a
     running board, and the deepest boards are the least likely to finish
     while the browser is watching. Read the rows; never guess. */
  const refineByBoard = async (tables: EngineTableLiveness[]): Promise<EngineTableLiveness[]> => {
    const fresh = tables.filter((table) => !excluded.has(table.tableId));
    if (options.hudReader && fresh.length > 0) {
      const clocks = await options.hudReader.clocks(
        fresh.map((table) => table.tableId),
        MTT_HUD_LEVEL_CAP_MS,
        selectableHudClock
      );
      return fresh.filter((table) => clocks.has(table.tableId));
    }
    if (!options.boardReader || fresh.length === 0) return fresh;
    const facts = await options.boardReader.boardFacts(fresh.map((table) => table.tableId));
    return orderByEndurance(
      fresh.filter((table) => selectableWhileRunning(facts.get(table.tableId))),
      facts
    );
  };
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
  let baselines = await refineByBoard(readyTables(before));

  // A publisher can finish while natural tournament tables are still resuming.
  // Wait only for the same live-table prerequisites, before freezing identities.
  try {
    if (baselines.length === 0) {
      await expect
        .poll(
          async () => {
            before = await readEngineHealth(request, { gameFormat });
            baselines = await refineByBoard(readyTables(before));
            return baselines.length;
          },
          {
            timeout: pollBudgetMs(),
            intervals: [2_000, 3_000, 5_000, 5_000],
            message:
              `production exposed no already-running ${gameFormat.toUpperCase()} table with ` +
              `${minimumStableSeats}+ dealable players in fixture scope ${CLUB_ID}/${UNION_ID}` +
              (options.hudReader
                ? ' whose tournament can yield an eligible natural HUD clock (running, not on a break, ' +
                  'not in its add-on period, not accelerated, next levels playable)'
                : '') +
              ` inside ${CAUSAL_HAND_TIMEOUT_MS}ms` +
              (excluded.size
                ? ` (${excluded.size} board(s) already ended naturally this case)`
                : ''),
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
  let acceptedFacts: TournamentBoardFacts | null = null;
  const continuouslyActive = createProgressSilenceGuard(MAX_GAMEPLAY_SILENCE_MS);
  await expect
    .poll(
      async () => {
        baselines = baselines.filter((table) => !excluded.has(table.tableId));
        if (baselines.length === 0) return false;
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
            // Fresh proof at acceptance: a board whose finishing hand was that
            // very hand is an ended board, not a running one.
            if (options.boardReader) {
              const fresh = (await options.boardReader.boardFacts([baseline.tableId])).get(
                baseline.tableId
              );
              if (!selectableWhileRunning(fresh)) {
                excluded.add(baseline.tableId);
                continue;
              }
              acceptedFacts = fresh ?? null;
            }
            beforeTable = baseline;
            afterTable = current;
            return true;
          }
        }
        return false;
      },
      {
        timeout: pollBudgetMs(),
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
    boardFacts: acceptedFacts,
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

/** A proven natural ending: the board finished while watched, so this case takes another running board. */
class NaturalCompletionDuringObservation extends Error {
  constructor(
    message: string,
    readonly evidence: Record<string, unknown>
  ) {
    super(message);
    this.name = 'NaturalCompletionDuringObservation';
  }
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
  const caseStartedAt = Date.now();
  const observationDeadline = caseStartedAt + testInfo.timeout;
  /* A heads-up Sit & Go can finish its last hand while the browser watches
     it, and then it is COMPLETED, not broken. Only that format reads the rows
     that prove it. Every other failure keeps its own message and evidence. */
  const boardReader = gameFormat === 'sng' ? await createHudClockReader() : undefined;
  /* The MTT alone needs a natural blind-level clock after recovery, so it alone
     qualifies its table by that clock at selection instead of by seat count. */
  const hudReader = gameFormat === 'mtt' ? await createHudClockReader() : undefined;
  const watched: string[] = [];
  const endings: Array<Record<string, unknown>> = [];
  const pages: Page[] = [];
  try {
    for (let attempt = 0; ; attempt++) {
      const attemptPage = attempt === 0 ? page : await page.context().newPage();
      pages.push(attemptPage);
      try {
        await observeTournamentBoard(attemptPage, request, testInfo, gameFormat, {
          caseStartedAt,
          observationDeadline,
          boardReader,
          hudReader,
          watched,
          tag: attempt === 0 ? gameFormat : `${gameFormat}-attempt-${attempt + 1}`,
        });
        return;
      } catch (error) {
        if (!(error instanceof NaturalCompletionDuringObservation)) throw error;
        endings.push(error.evidence);
        const decision = decideReselection({
          reselectionsUsed: attempt,
          remainingMs: observationDeadline - Date.now(),
        });
        if (!decision.reselect) {
          throw Object.assign(
            new Error(
              `${gameFormat.toUpperCase()} boards ended naturally while under observation and no ` +
                `further board could be observed: ${decision.reason}. Endings: ${JSON.stringify(endings)}`
            ),
            { cause: error }
          );
        }
        // Leave the finished board's page before another board is selected.
        await attemptPage.goto('about:blank').catch(() => {});
      }
    }
  } finally {
    for (const extra of pages.slice(1)) await extra.close().catch(() => {});
    if (endings.length)
      await testInfo.attach(`${gameFormat}-natural-completions`, {
        body: Buffer.from(JSON.stringify(endings, null, 2)),
        contentType: 'application/json',
      });
    if (boardReader) await boardReader.close().catch(() => {});
    if (hudReader) await hudReader.close().catch(() => {});
  }
}

async function observeTournamentBoard(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  gameFormat: (typeof TOURNAMENT_FORMATS)[number],
  clock: {
    caseStartedAt: number;
    observationDeadline: number;
    boardReader: BoardReader | undefined;
    hudReader: BoardReader | undefined;
    watched: string[];
    tag: string;
  }
): Promise<void> {
  const { caseStartedAt, observationDeadline, boardReader, hudReader, watched, tag } = clock;
  let hudClock: HudClock | undefined;
  const selected = await selectProgressingTournamentTable(request, gameFormat, testInfo, {
    boardReader,
    hudReader,
    excludeTableIds: watched,
    deadline: observationDeadline,
  });
  const { candidate, evidence } = selected;
  watched.push(candidate.id);
  if (hudReader)
    await testInfo.attach(`${tag}-mtt-hud-selection-qualification`, {
      body: Buffer.from(JSON.stringify(hudReader.qualifications.slice(-32), null, 2)),
      contentType: 'application/json',
    });
  await testInfo.attach(`${tag}-engine-before-navigation`, {
    body: Buffer.from(
      JSON.stringify(
        {
          expectedVersion: EXPECTED_ENGINE_SHA,
          gameFormat,
          before: compactHealthEvidence(evidence.before, evidence.beforeTable),
          after: compactHealthEvidence(evidence.after, evidence.afterTable),
          boardAtSelection: selected.boardFacts,
        },
        null,
        2
      )
    ),
    contentType: 'application/json',
  });

  const journal = new EngineSocketJournal(page);
  const context = page.context();
  const hudLevels = gameFormat === 'mtt' ? observeHudLevels(page) : [];
  let peerContext: BrowserContext | undefined;
  let peerPage: Page | undefined;
  let peerLevels: HudLevel[] = [];
  let hudBaseline = 0;
  let hudSince = 0;
  const hudObservation = new AbortController();
  const hudLevelBadge = (target: Page) =>
    target
      .locator('.tournament-hud-bar')
      .getByText('Level', { exact: true })
      .locator('..')
      .locator('span')
      .nth(1);
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

    await whileInitialTableConnects(
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
        // Cold entry may honestly say Connecting before its first state. The
        // actual subscription, snapshot, mounted felt and cleared status must
        // still finish inside the same original navigation deadline.
        await expect(banner).toBeHidden({
          timeout: remainingInitialTableReadinessMs(navigationStartedAt, CONNECT_DEADLINE_MS),
        });
      })(),
      `${candidate.name} initial live-table connection`
    );

    await expect(banner).toBeHidden();
    if (gameFormat === 'mtt') {
      const browser = context.browser();
      if (!browser) throw new Error('HUD witness needs the existing isolated WebKit browser');
      peerContext = await browser.newContext({
        ...devices['iPhone 13'],
        baseURL: testInfo.project.use.baseURL,
        storageState: await context.storageState(),
      });
      peerPage = await peerContext.newPage();
      peerLevels = observeHudLevels(peerPage);
      peerPage.on('request', (outgoing) => {
        if (isSpectatorParticipationMutation(outgoing.method(), outgoing.url()))
          participationMutations.push({
            method: outgoing.method(),
            path: new URL(outgoing.url()).pathname,
          });
      });
      await peerPage.goto(`table/${candidate.id}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      expect(tableIdFromUrl(peerPage)).toBe(candidate.id);
      await expect(peerPage.locator('.table-surface')).toBeVisible({ timeout: 20_000 });
      await expect(peerPage.getByTestId('table-connection-banner')).toBeHidden({
        timeout: CONNECT_DEADLINE_MS,
      });
      await expect
        .poll(
          async () => {
            const primary = Number(await hudLevelBadge(page).innerText());
            const peer = Number(await hudLevelBadge(peerPage!).innerText());
            return Number.isSafeInteger(primary) && primary > 0 && primary === peer ? primary : 0;
          },
          {
            timeout: 15_000,
            message: 'the two real HUDs did not agree on their initial display level',
          }
        )
        .toBeGreaterThan(0);
    }
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
    // acquire() deliberately re-subscribes when a prepared facade hands over
    // to the live client. The server keeps one subscriber for that transport
    // and table. Require one transport throughout initial acquisition, then
    // no further acquisition during the actual observed hand cycle.
    assertInitialTableOwnership(
      journal.matchingFrames({
        direction: 'sent',
        tableId: candidate.id,
        type: 'SUBSCRIBE',
        since: navigationStartedAt,
      }),
      preOutageTransports[0]!,
      progressStartedAt
    );

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

    if (gameFormat === 'mtt') {
      if (!peerPage) throw new Error('The mandatory second HUD context is unavailable');
      // All mandatory gameplay, outage and one-owner reconnect assertions are
      // complete. Neither context goes offline again after this fresh clock.
      // A level emitted during the outage cannot satisfy this new baseline.
      const reader = await createHudClockReader();
      try {
        hudClock = (await reader.clocks([candidate.id])).get(candidate.id);
      } finally {
        await testInfo.attach('mtt-hud-clock-qualification', {
          body: Buffer.from(JSON.stringify(reader.qualifications, null, 2)),
          contentType: 'application/json',
        });
        await reader.close();
      }
      if (!hudClock)
        throw new Error(
          'The recovered MTT has no eligible natural HUD clock (absent, paused, terminal, ' +
            'malformed, or its level is longer than the certifiable cap)'
        );
      // Whatever this real clock needs is what the case gets: never a fixed
      // guess a natural blind level can outrun by luck. This only ever grows
      // the case's one deadline (never shrinks it) - see mttCaseTimeoutMs.
      const mttTimeoutMs = mttCaseTimeoutMs(
        hudClock.observedAt - caseStartedAt,
        hudClock,
        testInfo.timeout
      );
      testInfo.setTimeout(mttTimeoutMs);
      const mttDeadline = caseStartedAt + mttTimeoutMs;
      hudBaseline = hudClock.levelIndex;
      hudSince = hudClock.observedAt;
      const transition = await waitForSharedNaturalLevel(
        () =>
          sharedNaturalLevel(hudLevels, peerLevels, hudClock!.tournamentId, hudBaseline, hudSince),
        hudEventObservationMs(hudClock, mttDeadline),
        hudObservation.signal
      );
      // Actual source contract: payload.level is the zero-based engine index;
      // TournamentHUD renders levelState.levelIndex + 1.
      await Promise.all(
        [page, peerPage].map((target) =>
          expect(hudLevelBadge(target)).toHaveText(String(transition.levelIndex + 1), {
            timeout: 15_000,
          })
        )
      );
      console.log(
        `[tournament-hud] two isolated spectators received natural level_up index ${transition.levelIndex} and rendered display ${transition.levelIndex + 1} for ${hudClock.tournamentId}`
      );
      await readEngineHealth(request, { tableIds: [candidate.id] });
    }

    /* The only UNSUBSCRIBE tolerated is the same-transport, same-tick handoff
       the client makes while the felt mounts, before observation begins (the
       SUBSCRIBE half is already accepted by assertInitialTableOwnership).
       Everything else, including any UNSUBSCRIBE during or after the observed
       hand cycle, still fails here. */
    const unsubscribeVerdict = classifyUnsubscribes(
      journal.matchingFrames({
        direction: 'sent',
        tableId: candidate.id,
        type: 'UNSUBSCRIBE',
        since: navigationStartedAt,
      }),
      journal.matchingFrames({
        direction: 'sent',
        tableId: candidate.id,
        type: 'SUBSCRIBE',
        since: navigationStartedAt,
      }),
      preOutageTransports[0]!,
      progressStartedAt
    );
    if (unsubscribeVerdict.handoffs.length > 0)
      await testInfo.attach(`${tag}-initial-handoffs`, {
        body: Buffer.from(JSON.stringify(unsubscribeVerdict.handoffs, null, 2)),
        contentType: 'application/json',
      });
    expect(
      unsubscribeVerdict.violations,
      `${candidate.name} was unsubscribed while under observation`
    ).toEqual([]);
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
  } catch (error) {
    /* Say WHY the case failed, from evidence, before the failure leaves this
       function. Nothing here turns a failure into a pass: a proven natural
       ending routes to another running board (bounded, inside the same case
       deadline), a table rebuilt under the browser is named as the engine
       defect it is, and every other failure is rethrown untouched. */
    const original = error instanceof Error ? error : new Error(String(error));
    const lastGameplayEventType = journal.lastGameplayEventType(candidate.id, navigationStartedAt);
    let atFailure: TournamentBoardFacts | null = null;
    if (boardReader) {
      try {
        // The bust is written to the rows within seconds of the finishing hand.
        for (let read = 0; read < 10; read++) {
          atFailure = (await boardReader.boardFacts([candidate.id])).get(candidate.id) ?? null;
          if (
            classifyBoardEnding(atFailure) !== 'running' ||
            !lastGameplayEventType ||
            !HAND_BOUNDARY_EVENT_TYPES.has(lastGameplayEventType)
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      } catch {
        atFailure = null;
      }
    }
    const outcome = classifyCaseFailure({
      engineRestartFrames: journal.countReceivedEvents(
        candidate.id,
        'engine_restarting',
        navigationStartedAt
      ),
      atSelection: selected.boardFacts,
      atFailure,
      lastGameplayEventType,
    });
    await testInfo.attach(`${tag}-failure-classification`, {
      body: Buffer.from(
        JSON.stringify(
          {
            tableId: candidate.id,
            outcome,
            lastGameplayEventType,
            atSelection: selected.boardFacts,
            atFailure,
            failure: original.message.split('\n')[0],
          },
          null,
          2
        )
      ),
      contentType: 'application/json',
    });
    if (outcome.kind === 'natural-completion') {
      throw new NaturalCompletionDuringObservation(`${candidate.name}: ${outcome.reason}`, {
        tableId: candidate.id,
        reason: outcome.reason,
        atSelection: selected.boardFacts,
        atFailure,
        failure: original.message.split('\n')[0],
      });
    }
    if (outcome.kind === 'table-engine-restarted') {
      throw Object.assign(
        new Error(
          `${candidate.name} TABLE ENGINE RESTARTED DURING OBSERVATION: ${outcome.reason}. ` +
            `This is an engine defect, not a browser or transport failure. Original failure: ${original.message}`
        ),
        { cause: original }
      );
    }
    throw original;
  } finally {
    hudObservation.abort();
    if (offline) await context.setOffline(false).catch(() => {});
    if (hudClock)
      await testInfo.attach('mtt-two-context-hud', {
        body: Buffer.from(
          JSON.stringify(
            {
              tableId: candidate.id,
              clock: hudClock,
              baselineIndex: hudBaseline,
              since: hudSince,
              primary: hudLevels,
              peer: peerLevels,
              completedAt: Date.now(),
            },
            null,
            2
          )
        ),
        contentType: 'application/json',
      });
    await peerContext?.close();
    await testInfo.attach(`${tag}-live-table-realtime-summary`, {
      body: Buffer.from(JSON.stringify(journal.summary(candidate.id), null, 2)),
      contentType: 'application/json',
    });
    await testInfo.attach(`${tag}-live-table-presentation-summary`, {
      body: Buffer.from(
        JSON.stringify(await liveTablePresentationEvidence(page).catch(() => []), null, 2)
      ),
      contentType: 'application/json',
    });
    await testInfo.attach(`${tag}-spectator-mutation-summary`, {
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
    /* Cash hands are long (p90 87s, p99 149s over 20,488 hands, measured
       2026-09-29) and both causal cycles begin mid-hand, so like every
       tournament case this one gets the base case budget PLUS one full-hand
       bound for pre-navigation readiness, one fixed deadline, and a reserved
       tail so a named failure fires before the case's own timeout can. */
    testInfo.setTimeout(testInfo.timeout + CAUSAL_HAND_TIMEOUT_MS);
    const caseStartedAt = Date.now();
    const observationDeadline = caseStartedAt + testInfo.timeout - CASH_CASE_TAIL_MS;
    const journal = new EngineSocketJournal(page);
    const selected = await selectOccupiedRunningCashTables(page, request);
    // Keep the exact table identities even when the next-hand proof times out.
    await testInfo.attach('cash-selected-before-progress', {
      body: Buffer.from(
        JSON.stringify(
          {
            selectedAt: new Date().toISOString(),
            expectedVersion: EXPECTED_ENGINE_SHA,
            candidates: selected.tables.map((entry) => ({
              candidate: entry.candidate,
              table: entry.table,
            })),
            health: compactHealthEvidence(selected.health, selected.tables[0].table),
          },
          null,
          2
        )
      ),
      contentType: 'application/json',
    });
    const engineBeforeNavigation = await proveTableProgressedBeforeNavigation(
      request,
      selected.tables,
      selected.health,
      observationDeadline
    );
    const { candidate } = engineBeforeNavigation.selected;
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

    // The engine-progress wait above can outlast the optional invitation's
    // arrival. Own its dismissal before the unchanged View visibility check.
    await prepareCashLobbyActions(page, { retainInvitationHandler: false });
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
          remainingObservationMs(observationDeadline),
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
            remainingObservationMs(observationDeadline),
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
