/** Strict parsers for the two P14.3 private service-role RPCs, kept in ONE
 * place so they align with the installed SQL by editing one file:
 *   fn_horse_commitment_selection_receipt(p_day, p_after_played_at, p_after_hand_id, p_limit)
 *   fn_horse_accepted_source_rows(p_hands)
 * Both are read-only readers. A receipt is a diagnostic observation: it never
 * establishes source coverage, a complete population or any authority. */
import {
  DAILY_LIMITS,
  type DailySelectionCursor,
  type DailySelectionPass,
  type DailySelectionReceipt,
  type DailySelectionRequest,
  type DailySelectionGap,
  type DailyDayState,
} from './contract.js';
import { object, sha, utcDay, utcTime, uuid } from './validation.js';

export const SELECTION_RECEIPT_SOURCE = 'horse_commitment_selection_receipt' as const;
/** Exactly the columns of ACCEPTED_SOURCE_SELECT (horseAcceptedRoster/exporter.ts). */
export const ACCEPTED_SOURCE_COLUMNS = Object.freeze([
  'hand_id',
  'table_id',
  'hand_number',
  'atomic_hand_id',
  'atomic_table_id',
  'atomic_hand_number',
  'big_blind',
  'game_variant',
  'tournament_id',
  'actions_text',
  'players_text',
  'payload_text',
  'payload_digest',
  'core_payload_digest',
  'post_commit_request_digest',
  'stack_result_text',
  'committed_at',
  'post_commit_completed_at',
  'roster_hand_id',
  'roster_status',
  'roster_payload_digest',
  'roster_producer_version',
  'roster_text',
  'read_at',
  'snapshot_id',
] as const);
/** The RPC adds exactly this one column: smarter_private.hand_submissions.lease_generation. */
export const SOURCE_ROW_LEASE_COLUMN = 'lease_generation' as const;
type SourceColumn = (typeof ACCEPTED_SOURCE_COLUMNS)[number];
export type AcceptedSourceRow = Readonly<Record<SourceColumn, string | null>>;
export interface AcceptedSourceRowWithLease {
  row: AcceptedSourceRow;
  leaseGeneration: string | null;
}
export interface AcceptedSourceCoordinate {
  handId: string;
  tableId: string;
}

const LATE_PREFIX = 'late_arrival_after_pass:';
/** The reader's fixed substitute when a gap row's stored reasons cannot be
 * read safely. "Could not tell" is its own outcome, never a guessed kind. */
export const GAP_REASONS_UNAVAILABLE = 'daily_gap_reasons_unavailable' as const;
/** Exactly the gap labels fn_horse_commitment_audit_step writes for a hand
 * whose accepted source is absent: no commit row ('hand_without_commit'), or
 * a commit row whose payload is NULL ('accepted_commitment_facts_missing') or
 * oversized ('accepted_payload_oversized'), the step's missing_source count.
 * A digest mismatch or invalid facts is a source gap, not a missing source. */
const MISSING_SOURCE_REASONS = new Set([
  'hand_without_commit',
  'accepted_commitment_facts_missing',
  'accepted_payload_oversized',
]);
export function classifySelectionGap(reasons: readonly string[]): DailySelectionGap['kind'] {
  if (reasons.includes(GAP_REASONS_UNAVAILABLE)) return 'reasons_unavailable';
  if (
    reasons.some(
      (r) => r.startsWith(LATE_PREFIX) && /^[1-9][0-9]{0,17}$/.test(r.slice(LATE_PREFIX.length))
    )
  )
    return 'late_arrival';
  if (reasons.some((r) => MISSING_SOURCE_REASONS.has(r))) return 'missing_source';
  return 'source_gap';
}

const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1e12;
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const nullableTime = (v: unknown): v is string | null => v === null || utcTime(v);
function reasonList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= 32 &&
    v.every((x) => typeof x === 'string' && x.length > 0 && Buffer.byteLength(x) <= 160)
  );
}
function scanCursor(v: unknown): v is { createdAt: string; handId: string } {
  return (
    object(v) && exactKeys(v, ['createdAt', 'handId']) && utcTime(v.createdAt) && uuid(v.handId)
  );
}
function gapCursor(v: unknown): v is DailySelectionCursor {
  return object(v) && exactKeys(v, ['playedAt', 'handId']) && utcTime(v.playedAt) && uuid(v.handId);
}
const nextDay = (day: string) =>
  new Date(Date.parse(day + 'T00:00:00.000Z') + 86400000).toISOString().slice(0, 10) +
  'T00:00:00.000000Z';
export const selectionCursorKey = (v: DailySelectionCursor) => `${v.playedAt}|${v.handId}`;
export function validateSelectionRequest(v: DailySelectionRequest): void {
  if (
    !v ||
    !utcDay(v.day) ||
    (v.after !== null && (!gapCursor(v.after) || v.after.playedAt.slice(0, 10) !== v.day))
  )
    throw Error('invalid_daily_selection_request');
}
const COUNTERS = [
  'scannedHands',
  'horseHands',
  'flaggedHorseHands',
  'unknownHorseHands',
  'handGaps',
] as const;
function parseDayState(v: unknown, day: string): DailyDayState | null {
  if (v === null) return null;
  const keys = ['pass', 'startedAt', 'lastBatchAt', 'finishedAt', 'cursor', ...COUNTERS];
  if (
    !object(v) ||
    !exactKeys(v, keys) ||
    !count(v.pass) ||
    v.pass < 1 ||
    !utcTime(v.startedAt) ||
    !nullableTime(v.lastBatchAt) ||
    !nullableTime(v.finishedAt) ||
    !(v.cursor === null || scanCursor(v.cursor)) ||
    !COUNTERS.every((k) => count(v[k])) ||
    (v.cursor !== null && (v.cursor as { createdAt: string }).createdAt.slice(0, 10) !== day)
  )
    throw Error('daily_selection_mismatch');
  return Object.freeze({
    pass: v.pass,
    startedAt: v.startedAt,
    lastBatchAt: v.lastBatchAt,
    finishedAt: v.finishedAt,
    cursor: v.cursor
      ? Object.freeze({ ...(v.cursor as { createdAt: string; handId: string }) })
      : null,
    scannedHands: v.scannedHands as number,
    horseHands: v.horseHands as number,
    flaggedHorseHands: v.flaggedHorseHands as number,
    unknownHorseHands: v.unknownHorseHands as number,
    handGaps: v.handGaps as number,
  });
}
const PASS_COUNTERS = [
  ...COUNTERS,
  'handsWithoutCommit',
  'missingSourceHands',
  'lateArrivalHands',
] as const;
function parsePass(v: unknown): DailySelectionPass {
  const keys = [
    'pass',
    'windowStart',
    'windowEnd',
    'cutover',
    'maxScannedCreatedAt',
    ...PASS_COUNTERS,
    'finalCursor',
    'startedAt',
    'finishedAt',
    'sourceCoverage',
    'identityBasis',
  ];
  if (
    !object(v) ||
    !exactKeys(v, keys) ||
    !count(v.pass) ||
    v.pass < 1 ||
    !utcTime(v.windowStart) ||
    !utcTime(v.windowEnd) ||
    !(v.windowStart < v.windowEnd) ||
    !utcTime(v.cutover) ||
    !nullableTime(v.maxScannedCreatedAt) ||
    !PASS_COUNTERS.every((k) => count(v[k])) ||
    !(v.finalCursor === null || scanCursor(v.finalCursor)) ||
    !utcTime(v.startedAt) ||
    !utcTime(v.finishedAt) ||
    v.startedAt > v.finishedAt ||
    v.sourceCoverage !== 'not_established' ||
    v.identityBasis !== 'current_profile_is_horse' ||
    (v.maxScannedCreatedAt !== null &&
      (v.maxScannedCreatedAt < v.windowStart || v.maxScannedCreatedAt >= v.windowEnd)) ||
    // horse_commitment_audit_passes CHECKs, restated: the max scanned clock IS
    // the final cursor's clock, a pass finishes no later than its cutover, and
    // a no-commit hand is one kind of missing-source hand.
    (v.maxScannedCreatedAt ?? null) !==
      ((v.finalCursor as { createdAt?: string } | null)?.createdAt ?? null) ||
    (v.finishedAt as string) > (v.cutover as string) ||
    ((v.scannedHands as number) === 0 && v.maxScannedCreatedAt !== null) ||
    (v.handsWithoutCommit as number) > (v.missingSourceHands as number) ||
    (v.flaggedHorseHands as number) + (v.unknownHorseHands as number) > (v.horseHands as number) ||
    (v.handGaps as number) > (v.scannedHands as number) ||
    (v.lateArrivalHands as number) > (v.scannedHands as number) ||
    (v.handsWithoutCommit as number) > (v.scannedHands as number) ||
    (v.missingSourceHands as number) > (v.scannedHands as number)
  )
    throw Error('daily_selection_pass_invalid');
  return Object.freeze({
    pass: v.pass,
    windowStart: v.windowStart,
    windowEnd: v.windowEnd,
    cutover: v.cutover,
    maxScannedCreatedAt: v.maxScannedCreatedAt,
    scannedHands: v.scannedHands as number,
    horseHands: v.horseHands as number,
    flaggedHorseHands: v.flaggedHorseHands as number,
    unknownHorseHands: v.unknownHorseHands as number,
    handGaps: v.handGaps as number,
    handsWithoutCommit: v.handsWithoutCommit as number,
    missingSourceHands: v.missingSourceHands as number,
    lateArrivalHands: v.lateArrivalHands as number,
    finalCursor: v.finalCursor
      ? Object.freeze({ ...(v.finalCursor as { createdAt: string; handId: string }) })
      : null,
    startedAt: v.startedAt,
    finishedAt: v.finishedAt,
    sourceCoverage: 'not_established',
    identityBasis: 'current_profile_is_horse',
  });
}
/** Detach exactly the bounded receipt before any asynchronous consumer sees it. */
export function parseSelectionReceipt(
  raw: unknown,
  request: DailySelectionRequest
): DailySelectionReceipt {
  validateSelectionRequest(request);
  const serialized = JSON.stringify(raw);
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized) > DAILY_LIMITS.selectionWireBytes
  )
    throw Error('daily_selection_bounds');
  const p: unknown = JSON.parse(serialized);
  const keys = [
    'version',
    'source',
    'day',
    'readAt',
    'limit',
    'after',
    'dayState',
    'passes',
    'gaps',
    'hasMore',
    'next',
    'sourceCoverage',
    'identityBasis',
    'gtoVerified',
    'activationAllowed',
  ];
  if (
    !object(p) ||
    !exactKeys(p, keys) ||
    p.version !== 1 ||
    p.source !== SELECTION_RECEIPT_SOURCE ||
    p.day !== request.day ||
    !utcTime(p.readAt) ||
    p.limit !== DAILY_LIMITS.pageRows ||
    !(p.after === null
      ? request.after === null
      : gapCursor(p.after) &&
        request.after !== null &&
        selectionCursorKey(p.after) === selectionCursorKey(request.after)) ||
    !Array.isArray(p.passes) ||
    p.passes.length > DAILY_LIMITS.selectionPasses ||
    !Array.isArray(p.gaps) ||
    p.gaps.length > DAILY_LIMITS.pageRows ||
    typeof p.hasMore !== 'boolean' ||
    p.sourceCoverage !== 'not_established' ||
    p.identityBasis !== 'current_profile_is_horse' ||
    p.gtoVerified !== false ||
    p.activationAllowed !== false
  )
    throw Error('daily_selection_mismatch');
  const dayState = parseDayState(p.dayState, request.day);
  const passes: DailySelectionPass[] = [];
  for (const x of p.passes) {
    const pass = parsePass(x);
    if (passes.length && pass.pass <= passes.at(-1)!.pass)
      throw Error('daily_selection_pass_order');
    if (
      pass.windowStart !== `${request.day}T00:00:00.000000Z` ||
      pass.windowEnd !== nextDay(request.day)
    )
      throw Error('daily_selection_pass_invalid');
    passes.push(pass);
  }
  // A recorded pass number can never exceed the day row's current pass.
  if (passes.length && (!dayState || passes.at(-1)!.pass > dayState.pass))
    throw Error('daily_selection_pass_invalid');
  let previous = request.after ? selectionCursorKey(request.after) : '';
  const gaps: DailySelectionGap[] = [];
  for (const g of p.gaps) {
    if (
      !object(g) ||
      !exactKeys(g, ['handId', 'tableId', 'playedAt', 'reasons']) ||
      !uuid(g.handId) ||
      !(g.tableId === null || uuid(g.tableId)) ||
      !utcTime(g.playedAt) ||
      g.playedAt.slice(0, 10) !== request.day ||
      !reasonList(g.reasons) ||
      (g.reasons.includes(GAP_REASONS_UNAVAILABLE) && g.reasons.length !== 1)
    )
      throw Error('daily_selection_gap_invalid');
    const key = selectionCursorKey({ playedAt: g.playedAt, handId: g.handId });
    if (key <= previous) throw Error('daily_selection_cursor_order');
    previous = key;
    const reasons = Object.freeze([...g.reasons]);
    gaps.push(
      Object.freeze({
        handId: g.handId,
        tableId: g.tableId as string | null,
        playedAt: g.playedAt,
        reasons,
        kind: classifySelectionGap(reasons),
      })
    );
  }
  const last = gaps.at(-1);
  const next = last ? { playedAt: last.playedAt, handId: last.handId } : null;
  if (
    (p.hasMore && gaps.length !== DAILY_LIMITS.pageRows) ||
    !(p.next === null
      ? next === null
      : gapCursor(p.next) &&
        next !== null &&
        selectionCursorKey(p.next) === selectionCursorKey(next))
  )
    throw Error('daily_selection_next_cursor_invalid');
  return Object.freeze({
    version: 1,
    source: SELECTION_RECEIPT_SOURCE,
    day: request.day,
    readAt: p.readAt,
    after: request.after ? Object.freeze({ ...request.after }) : null,
    dayState,
    passes: Object.freeze(passes),
    gaps: Object.freeze(gaps),
    hasMore: p.hasMore,
    next: next ? Object.freeze(next) : null,
    sourceCoverage: 'not_established',
    identityBasis: 'current_profile_is_horse',
    gtoVerified: false,
    activationAllowed: false,
  });
}

export function validateSourceCoordinates(hands: readonly AcceptedSourceCoordinate[]): void {
  const seen = new Set<string>();
  if (!Array.isArray(hands) || hands.length < 1 || hands.length > DAILY_LIMITS.hands)
    throw Error('invalid_accepted_source_request');
  for (const h of hands) {
    if (!object(h) || !uuid(h.handId) || !uuid(h.tableId) || seen.has(h.handId))
      throw Error('invalid_accepted_source_request');
    seen.add(h.handId);
  }
}
/** timestamptz::text under the reader's SET timezone='UTC':
 * 'YYYY-MM-DD HH24:MI:SS[.f{1,6}]+00' (PostgreSQL drops trailing zeros, and
 * the fraction entirely when it is zero). Distinct from the reader cursors'
 * to_char 'YYYY-MM-DDTHH24:MI:SS.USZ' text; the exporter reads both via Date.parse. */
export function postgresUtcText(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m =
    /^(20[0-9]{2}-[0-9]{2}-[0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,6})?\+00$/.exec(v);
  return (
    !!m &&
    utcDay(m[1]) &&
    Number(m[2]) < 24 &&
    Number(m[3]) < 60 &&
    Number(m[4]) < 60 &&
    (m[5] === undefined || !m[5].endsWith('0')) &&
    Number.isFinite(Date.parse(v))
  );
}
/** Exactly the requested coordinates or fewer: a row for any other hand, a
 * duplicate, a missing or extra column, or a non-text value refuses the whole
 * reply. Absent hands are returned as explicitly absent, never skipped. */
export function parseAcceptedSourceRows(
  raw: unknown,
  hands: readonly AcceptedSourceCoordinate[]
): ReadonlyMap<string, AcceptedSourceRowWithLease> {
  validateSourceCoordinates(hands);
  const serialized = JSON.stringify(raw);
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized) > DAILY_LIMITS.sourceRowWireBytes
  )
    throw Error('accepted_source_bounds');
  const p: unknown = JSON.parse(serialized);
  if (
    !object(p) ||
    !exactKeys(p, ['version', 'rows']) ||
    p.version !== 1 ||
    !Array.isArray(p.rows) ||
    p.rows.length > hands.length
  )
    throw Error('accepted_source_mismatch');
  const wanted = new Map(hands.map((h) => [h.handId, h.tableId]));
  const out = new Map<string, AcceptedSourceRowWithLease>();
  const columns = [...ACCEPTED_SOURCE_COLUMNS, SOURCE_ROW_LEASE_COLUMN];
  let order = -1;
  for (const r of p.rows) {
    if (
      !object(r) ||
      !exactKeys(r, columns) ||
      !columns.every((k) => r[k] === null || typeof r[k] === 'string') ||
      typeof r.hand_id !== 'string' ||
      !wanted.has(r.hand_id) ||
      wanted.get(r.hand_id) !== r.table_id ||
      out.has(r.hand_id) ||
      !(r.lease_generation === null || uuid(r.lease_generation)) ||
      // The reader returns rows in request order (ORDER BY the ordinality).
      hands.findIndex((h) => h.handId === r.hand_id) <= order ||
      !postgresUtcText(r.committed_at) ||
      !postgresUtcText(r.read_at) ||
      !(r.post_commit_completed_at === null || postgresUtcText(r.post_commit_completed_at))
    )
      throw Error('accepted_source_row_refused');
    order = hands.findIndex((h) => h.handId === r.hand_id);
    const row = Object.freeze(
      Object.fromEntries(ACCEPTED_SOURCE_COLUMNS.map((k) => [k, r[k] as string | null]))
    ) as AcceptedSourceRow;
    out.set(
      r.hand_id,
      Object.freeze({ row, leaseGeneration: r.lease_generation as string | null })
    );
  }
  return out;
}
/** Re-exported so callers keep one import site for digest grammar. */
export { sha };
