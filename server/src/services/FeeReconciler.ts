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
  tournament_id: string | null;
  big_blind: number | null;
  kind: PendingFeeKind;
  attempts: number;
}

/** Give up re-driving after this many attempts and leave the row for a human. */
const MAX_RECONCILE_ATTEMPTS = 25;
/** Bound the work a single cycle does so a large backlog cannot stall the loop. */
const RECONCILE_BATCH = 100;

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
      tournament_id: fee.tournamentId ?? null,
      big_blind: fee.bigBlind ?? null,
      kind,
      last_error: fee.lastError,
    });
    if (error && !/duplicate|unique/i.test(error.message || '')) {
      reportError(
        new Error(
          `[A5] Could not queue unbanked ${kind} for hand ${fee.handId ?? fee.handNumber} ` +
            `(rake ${fee.rake}, bbj ${fee.bbj}): ${error.message}. These chips left the pot and ` +
            `are now recoverable only by hand.`
        ),
        'FeeReconciler.queue_failed'
      );
    }
  } catch (err) {
    reportError(err, 'FeeReconciler.queue_threw');
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
      'id, table_id, club_id, hand_id, hand_number, rake, bbj, pot, num_players, contributions, tournament_id, big_blind, kind, attempts'
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

    try {
      if (row.kind === 'rake') {
        const { error: rdErr } = await supabase.rpc('atomic_distribute_rake', {
          p_table_id: row.table_id,
          p_club_id: row.club_id,
          p_hand_id: row.hand_id,
          p_hand_number: row.hand_number,
          p_rake: row.rake,
          p_bbj: row.bbj,
          p_pot: row.pot,
          p_num_players: row.num_players,
          p_contributions: row.contributions ?? {},
          p_tournament_id: row.tournament_id,
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
          row.hand_id
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
      reportError(
        new Error(
          `[A5] Unbanked ${row.kind} for hand ${row.hand_id ?? row.hand_number} still failing after ` +
            `${attempts} attempts (rake ${row.rake}, bbj ${row.bbj}): ${failureMessage}. ` +
            `Row ${row.id} left open for manual reconciliation.`
        ),
        'FeeReconciler.exhausted'
      );
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
export async function auditBBJDrift(
  windowDays = 1,
  toleranceChips = 0.05
): Promise<{ booked: number; received: number; drift: number } | null> {
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

    if (Math.abs(drift) > toleranceChips) {
      reportError(
        new Error(
          `[A5] BBJ ledger drift over the last ${windowDays}d: rake_records booked ${booked} ` +
            `of BBJ contribution, bbj_contributions received ${received} (drift ${drift}). ` +
            `A positive drift means chips left pots and never reached the jackpot pool.`
        ),
        'FeeReconciler.bbj_drift'
      );
    }
    return { booked, received, drift };
  } catch (err) {
    reportError(err, 'FeeReconciler.drift_threw');
    return null;
  }
}
