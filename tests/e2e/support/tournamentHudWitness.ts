import { createClient } from '@supabase/supabase-js';
import type { Page } from '@playwright/test';
import { remainingObservationMs } from './observationDeadline';
import type { TournamentBoardFacts } from './tournamentBoardEnding';

type Row = Record<string, unknown>;
export type HudClock = {
  tournamentId: string;
  levelIndex: number;
  intervalMs: number;
  remainingMs: number;
  nextIntervalMs: number;
  requiredObservationMs: number;
  observedAt: number;
};
export type HudLevel = { tournamentId: string; levelIndex: number; at: number };

export type HudClockRejectionCategory =
  | 'eligible'
  | 'unreadable_table'
  | 'unreadable_tournament'
  | 'not_mtt_format'
  | 'not_running'
  | 'on_break'
  | 'accelerated'
  | 'insufficient_players'
  | 'not_started'
  | 'addon_period_open'
  | 'clock_or_schedule_ineligible'
  | 'selection_lookahead_ineligible'
  | 'no_readable_running_table'
  | 'tournament_scan_truncated'
  | 'table_scan_truncated';

export type HudTournamentQualification = {
  tournamentId: string | null;
  clock: HudClock | null;
  category: HudClockRejectionCategory;
};

export type HudQualificationBatchEvidence = {
  requestedTableCount: number;
  readableTableCount: number;
  requestedTournamentCount: number;
  readableTournamentCount: number;
  eligibleTournamentCount: number;
  eligibleTableCount: number;
  rejectionCategories: Partial<Record<HudClockRejectionCategory, number>>;
};

export type HudDiscoveryEvidence = {
  fixtureClubIds: string[];
  readableTournamentCount: number;
  eligibleTournamentCount: number;
  requestedTournamentCount: number;
  readableTableCount: number;
  selectedTableCount: number;
  rejectionCategories: Partial<Record<HudClockRejectionCategory, number>>;
};

/** Event delivery (15s) + both rendered assertions (15s) + final health/evidence/cleanup (30s). */
export const HUD_RESERVE_MS = 60_000;

/** Discovery is one joined, authenticated tables+tournament read with at most
 * four pages. Exact engine health then gets at most three 32-table batches of
 * authoritative MTT candidates plus the scoped-health fallback. */
export const HUD_DISCOVERY_PAGE_SIZE = 1_000;
export const HUD_DISCOVERY_MAX_PAGES = 4;
export const HUD_DISCOVERY_CANDIDATE_LIMIT = 96;
export const HUD_EXACT_HEALTH_BATCH_SIZE = 32;

export function isMttFormatContract(value: unknown): boolean {
  return value === 'mtt-v1' || value === 'mtt-v2';
}

/** A level longer than this is refused outright rather than sizing the case
 *  timeout to fit it: a genuinely "long" clock, not a witness. Production
 *  blind schedules run well under this (observed 5-10 minutes); anything
 *  past it is treated the same as a paused or terminal tournament. Chosen so
 *  the worst case (this plus the existing 390s case budget plus the 60s
 *  reserve) still leaves the enclosing 60-minute job its required five
 *  minutes of cleanup margin - see the arithmetic law in
 *  tests/await-engine-gameplay.test.ts. */
export const MTT_HUD_LEVEL_CAP_MS = 15 * 60_000;

/**
 * Qualification only: unknown, paused, terminal, malformed and longer-than-
 * the-certifiable-cap clocks are not witnesses. A level that fits under
 * `levelCapMs` is eligible regardless of how much of the case's own deadline
 * remains - the caller sizes its deadline from `requiredObservationMs`
 * (see `mttCaseTimeoutMs`) instead of this function guessing whether it fits.
 */
export function eligibleHudClock(
  row: Row,
  now: number,
  levelCapMs: number = MTT_HUD_LEVEL_CAP_MS
): HudClock | null {
  if (!isMttFormatContract(row.format_contract)) return null;
  if (row.status !== 'RUNNING' || row.on_break === true || row.accelerated_mtt === true)
    return null;
  if (
    !Number.isSafeInteger(row.current_players) ||
    Number(row.current_players) < 4 ||
    !row.started_at
  )
    return null;
  if (row.addon_period_started_at && Date.parse(String(row.addon_period_ends_at)) > now)
    return null;
  const levelIndex = row.current_level;
  if (typeof levelIndex !== 'number' || !Number.isSafeInteger(levelIndex) || levelIndex < 0)
    return null;
  let levels: unknown = row.blind_structure;
  if (typeof levels === 'string') {
    try {
      levels = JSON.parse(levels);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(levels) || !levels.length) return null;
  // Called only AFTER the mandatory hand/offline/rejoin proof. Both observers
  // remain online from this baseline, so one future named level_up is needed.
  // Refuse an upcoming break; it is not the same event as a blind level.
  const schedule = levels;
  const at = (offset: number) => schedule[Math.min(levelIndex + offset, schedule.length - 1)];
  const level = at(0);
  const next = at(1);
  if (!level || !next || level.isBreak || next.isBreak) return null;
  const durationMs = (entry: Row) => {
    const minutes = Number(entry.durationMinutes ?? entry.duration_minutes);
    return (minutes > 0 ? minutes * 60 : Number(entry.duration)) * 1000;
  };
  const intervalMs = durationMs(level);
  const nextIntervalMs = durationMs(next);
  const startedAt = Date.parse(String(row.level_started_at));
  const remainingMs = startedAt + intervalMs - now;
  // Keep the original 60s reserve: 15s for event delivery, 15s for both
  // rendered assertions and 30s for final health/evidence/cleanup. The outage
  // and peer setup have already consumed the case's ONE fixed deadline.
  const requiredObservationMs = remainingMs + HUD_RESERVE_MS;
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isFinite(nextIntervalMs) ||
    nextIntervalMs <= 32_000 ||
    !Number.isFinite(levelCapMs) ||
    intervalMs > levelCapMs ||
    !Number.isFinite(startedAt) ||
    startedAt > now ||
    remainingMs <= 20_000
  )
    return null;
  if (typeof row.id !== 'string') return null;
  return {
    tournamentId: row.id,
    levelIndex,
    intervalMs,
    remainingMs,
    nextIntervalMs,
    requiredObservationMs,
    observedAt: now,
  };
}

/** Levels beyond the current one that must all be playable for a table to be SELECTED. */
export const MTT_SELECTION_LOOKAHEAD_LEVELS = 3;

/**
 * Selection-time qualification, before the browser exists.
 *
 * `eligibleHudClock` is read AFTER the mandatory hand/offline/rejoin proof,
 * minutes after the table was chosen, and it refuses a tournament that is in
 * its add-on period, on a break, accelerated, or about to break. Choosing the
 * table by seat count alone (the 383-player field, still in its add-on hour)
 * therefore chose a table that could not possibly satisfy that later read:
 * measured 2026-09-29, runs 36525050502 and 36526016402 both refused
 * "no eligible natural HUD clock" for tournament 4dddfe78 with the add-on
 * period open until 06:07Z.
 *
 * This applies the SAME predicate at selection, plus a look-ahead: a level can
 * roll over while the setup runs (one more level per level length), and the
 * later read then judges the new level's successor, so the next
 * MTT_SELECTION_LOOKAHEAD_LEVELS entries must be playable levels no longer
 * than the cap. It never invents a clock: an unreadable or ineligible row is
 * refused, and the caller still refuses loudly when nothing qualifies.
 */
export function selectableHudClock(
  row: Row,
  now: number,
  levelCapMs: number = MTT_HUD_LEVEL_CAP_MS
): HudClock | null {
  const clock = eligibleHudClock(row, now, levelCapMs);
  if (!clock) return null;
  let levels: unknown = row.blind_structure;
  if (typeof levels === 'string') {
    try {
      levels = JSON.parse(levels);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(levels)) return null;
  for (let ahead = 1; ahead <= MTT_SELECTION_LOOKAHEAD_LEVELS; ahead++) {
    const index = clock.levelIndex + ahead;
    // The engine holds the last level once the schedule is exhausted.
    if (index >= levels.length) break;
    const entry = levels[index] as Row | undefined;
    if (!entry || entry.isBreak) return null;
    const minutes = Number(entry.durationMinutes ?? entry.duration_minutes);
    const durationMs = (minutes > 0 ? minutes * 60 : Number(entry.duration)) * 1000;
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > levelCapMs) return null;
  }
  return clock;
}

function addCategory(
  categories: Partial<Record<HudClockRejectionCategory, number>>,
  category: HudClockRejectionCategory,
  count = 1
): void {
  categories[category] = (categories[category] ?? 0) + count;
}

/** Explain a refusal without changing either clock predicate. */
export function hudClockRejectionCategory(
  row: Row,
  now: number,
  levelCapMs: number,
  selectedClock: HudClock | null
): HudClockRejectionCategory {
  if (selectedClock) return 'eligible';
  if (row.status !== 'RUNNING') return 'not_running';
  if (!isMttFormatContract(row.format_contract)) return 'not_mtt_format';
  if (row.on_break === true) return 'on_break';
  if (row.accelerated_mtt === true) return 'accelerated';
  if (!Number.isSafeInteger(row.current_players) || Number(row.current_players) < 4)
    return 'insufficient_players';
  if (!row.started_at) return 'not_started';
  if (row.addon_period_started_at && Date.parse(String(row.addon_period_ends_at)) > now)
    return 'addon_period_open';
  return eligibleHudClock(row, now, levelCapMs)
    ? 'selection_lookahead_ineligible'
    : 'clock_or_schedule_ineligible';
}

/** Apply the unchanged selection predicate to every readable tournament row. */
export function qualifyHudTournamentRows(
  rows: readonly Row[],
  now: number,
  levelCapMs: number = MTT_HUD_LEVEL_CAP_MS
): HudTournamentQualification[] {
  return rows.map((row) => {
    const clock = selectableHudClock(row, now, levelCapMs);
    return {
      tournamentId: typeof row.id === 'string' ? row.id : null,
      clock,
      category: hudClockRejectionCategory(row, now, levelCapMs, clock),
    };
  });
}

/**
 * Pick the first readable running table from every eligible tournament before
 * any second table, then repeat by depth. Occupancy orders tables only INSIDE
 * a tournament, so one large field cannot monopolize the exact-health batch,
 * while a stale top row still leaves its field's healthy backup reachable.
 */
export function selectHudTableCandidatesRoundRobin(
  qualifications: readonly HudTournamentQualification[],
  tableRows: readonly Row[],
  limit = 32
): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const byTournament = new Map<string, Row[]>();
  for (const row of tableRows) {
    if (
      typeof row.id !== 'string' ||
      typeof row.tournament_id !== 'string' ||
      String(row.status).toLowerCase() !== 'running'
    )
      continue;
    const rows = byTournament.get(row.tournament_id) ?? [];
    rows.push(row);
    byTournament.set(row.tournament_id, rows);
  }
  for (const rows of byTournament.values())
    rows.sort(
      (a, b) =>
        Number(b.current_players ?? 0) - Number(a.current_players ?? 0) ||
        String(a.id).localeCompare(String(b.id))
    );
  const eligible = qualifications
    .filter(
      (
        qualification
      ): qualification is HudTournamentQualification & {
        tournamentId: string;
        clock: HudClock;
      } => Boolean(qualification.tournamentId && qualification.clock)
    )
    .sort(
      (a, b) =>
        a.clock.requiredObservationMs - b.clock.requiredObservationMs ||
        a.tournamentId.localeCompare(b.tournamentId)
    );
  const selected: string[] = [];
  for (let depth = 0; selected.length < limit; depth += 1) {
    let foundAtDepth = false;
    for (const qualification of eligible) {
      const row = byTournament.get(qualification.tournamentId)?.[depth];
      if (!row) continue;
      foundAtDepth = true;
      selected.push(String(row.id));
      if (selected.length === limit) break;
    }
    if (!foundAtDepth) break;
  }
  return selected;
}

/** Preserve eligibility-first ordering and keep the public occupancy sample
 * only as a fallback after every discovered candidate. */
export function mergeHudCandidateTableIds(
  discovered: readonly string[],
  scoped: readonly string[],
  limit = HUD_DISCOVERY_CANDIDATE_LIMIT + HUD_EXACT_HEALTH_BATCH_SIZE
): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  return [...new Set([...discovered, ...scoped])].slice(0, limit);
}

export function hudCandidateTableIdBatches(
  tableIds: readonly string[],
  batchSize = HUD_EXACT_HEALTH_BATCH_SIZE
): string[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 32) return [];
  const batches: string[][] = [];
  for (let offset = 0; offset < tableIds.length; offset += batchSize)
    batches.push(tableIds.slice(offset, offset + batchSize));
  return batches;
}

/** Read exact-health batches until one contains a usable candidate. A stale
 * first table therefore cannot hide a live backup from the same MTT. */
export async function scanHudCandidateBatches<T>(options: {
  batches: readonly string[][];
  read: (tableIds: string[]) => Promise<T>;
  usable: (result: T) => boolean;
}): Promise<{ results: T[]; requestedTableIds: string[] }> {
  const results: T[] = [];
  const requestedTableIds: string[] = [];
  for (const batch of options.batches) {
    if (!batch.length) continue;
    requestedTableIds.push(...batch);
    const result = await options.read(batch);
    results.push(result);
    if (options.usable(result)) break;
  }
  return { results, requestedTableIds };
}

/** Only a clean zero-result poll may be classified as an absent subject. */
export class OperationalPollFailure {
  private hasLatest = false;
  private latest: unknown;
  private inFlight = 0;

  async attempt<T>(operation: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      const result = await operation();
      this.hasLatest = false;
      this.latest = undefined;
      return result;
    } catch (error) {
      this.hasLatest = true;
      this.latest = error;
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  rethrowIfPresent(): void {
    if (this.hasLatest) throw this.latest;
    if (this.inFlight > 0)
      throw new Error(
        'The production readiness poll expired while an authenticated health read was still in flight'
      );
  }
}

/**
 * The case's ONE deadline, sized from a real clock instead of guessed. A
 * qualified level is never a matter of luck against a fixed budget: whatever
 * this level's own reserve requires (`requiredObservationMs`, already capped
 * by `eligibleHudClock` refusing anything longer than `MTT_HUD_LEVEL_CAP_MS`)
 * is added to the time the case has already spent, on top of - never less
 * than - the deadline already in force. This can only grow a case's timeout,
 * never shrink one.
 */
export function mttCaseTimeoutMs(
  elapsedMs: number,
  clock: HudClock,
  currentTimeoutMs: number
): number {
  return Math.max(currentTimeoutMs, elapsedMs + clock.requiredObservationMs);
}

/** Clock reads and rendered setup never restart the case or event budget. */
export function hudEventObservationMs(clock: HudClock, deadline: number, now = Date.now()): number {
  const eventDeadline = clock.observedAt + clock.remainingMs + 15_000;
  const budget = Math.min(eventDeadline - now, remainingObservationMs(deadline, now) - 45_000);
  if (!Number.isFinite(budget) || budget <= 0)
    throw new Error('The recovered HUD has no reserved time for its natural level event');
  return budget;
}

/** A separate LOCAL session of the existing reserved fixture, never a service/owner read. */
export async function createHudClockReader() {
  const email = process.env.SP_EMAIL || '';
  if (!email.startsWith('ca-customization-cert-postdeploy-') || !email.endsWith('@example.invalid'))
    throw new Error('HUD witness requires the existing reserved postdeploy account');
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !process.env.SP_PASS) throw new Error('HUD witness auth is not configured');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const requestTimeout = AbortSignal.timeout(15_000);
        const signal = init?.signal
          ? AbortSignal.any([init.signal, requestTimeout])
          : requestTimeout;
        return fetch(input, { ...init, signal });
      },
    },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: process.env.SP_PASS,
  });
  if (error || data.user?.email !== email) {
    if (data.session) await client.auth.signOut({ scope: 'local' });
    throw new Error('HUD reserved account authentication failed');
  }
  const qualifications: Array<{
    tableId: string;
    clock: HudClock | null;
    row: Row | null;
    levelCapMs: number;
    category: HudClockRejectionCategory;
  }> = [];
  const qualificationBatches: HudQualificationBatchEvidence[] = [];
  const discoveries: HudDiscoveryEvidence[] = [];
  const tournamentClockColumns =
    'id,format_contract,status,current_players,current_level,blind_structure,started_at,level_started_at,on_break,accelerated_mtt,addon_period_started_at,addon_period_ends_at';
  return {
    qualifications,
    qualificationBatches,
    discoveries,
    refusalEvidence() {
      return {
        latestDiscovery: discoveries.at(-1) ?? null,
        recentExactReads: qualificationBatches.slice(-8),
        latestQualifications: qualifications.slice(-32).map((qualification) => ({
          tableId: qualification.tableId,
          tournamentId: typeof qualification.row?.id === 'string' ? qualification.row.id : null,
          clock: qualification.clock,
          levelCapMs: qualification.levelCapMs,
          category: qualification.category,
        })),
      };
    },
    /**
     * Read running tables and their authoritative MTT contracts together, then
     * apply the clock predicate and return fair, bounded candidates. One joined
     * query removes the previous per-32-tournament N+1 path; the fixed deadline
     * and four-page ceiling keep RLS/PostgREST work inside the case budget.
     */
    async discoverSelectableTableIds(
      fixtureClubIds: string[],
      levelCapMs: number = MTT_HUD_LEVEL_CAP_MS,
      limit = HUD_DISCOVERY_CANDIDATE_LIMIT,
      deadline = Date.now() + 30_000
    ): Promise<string[]> {
      const clubIds = [...new Set(fixtureClubIds.map((id) => id.toLowerCase()))];
      if (
        clubIds.length === 0 ||
        clubIds.length > 2 ||
        clubIds.some(
          (id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
        ) ||
        !Number.isSafeInteger(limit) ||
        limit <= 0 ||
        limit > HUD_DISCOVERY_CANDIDATE_LIMIT ||
        !Number.isFinite(deadline) ||
        deadline <= Date.now()
      )
        throw new Error('HUD fixture discovery scope is invalid');
      const scope = clubIds.join(',');
      const tableRows: Row[] = [];
      let tableScanTruncated = false;
      let lastTableId: string | null = null;
      for (let page = 0; page < HUD_DISCOVERY_MAX_PAGES; page += 1) {
        const timeoutMs = Math.max(
          1,
          Math.min(15_000, Math.floor(remainingObservationMs(deadline)))
        );
        let query = client
          .from('tables')
          .select(
            `id,tournament_id,status,current_players,tournament:tournaments!tables_tournament_id_fkey!inner(${tournamentClockColumns},club_id,union_id)`
          )
          .eq('status', 'running')
          .eq('tournament.status', 'RUNNING')
          .in('tournament.format_contract', ['mtt-v1', 'mtt-v2'])
          .or(`club_id.in.(${scope}),union_id.in.(${scope})`, {
            referencedTable: 'tournament',
          })
          .order('id', { ascending: true })
          .limit(HUD_DISCOVERY_PAGE_SIZE);
        if (lastTableId) query = query.gt('id', lastTableId);
        const tables = await query.abortSignal(AbortSignal.timeout(timeoutMs));
        if (tables.error) throw tables.error;
        const pageRows = tables.data || [];
        tableRows.push(...pageRows);
        if (pageRows.length < HUD_DISCOVERY_PAGE_SIZE) break;
        const pageCursor = pageRows.at(-1)?.id;
        if (typeof pageCursor !== 'string' || pageCursor.length === 0)
          throw new Error('HUD fixture discovery page ended without an immutable table cursor');
        lastTableId = pageCursor;
        if (page === HUD_DISCOVERY_MAX_PAGES - 1) tableScanTruncated = true;
      }
      const requestedTournamentIds = new Set<string>();
      const tournamentById = new Map<string, Row>();
      let unreadableTournamentCount = 0;
      for (const table of tableRows) {
        if (typeof table.tournament_id === 'string')
          requestedTournamentIds.add(table.tournament_id);
        const embedded = Array.isArray(table.tournament)
          ? table.tournament.length === 1
            ? table.tournament[0]
            : null
          : table.tournament;
        if (
          !embedded ||
          typeof embedded !== 'object' ||
          Array.isArray(embedded) ||
          typeof (embedded as Row).id !== 'string' ||
          (embedded as Row).id !== table.tournament_id
        ) {
          unreadableTournamentCount += 1;
          continue;
        }
        tournamentById.set((embedded as Row).id as string, embedded as Row);
      }
      const tournamentRows = [...tournamentById.values()];
      const now = Date.now();
      const tournamentQualifications = qualifyHudTournamentRows(tournamentRows, now, levelCapMs);
      const rejectionCategories: Partial<Record<HudClockRejectionCategory, number>> = {};
      for (const qualification of tournamentQualifications)
        addCategory(rejectionCategories, qualification.category);
      if (unreadableTournamentCount)
        addCategory(rejectionCategories, 'unreadable_tournament', unreadableTournamentCount);
      const eligible = tournamentQualifications
        .filter(
          (
            qualification
          ): qualification is HudTournamentQualification & {
            tournamentId: string;
            clock: HudClock;
          } => Boolean(qualification.tournamentId && qualification.clock)
        )
        .sort(
          (a, b) =>
            a.clock.requiredObservationMs - b.clock.requiredObservationMs ||
            a.tournamentId.localeCompare(b.tournamentId)
        );
      const selected = selectHudTableCandidatesRoundRobin(eligible, tableRows, limit);
      if (tableScanTruncated) addCategory(rejectionCategories, 'table_scan_truncated');
      discoveries.push({
        fixtureClubIds: clubIds,
        readableTournamentCount: tournamentRows.length,
        eligibleTournamentCount: eligible.length,
        requestedTournamentCount: requestedTournamentIds.size,
        readableTableCount: tableRows.length,
        selectedTableCount: selected.length,
        rejectionCategories,
      });
      if (tableScanTruncated && selected.length === 0)
        throw new Error(
          'HUD fixture discovery reached a bounded read limit before finding a selectable subject'
        );
      return selected;
    },
    async clocks(
      tableIds: string[],
      levelCapMs: number = MTT_HUD_LEVEL_CAP_MS,
      qualify: (row: Row, now: number, levelCapMs: number) => HudClock | null = eligibleHudClock
    ): Promise<Map<string, HudClock>> {
      const requestedTableIds = [...new Set(tableIds)];
      const tables = await client
        .from('tables')
        .select('id,tournament_id')
        .in('id', requestedTableIds);
      if (tables.error) throw tables.error;
      const ids = [...new Set((tables.data || []).map((row) => row.tournament_id).filter(Boolean))];
      const tournaments = ids.length
        ? await client.from('tournaments').select(tournamentClockColumns).in('id', ids)
        : { data: [] as Row[], error: null };
      if (tournaments.error) throw tournaments.error;
      const now = Date.now();
      const clocks = new Map<string, HudClock>();
      const tableById = new Map((tables.data || []).map((table) => [table.id, table]));
      const tournamentById = new Map(
        (tournaments.data || []).map((tournament) => [tournament.id, tournament])
      );
      const batchQualifications: typeof qualifications = [];
      for (const tableId of requestedTableIds) {
        const table = tableById.get(tableId);
        if (!table) {
          batchQualifications.push({
            tableId,
            clock: null,
            row: null,
            levelCapMs,
            category: 'unreadable_table',
          });
          continue;
        }
        const row = tournamentById.get(table.tournament_id);
        const clock = row ? qualify(row, now, levelCapMs) : null;
        const category = row
          ? hudClockRejectionCategory(row, now, levelCapMs, clock)
          : 'unreadable_tournament';
        batchQualifications.push({ tableId, clock, row: row || null, levelCapMs, category });
        if (clock) clocks.set(tableId, clock);
      }
      qualifications.push(...batchQualifications);
      const rejectionCategories: Partial<Record<HudClockRejectionCategory, number>> = {};
      for (const qualification of batchQualifications)
        addCategory(rejectionCategories, qualification.category);
      qualificationBatches.push({
        requestedTableCount: requestedTableIds.length,
        readableTableCount: (tables.data || []).length,
        requestedTournamentCount: ids.length,
        readableTournamentCount: (tournaments.data || []).length,
        eligibleTournamentCount: new Set([...clocks.values()].map((clock) => clock.tournamentId))
          .size,
        eligibleTableCount: clocks.size,
        rejectionCategories,
      });
      return clocks;
    },
    /**
     * Read-only facts about the boards under certification, from tables that
     * public RLS already exposes to this reserved account: the tournament
     * row, the table row and the seated stacks. A board with no readable
     * tournament comes back with null fields (classified `unknown`), never
     * with invented ones.
     */
    async boardFacts(tableIds: string[]): Promise<Map<string, TournamentBoardFacts>> {
      const facts = new Map<string, TournamentBoardFacts>();
      if (!tableIds.length) return facts;
      const tables = await client
        .from('tables')
        .select('id,tournament_id,status')
        .in('id', tableIds);
      if (tables.error) throw tables.error;
      const tournamentIds = [
        ...new Set((tables.data || []).map((row) => row.tournament_id).filter(Boolean)),
      ];
      const tournaments = tournamentIds.length
        ? await client
            .from('tournaments')
            .select('id,status,current_players,ended_at,blind_level_state')
            .in('id', tournamentIds)
        : { data: [] as Row[], error: null };
      if (tournaments.error) throw tournaments.error;
      const seats = await client
        .from('table_seats')
        .select('table_id,user_id,stack,left_at')
        .in('table_id', tableIds)
        .is('left_at', null);
      if (seats.error) throw seats.error;
      for (const table of tables.data || []) {
        const tournament = tournaments.data?.find((row) => row.id === table.tournament_id);
        const level = tournament?.blind_level_state as { big_blind?: unknown } | null | undefined;
        const bigBlind = Number(level?.big_blind);
        facts.set(table.id, {
          tableId: table.id,
          tournamentId: (table.tournament_id as string | null) ?? null,
          tournamentStatus: tournament ? String(tournament.status) : null,
          currentPlayers: Number.isSafeInteger(tournament?.current_players)
            ? Number(tournament?.current_players)
            : null,
          tableStatus: table.status ? String(table.status) : null,
          endedAt: tournament?.ended_at ? String(tournament.ended_at) : null,
          bigBlind: Number.isFinite(bigBlind) && bigBlind > 0 ? bigBlind : null,
          seatedUserIds: (seats.data || [])
            .filter((seat) => seat.table_id === table.id)
            .map((seat) => String(seat.user_id)),
          seatStacks: (seats.data || [])
            .filter((seat) => seat.table_id === table.id)
            .map((seat) => Number(seat.stack))
            .filter((stack) => Number.isFinite(stack)),
        });
      }
      return facts;
    },
    async accountClosedBoard(
      start: TournamentBoardFacts,
      end: TournamentBoardFacts
    ): Promise<TournamentBoardFacts> {
      const ids = start.seatedUserIds ?? [];
      if (
        !ids.length ||
        ids.length > 10 ||
        start.tableId !== end.tableId ||
        !start.tournamentId ||
        start.tournamentId !== end.tournamentId ||
        end.tableStatus !== 'closed' ||
        end.seatStacks.length ||
        end.seatedUserIds?.length !== 0 ||
        end.tournamentStatus !== 'RUNNING'
      )
        return end;
      const players = await client
        .from('tournament_players')
        .select('user_id,table_id,status,position,eliminated_at,chip_count')
        .eq('tournament_id', start.tournamentId)
        .in('user_id', ids);
      if (players.error) throw players.error;
      const destinations = [
        ...new Set(
          (players.data ?? []).map((p) => p.table_id).filter((id) => id && id !== start.tableId)
        ),
      ];
      const seats = destinations.length
        ? await client
            .from('table_seats')
            .select('user_id,table_id,stack')
            .in('table_id', destinations)
            .in('user_id', ids)
            .is('left_at', null)
        : { data: [] as Row[], error: null };
      if (seats.error) throw seats.error;
      const tables = destinations.length
        ? await client.from('tables').select('id,tournament_id,status').in('id', destinations)
        : { data: [] as Row[], error: null };
      if (tables.error) throw tables.error;
      const relocatedUserIds: string[] = [];
      const eliminatedUserIds: string[] = [];
      for (const id of ids) {
        const matches = (players.data ?? []).filter((p) => p.user_id === id);
        if (matches.length !== 1) continue;
        const p = matches[0]!;
        if (
          p.status === 'eliminated' &&
          p.chip_count !== null &&
          Number(p.chip_count) === 0 &&
          Number(p.position) > 0 &&
          Number.isFinite(Date.parse(String(p.eliminated_at ?? '')))
        )
          eliminatedUserIds.push(id);
        else if (
          p.status === 'playing' &&
          p.table_id !== start.tableId &&
          (tables.data ?? []).some(
            (t) =>
              t.id === p.table_id &&
              t.tournament_id === start.tournamentId &&
              t.status === 'running'
          ) &&
          (seats.data ?? []).filter(
            (s) => s.user_id === id && s.table_id === p.table_id && Number(s.stack) > 0
          ).length === 1
        )
          relocatedUserIds.push(id);
      }
      return { ...end, relocatedUserIds, eliminatedUserIds };
    },
    async close() {
      const result = await client.auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
    },
  };
}

/** Retain only named level facts; never auth frames, tokens, or arbitrary payloads. */
export function receivedHudLevel(raw: string, at: number): HudLevel | null {
  try {
    const frame = JSON.parse(raw);
    const topic = Array.isArray(frame) ? frame[2] : frame.topic;
    const event = Array.isArray(frame) ? frame[3] : frame.event;
    const body = Array.isArray(frame) ? frame[4] : frame.payload;
    const match = /^realtime:t-break-([0-9a-f-]{36})$/i.exec(String(topic));
    if (
      !match ||
      event !== 'broadcast' ||
      body?.event !== 'tournament_event' ||
      body?.payload?.type !== 'level_up'
    )
      return null;
    const levelIndex = body.payload.payload?.level;
    if (!Number.isSafeInteger(levelIndex) || levelIndex < 0) return null;
    return { tournamentId: match[1], levelIndex, at };
  } catch {
    return null;
  }
}

export function observeHudLevels(page: Page): HudLevel[] {
  const levels: HudLevel[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const level = receivedHudLevel(String(payload), Date.now());
      if (level) levels.push(level);
    })
  );
  return levels;
}

export function sharedNaturalLevel(
  a: HudLevel[],
  b: HudLevel[],
  id: string,
  baseline: number,
  since: number
) {
  return a.find(
    (first) =>
      first.tournamentId === id &&
      first.levelIndex > baseline &&
      first.at > since &&
      b.some(
        (second) =>
          second.tournamentId === id && second.levelIndex === first.levelIndex && second.at > since
      )
  );
}

export function waitForSharedNaturalLevel(
  read: () => HudLevel | undefined,
  timeoutMs: number,
  signal: AbortSignal
): Promise<HudLevel> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (level?: HudLevel, error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (level) resolve(level);
      else reject(error);
    };
    const abort = () => finish(undefined, new Error('HUD observation retired'));
    const inspect = () => {
      if (signal.aborted) return abort();
      if (Date.now() >= deadline)
        return finish(
          undefined,
          new Error('Qualified MTT produced no shared natural level transition')
        );
      const level = read();
      if (level) return finish(level);
      timer = setTimeout(inspect, 50);
    };
    signal.addEventListener('abort', abort, { once: true });
    inspect();
  });
}
