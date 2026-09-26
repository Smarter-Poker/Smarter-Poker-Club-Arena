import nodeCrypto from 'node:crypto';
import { isUuidShape } from '../lib/uuidShape.js';
import { f06AbandonedGenerationClosuresTotal } from '../observability/engineInstruments.js';

/**
 * A DEAD GENERATION'S HAND IS DECIDED BY THE GENERATION THAT ADOPTS ITS EVENT
 * (2026-09-22).
 *
 * Every tournament hand is authorised by one smarter_private.f06_hand_permits
 * row that its manager's lease generation reserves before the deal and
 * closes after it. When that generation dies while a hand is in the air (its
 * lease proof lapsed during a database blip, the process restarted, the
 * manager was fenced), nothing it owned can ever close the permit again:
 * every F06 door refuses a stale generation. The generation that adopts the
 * event reads the table through fn_f06_hand_number_state, is told
 * `hand_permit_unresolved`, and until now refused to deal there for the rest
 * of its life. It retried every 15 s; the table never dealt again while the
 * event stayed RUNNING.
 *
 * Measured on production 2026-09-22: 56 MTT tables in 36 events (plus 90 Spin
 * and 80 SNG tables) held a reserved permit of a generation that was no longer
 * the lease holder. Three database blips that day each expired several
 * hundred leases at once, and each left a new crop behind. The only thing
 * that cleared them was an operator running
 * public.fn_f06_abort_abandoned_generation by hand.
 *
 * That door is the correct disposition, and the adopting generation is its
 * natural caller (it admits the `tournament-manager` actor). Under the
 * canonical lock order it proves from rows that the permit's generation is
 * not the live lease, that nothing of the hand is durable (no commit,
 * history, dispatch, private state or retained submission) and that every
 * chair still holds exactly its registration's chips. Then it closes the
 * permit `aborted_unsettled` / `never_started` with a receipt and credits
 * nothing. It also returns the event's blind clock to the level play stopped
 * at, which is why the manager asks it during adoption, BEFORE it reads the
 * clock, and reads the event again when the door committed.
 *
 * What this is not: a sweep, a watcher or a retry loop. It runs inside work
 * the generation was already performing - the adoption, and the table
 * admission that is already being refused - once per dead generation it finds
 * blocking one of its tables. A refusal the door names (a roster that moved, a
 * custody transfer in progress) is a rule, not a blip: it is reported, and the
 * table stays exactly as blocked as it was before this change.
 *
 * ADOPTION WAS THE WRONG AND ONLY MOMENT (2026-09-25). Asking during adoption
 * is right, but it was the ONLY ask, and `resumeLifecycle` runs exactly once
 * per manager: on the adoption path a manager holds its event's lease for the
 * rest of its life and never resumes again. So every way that single ask could
 * end without a decision - a freeze that outlasted the wait, a table state
 * that could not be read, a transient refusal that used up its three attempts
 * - left the table blocked for the whole life of that manager, and the next
 * ask waited for the next engine release.
 *
 * Measured on the 15:29 cutover to 778075b4: 526 tables in 388 RUNNING events
 * held a reserved permit of a dead generation, carrying 2,061 seated players
 * and 14,210,568 chips. All 388 events were adopted between 15:42:08 and
 * 15:44:33; the adoption read every table (1,411 fn_f06_hand_number_state
 * calls, all HTTP 200, returning a well-formed `hand_permit_unresolved` whose
 * generation was not the lease holder's); and the door itself was never
 * requested once - zero /rpc/fn_f06_abort_abandoned_generation calls, and zero
 * on every label of poker_f06_abandoned_generation_closures_total. Probed in a
 * rolled-back transaction the same day, the door decided 7 of 8 sampled
 * generations cleanly, crediting nothing. The door was right; the single
 * moment it was asked in was not.
 *
 * So the ask now also happens where the refusal is actually MET: in the table
 * admission that reads `hand_permit_unresolved` and has been throwing
 * `f06_engine_admission_unproven` every fifteen seconds since. That is the
 * live path for that table, on the event that is already blocked, at the
 * moment it is blocked - not a job that comes along afterwards (CLAUDE.md
 * 10.12). The receipt is derived from (event, dead generation), so the second
 * ask replays the first instead of minting anything, and a rule the door names
 * is asked once and not again by that manager.
 */

export type AbandonedGenerationOutcome = 'aborted' | 'replayed' | 'already_closed';

/**
 * transient: says nothing about the hand (a lane or lock the door would not
 * wait for, the platform freeze, a lost connection); asking again may pass.
 * retained_submission: the hand has an original the table's own admission
 * finishes first (resumeRetainedHandSubmission).
 * definite: a rule refused; asking again cannot pass.
 */
export type AbandonedGenerationRefusal = 'transient' | 'retained_submission' | 'definite';

export interface AbandonedGenerationRpcResult {
  data: unknown;
  error: { message?: string; code?: string } | null;
}

export type AbandonedGenerationRpc = (
  name: 'fn_f06_abort_abandoned_generation',
  args: {
    p_tournament_id: string;
    p_generation: string;
    p_receipt_id: string;
    p_reason: string;
    p_release_current_lease: false;
  }
) => Promise<AbandonedGenerationRpcResult>;

/** The door's own refusal, spelled F06_... (or PLATFORM_FROZEN) in its message. */
const NAMED_REFUSAL = /\b(F06_[A-Z0-9_]+|PLATFORM_FROZEN)\b/;

const TRANSIENT_NAMED = new Set([
  'F06_HAND_DISPATCH_BUSY',
  'F06_ABORT_RETRY_PLAYER_LANE',
  'F06_RETRY_CANONICAL_LANE',
  'F06_GENERATION_STILL_LIVE',
  'PLATFORM_FROZEN',
]);
/** serialization, deadlock, statement timeout, lock timeout, lost connection */
const TRANSIENT_SQLSTATE = new Set(['40001', '40P01', '57014', '55P03', '08006', '08000']);

/** Another receipt already decided this generation: nothing is left to ask. */
const ALREADY_CLOSED = new Set([
  'F06_GENERATION_ALREADY_ABORTED',
  'F06_ABANDONED_NOTHING_RESERVED',
]);

export class AbandonedGenerationRefusedError extends Error {
  readonly code: string;
  readonly refusal: AbandonedGenerationRefusal;
  constructor(code: string, refusal: AbandonedGenerationRefusal, detail = '') {
    super(`f06_abandoned_generation_refused [${code}]${detail ? ` ${detail}` : ''}`);
    this.name = 'AbandonedGenerationRefusedError';
    this.code = code;
    this.refusal = refusal;
  }
}

/**
 * The generation of a reserved permit that blocks this table and that this
 * manager's own generation did not reserve - or null. Anything short of an
 * exact, well-formed `hand_permit_unresolved` answer about this table and
 * this event is not this generation's to decide and returns null, so the
 * table's existing admission refusal still applies to it.
 */
export function abandonedPermitGeneration(
  state: unknown,
  tournamentId: string,
  tableId: string,
  leaseGeneration: string
): string | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const s = state as Record<string, unknown>;
  if (
    s.ok !== true ||
    !sameId(s.table_id, tableId) ||
    s.can_reserve !== false ||
    s.blocked_reason !== 'hand_permit_unresolved'
  )
    return null;
  const permit = s.unresolved_permit;
  if (!permit || typeof permit !== 'object' || Array.isArray(permit)) return null;
  const p = permit as Record<string, unknown>;
  if (
    p.state !== 'reserved' ||
    !sameId(p.table_id, tableId) ||
    !sameId(p.tournament_id, tournamentId) ||
    !isUuidShape(p.generation) ||
    !isUuidShape(leaseGeneration)
  )
    return null;
  const generation = p.generation.toLowerCase();
  return generation === leaseGeneration.toLowerCase() ? null : generation;
}

function sameId(value: unknown, id: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === id.toLowerCase();
}

/**
 * One receipt per (event, dead generation), whoever asks: a later adopting
 * generation, or the same one after an unknown outcome, replays the stored
 * result instead of minting a second receipt the door would refuse.
 */
export function abandonedGenerationReceiptId(tournamentId: string, generation: string): string {
  const hex = nodeCrypto
    .createHash('md5')
    .update(`f06:abandoned:successor:${tournamentId.toLowerCase()}:${generation.toLowerCase()}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type AbandonedGenerationCount =
  | 'aborted'
  | 'replayed'
  | 'already_closed'
  | 'refused'
  | 'transient'
  /** The maintenance freeze outlasted the wait: the door was never reached. */
  | 'frozen'
  /** The table's own state could not be read, so nothing was decided about it. */
  | 'unreadable';

/**
 * Every end of an ask is a number, including the ends that never reach the
 * door. `frozen` and `unreadable` were silent until 2026-09-25, and silence
 * reads identically to "there was nothing to decide" (CLAUDE.md 10.86 rule 1).
 */
export function countAbandonedGenerationOutcome(outcome: AbandonedGenerationCount): void {
  try {
    f06AbandonedGenerationClosuresTotal.inc(1, { outcome });
  } catch {
    /* a metric never changes a custody decision */
  }
}

function count(outcome: AbandonedGenerationCount): void {
  countAbandonedGenerationOutcome(outcome);
}

/**
 * Ask the door, once, to decide every reserved permit of one dead generation
 * of this event. Resolves with what the door did; rejects with an
 * AbandonedGenerationRefusedError that says whether asking again could pass.
 */
export async function closeAbandonedGeneration(
  rpc: AbandonedGenerationRpc,
  tournamentId: string,
  generation: string,
  successorGeneration: string
): Promise<AbandonedGenerationOutcome> {
  const event = tournamentId.toLowerCase();
  const dead = generation.toLowerCase();
  const receipt = abandonedGenerationReceiptId(event, dead);
  let reply: AbandonedGenerationRpcResult;
  try {
    reply = await rpc('fn_f06_abort_abandoned_generation', {
      p_tournament_id: event,
      p_generation: dead,
      p_receipt_id: receipt,
      p_reason:
        `generation ${successorGeneration.toLowerCase()} adopted tournament ${event}; ` +
        `generation ${dead} left a reserved hand it can never finish`,
      p_release_current_lease: false,
    });
  } catch (cause) {
    count('transient');
    throw new AbandonedGenerationRefusedError(
      'no_answer',
      'transient',
      String((cause as Error)?.message ?? cause).slice(0, 160)
    );
  }
  const { data, error } = reply;
  if (error) {
    const message = typeof error.message === 'string' ? error.message : '';
    const sqlstate = typeof error.code === 'string' && error.code ? error.code : 'no_sqlstate';
    const named = NAMED_REFUSAL.exec(message)?.[1];
    if (named && ALREADY_CLOSED.has(named)) {
      count('already_closed');
      return 'already_closed';
    }
    if (!named || TRANSIENT_NAMED.has(named) || TRANSIENT_SQLSTATE.has(sqlstate)) {
      count('transient');
      throw new AbandonedGenerationRefusedError(
        named ?? sqlstate,
        'transient',
        message.slice(0, 160)
      );
    }
    count('refused');
    throw new AbandonedGenerationRefusedError(
      named,
      named === 'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION' ? 'retained_submission' : 'definite'
    );
  }
  const r = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<
    string,
    unknown
  >;
  if (
    r.ok !== true ||
    !sameId(r.receipt_id, receipt) ||
    !sameId(r.tournament_id, event) ||
    !sameId(r.generation, dead) ||
    r.credit !== 0
  ) {
    // The call may have committed; the same receipt replays it next time.
    count('transient');
    throw new AbandonedGenerationRefusedError('F06_ABANDONED_REPLY_UNPROVEN', 'transient');
  }
  const outcome: AbandonedGenerationOutcome = r.replayed === true ? 'replayed' : 'aborted';
  count(outcome);
  return outcome;
}
