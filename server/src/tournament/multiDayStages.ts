/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MULTI-DAY TOURNAMENTS: THE ENGINE'S READS AND ITS SEVEN DOORS (R5 ENGINE)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Design: docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md,
 * sections 3, 5, 6 and 11. The database half is
 * supabase/migrations/20260924043239_multi_day_stage_transitions_are_lease_fenced.sql;
 * every call here is one of its RPCs, with its exact argument names.
 *
 * INERT UNLESS BOTH ARE TRUE: a sealed stage plan exists for the tournament,
 * AND `fn_capability_available('tournament.multi_day.single_flight')` answers
 * true. A missing table or function (42P01, 42883, PGRST202, PGRST205) reads
 * as "no multi-day", so this engine is safe to run before the migrations are
 * installed. Any OTHER failure is UNKNOWN and is reported as such - it is
 * never folded into "no plan" (CLAUDE.md 10.86 rule 2).
 *
 * Only a format the seal accepts is ever asked: an MTT that is not a Spin or
 * a Sit and Go (`fn_seal_tournament_stage_plan` refuses every other format
 * with `format_not_multi_day`). A Spin, a Sit and Go or a heads-up duel never
 * issues a single extra request because of this file.
 *
 * Horses and humans go through exactly the same code here (CLAUDE.md 10.5):
 * nothing below reads `is_horse` or a horse id. A bag is per seat, an
 * entitlement is per bag row, and the Day 2 seat draw shuffles every
 * entitlement together.
 */
import { supabase } from '../services/supabase.js';
import { maxSeatsFor as maxSeatsTheDeckAllows } from '../engine/VariantRules.js';

export const MULTI_DAY_CAPABILITY = 'tournament.multi_day.single_flight';

/** The codes a database without the multi-day migrations answers with. */
const MISSING_SCHEMA_CODES = new Set(['42P01', '42883', 'PGRST202', 'PGRST205']);

export function isMissingMultiDaySchema(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && MISSING_SCHEMA_CODES.has(code);
}

/** The exact format rule the seal enforces. */
export function mayCarryMultiDayPlan(row: unknown): boolean {
  const t = row as { tournament_type?: unknown; variant?: unknown } | null;
  if (!t) return false;
  const type = String(t.tournament_type ?? '').toUpperCase();
  const variant = String(t.variant ?? '').toLowerCase();
  return type === 'MTT' && variant !== 'spin' && variant !== 'sng';
}

export interface MultiDayStageRow {
  stageNo: number;
  /** NULL only on the final stage. */
  endAfterLevel: number | null;
  scheduledStartUtc: string | null;
  scheduleGeneration: number;
  state: string;
}

export type MultiDayPlanRead =
  | { kind: 'none' }
  | { kind: 'unknown'; error: unknown }
  | { kind: 'active'; timeZone: string; stages: MultiDayStageRow[] };

const STAGE_STATES = new Set([
  'planned',
  'running',
  'day_ending',
  'bagged',
  'scheduled',
  'resuming',
  'closed',
]);

function readStageRow(raw: unknown): MultiDayStageRow | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const stageNo = r.stage_no;
  const end = r.end_after_level;
  const generation = Number(r.schedule_generation);
  const start = r.scheduled_start_utc;
  if (!Number.isSafeInteger(stageNo) || (stageNo as number) < 1) return null;
  if (end !== null && (!Number.isSafeInteger(end) || (end as number) < 1)) return null;
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  if (start !== null && (typeof start !== 'string' || !Number.isFinite(Date.parse(start))))
    return null;
  if (typeof r.state !== 'string' || !STAGE_STATES.has(r.state)) return null;
  return {
    stageNo: stageNo as number,
    endAfterLevel: end as number | null,
    scheduledStartUtc: start as string | null,
    scheduleGeneration: generation,
    state: r.state,
  };
}

/**
 * Is this tournament a multi-day event the engine must drive? One plan read
 * for an eligible MTT; the capability and the stages only when a plan exists.
 */
export async function readMultiDayStagePlan(tournamentId: string): Promise<MultiDayPlanRead> {
  try {
    const plan = await supabase
      .from('tournament_stage_plans')
      .select('tournament_id, time_zone, stage_count')
      .eq('tournament_id', tournamentId)
      .maybeSingle();
    if (plan.error) {
      return isMissingMultiDaySchema(plan.error)
        ? { kind: 'none' }
        : { kind: 'unknown', error: plan.error };
    }
    if (!plan.data) return { kind: 'none' };
    const planRow = plan.data as {
      tournament_id?: unknown;
      time_zone?: unknown;
      stage_count?: unknown;
    };
    if (planRow.tournament_id !== tournamentId || typeof planRow.time_zone !== 'string') {
      return { kind: 'unknown', error: new Error('stage plan row did not identify this event') };
    }

    const capability = await supabase.rpc('fn_capability_available', {
      p_capability_id: MULTI_DAY_CAPABILITY,
    });
    if (capability.error) {
      return isMissingMultiDaySchema(capability.error)
        ? { kind: 'none' }
        : { kind: 'unknown', error: capability.error };
    }
    if (capability.data === false) return { kind: 'none' };
    if (capability.data !== true) {
      return { kind: 'unknown', error: new Error('capability answer was not a boolean') };
    }

    const stages = await supabase
      .from('tournament_stages')
      .select('stage_no, end_after_level, scheduled_start_utc, schedule_generation, state')
      .eq('tournament_id', tournamentId)
      .order('stage_no', { ascending: true });
    if (stages.error) {
      return isMissingMultiDaySchema(stages.error)
        ? { kind: 'none' }
        : { kind: 'unknown', error: stages.error };
    }
    if (!Array.isArray(stages.data)) {
      return { kind: 'unknown', error: new Error('stage rows were unreadable') };
    }
    const rows = stages.data.map(readStageRow);
    if (
      rows.some((row) => row === null) ||
      rows.length !== Number(planRow.stage_count) ||
      rows.some((row, index) => row!.stageNo !== index + 1)
    ) {
      return { kind: 'unknown', error: new Error('stage rows disagree with the sealed plan') };
    }
    return { kind: 'active', timeZone: planRow.time_zone, stages: rows as MultiDayStageRow[] };
  } catch (error) {
    return { kind: 'unknown', error };
  }
}

/**
 * The stage a RUNNING event is playing. Stage 1 stays `planned` for the whole
 * of Day 1 (nothing writes it `running`; fn_begin_stage_end accepts either),
 * later stages are `running` once their resume completes, and the one the
 * day-end intent was recorded for is `day_ending`.
 */
export function runningStage(stages: readonly MultiDayStageRow[]): MultiDayStageRow | null {
  const ending = stages.find((stage) => stage.state === 'day_ending');
  if (ending) return ending;
  const running = stages.find((stage) => stage.state === 'running');
  if (running) return running;
  const first = stages[0];
  return first && first.stageNo === 1 && first.state === 'planned' ? first : null;
}

/**
 * The stage whose day ends when `endingLevel` expires, or null. Only a stage
 * with a next stage ends a day; the final stage ends with the tournament.
 */
export function stageEndingAtLevel(
  stages: readonly MultiDayStageRow[],
  endingLevel: number
): MultiDayStageRow | null {
  const stage = runningStage(stages);
  if (!stage || stage.state === 'day_ending') return null;
  if (stage.endAfterLevel === null || stage.endAfterLevel !== endingLevel) return null;
  return stages.some((next) => next.stageNo === stage.stageNo + 1) ? stage : null;
}

/** The stage a BAGGED event resumes into: scheduled, or already resuming. */
export function resumeTargetStage(stages: readonly MultiDayStageRow[]): MultiDayStageRow | null {
  const target = stages.find((stage) => stage.state === 'resuming' || stage.state === 'scheduled');
  if (!target) return null;
  const previous = stages.find((stage) => stage.stageNo === target.stageNo - 1);
  return previous && previous.state === 'bagged' ? target : null;
}

// ─────────────────────────────────────────────────────────────────────────
// THE DOORS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Four outcomes, each with its own name (CLAUDE.md 10.86 rule 1):
 *   ok       - the RPC answered ok:true (a replay included);
 *   refused  - the RPC answered ok:false with a reason; nothing was written;
 *   failed   - the database raised (it carries a SQLSTATE): rolled back, and
 *              the same call will raise again until its cause is fixed;
 *   unknown  - no readable answer (transport failure, malformed body): the
 *              call may have committed. Only the durable record can say.
 */
export type StageRpcOutcome =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'refused'; reason: string; data: Record<string, unknown> }
  | { kind: 'failed'; error: unknown }
  | { kind: 'unknown'; error: unknown };

async function callStageRpc(name: string, args: Record<string, unknown>): Promise<StageRpcOutcome> {
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) {
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !code.startsWith('PGRST')
        ? { kind: 'failed', error }
        : { kind: 'unknown', error };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { kind: 'unknown', error: new Error(`${name} returned no receipt object`) };
    }
    const body = data as Record<string, unknown>;
    if (body.ok === true) return { kind: 'ok', data: body };
    if (body.ok === false && typeof body.reason === 'string') {
      return { kind: 'refused', reason: body.reason, data: body };
    }
    return { kind: 'unknown', error: new Error(`${name} returned an unreadable receipt`) };
  } catch (error) {
    return { kind: 'unknown', error };
  }
}

export function beginStageEnd(
  tournamentId: string,
  leaseGeneration: string,
  stageNo: number,
  endedLevel: number
): Promise<StageRpcOutcome> {
  return callStageRpc('fn_begin_stage_end', {
    p_tournament_id: tournamentId,
    p_lease_generation: leaseGeneration,
    p_stage_no: stageNo,
    p_ended_level: endedLevel,
  });
}

export interface TableWatermark {
  table_id: string;
  last_hand_number: number | null;
}

export function bagTournamentStage(
  tournamentId: string,
  leaseGeneration: string,
  stageNo: number,
  watermarks: TableWatermark[]
): Promise<StageRpcOutcome> {
  return callStageRpc('fn_bag_tournament_stage', {
    p_tournament_id: tournamentId,
    p_lease_generation: leaseGeneration,
    p_stage_no: stageNo,
    p_watermarks: watermarks,
  });
}

export interface StageFirstLevel {
  index: number;
  small_blind: number;
  big_blind: number;
  ante: number;
  duration_ms: number;
}

export function beginStageResume(
  tournamentId: string,
  stageNo: number,
  resumeId: string,
  scheduleGeneration: number,
  leaseGeneration: string,
  firstLevel: StageFirstLevel
): Promise<StageRpcOutcome> {
  return callStageRpc('fn_begin_stage_resume', {
    p_tournament_id: tournamentId,
    p_stage_no: stageNo,
    p_resume_id: resumeId,
    p_schedule_generation: scheduleGeneration,
    p_lease_generation: leaseGeneration,
    p_first_level: firstLevel,
  });
}

export function seatStageEntitlement(
  tournamentId: string,
  resumeId: string,
  leaseGeneration: string,
  entitlementId: string,
  tableId: string,
  seatNumber: number
): Promise<StageRpcOutcome> {
  return callStageRpc('fn_seat_stage_entitlement', {
    p_tournament_id: tournamentId,
    p_resume_id: resumeId,
    p_lease_generation: leaseGeneration,
    p_entitlement_id: entitlementId,
    p_table_id: tableId,
    p_seat_number: seatNumber,
  });
}

export function completeStageResume(
  tournamentId: string,
  resumeId: string,
  leaseGeneration: string
): Promise<StageRpcOutcome> {
  return callStageRpc('fn_complete_stage_resume', {
    p_tournament_id: tournamentId,
    p_resume_id: resumeId,
    p_lease_generation: leaseGeneration,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// THE BAG'S WATERMARK READ
// ─────────────────────────────────────────────────────────────────────────

/** The same "open table" rule fn_bag_tournament_stage locks. */
const CLOSED_TABLE_STATUSES = new Set(['closed', 'deleted', 'completed', 'cancelled', 'finished']);

/**
 * Every open table of the event and its last accepted hand, or null when any
 * part of that could not be read. A partial watermark is not a watermark.
 */
export async function readTableWatermarks(tournamentId: string): Promise<TableWatermark[] | null> {
  try {
    const { data: tables, error } = await supabase
      .from('tables')
      .select('id, status, is_deleted')
      .eq('tournament_id', tournamentId);
    if (error || !Array.isArray(tables)) return null;
    const open = tables.filter(
      (table: { id?: unknown; status?: unknown; is_deleted?: unknown }) =>
        typeof table.id === 'string' &&
        table.is_deleted !== true &&
        !CLOSED_TABLE_STATUSES.has(String(table.status ?? '').toLowerCase())
    ) as Array<{ id: string }>;
    const watermarks: TableWatermark[] = [];
    for (const table of open) {
      const { data: last, error: lastError } = await supabase
        .from('hand_atomic_commits')
        .select('hand_number')
        .eq('table_id', table.id)
        .order('hand_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastError) return null;
      const handNumber = last ? Number((last as { hand_number?: unknown }).hand_number) : null;
      if (handNumber !== null && !Number.isSafeInteger(handNumber)) return null;
      watermarks.push({ table_id: table.id, last_hand_number: handNumber });
    }
    return watermarks;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// THE RESUME'S READS AND ITS SEAT DRAW
// ─────────────────────────────────────────────────────────────────────────

export interface StageEntitlementRow {
  id: string;
  userId: string;
  stack: number;
  state: 'active' | 'consumed';
  consumedTableId: string | null;
  consumedSeatNumber: number | null;
}

/** Every entitlement targeting the stage, or null when unreadable. */
export async function readStageEntitlements(
  tournamentId: string,
  stageNo: number
): Promise<StageEntitlementRow[] | null> {
  try {
    const { data, error } = await supabase
      .from('tournament_qualification_entitlements')
      .select('id, user_id, stack, state, consumed_table_id, consumed_seat_number')
      .eq('tournament_id', tournamentId)
      .eq('target_stage_no', stageNo)
      .order('id', { ascending: true });
    if (error || !Array.isArray(data)) return null;
    const rows: StageEntitlementRow[] = [];
    for (const raw of data as Array<Record<string, unknown>>) {
      const stack = Number(raw.stack);
      if (
        typeof raw.id !== 'string' ||
        typeof raw.user_id !== 'string' ||
        !Number.isSafeInteger(stack) ||
        stack <= 0 ||
        (raw.state !== 'active' && raw.state !== 'consumed')
      )
        return null;
      rows.push({
        id: raw.id,
        userId: raw.user_id,
        stack,
        state: raw.state,
        consumedTableId: typeof raw.consumed_table_id === 'string' ? raw.consumed_table_id : null,
        consumedSeatNumber: Number.isSafeInteger(raw.consumed_seat_number)
          ? (raw.consumed_seat_number as number)
          : null,
      });
    }
    return rows;
  } catch {
    return null;
  }
}

/** The bagged stage's `next_level_index`, the only first level begin accepts. */
export async function readNextLevelIndex(
  tournamentId: string,
  baggedStageNo: number
): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from('tournament_stage_clock_snapshots')
      .select('next_level_index')
      .eq('tournament_id', tournamentId)
      .eq('stage_no', baggedStageNo)
      .maybeSingle();
    if (error || !data) return null;
    const index = (data as { next_level_index?: unknown }).next_level_index;
    return Number.isSafeInteger(index) && (index as number) >= 1 ? (index as number) : null;
  } catch {
    return null;
  }
}

/** Seats per table for a multi-day MTT: table_size clamped 2-10, then the deck. */
export function stageSeatsPerTable(tableSize: unknown, gameType: unknown): number {
  const requested = Math.min(10, Math.max(2, Number(tableSize) || 9));
  return Math.min(requested, maxSeatsTheDeckAllows(String(gameType ?? '').toLowerCase()));
}

export interface StageDrawTable {
  id: string;
  capacity: number;
  occupied: Set<number>;
}

export interface StageSeatAssignment {
  entitlementId: string;
  tableId: string;
  seatNumber: number;
}

/**
 * THE DAY 2 SEAT DRAW. Every entitlement still to be seated - horse or human,
 * there is no difference here - is shuffled together, then each is seated at
 * the least-full table (ties go to the earlier table) in a random free chair.
 * Returns null when the tables cannot hold everybody, which the caller must
 * treat as a refusal to proceed, never as a partial answer.
 *
 * `randomInt(n)` returns an integer in [0, n): secureRandomInt in production,
 * a seeded source in tests.
 */
export function drawStageSeats(
  entitlementIds: readonly string[],
  tables: readonly StageDrawTable[],
  randomInt: (exclusiveMax: number) => number
): StageSeatAssignment[] | null {
  const order = [...entitlementIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const state = tables.map((table) => ({
    id: table.id,
    capacity: table.capacity,
    occupied: new Set(table.occupied),
  }));
  const assignments: StageSeatAssignment[] = [];
  for (const entitlementId of order) {
    let best: (typeof state)[number] | null = null;
    for (const table of state) {
      if (table.occupied.size >= table.capacity) continue;
      if (!best || table.occupied.size < best.occupied.size) best = table;
    }
    if (!best) return null;
    const free: number[] = [];
    for (let chair = 1; chair <= best.capacity; chair++) {
      if (!best.occupied.has(chair)) free.push(chair);
    }
    const seatNumber = free[randomInt(free.length)];
    best.occupied.add(seatNumber);
    assignments.push({ entitlementId, tableId: best.id, seatNumber });
  }
  return assignments;
}
