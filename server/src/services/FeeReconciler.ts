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
 * So the engine wrote the exact arguments it could not bank into
 * `pending_fee_distributions`, and this module drained that queue. Re-driving
 * was safe by construction: `atomic_distribute_rake` is hand-gated and
 * `bbj_record_contribution` is keyed per (table, hand), so an entry that
 * actually did land resolved as a no-op instead of double-banking.
 *
 * THE HAND OWES ITS OWN FEES NOW, AND NOTHING HERE RE-DRIVES THEM (2026-09-22).
 *
 * Since 2026-09-09 21:56 UTC the only hand door the engine can reach,
 * `fn_ca_commit_hand_settlement`, carries the rake and the BBJ drop in the
 * hand's post-commit envelope and refuses a raked hand whose envelope does not
 * carry them. `fn_ca_process_hand_post_commit_obligations` banks both in one
 * transaction, and the hand projection outbox is its crash successor.
 *
 * RE-MEASURED ON PRODUCTION 2026-09-24 03:46 UTC, before this shipped: 57,377
 * raked cash hands in the preceding 24 hours, every one with an atomic commit
 * and none with a null envelope; 173,098 cash rake records in the preceding 3
 * days, none banked more than five minutes after its hand (worst 2m04s) and no
 * raked cash hand without one. No rake claim has been queued since 2026-09-08
 * 17:30 UTC, and `pending_fee_distributions` holds no unresolved row of any
 * kind (2026-09-24 03:17 UTC).
 *
 * So the drain below completes jackpot payout claims (`bbj_payout`) and nothing
 * else: their writer is still outside the hand's transaction. The rake and
 * BBJ-drop re-drive branches, the hourly restart-orphan re-queue
 * (`fn_requeue_unbanked_cash_rake`) and the hourly BBJ self-heal
 * (`fn_bbj_repair_unbanked`) are gone. They compensated for the split write the
 * envelope removed, and the re-queue did worse than nothing when an envelope
 * was merely late: it filed an equal-split claim after ten minutes, and
 * `atomic_distribute_rake` keeps the first write for a hand, so the hand's
 * weighted per-player attribution was lost for good.
 *
 * `queueUnbankedFee` is still reachable from the protocol-1 compatibility path
 * in ServerTableEngineSettlement (a hand committed without a verified lease and
 * envelope), which production refuses at the hand door. A claim it writes is
 * the durable record that the fee is owed, read by the rake/BBJ invariant audit
 * and reconciled by a person. No timer re-drives it.
 */

import { supabase } from './supabase.js';
import { processBBJPayout, setBBJPayoutQueue } from './supabase/bbj.js';
import type { BBJPayoutParams } from './supabase/bbj.js';
import { reportError } from './errorReporter.js';
import { raiseFinancialAlert } from './financialAlerts.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';

/**
 * 'bbj_payout' (BBJ audit 2026-09-05): a jackpot the engine DETECTED but could
 * not PAY - every attempt at bbj_atomic_payout_v2 failed. The payout's full
 * parameter set rides in `contributions` (the row's free jsonb column); rake
 * and bbj are 0 because no fee is at stake, the pool's money is. The drain
 * re-drives it through processBBJPayout, which is idempotent on (pool, table,
 * hand). See processBBJPayout for why a one-shot payout was a defect.
 */
export type PendingFeeKind = 'rake' | 'bbj_contribution' | 'bbj_payout';

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
 * sequential RPCs while cutting worst-case drain time by 2.5x. Since 2026-09-22
 * the drain reads jackpot payout claims only; the bound is unchanged.
 */
const RECONCILE_BATCH = 250;

/**
 * Durably record a jackpot payout the engine could not land (BBJ audit
 * 2026-09-05). Same table, same drain loop, same dedupe indexes as the fee
 * queue; the difference is what the row carries and what re-driving it calls.
 *
 * `hand_id` is resolved from hand_history here rather than trusted from the
 * caller: postHandTasks writes the hand BEFORE the payout step, so it is
 * normally present, and the (hand_id, kind) index then makes a second queue
 * attempt for the same hand a no-op. When the hand row is missing too (the
 * outage took both), the (table_id, hand_number, kind) index covers it.
 *
 * Registered with bbj.ts below so processBBJPayout can call it without a
 * static import in the other direction (bbj.ts is imported by this module).
 */
export async function queueUnpaidBBJPayout(
  params: BBJPayoutParams,
  note: string
): Promise<boolean> {
  let handId: string | null = null;
  try {
    const { data: hh } = await supabase
      .from('hand_history')
      .select('id')
      .eq('table_id', params.tableId)
      .eq('hand_number', params.handNumber)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (hh?.id) handId = hh.id as string;
  } catch {
    /* the (table_id, hand_number, kind) index dedupes a null hand_id */
  }

  let queueError = '';
  for (let attempt = 1; attempt <= QUEUE_INSERT_ATTEMPTS; attempt++) {
    const { error } = await supabase.from('pending_fee_distributions').insert({
      table_id: params.tableId,
      club_id: params.clubId,
      hand_id: handId,
      hand_number: params.handNumber,
      rake: 0,
      bbj: 0,
      pot: 0,
      num_players: params.dealtInPlayerIds.length,
      contributions: params as unknown as Record<string, unknown>,
      kind: 'bbj_payout',
      last_error: note.slice(0, 500),
    });
    if (!error) {
      console.warn(
        `[BBJ] Claimed jackpot payout for table ${params.tableId} hand #${params.handNumber} ` +
          `(${params.dealtInPlayerIds.length} recipients): ${note}`
      );
      return true;
    }
    if (/duplicate|unique/i.test(error.message || '')) {
      /* WRITE-AHEAD MADE THIS THE ORDINARY PATH (phase 2.1). The claim is
         written before the first attempt, so a later call finds its own row.
         Refresh the note so the open row carries the CURRENT reason rather
         than "not yet attempted". */
      const { error: refreshError, count } = await supabase
        .from('pending_fee_distributions')
        .update({ last_error: note.slice(0, 500) }, { count: 'exact' })
        .eq('table_id', params.tableId)
        .eq('hand_number', params.handNumber)
        .eq('kind', 'bbj_payout')
        .is('resolved_at', null);
      if (!refreshError && count === 1) return true;
      queueError = refreshError?.message || 'No single open jackpot claim was confirmed';
      break;
    }
    queueError = error.message || String(error);
    if (!TRANSIENT_DB_ERROR.test(queueError) || attempt === QUEUE_INSERT_ATTEMPTS) break;
    await new Promise((r) => setTimeout(r, QUEUE_BACKOFF_MS(attempt)));
  }
  // The caller (processBBJPayout) raises the CRITICAL alert with every
  // parameter; this one says the durable copy is missing too.
  reportError(
    new Error(
      `[BBJ] Could not queue the unpaid jackpot for table ${params.tableId} hand #${params.handNumber}: ` +
        `${queueError}. Durable queue persistence is not confirmed.`
    ),
    'FeeReconciler.bbj_payout_queue_failed'
  );
  return false;
}

/**
 * Close a write-ahead claim once the outcome is known: the money landed, it
 * had already landed, or nothing will ever be owed for this hand.
 *
 * Leaving a settled hand's claim open would have the drain re-drive a payout
 * that is finished - harmless, because the RPC answers `already_paid`, but it
 * would burn 25 attempts and end in a CRITICAL alert about a hand that paid
 * correctly. An alarm that fires on success is how real alarms get ignored.
 */
export async function settleBBJPayoutClaim(params: BBJPayoutParams, note: string): Promise<void> {
  const { error } = await supabase
    .from('pending_fee_distributions')
    .update({
      resolved_at: new Date().toISOString(),
      last_attempt_at: new Date().toISOString(),
      last_error: note.slice(0, 500),
    })
    .eq('table_id', params.tableId)
    .eq('hand_number', params.handNumber)
    .eq('kind', 'bbj_payout')
    .is('resolved_at', null);
  if (error) {
    /* Not fatal: the money is placed. The drain re-reads the row, the RPC
       answers already_paid, and the bbj_payout branch resolves it. */
    console.warn(
      `[BBJ] Could not close the payout claim for table ${params.tableId} hand #${params.handNumber}:`,
      error.message
    );
  }
}

setBBJPayoutQueue({ claim: queueUnpaidBBJPayout, settle: settleBBJPayoutClaim });

/**
 * Durably record a fee that left the pot but could not be banked.
 *
 * Deliberately loud on failure: if even this insert fails, the chips really are
 * unrecoverable from data, and the alert is all that stands between that and a
 * silent shortfall. The partial unique index on (hand_id, kind) where
 * resolved_at is null makes a duplicate queue attempt a harmless no-op.
 *
 * Only the protocol-1 compatibility path reaches this (see the module header),
 * and production refuses such a hand at the hand door. The row is the durable
 * record that the fee is owed; no timer re-drives it (2026-09-22).
 */
export async function queueUnbankedFee(kind: PendingFeeKind, fee: UnbankedFee): Promise<void> {
  try {
    // RETRIED (2026-08-22). This is the last line of defence, and it was a
    // single attempt: one transient blip and the safety net itself was the
    // thing that failed. Measured over 2026-08-20..22, 938 of 988 of these
    // alerts said `supabase_timeout` — the exact condition the net exists to
    // survive. The insert is idempotent by index, so repeating it is free.
    const insertOnce = async (): Promise<{ done: boolean; error: string }> => {
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
      if (!error) return { done: true, error: '' };
      // Already queued by an earlier attempt (possibly one that committed and
      // then timed out on us). Nothing is lost: the durable claim exists.
      if (/duplicate|unique/i.test(error.message || '')) return { done: true, error: '' };
      return { done: false, error: error.message || String(error) };
    };

    let lastError = '';
    for (let attempt = 1; attempt <= QUEUE_INSERT_ATTEMPTS; attempt++) {
      const res = await insertOnce();
      if (res.done) return;
      lastError = res.error;
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
    await alarmUnqueueableFee(kind, fee, lastError);
  } catch (err) {
    reportError(err, 'FeeReconciler.queue_threw');
  }
}

/**
 * The last word on a fee that could not be queued: ask whether the chips are
 * really missing, and alarm only if the answer is a definite no.
 *
 * Split out of queueUnbankedFee so every terminal queue-insert outcome reaches
 * the same evidence check and the same durable alert boundary.
 */
async function alarmUnqueueableFee(
  kind: PendingFeeKind,
  fee: UnbankedFee,
  lastError: string
): Promise<void> {
  try {
    const verdict = await feeIsAccountedFor(kind, fee);
    if (verdict === 'yes') {
      console.warn(
        `[A5] Queue insert for ${kind} on hand ${fee.handId ?? fee.handNumber} reported ` +
          `"${lastError}", but the fee is already queued or banked - no chips at risk, ` +
          `not alarming.`
      );
      return;
    }
    /* STILL FAILS CLOSED (and this is deliberate, 2026-09-08).
       `unknown` means the check itself could not run - so it is NOT evidence
       that the fee is banked, and it does not suppress the alarm. That rule
       predates this change and stays: chips have already left the pot, and
       silence about them is the one outcome worse than a false alarm.

       The durable claim insert gets the bounded transient retries above before
       this evidence check. A response timeout can mean the write committed, so
       the final read distinguishes that ambiguous transport result from a
       proven missing fee before choosing the alert wording.

       And the alarm no longer overstates itself. `verifiedUnbanked: true` used
       to be written whether or not the verification had run. */
    const verified = verdict === 'no';
    const detail =
      `[A5] Could not queue unbanked ${kind} for hand ${fee.handId ?? fee.handNumber} ` +
      `(rake ${fee.rake}, bbj ${fee.bbj}): ${lastError}. These chips left the pot and ` +
      `are now recoverable only by hand.` +
      (verified
        ? ''
        : ` The database could not be asked whether the fee is already banked, so this is unverified.`);
    reportError(new Error(detail), 'FeeReconciler.queue_failed');
    // error reporting alone is not enough for a money alarm: financial_alerts is the
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
      verifiedUnbanked: verified,
      verificationUnavailable: !verified,
    });
  } catch (err) {
    reportError(err, 'FeeReconciler.alarm_threw');
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
 *      so the owed fee is on disk and nothing is lost. The duplicate-
 *      key path above catches this only when Postgres gets to answer; a
 *      timeout is precisely when it does not.
 *   2. THE FEE IS ALREADY BANKED — the banking call succeeded and only its
 *      response was lost.
 *
 * Fails CLOSED: anything unknown — a thrown query, a missing hand number —
 * returns false, so the alarm is raised. Suppressing a money alert on a guess
 * would be worse than the noise it removes.
 */
/**
 * "Yes it landed", "no it did not", or "I could not ask".
 *
 * THE THIRD ANSWER IS THE POINT (2026-09-08). This used to return a boolean and
 * discard every error - `const { data } = await ...` never looked at `error`,
 * and the catch returned false. So while PostgREST was reloading its schema
 * cache, the check that decides whether chips are really missing could not run
 * either, answered "no" for every hand, and turned a survivable window into 23
 * critical money alarms. All 23 were false: every one of those fees was banked,
 * 58.27 rake and 7.90 BBJ, none of it ever at risk.
 *
 * Dan, binding: "HAVE THE PUSH NOTIFICATIONS STOP UPDATING ME FOR 0.00 OR
 * FIXES, ONLY CRITICAL ERRORS THAT NEED MY ATTENTION." A critical raised because
 * we could not reach the database is exactly a 0.00. Only a definite `no` may
 * alarm now; `unknown` keeps retrying instead.
 */
type AccountedVerdict = 'yes' | 'no' | 'unknown';

async function feeIsAccountedFor(
  kind: PendingFeeKind,
  fee: UnbankedFee
): Promise<AccountedVerdict> {
  /** A read that errored proves nothing - least of all that chips are gone. */
  let couldNotAsk = false;
  // PostgrestBuilder is thenable, not a Promise, so PromiseLike is the type.
  const asked = async (
    run: () => PromiseLike<{ data: unknown; error: unknown }>
  ): Promise<boolean> => {
    try {
      const { data, error } = await run();
      if (error) {
        couldNotAsk = true;
        return false;
      }
      return !!data;
    } catch {
      couldNotAsk = true;
      return false;
    }
  };

  // Cheapest check, and the one that is true most often.
  if (Number(fee.handNumber) > 0) {
    if (
      await asked(() =>
        supabase
          .from('pending_fee_distributions')
          .select('id')
          .eq('table_id', fee.tableId)
          .eq('hand_number', fee.handNumber)
          .eq('kind', kind)
          .limit(1)
          .maybeSingle()
      )
    )
      return 'yes';
  }

  if (kind === 'rake') {
    if (fee.handId) {
      if (
        await asked(() =>
          supabase
            .from('rake_records')
            .select('id')
            .eq('hand_id', fee.handId)
            .limit(1)
            .maybeSingle()
        )
      )
        return 'yes';
    }
    if (Number(fee.handNumber) > 0) {
      // global_hand_id carries the hand number; scoped by table so it cannot
      // match another table's hand.
      if (
        await asked(() =>
          supabase
            .from('rake_records')
            .select('id')
            .eq('table_id', fee.tableId)
            .eq('global_hand_id', fee.handNumber)
            .limit(1)
            .maybeSingle()
        )
      )
        return 'yes';
    }
    return couldNotAsk ? 'unknown' : 'no';
  }

  if (Number(fee.handNumber) > 0) {
    if (
      await asked(() =>
        supabase
          .from('bbj_contributions')
          .select('id')
          .eq('table_id', fee.tableId)
          .eq('hand_number', fee.handNumber)
          .limit(1)
          .maybeSingle()
      )
    )
      return 'yes';
  }
  return couldNotAsk ? 'unknown' : 'no';
}

/**
 * Complete the jackpot payout claims (`bbj_payout`) the live payout could not
 * land: deferred by the maintenance freeze, or left open by a process that died
 * between its write-ahead claim and the payout. Returns a small summary so the
 * caller can log one line.
 *
 * It reads ONLY `bbj_payout` rows (2026-09-22). The rake and BBJ drop of an
 * accepted hand are banked by the hand's own post-commit envelope, so a queued
 * row of any other kind is never re-driven and never touched here. The module
 * header says why that re-drive was harmful as well as redundant.
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
  /* DEFERRED IS ITS OWN OUTCOME (2026-09-11). A jackpot row skipped because
     the platform is on its maintenance break is neither resolved nor still
     failing, and folding it into either would be a signal answering when it
     has deliberately not looked (CLAUDE.md 10.86). scanned - resolved -
     stillFailing must still add up, so the deferral has to be countable. */
  deferredFrozen: number;
}> {
  const summary = { scanned: 0, resolved: 0, stillFailing: 0, exhausted: 0, deferredFrozen: 0 };

  const { data, error } = await supabase
    .from('pending_fee_distributions')
    .select(
      'id, table_id, club_id, hand_id, hand_number, rake, bbj, pot, num_players, contributions, returned_uncalled, rake_method, tournament_id, big_blind, kind, attempts'
    )
    .eq('kind', 'bbj_payout')
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
    /* ═══════════════════════════════════════════════════════════════════════
       THE SWEEP CHECKS THE FREEZE, FOR EVERY KIND (section 13 rule 5, 2026-09-11)
       ═══════════════════════════════════════════════════════════════════════

       Every row this loop re-drives moves money: a `bbj_payout` credits
       seats. Dan, section 13: "NO CHIP MOVEMENTS." (Until 2026-09-22 the loop
       also re-drove `rake` through `atomic_distribute_rake` and BBJ drops
       through `logBBJCollection`; those are the hand's own envelope now.)

       The first cut of this check gated only the jackpot branch, on the
       reasoning that jackpots were what this programme was about. That left
       the other two moving money through the break, and made the check's own
       justification false: it is here so that a caller which forgets to gate
       the cycle cannot slip money through, and two thirds of the money was
       still slipping. `GameServer` does return early while frozen, but the
       cycle is sized to run "comfortably under a minute of sequential RPCs" -
       a freeze that begins MID-cycle is exactly the case a caller-level gate
       cannot cover, and exactly the case this one is for.

       The row is left completely untouched rather than attempted and failed:
       bumping its attempt counter and writing a failure message would read in
       the log as work that failed, when what happened is a break we scheduled.
       It is also checked FIRST, before any read or write below, so a deferred
       row costs nothing either. */
    if (isMaintenanceFrozen()) {
      summary.deferredFrozen++;
      continue;
    }

    /* THE READ ABOVE ASKS FOR JACKPOT CLAIMS ONLY (2026-09-22). A row of any
       other kind is not work this drain owns: the rake and BBJ drop of an
       accepted hand are banked by its own post-commit envelope. So it is never
       re-driven and never written here, not even its attempt counter. It is
       counted as still open and said out loud, because a read that returned
       it has broken its own filter. */
    if (row.kind !== 'bbj_payout') {
      summary.stillFailing++;
      reportError(
        new Error(
          `[A5] pending_fee_distributions row ${row.id} (kind ${row.kind}) reached the jackpot ` +
            `claim drain; left untouched, because only a bbj_payout claim is this drain's work`
        ),
        'FeeReconciler.not_a_jackpot_claim'
      );
      continue;
    }

    let ok = false;
    let failureMessage = '';
    /* A jackpot that landed from the durable fee queue rather than live. The table is told
       when it does, so the celebration still happens - late, but it happens
       (phase 2.2). */
    let paidLate: {
      tableId: string;
      handNumber: number;
      totalPayout?: number;
      kind?: 'main' | 'mini';
    } | null = null;

    try {
      // BBJ AUDIT 2026-09-05: re-drive a jackpot payout the live path could
      // not land. The parameter set was frozen at hit time (who was dealt
      // in, who took the beat, who beat them, the tier's percent). The ONE
      // thing re-read live is who is still seated: the RPC credits a seat
      // that is still there and the club wallet of anyone who has left, and
      // "still there" is a fact about NOW, not about the moment the hit was
      // queued. Both routes are durable and both are keyed, so a recipient
      // is paid exactly once whichever one they land on.
      const p = row.contributions as unknown as Partial<BBJPayoutParams> | null;
      if (
        !p ||
        !p.tableId ||
        !p.clubId ||
        !p.loserUserId ||
        !p.winnerUserId ||
        p.tableId !== row.table_id ||
        p.clubId !== row.club_id ||
        !Number.isSafeInteger(row.hand_number) ||
        row.hand_number <= 0 ||
        (p.handNumber != null && p.handNumber !== row.hand_number) ||
        typeof p.loserUserId !== 'string' ||
        typeof p.winnerUserId !== 'string' ||
        p.loserUserId === p.winnerUserId ||
        !Array.isArray(p.dealtInPlayerIds) ||
        p.dealtInPlayerIds.some((id) => typeof id !== 'string' || id.trim() === '') ||
        typeof p.payoutTotalPercent !== 'number' ||
        !Number.isFinite(p.payoutTotalPercent) ||
        p.payoutTotalPercent < 0 ||
        (p.kind !== 'mini' && p.payoutTotalPercent === 0) ||
        p.payoutTotalPercent > 100 ||
        (p.kind !== undefined && p.kind !== 'main' && p.kind !== 'mini') ||
        (p.kind === 'mini' && !p.tierId)
      ) {
        ok = false;
        failureMessage =
          'bbj_payout row is missing its parameters or has an invalid operation identity';
      } else {
        const { data: seats } = await supabase
          .from('table_seats')
          .select('user_id')
          .eq('table_id', p.tableId)
          .is('left_at', null);
        const seatedNow = new Set((seats ?? []).map((s) => s.user_id as string));
        const outcome = await processBBJPayout(
          {
            tableId: p.tableId,
            clubId: p.clubId,
            handNumber: Number(p.handNumber ?? row.hand_number),
            loserUserId: p.loserUserId,
            winnerUserId: p.winnerUserId,
            loserHandName: p.loserHandName || 'Unknown',
            winnerHandName: p.winnerHandName || 'Unknown',
            dealtInPlayerIds: p.dealtInPlayerIds,
            seatedUserIds: p.dealtInPlayerIds.filter((id) => seatedNow.has(id)),
            payoutTotalPercent: p.payoutTotalPercent,
            kind: p.kind,
            tierId: p.tierId,
            metadata: p.metadata,
          },
          { fromQueue: true }
        );
        /* The outcome says which of the four happened (phase 2.1). Before it,
           this branch got `null` for "already paid", "nothing to pay" and
           "failed again" alike and had to ask the ledger which one it was -
           and a write-ahead claim for a hand that can never pay (an empty
           pool) would have re-driven all the way to a critical alert. */
        ok =
          outcome.status === 'paid' ||
          outcome.status === 'already_paid' ||
          outcome.status === 'nothing_to_pay';
        if (outcome.status === 'paid' || outcome.status === 'already_paid') {
          paidLate = {
            tableId: p.tableId,
            handNumber: Number(p.handNumber ?? row.hand_number),
            kind: p.kind,
            totalPayout: outcome.status === 'paid' ? outcome.result.totalPayout : undefined,
          };
        }
        if (outcome.status === 'nothing_to_pay') {
          failureMessage = `nothing to pay (${outcome.reason}); claim closed`;
        } else if (!ok) {
          failureMessage = outcome.status === 'queued' ? outcome.lastError : 'unknown outcome';
        }
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

    const { error: updErr, count: updatedCount } = await supabase
      .from('pending_fee_distributions')
      .update(patch, { count: 'exact' })
      .eq('id', row.id);
    const marked = !updErr && updatedCount === 1;

    if (!marked) {
      // The fee itself is banked (or not) regardless of this bookkeeping write.
      // Leaving the row open is the safe direction: the next cycle re-drives it,
      // and both underlying operations are idempotent.
      reportError(
        updErr ?? new Error(`Expected one queue row acknowledgement, received ${updatedCount}`),
        'FeeReconciler.mark_failed'
      );
    }

    /* THE CELEBRATION STILL HAPPENS, LATE (BBJ phase 2.2). A jackpot the live
       path could not pay - the :55 freeze is the ordinary cause - was
       announced to the table as PENDING by the engine. This is the other half
       of that promise: when the drain finally lands it, the table is told, so
       the players see the payout instead of chips that simply appeared. The
       engine that owns the table may be a different process by now; the hub is
       per-process, so this reaches whoever is hosting it, and the retained
       window carries it to a socket that reconnects. Never fatal: the money is
       placed either way. */
    if (ok && paidLate) {
      try {
        /* LAZY, and deliberately so. A static import of the transport here
           pulls TableStateHub -> handFacts -> the real Supabase client into
           module-init for every consumer of this file, which broke an
           unrelated test with a temporal-dead-zone error on `reportError`
           before it broke anything in production. A late payout is rare;
           paying one import for it at call time is the right trade. */
        const { tableStateHub } = await import('../transport/TableStateHub.js');
        tableStateHub.emitEvent(paidLate.tableId, {
          type: 'bbj_payout_paid',
          kind: paidLate.kind ?? 'main',
          table_id: paidLate.tableId,
          hand_number: paidLate.handNumber,
          totalPayout: paidLate.totalPayout,
          emitted_at: Date.now(),
          replay_until: Date.now() + 60_000,
        });
      } catch (e) {
        console.warn('[BBJ] could not announce the late payout (money is placed):', e);
      }
    }

    if (!marked) {
      summary.stillFailing++;
    } else if (ok) {
      summary.resolved++;
    } else if (attempts >= MAX_RECONCILE_ATTEMPTS) {
      summary.exhausted++;
      const detail =
        `[A5] Queued ${row.kind} claim for hand ${row.hand_id ?? row.hand_number} still failing ` +
        `after ${attempts} attempts: ${failureMessage}. ` +
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
 * A CONDITION IS ONE ALERT, HOWEVER LONG IT STAYS TRUE (BBJ build plan phase 1).
 *
 * For a periodic audit that re-measures the same fact every cycle. While the
 * condition holds, exactly one unresolved financial_alerts row exists for
 * `source`: raised the first time, refreshed (message + context) on later
 * cycles so the operator sees the CURRENT figures, and resolved automatically
 * - with a note - the first cycle the condition is false. error reporting hears about
 * it once, when it is raised.
 *
 * Never throws: bookkeeping about an alarm must not fail the audit.
 */
export async function raiseOrRefreshCondition(
  source: string,
  isTrue: boolean,
  message: string,
  context: Record<string, unknown>
): Promise<'raised' | 'refreshed' | 'resolved' | 'quiet'> {
  try {
    const { data: open } = await supabase
      .from('financial_alerts')
      .select('id, message')
      .eq('source', source)
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (isTrue) {
      if (open?.id) {
        if (open.message !== message) {
          await supabase
            .from('financial_alerts')
            .update({ message, context: { ...context, refreshed_at: new Date().toISOString() } })
            .eq('id', open.id);
        }
        return 'refreshed';
      }
      reportError(new Error(message), source);
      await raiseFinancialAlert('warning', source, message, context);
      return 'raised';
    }

    if (open?.id) {
      await supabase
        .from('financial_alerts')
        .update({
          resolved: true,
          resolved_at: new Date().toISOString(),
          resolution: `Cleared by the next audit cycle: the condition is no longer true. ${JSON.stringify(context)}`,
        })
        .eq('id', open.id);
      return 'resolved';
    }
    return 'quiet';
  } catch (e) {
    console.warn(`[FeeReconciler] raiseOrRefreshCondition(${source}) failed:`, e);
    return 'quiet';
  }
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
    /* ONE OPEN ROW PER CONDITION (BBJ build plan phase 1, 2026-09-05).
       This audit runs hourly and used to raise a NEW warning every hour for
       the same 3.5 chips - 24 identical rows a day, each also a error reporting event
       - which is precisely the pattern that buried the nine real alerts on
       2026-08-22 under 988 duplicates. A condition that is still true is
       still ONE fact: the open row is refreshed with the current figures, a
       new row is raised only when there is none, and when the condition
       clears the row is resolved with a note saying so. */
    await raiseOrRefreshCondition(
      'FeeReconciler.bbj_unlinkable',
      unlinkableChips > toleranceChips,
      `[A5] ${unlinkableChips} chips of BBJ contribution over the last ${windowDays}d sit on ` +
        `${unlinkableRows} rake_records row(s) with NO hand_id, so they can be reconciled ` +
        `against the jackpot pool by neither this audit nor fn_bbj_repair_unbanked. ` +
        /* THIS SENTENCE USED TO NAME ONE CAUSE AND IT WAS THE WRONG ONE
           (BBJ programme close-out, 2026-09-07). It read "rising numbers here
           mean logHandHistory is failing and returning a null id", which sends
           the reader hunting for jackpot chips that never left. Measured on all
           71 orphan rows of the preceding two days: every one had a properly
           linked SIBLING row for the same hand carrying the same contribution,
           and bbj_contributions held 0.99 rows per hand with ZERO hands banked
           twice. The drop reached the pool exactly once. The orphan is a
           DUPLICATE audit row - the tracked chip_standard.duplicate_rake_
           attribution incident (4,452 rows, 2026-04-16..09-05) - not a lost
           contribution.
           Both causes are real and they need different people, so the alert now
           says how to tell them apart instead of choosing for the reader
           (CLAUDE.md 10.86). */
        `THIS IS NOT PROOF OF MISSING CHIPS. Check first whether each orphan has a ` +
        `sibling rake_records row for the same (table_id, metadata->>'hand_number') that ` +
        `DOES carry a hand_id: if it does, the drop was banked once and the orphan is a ` +
        `duplicate audit row (chip_standard.duplicate_rake_attribution owns that). Only if ` +
        `there is no such sibling is logHandHistory returning a null id and a contribution ` +
        `genuinely unreconcilable. fn_bbj_conservation_check and FeeReconciler.bbj_drift are ` +
        `what say whether chips are actually short.`,
      { windowDays, unlinkableRows, unlinkableChips }
    );

    await raiseOrRefreshCondition(
      'FeeReconciler.bbj_drift',
      Math.abs(drift) > toleranceChips,
      `[A5] BBJ ledger drift over the last ${windowDays}d: rake_records booked ${booked} ` +
        `of BBJ contribution, bbj_contributions received ${received} (drift ${drift}). ` +
        `A positive drift means chips left pots and never reached the jackpot pool.`,
      { windowDays, booked, received, drift }
    );
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

/**
 * SATELLITE CONSERVATION watchdog (2026-08-30 satellite audit, phase 3).
 *
 * Two failure shapes shipped silently in one week and this makes both loud:
 *
 *   1. UNPAID WINNERS — a finisher inside the awardable count who received
 *      neither a funded seat (rake_records / fn_award_satellite_seat) nor
 *      prize cash. Four players won satellites and got nothing.
 *   2. DISBURSED BEYOND THE PROMISE — cash + funded seats worth more than
 *      max(pool, awardable_seats x ticket). The guarantee overlay is the
 *      advertised promise and is allowed; the pre-#1935 face-value cash bug
 *      (4,132.50 chips, now an acknowledged baseline) was not.
 *
 * The arithmetic lives in fn_satellite_conservation_audit so the check reads
 * the same ledgers the money moved through. Read-only: it reports, it never
 * repairs.
 *
 * CORRECTED 2026-08-31 (migration prize_disbursement_audit_and_three_false_alarms).
 * Shape 1 as originally written produced a FALSE critical every hour on
 * ccb686f8: pool 216, ticket 200, target already closed, so the whole 216
 * went out as cash to the finisher and the money conserved exactly — but the
 * check computed awardable = GREATEST(configured 2, floor(216/200)=1) = 2 and
 * then demanded that position 2 be paid as well. A satellite whose pool funds
 * one seat does not owe a second player anything, and how a cash fallback
 * splits is the payout structure's business, not a conservation invariant.
 * Shape 2's allowance, GREATEST(pool, awardable x ticket), was too generous
 * the same way: it would have let that satellite pay 400 against a 216 pool
 * in silence. The SQL now states conservation symmetrically —
 *   disbursed = cash + seats x ticket, allowance = pool + acknowledged,
 *   excess (minted) or undisbursed (kept back) — and needs no seat count.
 */
/**
 * A GUARANTEE IS A PROMISE, AND NOTHING WAS CHECKING IT (2026-08-31, phase 6).
 *
 * Every guarantee check in this estate is a PRE-START affordability check, or
 * it excludes the events that actually fail. Enumerated against production:
 * trg_tournaments_guarantee_affordable is scoped to ANNOUNCED/REGISTERING/
 * RUNNING; fn_overlay_at_risk and fn_audit_overlays both require
 * `buy_in_amount > 0`, which excludes every freeroll; fn_tournament_metrics
 * (the phase 2 unpaid detector) filters `prize_pool > 0`, which is the exact
 * column this defect zeroes.
 *
 * So a freeroll - whose pool is 0 by construction and whose guarantee is
 * therefore the only money it will ever have - was invisible to all of them.
 * Nine of them ranked a full field, up to 326 players, stamped a winner, and
 * paid zero chips to anybody, with no alert from any source.
 *
 * This asks the question nothing asked: did a COMPLETED guaranteed event
 * actually PAY its guarantee? It reads tournament_payouts, not prize_pool,
 * for the reason phase 3 built the record - a settled question is answered
 * from evidence, not from a column an outage can overwrite.
 *
 * It detects and never repairs. The engine now funds the guarantee on the
 * finish path; the historical backlog is an owner's decision, not a sweep's.
 */
export async function auditGuaranteesKept(
  windowHours = 24
): Promise<{ shortOfGuarantee: number } | null> {
  try {
    const { data, error } = await supabase.rpc('fn_tournament_guarantee_check', {
      p_hours: windowHours,
    });
    if (error) {
      reportError(error, 'FeeReconciler.guarantee_check_query_failed');
      return null;
    }
    const r = (data ?? {}) as {
      checked?: number;
      short_of_guarantee?: number;
      paid_nothing?: number;
      chips_short?: number;
      alerts_raised?: number;
    };
    const short = Number(r.short_of_guarantee ?? 0);
    if (short > 0) {
      console.warn(
        `[FeeReconciler] guarantee check: ${short} of ${r.checked ?? 0} completed guaranteed event(s) ` +
          `paid under their guarantee in the last ${windowHours}h ` +
          `(${r.paid_nothing ?? 0} paid nothing at all, ${r.chips_short ?? 0} chips short, ` +
          `${r.alerts_raised ?? 0} new alert(s)).`
      );
    }
    return { shortOfGuarantee: short };
  } catch (err) {
    reportError(err, 'FeeReconciler.guarantee_check_failed');
    return null;
  }
}

export async function auditSatelliteConservation(
  windowHours = 24
): Promise<{ violations: number } | null> {
  try {
    const { data, error } = await supabase.rpc('fn_satellite_conservation_audit', {
      p_hours: windowHours,
    });
    if (error) {
      reportError(error, 'FeeReconciler.satellite_conservation_query_failed');
      return null;
    }
    const rows = (data ?? []) as Array<{
      satellite_id: string;
      satellite_name: string;
      pool: number;
      ticket_cost: number;
      awardable: number;
      seats_funded: number;
      cash_paid: number;
      unpaid_winners: number;
      excess_disbursed: number;
    }>;
    if (rows.length === 0) return { violations: 0 };

    const detail =
      `SATELLITE_CONSERVATION: ${rows.length} completed satellite(s) in the last ${windowHours}h ` +
      `broke conservation: ` +
      rows
        .slice(0, 10)
        .map(
          (r) =>
            `${r.satellite_id.slice(0, 8)} "${r.satellite_name}" (pool ${r.pool}, seats ${r.seats_funded}/${r.awardable}, ` +
            `cash ${r.cash_paid}, unpaid winners ${r.unpaid_winners}, excess ${r.excess_disbursed})`
        )
        .join('; ');
    reportError(new Error(detail), 'FeeReconciler.satellite_conservation');
    await raiseFinancialAlert('critical', 'FeeReconciler.satellite_conservation', detail, {
      windowHours,
      violations: rows.length,
      rows: rows.slice(0, 50),
    });
    return { violations: rows.length };
  } catch (err) {
    reportError(err, 'FeeReconciler.satellite_conservation_threw');
    return null;
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PRIZE DISBURSEMENT watchdog — read the LEDGER, not the snapshot
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS. On 2026-08-30 "Sunday $200 Deep Stack" paid 62,841.60
 * against a 44,640 prize pool — 18,201.60 of chips that came from nowhere. A
 * recovery payout paid places 1-9 on the pre-reset 20,880 pool; the outage
 * reset then re-opened the event, it was replayed, and the reconciler paid
 * the NEW places 1-9 in full. Eight of the first-run recipients finished
 * 62nd-109th on the replay and kept money for places they no longer hold.
 *
 * EVERY EXISTING CHECK STAYED GREEN, and the reason is the whole point of
 * this function. TournamentSentinel.payout_conservation compares
 * SUM(tournament_players.prize) against prize_pool — but the reset OVERWROTE
 * tournament_players, so that sum read 44,640, exactly the pool. The
 * double payment existed only in wallet_transactions, which a reset cannot
 * rewrite. A conservation check that reads a mutable snapshot is measuring
 * the wrong object; this one reads the ledger.
 *
 * ACKNOWLEDGED, NOT FORGIVEN. tournament_conservation_baseline carries the
 * known historical excesses (including the 18,201.60, recorded with its
 * cause and with Dan named as the decision owner for any clawback), so this
 * speaks only for NEW drift. Read-only: it reports, it never repairs.
 */
/**
 * ONE SHORTFALL, ONE PAYMENT (2026-09-02).
 *
 * A tournament prize obligation can be topped up by more than one repair
 * path. `overlay_backpay`, `reconcile` and `spin_backpay` all exist to find a
 * player who was paid less than they were owed and make them whole. Each one
 * builds its idempotency key out of its OWN name:
 *
 *   tourney:<tid>:overlay_backpay:<uid>
 *   tourney:<tid>:prize:<uid>:<place>:reconcile
 *
 * Those are the SAME DEBT under two different names, so
 * uq_tournament_payouts_idempotency_key cannot see them as one and both pay.
 * The key is namespaced by the repairer instead of by the thing repaired.
 *
 * Measured when this was written: 57 completed events in seven days paid out
 * more prize money than their pool, 3,808.52 chips, and 56 obligations were
 * provably this pattern. It is invisible to auditPrizeDisbursement above,
 * which only reports that an event over-paid IN TOTAL and never says why -
 * this one names the player, the place and the two paths that both paid.
 *
 * NOT a bounty problem, despite bounty events dominating the excess list. A
 * knockout pays into wallet_transactions.category = 'bounty', which the prize
 * audit never counts; on the worst offender bounty reconciled exactly
 * (1,020.00 paid against a 1,020.00 pool). Bounty sources are excluded from
 * this check for the same reason: a player who busts four opponents correctly
 * receives four equal payments at one finishing position.
 *
 * Reports, never repairs. Deciding whether an over-payment is clawed back
 * from a player is Dan's call, not an auto-repair loop's.
 */
export async function auditDoublePaidObligations(
  windowHours = 24
): Promise<{ violations: number; excess: number } | null> {
  try {
    const { data, error } = await supabase.rpc('fn_tournament_double_paid_obligations', {
      p_hours: windowHours,
    });
    if (error) {
      reportError(error, 'FeeReconciler.double_paid_query_failed');
      return null;
    }
    const rows = (data ?? []) as Array<{
      tournament_id: string;
      tournament_name: string;
      player_id: string;
      finish_position: number;
      amount: number;
      payments: number;
      sources: string;
      excess_chips: number;
    }>;
    if (rows.length === 0) return { violations: 0, excess: 0 };

    const excess = rows.reduce((s, r) => s + (Number(r.excess_chips) || 0), 0);
    const detail =
      `DOUBLE_PAID_OBLIGATION: ${rows.length} prize obligation(s) in the last ${windowHours}h ` +
      `were settled by more than one repair path (${excess.toFixed(2)} chips paid twice): ` +
      rows
        .slice(0, 10)
        .map(
          (r) =>
            `${r.tournament_id.slice(0, 8)} "${r.tournament_name}" place ${r.finish_position} ` +
            `player ${String(r.player_id).slice(0, 8)} ${r.amount} x${r.payments} via ${r.sources}`
        )
        .join('; ');
    reportError(new Error(detail), 'FeeReconciler.double_paid_obligation');
    await raiseFinancialAlert('critical', 'FeeReconciler.double_paid_obligation', detail, {
      windowHours,
      violations: rows.length,
      excessTotal: Number(excess.toFixed(2)),
      rows: rows.slice(0, 50),
    });
    return { violations: rows.length, excess };
  } catch (err) {
    reportError(err, 'FeeReconciler.double_paid_threw');
    return null;
  }
}

export async function auditPrizeDisbursement(
  windowHours = 24
): Promise<{ violations: number; excess: number } | null> {
  try {
    const { data, error } = await supabase.rpc('fn_tournament_prize_disbursement_audit', {
      p_hours: windowHours,
    });
    if (error) {
      reportError(error, 'FeeReconciler.prize_disbursement_query_failed');
      return null;
    }
    const rows = (data ?? []) as Array<{
      tournament_id: string;
      name: string;
      variant: string;
      prize_pool: number;
      disbursed: number;
      acknowledged: number;
      excess: number;
    }>;
    if (rows.length === 0) return { violations: 0, excess: 0 };

    const excess = rows.reduce((s, r) => s + (Number(r.excess) || 0), 0);
    const detail =
      `PRIZE_DISBURSEMENT: ${rows.length} completed tournament(s) in the last ${windowHours}h ` +
      `paid out more than their prize pool (${excess.toFixed(2)} chips beyond pool + acknowledged): ` +
      rows
        .slice(0, 10)
        .map(
          (r) =>
            `${r.tournament_id.slice(0, 8)} "${r.name}" (${r.variant}: pool ${r.prize_pool}, ` +
            `disbursed ${r.disbursed}, excess ${r.excess})`
        )
        .join('; ');
    reportError(new Error(detail), 'FeeReconciler.prize_disbursement');
    await raiseFinancialAlert('critical', 'FeeReconciler.prize_disbursement', detail, {
      windowHours,
      violations: rows.length,
      excessTotal: Number(excess.toFixed(2)),
      rows: rows.slice(0, 50),
    });
    return { violations: rows.length, excess };
  } catch (err) {
    reportError(err, 'FeeReconciler.prize_disbursement_threw');
    return null;
  }
}
