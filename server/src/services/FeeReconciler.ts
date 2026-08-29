/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FEE RECONCILER — A5: no fee that leaves a pot may cease to exist
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Rake and the BBJ contribution are removed from the pot inside the hand and
 * banked afterwards by two different paths:
 *
 *   - `atomic_distribute_rake(...)` — writes the durable `rake_records` audit,
 *     credits the club wallet, and routes the spendable rake. It is atomic,
 *     hand-gated (`uq_rake_records_hand_id`) and idempotent, and the engine
 *     retries it three times.
 *   - `logBBJCollection(...)` -> `bbj_record_contribution(...)` — puts the BBJ
 *     slice into the jackpot pool. This one matters more than it looks:
 *     `atomic_distribute_rake` computes `v_net := p_rake - v_bbj` and credits
 *     the club wallet only `v_net`, deliberately excluding the BBJ slice on the
 *     assumption that the pool will receive it.
 *
 * Either call failing therefore destroys chips: they have already left the pot,
 * and nothing else is holding them. Both failures used to be merely logged — the
 * BBJ one on just one hand in a hundred — so a loss would have been invisible.
 *
 * To be clear about the evidence: an audit joining rake_records to
 * bbj_contributions on hand_id over the 20,000 most recent raked hands found
 * ZERO hands missing a pool row, and a sample of the 500 most recent raked cash
 * hands found zero missing a rake_records row. Nothing is known to have been
 * lost. This closes the hole and, more importantly, makes any future occurrence
 * visible and self-healing instead of silent.
 *
 * So the engine now writes the exact arguments it could not bank into
 * `pending_fee_distributions`, and this module drains that queue. Re-driving is
 * safe by construction: `atomic_distribute_rake` is hand-gated and
 * `bbj_record_contribution` is keyed per (table, hand), so an entry that
 * actually did land resolves as a no-op instead of double-banking.
 */

import { supabase } from './supabase.js';
import { logBBJCollection } from './supabase.js';
import { reportError } from './errorReporter.js';
import { raiseFinancialAlert } from './financialAlerts.js';

export type PendingFeeKind = 'rake' | 'bbj_contribution';

export interface UnbankedFee {
  tableId: string;
  clubId: string | null | undefined;
  handId: string | null;
  handNumber: number;
  rake: number;
  bbj: number;
  pot: number;
  numPlayers: number;
  contributions: Record<string, number>;
  /** Per-player uncalled amounts returned (weighted contributed rake audit). */
  returnedUncalled?: Record<string, number> | null;
  /**
   * Methodology the hand was settled under ('WEIGHTED_CONTRIBUTED' for the
   * post-2026-08-29 engine). Threaded through the queue so a re-driven hand
   * keeps the attribution it was played with.
   */
  rakeMethod?: string | null;
  tournamentId?: string | null;
  bigBlind?: number | null;
  lastError: string;
}

interface PendingFeeRow {
  id: string;
  table_id: string;
  club_id: string;
  hand_id: string | null;
  hand_number: number;
  rake: number;
  bbj: number;
  pot: number;
  num_players: number;
  contributions: Record<string, number> | null;
  returned_uncalled: Record<string, number> | null;
  rake_method: string | null;
  tournament_id: string | null;
  big_blind: number | null;
  kind: PendingFeeKind;
  attempts: number;
}

/** Give up re-driving after this many attempts and leave the row for a human. */
const MAX_RECONCILE_ATTEMPTS = 25;
/**
 * Errors that mean "the network or the database was busy", not "this was
 * rejected". The queue insert is safe to repeat — the partial unique index on
 * (hand_id, kind) where resolved_at is null makes a duplicate a no-op — so
 * these get retried rather than escalated.
 */
const TRANSIENT_DB_ERROR =
  /timeout|timed out|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|502|503|504|57014|too many connections|schema cache|PGRST002|PGRST001/i;
const QUEUE_INSERT_ATTEMPTS = 4;
/**
 * 300ms, 900ms, 2.7s. Was a flat 250 * attempt — 1.5s of total patience.
 *
 * A PostgREST schema-cache reload is not instant, and it is self-inflicted:
 * every `apply_migration` triggers one. Five migrations were applied on
 * 2026-08-22 and the reload window is visible in the alerts. Backing off
 * further costs nothing on a path that only runs when banking has ALREADY
 * failed, and buys the reload time to finish.
 */
const QUEUE_BACKOFF_MS = (attempt: number): number => 100 * 3 ** attempt;
/**
 * Bound the work a single cycle does so a large backlog cannot stall the loop.
 *
 * Raised 100 -> 250 after the 2026-08-29 FK outage: 1,860 queued hands at 100
 * per cycle meant hours of natural drain for a backlog the database could
 * clear in minutes. 250 keeps a cycle comfortably under a minute of
 * sequential RPCs while cutting worst-case drain time by 2.5x. For anything
 * bigger, the DB-side sweep exists: fn_redrive_unbanked_rake (service_role),
 * which re-drives idempotently without the per-row HTTP round trip.
 */
const RECONCILE_BATCH = 250;

/**
 * Durably record a fee that left the pot but could not be banked.
 *
 * Deliberately loud on failure: if even this insert fails, the chips really are
 * unrecoverable from data, and the alert is all that stands between that and a
 * silent shortfall. The partial unique index on (hand_id, kind) where
 * resolved_at is null makes a duplicate queue attempt a harmless no-op.
 */
export async function queueUnbankedFee(kind: PendingFeeKind, fee: UnbankedFee): Promise<void> {
  try {
    // RETRIED (2026-08-22). This is the last line of defence, and it was a
    // single attempt: one transient blip and the safety net itself was the
    // thing that failed. Measured over 2026-08-20..22, 938 of 988 of these
    // alerts said `supabase_timeout` — the exact condition the net exists to
    // survive. The insert is idempotent by index, so repeating it is free.
    let lastError = '';
    for (let attempt = 1; attempt <= QUEUE_INSERT_ATTEMPTS; attempt++) {
      const { error } = await supabase.from('pending_fee_distributions').insert({
        table_id: fee.tableId,
        club_id: fee.clubId,
        hand_id: fee.handId,
        hand_number: fee.handNumber,
        rake: fee.rake,
        bbj: fee.bbj,
        pot: fee.pot,
        num_players: fee.numPlayers,
        contributions: fee.contributions,
        returned_uncalled: fee.returnedUncalled ?? null,
        rake_method: fee.rakeMethod ?? null,
        tournament_id: fee.tournamentId ?? null,
        big_blind: fee.bigBlind ?? null,
        kind,
        last_error: fee.lastError,
      });
      if (!error) return;
      // Already queued by an earlier attempt (possibly one that committed and
      // then timed out on us). Nothing is lost; the drain loop owns it now.
      if (/duplicate|unique/i.test(error.message || '')) return;

      lastError = error.message || String(error);
      if (!TRANSIENT_DB_ERROR.test(lastError) || attempt === QUEUE_INSERT_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, QUEUE_BACKOFF_MS(attempt)));
    }

    // ASK BEFORE ALARMING (2026-08-22).
    //
    // A timeout is not a failure — it is the absence of an answer, and the
    // write underneath it usually committed. Of the 127 of these alerts that
    // carried a hand id, 118 had a `rake_records` row for that very hand: the
    // banking call had SUCCEEDED and only the response was lost. Nine had not,
    // worth 29.44 chips.
    //
    // So 93% of a critical money alarm was noise, and noise on that channel is
    // not harmless: 988 unresolved criticals is how the nine real ones stay
    // invisible. Check whether the fee actually landed before declaring the
    // chips unrecoverable.
    if (await feeIsAccountedFor(kind, fee)) {
      console.warn(
        `[A5] Queue insert for ${kind} on hand ${fee.handId ?? fee.handNumber} reported ` +
          `"${lastError}", but the fee is already queued or banked — no chips at risk, ` +
          `not alarming.`
      );
      return;
    }

    const detail =
      `[A5] Could not queue unbanked ${kind} for hand ${fee.handId ?? fee.handNumber} ` +
      `(rake ${fee.rake}, bbj ${fee.bbj}): ${lastError}. These chips left the pot and ` +
      `are now recoverable only by hand.`;
    reportError(new Error(detail), 'FeeReconciler.queue_failed');
    // Sentry alone is not enough for a money alarm: financial_alerts is the
    // durable, queryable channel an operator actually reads, and this is the
    // last line of defence before chips become unrecoverable from data.
    // THE WHOLE PAYLOAD, NOT A SUMMARY (2026-08-22).
    //
    // This context used to carry kind/table/club/hand/rake/bbj and stop there.
    // That is enough to say chips are missing and not enough to put them back:
    // `atomic_distribute_rake` needs pot, num_players and — critically —
    // `contributions`, the per-player split. Without it the rake can only be
    // booked with no attribution, and `auditBBJDrift` in this same file already
    // states the consequence: "guessing it would corrupt rakeback attribution".
    //
    // So the 190 alerts open on 2026-08-22 name chips nobody can safely
    // re-drive, only because the alarm summarised a payload it was already
    // holding in full. It costs nothing to write all of it.
    await raiseFinancialAlert('critical', 'FeeReconciler.queue_failed', detail, {
      kind,
      tableId: fee.tableId,
      clubId: fee.clubId ?? null,
      handId: fee.handId,
      handNumber: fee.handNumber,
      rake: fee.rake,
      bbj: fee.bbj,
      // everything atomic_distribute_rake / logBBJCollection need to re-drive
      pot: fee.pot,
      numPlayers: fee.numPlayers,
      contributions: fee.contributions ?? {},
      returnedUncalled: fee.returnedUncalled ?? null,
      rakeMethod: fee.rakeMethod ?? null,
      tournamentId: fee.tournamentId ?? null,
      bigBlind: fee.bigBlind ?? null,
      dbError: lastError,
      verifiedUnbanked: true,
    });
  } catch (err) {
    reportError(err, 'FeeReconciler.queue_threw');
  }
}

/**
 * Are these chips accounted for somewhere after all?
 *
 * TWO places count, and the first one is the common case:
 *
 *   1. THE QUEUE ALREADY HAS THE ROW. A timeout is the absence of an answer,
 *      not a rejection — the insert usually committed. Auditing the 1,020 open
 *      alerts on 2026-08-22: 830 of them referred to a fee that was already
 *      queued or already banked. The row is in `pending_fee_distributions`,
 *      `reconcilePendingFees` owns it, and nothing is at risk. The duplicate-
 *      key path above catches this only when Postgres gets to answer; a
 *      timeout is precisely when it does not.
 *   2. THE FEE IS ALREADY BANKED — the banking call succeeded and only its
 *      response was lost.
 *
 * Fails CLOSED: anything unknown — a thrown query, a missing hand number —
 * returns false, so the alarm is raised. Suppressing a money alert on a guess
 * would be worse than the noise it removes.
 */
async function feeIsAccountedFor(kind: PendingFeeKind, fee: UnbankedFee): Promise<boolean> {
  try {
    // Cheapest check, and the one that is true most often.
    if (Number(fee.handNumber) > 0) {
      const { data: queued } = await supabase
        .from('pending_fee_distributions')
        .select('id')
        .eq('table_id', fee.tableId)
        .eq('hand_number', fee.handNumber)
        .eq('kind', kind)
        .limit(1)
        .maybeSingle();
      if (queued) return true;
    }

    if (kind === 'rake') {
      if (fee.handId) {
        const { data } = await supabase
          .from('rake_records')
          .select('id')
          .eq('hand_id', fee.handId)
          .limit(1)
          .maybeSingle();
        if (data) return true;
      }
      if (Number(fee.handNumber) > 0) {
        // global_hand_id carries the hand number; scoped by table so it cannot
        // match another table's hand.
        const { data } = await supabase
          .from('rake_records')
          .select('id')
          .eq('table_id', fee.tableId)
          .eq('global_hand_id', fee.handNumber)
          .limit(1)
          .maybeSingle();
        return !!data;
      }
      return false;
    }

    if (!(Number(fee.handNumber) > 0)) return false;
    const { data } = await supabase
      .from('bbj_contributions')
      .select('id')
      .eq('table_id', fee.tableId)
      .eq('hand_number', fee.handNumber)
      .limit(1)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Drain the queue. Returns a small summary so the caller can log one line.
 *
 * A row that fails again is NOT resolved — its attempt counter is bumped and it
 * is retried next cycle, until MAX_RECONCILE_ATTEMPTS, at which point it stays
 * open and is reported so a human sees it. Nothing is ever dropped.
 */
export async function reconcilePendingFees(): Promise<{
  scanned: number;
  resolved: number;
  stillFailing: number;
  exhausted: number;
}> {
  const summary = { scanned: 0, resolved: 0, stillFailing: 0, exhausted: 0 };

  const { data, error } = await supabase
    .from('pending_fee_distributions')
    .select(
      'id, table_id, club_id, hand_id, hand_number, rake, bbj, pot, num_players, contributions, returned_uncalled, rake_method, tournament_id, big_blind, kind, attempts'
    )
    .is('resolved_at', null)
    .lt('attempts', MAX_RECONCILE_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(RECONCILE_BATCH);

  if (error) {
    reportError(error, 'FeeReconciler.read_failed');
    return summary;
  }
  const rows = (data ?? []) as PendingFeeRow[];
  summary.scanned = rows.length;
  if (rows.length === 0) return summary;

  for (const row of rows) {
    let ok = false;
    let failureMessage = '';

    // REVIEW FIX 2026-08-20 — the hole that kept this alert alive.
    //
    // A queued fee captures hand_id at the moment settlement FAILED. During an
    // outage both writes fail together: hand_history has no row yet, so the
    // captured hand_id is null. The engine's retry queue writes that hand a few
    // seconds later and calls fn_relink_rake_record_to_hand — which finds
    // nothing to link, because the rake row does not exist yet either. Then
    // THIS function finally creates it, passing the stale null through, and the
    // row is unlinkable forever. That is precisely the `unlinkable_rows` signal
    // auditBBJDrift reports below, with nothing left in the system able to
    // repair it.
    //
    // The hand row exists by now, so resolve the id here instead of trusting a
    // null captured minutes ago. hand_number is globally unique above
    // 1,000,000 (uq_hand_history_global_hand_number), so this is one indexed
    // lookup and it cannot match another table's hand.
    let resolvedHandId = row.hand_id;
    if (!resolvedHandId && Number(row.hand_number) >= 1_000_000) {
      const { data: hh } = await supabase
        .from('hand_history')
        .select('id')
        .eq('hand_number', row.hand_number)
        .limit(1)
        .maybeSingle();
      if (hh?.id) resolvedHandId = hh.id as string;
    }

    try {
      if (row.kind === 'rake') {
        const { error: rdErr } = await supabase.rpc('atomic_distribute_rake', {
          p_table_id: row.table_id,
          p_club_id: row.club_id,
          p_hand_id: resolvedHandId,
          p_hand_number: row.hand_number,
          p_rake: row.rake,
          p_bbj: row.bbj,
          p_pot: row.pot,
          p_num_players: row.num_players,
          p_contributions: row.contributions ?? {},
          p_tournament_id: row.tournament_id,
          // Weighted contributed rake (Dan 2026-08-29): a re-driven hand keeps
          // the methodology it was settled under. Legacy queue rows (null)
          // stay DEALT_EQUAL, which is what they were played as.
          p_returned_uncalled: row.returned_uncalled ?? null,
          p_rake_method: row.rake_method ?? 'DEALT_EQUAL',
        });
        ok = !rdErr;
        failureMessage = rdErr?.message ?? '';
      } else {
        ok = await logBBJCollection(
          row.table_id,
          row.club_id,
          row.hand_number,
          Number(row.bbj),
          Number(row.big_blind ?? 0),
          resolvedHandId
        );
        if (!ok) failureMessage = 'logBBJCollection returned false';
      }
    } catch (err: any) {
      ok = false;
      failureMessage = String(err?.message ?? err);
    }

    const attempts = (row.attempts ?? 0) + 1;
    const patch: Record<string, unknown> = {
      attempts,
      last_attempt_at: new Date().toISOString(),
      last_error: ok ? null : failureMessage.slice(0, 500),
    };
    if (ok) patch.resolved_at = new Date().toISOString();

    const { error: updErr } = await supabase
      .from('pending_fee_distributions')
      .update(patch)
      .eq('id', row.id);

    if (updErr) {
      // The fee itself is banked (or not) regardless of this bookkeeping write.
      // Leaving the row open is the safe direction: the next cycle re-drives it,
      // and both underlying operations are idempotent.
      reportError(updErr, 'FeeReconciler.mark_failed');
    }

    if (ok) {
      summary.resolved++;
    } else if (attempts >= MAX_RECONCILE_ATTEMPTS) {
      summary.exhausted++;
      const detail =
        `[A5] Unbanked ${row.kind} for hand ${row.hand_id ?? row.hand_number} still failing after ` +
        `${attempts} attempts (rake ${row.rake}, bbj ${row.bbj}): ${failureMessage}. ` +
        `Row ${row.id} left open for manual reconciliation.`;
      reportError(new Error(detail), 'FeeReconciler.exhausted');
      await raiseFinancialAlert('critical', 'FeeReconciler.exhausted', detail, {
        pendingFeeId: row.id,
        kind: row.kind,
        tableId: row.table_id,
        clubId: row.club_id,
        handId: row.hand_id,
        handNumber: row.hand_number,
        rake: row.rake,
        bbj: row.bbj,
        // Same reason as queue_failed above: an alarm about money should carry
        // what it takes to move that money back. This row already has it.
        pot: row.pot,
        numPlayers: row.num_players,
        contributions: row.contributions ?? {},
        tournamentId: row.tournament_id,
        bigBlind: row.big_blind,
        attempts,
        lastError: failureMessage,
      });
    } else {
      summary.stillFailing++;
    }
  }

  return summary;
}

/**
 * Independent drift alarm.
 *
 * The queue only catches failures the engine noticed. This catches the rest by
 * comparing the two ledgers against each other: every chip `rake_records` books
 * as a BBJ contribution should have reached `bbj_contributions`. A persistent
 * gap means chips are being destroyed somewhere the queue is not seeing, which
 * is exactly the condition that went unnoticed for a week.
 *
 * Read-only — it reports, it does not try to heal, because the per-player
 * contribution split needed to re-drive correctly is not recoverable from these
 * two tables alone and guessing it would corrupt rakeback attribution.
 */
/**
 * SELF-HEAL 2026-08-18: bank BBJ fees that rake_records proves were withheld
 * from pots but that never reached a pool.
 *
 * Why this exists on top of the pending_fee_distributions queue: that queue is
 * only written when `logBBJCollection` RETURNS FALSE, which requires the engine
 * process to still be alive to observe the failure and enqueue. A live
 * investigation on 2026-08-18 found 4 hands (2.00 chips) lost with ZERO queue
 * rows — two of them 52ms apart on different tables in different clubs, the
 * signature of the process dying between the rake transaction and the banking
 * call. Recovery that lives in the engine cannot survive the engine dying.
 *
 * fn_bbj_repair_unbanked works from rake_records — written inside the same
 * atomic transaction that withheld the fee — so it recovers regardless of how
 * the engine went away. It is idempotent by construction and skips the last 5
 * minutes so it can never race the live banking path.
 */
export async function repairUnbankedBBJFees(
  sinceHours = 48,
  limit = 200
): Promise<{ repaired: number; chips: number }> {
  try {
    const { data, error } = await supabase.rpc('fn_bbj_repair_unbanked', {
      p_since_hours: sinceHours,
      p_limit: limit,
    });
    if (error) {
      reportError(error, 'FeeReconciler.bbj_repair_failed');
      return { repaired: 0, chips: 0 };
    }
    const rows = (data ?? []) as Array<{ hand_id: string; club_id: string; amount: number }>;
    const chips = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    if (rows.length > 0) {
      // Report every recovery: money that had to be repaired is a signal about
      // engine stability, not routine bookkeeping to be logged and forgotten.
      reportError(
        new Error(
          `[BBJ self-heal] Recovered ${rows.length} unbanked BBJ contribution(s) totalling ` +
            `${chips.toFixed(2)} chips — these fees were withheld from pots but never reached a ` +
            `pool (no pending_fee_distributions row, i.e. the engine did not survive to enqueue). ` +
            `Hands: ${rows.map((r) => r.hand_id).join(', ')}`
        ),
        'FeeReconciler.bbj_self_heal_recovered'
      );
    }
    return { repaired: rows.length, chips };
  } catch (err) {
    reportError(err, 'FeeReconciler.bbj_repair_threw');
    return { repaired: 0, chips: 0 };
  }
}

export async function auditBBJDrift(
  windowDays = 1,
  toleranceChips = 0.05
): Promise<{
  booked: number;
  received: number;
  drift: number;
  unlinkableRows: number;
  unlinkableChips: number;
} | null> {
  try {
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

    const { data, error } = await supabase.rpc('bbj_drift_since', { p_since: since });
    if (error) {
      reportError(error, 'FeeReconciler.drift_query_failed');
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    const booked = Number(row?.booked ?? 0);
    const received = Number(row?.received ?? 0);
    const drift = Math.round((booked - received) * 100) / 100;

    /**
     * REVIEW FIX (2026-08-20): the alarm was structurally blind to the exact
     * population where the real bug lived.
     *
     * Both sides of the comparison join on hand_id, so a rake_records row with
     * NO hand id contributes to neither `booked` nor `received` — it is simply
     * invisible. That is not a rare corner: over 30 days 7,317 rake rows carry
     * no hand id, and it was precisely those rows that
     * atomic_distribute_rake / bbj_record_contribution failed to dedupe,
     * banking 237.95 chips of rake and 16.38 of BBJ more than once. An alarm
     * whose blind spot is congruent with the defect it exists to catch reads
     * 0.00 while money moves.
     *
     * The RPC already reports the unlinkable population; read it and say so.
     */
    const unlinkableRows = Number(row?.unlinkable_rows ?? 0);
    const unlinkableChips = Number(row?.unlinkable_chips ?? 0);
    if (unlinkableChips > toleranceChips) {
      const detail =
        `[A5] ${unlinkableChips} chips of BBJ contribution over the last ${windowDays}d sit on ` +
        `${unlinkableRows} rake_records row(s) with NO hand_id, so they can be reconciled ` +
        `against the jackpot pool by neither this audit nor fn_bbj_repair_unbanked. ` +
        `Rising numbers here mean logHandHistory is failing and returning a null id.`;
      reportError(new Error(detail), 'FeeReconciler.bbj_unlinkable');
      await raiseFinancialAlert('warning', 'FeeReconciler.bbj_unlinkable', detail, {
        windowDays,
        unlinkableRows,
        unlinkableChips,
      });
    }

    if (Math.abs(drift) > toleranceChips) {
      const detail =
        `[A5] BBJ ledger drift over the last ${windowDays}d: rake_records booked ${booked} ` +
        `of BBJ contribution, bbj_contributions received ${received} (drift ${drift}). ` +
        `A positive drift means chips left pots and never reached the jackpot pool.`;
      reportError(new Error(detail), 'FeeReconciler.bbj_drift');
      await raiseFinancialAlert('warning', 'FeeReconciler.bbj_drift', detail, {
        windowDays,
        booked,
        received,
        drift,
      });
    }
    return { booked, received, drift, unlinkableRows, unlinkableChips };
  } catch (err) {
    reportError(err, 'FeeReconciler.drift_threw');
    return null;
  }
}

/**
 * WEIGHTED CONTRIBUTED RAKE reconciliation watchdog (Dan 2026-08-29).
 *
 * Invariants 4 and 9 of the weighted-rake law: for every cash hand settled
 * under WEIGHTED_CONTRIBUTED, the per-player ledger (rake_attributions) must
 * sum back EXACTLY to the rake collected (rake_records.rake_amount). The
 * allocator guarantees this by construction, so ANY row here means either the
 * ledger write was lost (missing attribution rows) or the two ledgers were
 * written by disagreeing code. Read-only: it reports, it never "fixes"
 * financial discrepancies silently.
 */
export async function auditRakeAttributionDrift(
  windowHours = 24
): Promise<{ mismatchedHands: number; chips: number } | null> {
  try {
    const { data, error } = await supabase.rpc('fn_rake_attribution_drift', {
      p_hours: windowHours,
    });
    if (error) {
      reportError(error, 'FeeReconciler.rake_attribution_drift_query_failed');
      return null;
    }
    const rows = (data ?? []) as Array<{
      hand_id: string;
      rake_amount: number;
      allocated: number;
      difference: number;
    }>;
    if (rows.length === 0) return { mismatchedHands: 0, chips: 0 };

    const chips = Math.round(rows.reduce((s, r) => s + Number(r.difference || 0), 0) * 100) / 100;
    const detail =
      `[A5] RAKE_ALLOCATION_MISMATCH: ${rows.length} weighted-contributed hand(s) in the last ` +
      `${windowHours}h whose per-player rake_attributions do not sum to the rake collected ` +
      `(net difference ${chips} chips). First hands: ` +
      rows
        .slice(0, 10)
        .map((r) => `${r.hand_id} (rake ${r.rake_amount}, allocated ${r.allocated})`)
        .join(', ');
    reportError(new Error(detail), 'FeeReconciler.rake_attribution_drift');
    await raiseFinancialAlert('critical', 'FeeReconciler.rake_attribution_drift', detail, {
      windowHours,
      mismatchedHands: rows.length,
      netDifferenceChips: chips,
      hands: rows.slice(0, 50),
    });
    return { mismatchedHands: rows.length, chips };
  } catch (err) {
    reportError(err, 'FeeReconciler.rake_attribution_drift_threw');
    return null;
  }
}
