/**
 * Supabase helpers — Bad Beat Jackpot contribution and payout.
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 *
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';
import { raiseFinancialAlert } from '../financialAlerts.js';
import { bbjSharesParkedTotal } from '../../observability/engineInstruments.js';

/**
 * BBJ AUDIT 2026-09-05: every club that shares a jackpot pool with `clubId`.
 *
 * A club inside a union banks into (and is paid from) the UNION pool, so a hit
 * at one of its tables is news at every table of every club in that union -
 * that is the whole point of a shared jackpot, and it is who Dan means by
 * "everyone currently playing in the club or union". A standalone club is its
 * own set of one.
 *
 * Used by the settlement's club-wide announcement (see
 * ServerTableEngineSettlement, bbj_payout step) to choose which live engines
 * receive the `bbj_hit_global` event. Never throws: an announcement must not
 * be able to fail a payout that has already landed. On any error it returns
 * the hitting club alone, which is never wrong, only smaller.
 */
export async function resolveJackpotSiblingClubIds(clubId: string): Promise<string[]> {
  try {
    const { data: club } = await supabase
      .from('clubs')
      .select('union_id')
      .eq('id', clubId)
      .maybeSingle();
    if (!club?.union_id) return [clubId];
    const { data: siblings } = await supabase
      .from('clubs')
      .select('id')
      .eq('union_id', club.union_id);
    const ids = new Set<string>([clubId]);
    for (const row of siblings ?? []) if (row?.id) ids.add(row.id as string);
    return [...ids];
  } catch (e) {
    console.warn('[resolveJackpotSiblingClubIds] falling back to the hitting club only:', e);
    return [clubId];
  }
}

/**
 * BBJ AUDIT 2026-09-05: which errors from the payout RPC are worth a retry.
 *
 * Same shape as FeeReconciler's TRANSIENT_DB_ERROR: transport, timeouts,
 * PostgREST schema-cache reloads (PGRST001/002 - 28 seconds each on this
 * database, CLAUDE.md §2), connection exhaustion, and the maintenance freeze
 * (a hand that finished at :54:59 has its payout land at :55:00, when
 * zz_freeze_guard refuses every money write for five minutes). The RPC is
 * idempotent on (pool, table, hand) - a retry after a success that timed out
 * on the way back returns `already_paid` and re-drives any missing credit -
 * so retrying is free, and NOT retrying is how a detected jackpot goes unpaid.
 */
const BBJ_PAYOUT_RETRYABLE =
  /timeout|timed out|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|502|503|504|57014|too many connections|schema cache|PGRST002|PGRST001|PLATFORM_FROZEN|payout_frozen|P0404|deadlock|could not serialize|40001|40P01/i;
const BBJ_PAYOUT_ATTEMPTS = 4;
/** 400ms, 1.2s, 3.6s - long enough to outlive a schema-cache reload retry loop, short enough to keep the felt moving. */
const BBJ_PAYOUT_BACKOFF_MS = (attempt: number): number => 400 * 3 ** (attempt - 1);

/**
 * The database resolves the table's private/union scope and posts its BBJ
 * contribution in one transaction. Only a matching receipt confirms banking.
 */
export async function logBBJCollection(
  tableId: string,
  clubId: string,
  handNumber: number,
  bbjAmount: number,
  bigBlind: number,
  handId: string | null = null
): Promise<boolean> {
  if (bbjAmount === 0) return true;
  if (!Number.isFinite(bbjAmount) || bbjAmount < 0) return false;

  const payment = {
    p_table_id: tableId,
    p_club_id: clubId,
    p_hand_number: handNumber,
    p_amount: bbjAmount,
    p_big_blind: bigBlind,
    p_hand_id: handId,
  };
  let failure = 'No matching committed contribution receipt';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data, error } = await supabase.rpc('bbj_record_table_contribution', payment);
      const receipt = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
      if (
        !error &&
        receipt?.id &&
        receipt.pool_id &&
        receipt.table_id === tableId &&
        receipt.club_id === clubId &&
        receipt.hand_id === handId &&
        Number(receipt.hand_number) === handNumber &&
        receipt.amount != null &&
        Number(receipt.amount) === bbjAmount &&
        receipt.big_blind != null &&
        Number(receipt.big_blind) === bigBlind
      ) {
        return true;
      }
      failure = error?.message ?? 'No matching committed contribution receipt';
      if (error?.code === '22023') break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
  }
  reportError(
    new Error(
      '[logBBJCollection] Cannot confirm BBJ payment for table ' +
        tableId +
        ', hand ' +
        handNumber +
        ': ' +
        failure
    ),
    'logBBJCollection.contribution_failed'
  );
  return false;
}

/**
 * Everything the payout RPC needs, and everything a human needs to re-drive
 * it by hand. This is what gets queued when the live attempt fails, so it
 * has to be complete on its own: the engine's memory of the hit does not
 * survive the next hand, let alone a restart.
 */
export interface BBJPayoutParams {
  kind?: 'main' | 'mini';
  tierId?: string;
  metadata?: Record<string, unknown>;
  tableId: string;
  clubId: string;
  handNumber: number;
  loserUserId: string;
  winnerUserId: string;
  loserHandName: string;
  winnerHandName: string;
  dealtInPlayerIds: string[];
  seatedUserIds: string[]; // currently-seated user_ids (engine memory) — decides seat-credit vs direct wallet-credit for departed recipients
  payoutTotalPercent: number; // e.g., 55 for Mid stakes = 55% of main pool
}

export interface BBJPayoutResult {
  totalPayout: number;
  loserShare: number;
  winnerShare: number;
  tableShare: number;
  perPlayerShare: number;
  poolId: string;
}

/**
 * What became of a jackpot the engine detected. `null` used to carry four
 * different meanings here - paid, already paid, nothing to pay, and could not
 * pay - so the caller could not tell a settled hand from a lost one, and the
 * table had no way to say "paying after the break" (BBJ phase 2).
 */
export type BBJPayoutOutcome =
  | { status: 'paid'; result: BBJPayoutResult }
  /** A replay: the money was already placed, and the RPC re-drove any missing credit. */
  | { status: 'already_paid' }
  /** Nothing will ever be paid for this hand: no pool, an empty pool, a refused argument. */
  | { status: 'nothing_to_pay'; reason: string }
  /** Detected, NOT paid, and durably recorded for the reconciler to re-drive. */
  | { status: 'queued'; lastError: string };

/**
 * The durable record of a jackpot payout, injected by FeeReconciler at boot so
 * this module does not import it (FeeReconciler imports logBBJCollection from
 * here; a static import back would be a cycle).
 *
 * WRITE-AHEAD (BBJ phase 2.1). Until now the row was written only AFTER four
 * attempts had failed, which leaves the window this queue exists to close:
 * the engine detects a jackpot, announces it, and the process dies - a
 * SIGKILL, an OOM, the box going away - before any row exists. Nothing then
 * knows a jackpot was owed. `claim` is called BEFORE the first attempt, so
 * the intent is on disk while the money is still in the pool, and `settle`
 * closes it the moment the outcome is known.
 */
export interface BBJPayoutQueue {
  /** Record the intent to pay, before trying. Idempotent; never throws. */
  claim(params: BBJPayoutParams, note: string): Promise<void>;
  /** Close the claim: the money landed, or nothing will ever be owed. Never throws. */
  settle(params: BBJPayoutParams, note: string): Promise<void>;
}
let bbjPayoutQueue: BBJPayoutQueue | null = null;
/** Called once by FeeReconciler when it loads. Tests may call it with a stub. */
export function setBBJPayoutQueue(queue: BBJPayoutQueue | null): void {
  bbjPayoutQueue = queue;
}

/** Never let bookkeeping about the money stop the money. */
async function queueSafely(fn: () => Promise<void>, what: string): Promise<void> {
  if (!bbjPayoutQueue) return;
  try {
    await fn();
  } catch (e) {
    reportError(e, `processBBJPayout.queue_${what}_failed`);
  }
}

/** Thrown inside the attempt loop to say "this one is not worth retrying". */
class BBJPayoutFinal extends Error {
  constructor(
    message: string,
    public readonly reason: string
  ) {
    super(message);
  }
}

/**
 * Process BBJ payout — fetch pool balance, calculate shares, deduct from pool,
 * record payout in bbj_payouts + bbj_payout_recipients, and return amounts.
 *
 * Returns null if pool not found or balance is zero, if the hand was already
 * paid (a replay), or if every attempt failed - in which case the payout has
 * been QUEUED in pending_fee_distributions (kind 'bbj_payout') for the
 * reconciler to re-drive, and a CRITICAL financial alert carries every
 * parameter.
 *
 * BBJ AUDIT 2026-09-05 - why the retries and the queue exist:
 *
 * The old body made ONE call to bbj_atomic_payout_v2 and returned null on any
 * error. The engine's memory of the hit (`snap.bbjHit`) lives for one hand,
 * so a transient failure here - a PostgREST schema-cache reload (28 seconds
 * on this database), a dropped socket, the :55 maintenance freeze refusing
 * the write - meant a jackpot that had been DETECTED and ANNOUNCED
 * (`bbj_hit` had already gone out to the table) was never paid, never
 * recorded, and never retried. Nothing downstream could see it: there was no
 * bbj_payouts row to reconcile against. The pool simply kept the money.
 *
 * The RPC is idempotent on (pool, table, hand) - a retry after a success
 * whose response was lost returns already_paid and re-drives any missing
 * credit - so retrying is free. And in delta mode (chip standard 2026-09-04)
 * a seat credit that lands from the queue minutes later is preserved by the
 * next hand's write rather than erased, so a late payout is a correct payout.
 *
 * Chips are credited to players' table stacks INSIDE the RPC; ServerTableEngine
 * mirrors the shares into its memory after this returns.
 */
export async function processBBJPayout(
  params: BBJPayoutParams,
  options: {
    /**
     * True when the reconciler is re-driving a queued payout: the reconciler
     * OWNS the queue row (it bumps the attempt counter and resolves it), so
     * this call neither claims nor settles, and every recipient is notified,
     * because the table has long since moved on and nobody is going to see a
     * celebration overlay for this hand.
     */
    fromQueue?: boolean;
  } = {}
): Promise<BBJPayoutOutcome> {
  const owned = options.fromQueue !== true;

  /* WRITE-AHEAD (phase 2.1). The intent goes on disk BEFORE the first attempt,
     while the money is still in the pool. Until now the row was written only
     after four attempts had failed, so a process that died between detecting
     the jackpot and paying it left nothing behind that knew a jackpot was
     owed - the one gap the queue was built to close. Best effort: if the
     database is unreachable the payout is attempted anyway (it may be the
     Realtime side that is unwell, not Postgres), and the post-failure claim
     below is the second chance. */
  if (owned) {
    await queueSafely(
      () => bbjPayoutQueue!.claim(params, 'write-ahead: detected, payout not yet attempted'),
      'claim'
    );
  }

  let lastError = '';

  for (let attempt = 1; attempt <= BBJ_PAYOUT_ATTEMPTS; attempt++) {
    try {
      const outcome = await attemptBBJPayoutOnce(params, options.fromQueue === true);
      if (owned) {
        await queueSafely(
          () =>
            bbjPayoutQueue!.settle(
              params,
              outcome.status === 'paid'
                ? `paid ${outcome.result.totalPayout} to ${params.dealtInPlayerIds.length} recipient(s)`
                : 'already paid; the RPC re-drove any missing credit'
            ),
          'settle'
        );
      }
      return outcome;
    } catch (e) {
      if (e instanceof BBJPayoutFinal) {
        // Not a failure of the transport: the pool is empty, the club is
        // gone, the RPC refused the arguments. Retrying cannot change it, and
        // leaving the claim open would have the reconciler re-drive a hand
        // that can never pay until it exhausts into a critical alert.
        console.warn(`[processBBJPayout] ${e.reason}: ${e.message}`);
        if (owned) {
          await queueSafely(
            () => bbjPayoutQueue!.settle(params, `nothing to pay (${e.reason}): ${e.message}`),
            'settle'
          );
        }
        return { status: 'nothing_to_pay', reason: e.reason };
      }
      lastError = e instanceof Error ? e.message : String(e);
      const retryable = BBJ_PAYOUT_RETRYABLE.test(lastError);
      if (attempt < BBJ_PAYOUT_ATTEMPTS && retryable) {
        console.warn(
          `[processBBJPayout] attempt ${attempt}/${BBJ_PAYOUT_ATTEMPTS} failed for ` +
            `${params.tableId}#${params.handNumber} - retrying: ${lastError}`
        );
        await new Promise((r) => setTimeout(r, BBJ_PAYOUT_BACKOFF_MS(attempt)));
        continue;
      }
      break;
    }
  }

  // Every attempt failed. The hit is real (the engine detected it from a
  // showdown it witnessed) and the money is still in the pool. Make the
  // failure durable and loud, in that order.
  const detail =
    `[BBJ] Jackpot payout FAILED for table ${params.tableId} hand #${params.handNumber} ` +
    `(club ${params.clubId}, bad beat ${params.loserUserId} with ${params.loserHandName} ` +
    `beaten by ${params.winnerUserId} with ${params.winnerHandName}, ${params.dealtInPlayerIds.length} dealt in, ` +
    `${params.kind === 'mini' ? `Mini tier ${params.tierId}` : `${params.payoutTotalPercent}% of main`}): ${lastError}. ` +
    (options.fromQueue
      ? 'Re-drive from the queue failed again; the row stays open.'
      : 'Queued in pending_fee_distributions (kind bbj_payout) for the reconciler to re-drive; ') +
    `The jackpot RPC is idempotent on (pool, table, hand).`;
  reportError(new Error(detail), 'processBBJPayout.exhausted');

  if (owned) {
    // The claim above normally already exists; this refreshes its note with
    // the error, and is the second chance if the write-ahead insert failed.
    await queueSafely(() => bbjPayoutQueue!.claim(params, lastError), 'claim');
    await raiseFinancialAlert('critical', 'processBBJPayout.exhausted', detail, {
      ...params,
      attempts: BBJ_PAYOUT_ATTEMPTS,
      lastError,
      queued: bbjPayoutQueue !== null,
    });
  }
  return { status: 'queued', lastError };
}

/**
 * One attempt: resolve the pool, call the RPC, notify. Throws a plain Error
 * for anything the caller should consider retrying, BBJPayoutFinal for
 * anything it should not.
 */
async function attemptBBJPayoutOnce(
  params: BBJPayoutParams,
  fromQueue: boolean
): Promise<{ status: 'paid'; result: BBJPayoutResult } | { status: 'already_paid' }> {
  // 1. Find the club's union (if any). A read error is a transport failure,
  //    not "club not found" - the two used to be indistinguishable here, and
  //    the second one silently ended the payout.
  const { data: club, error: clubErr } = await supabase
    .from('clubs')
    .select('union_id')
    .eq('id', params.clubId)
    .maybeSingle();
  if (clubErr) throw new Error(`clubs read failed: ${clubErr.message}`);
  if (!club) {
    throw new BBJPayoutFinal(`Club ${params.clubId} not found`, 'club_not_found');
  }

  // 2. Find the BBJ pool (union-level first, then club-level)
  // HARDEN 2026-08-18: only an active pool can pay (matches collection path).
  let poolQuery = supabase
    .from('bbj_pools')
    .select('id, main_balance, backup_balance')
    .eq('status', 'active');
  if (club.union_id) {
    poolQuery = poolQuery.eq('union_id', club.union_id);
  } else {
    poolQuery = poolQuery.eq('club_id', params.clubId);
  }
  const { data: pool, error: poolErr } = await poolQuery.maybeSingle();
  if (poolErr) throw new Error(`bbj_pools read failed: ${poolErr.message}`);

  if (!pool) {
    throw new BBJPayoutFinal(
      `No BBJ pool or zero balance for club ${params.clubId}`,
      'no_pool_or_empty'
    );
  }

  // 3-5. FIX-A4 2026-07-19: atomic + idempotent payout via RPC. The RPC locks
  // the pool row, computes the payout from the LOCKED balance (no stale-read
  // mint), claims the hand via a unique (pool,table,hand) key before
  // decrementing, and records bbj_payouts — all in one transaction. Replaces
  // the previous non-atomic read-modify-write that could double-pay on
  // simultaneous hits or a task retry.
  const rpcName = params.kind === 'mini' ? 'fn_bbj_mini_payout' : 'bbj_atomic_payout_v2';
  const { data: rpcRows, error: rpcErr } = await supabase.rpc(rpcName, {
    p_pool_id: pool.id,
    p_table_id: params.tableId,
    p_hand_number: params.handNumber,
    ...(params.kind === 'mini'
      ? { p_tier_id: params.tierId }
      : { p_payout_total_percent: params.payoutTotalPercent }),
    p_loser_user_id: params.loserUserId, // BBJ "winner" (bad-beat holder, 50%)
    p_winner_user_id: params.winnerUserId, // BBJ "loser" (hand winner, 25%)
    // FIX P0-2 (2026-07-24): v2 credits recipients INSIDE the payout txn —
    // seated players (present in p_seated_ids) get table_seats.stack += share,
    // departed players get their wallet credited directly. The debit and every
    // credit are one atomic unit, so a crash can no longer debit the pool while
    // paying nobody, and a departed winner's share is never dropped.
    p_dealt_in_ids: params.dealtInPlayerIds,
    p_seated_ids: params.seatedUserIds,
    p_metadata: {
      winner_hand_name: params.loserHandName,
      loser_hand_name: params.winnerHandName,
      ...params.metadata,
      status: 'completed',
    },
  });

  if (rpcErr) {
    reportError(rpcErr, 'processBBJPayout.Atomic_rpc_failed');
    // A refused argument (percent out of range, service-only guard) will be
    // refused again; everything else is worth another go.
    if (/out of range|service only|42501/i.test(rpcErr.message || '')) {
      throw new BBJPayoutFinal(rpcErr.message, 'rpc_refused');
    }
    throw new Error(`${rpcName} failed: ${rpcErr.message}`);
  }

  const rpc = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  if (!rpc) throw new Error(`${rpcName} returned no settlement result`);
  if (!rpc.applied) {
    // already_paid (retry / concurrent / restart) or empty/zero pool. v2 has
    // already RE-DRIVEN any missing recipient credit inside the RPC (money is
    // durably placed — seats + wallets), so there is nothing left for the
    // engine to credit. Returning null here is now SAFE (no chip loss); it
    // used to mean permanent loss under the old non-recoverable payout.
    if (rpc?.already_paid) {
      console.warn(
        `[processBBJPayout] Already paid - hand ${params.tableId}#${params.handNumber} on pool ${pool.id}` +
          (rpc?.recovered ? ' (re-drove a missing recipient credit)' : '')
      );
      return { status: 'already_paid' };
    }
    if (params.kind === 'mini') {
      const finalReasons = [
        'reserve_at_floor',
        'mini_disabled_for_tier',
        'no_mini_amount_for_tier',
        'pool_not_found',
      ];
      if (finalReasons.includes(rpc.refused)) throw new BBJPayoutFinal(rpc.refused, rpc.refused);
      throw new Error(`${rpcName} returned an unrecognized refusal: ${rpc.refused}`);
    }
    /* Not applied and not a replay: the pool row read as empty between the
       lookup above and the locked read inside the RPC. Nothing is owed. */
    throw new BBJPayoutFinal(
      `pool ${pool.id} had nothing to pay when the RPC locked it`,
      'no_pool_or_empty'
    );
  }

  const totalPayout = Number(rpc.total_payout);
  const loserShare = Number(rpc.loser_share);
  const winnerShare = Number(rpc.winner_share);
  const tableShareTotal = Number(rpc.table_share);

  // Table-only players (for the log/broadcast only). v2 already credited every
  // recipient atomically and returns the exact per-player share it applied.
  const tableOnlyPlayers = params.dealtInPlayerIds.filter(
    (id) => id !== params.loserUserId && id !== params.winnerUserId
  );
  const perPlayerShare = Number(rpc.per_player_share);

  // NOTE (FIX P0-2): bbj_atomic_payout_v2 already records every recipient in
  // bbj_payout_recipients (idempotently, via the (payout_id,user_id) claim key)
  // AND inserts the bbj_winners "Previous Winners" row inside the same atomic
  // transaction as the debit + credits. The former app-side inserts here were
  // removed — the recipient insert would now violate the new unique claim key,
  // and the bbj_winners insert would create a duplicate row.

  console.log(
    `[processBBJPayout] BBJ HIT! Pool ${pool.id}: $${totalPayout} total ` +
      `(loser=$${loserShare}, winner=$${winnerShare}, table=$${tableShareTotal} / ${tableOnlyPlayers.length} players)`
  );

  /* A PARKED SHARE IS NEVER SILENT (BBJ phase 2.3). The RPC now parks a
     recipient's share rather than raising when no club wallet resolves for
     them - which is what stops one unpayable player costing the whole table
     their jackpot. The chips go back to the pool in the same transaction, so
     nothing is missing, but somebody is still OWED that money and a debt
     nobody is told about is the failure this whole phase is against. One
     indexed read on the rare jackpot path. */
  try {
    const { data: parked } = await supabase
      .from('bbj_unclaimed_shares')
      .select('user_id, amount')
      .eq('payout_id', rpc.payout_id)
      .is('paid_at', null);
    if (parked && parked.length > 0) {
      const total = parked.reduce((n, r) => n + Number(r.amount || 0), 0);
      /* COUNTED WHERE IT HAPPENS (BBJ phase 2.4). This counter was declared
         beside detected/paid/queued and incremented nowhere, which is the
         worse half of having no metric at all: `poker_bbj_shares_parked_total`
         would have read 0 for ever and been indistinguishable from "no share
         was ever parked". A number nobody writes to is not coverage. */
      bbjSharesParkedTotal.inc(parked.length, { table_id: params.tableId });
      await raiseFinancialAlert(
        'warning',
        'processBBJPayout.share_parked',
        `[BBJ] ${parked.length} jackpot share(s) worth ${total} could not be delivered on table ` +
          `${params.tableId} hand #${params.handNumber}: no club wallet resolved for the recipient. ` +
          `The chips were returned to pool ${pool.id} and the players are still owed them - ` +
          `fn_bbj_unclaimed_shares() lists every open one, and a re-drive pays them once they hold a club membership again.`,
        {
          tableId: params.tableId,
          handNumber: params.handNumber,
          poolId: pool.id,
          parked: parked.map((r) => ({ userId: r.user_id, amount: Number(r.amount) })),
        }
      );
    }
  } catch (parkErr) {
    console.warn('[processBBJPayout] could not read parked shares (money is placed):', parkErr);
  }

  // EVERY RECIPIENT IS TOLD (BBJ build plan phase 1, 2026-09-05).
  //
  // 2026-08-18 notified only the players who had LEFT the table, on the
  // grounds that a seated player sees the celebration overlay. That left the
  // seated winner of a $13,000 share with no record anywhere they can look:
  // a seat credit writes no chip_transactions row (the chips landed on the
  // felt, not in the wallet, and fn_my_wallet_ledger sums every row to a
  // player as wallet-in, so journalling it there would double-count the
  // cash-out later), and the overlay is gone in ten seconds. A player who was
  // reconnecting, backgrounded, or simply looking away had nothing.
  //
  // Now every recipient gets one durable notification saying what they won
  // and where it went - "added to your stack at the table" for a seated
  // player, "credited to your wallet" for one who had left. Non-fatal: the
  // money is already durably placed by the RPC; a failed insert only costs
  // the note. A payout re-driven from the queue (fromQueue) says which hand,
  // because by then the table has long moved on.
  try {
    const shareFor = (id: string): number =>
      id === params.loserUserId
        ? loserShare
        : id === params.winnerUserId
          ? winnerShare
          : perPlayerShare;
    const money = (n: number): string =>
      n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const rows = params.dealtInPlayerIds
      .map((id) => ({ id, share: shareFor(id), seated: params.seatedUserIds.includes(id) }))
      .filter((r) => r.share > 0)
      .map((r) => {
        const role =
          r.id === params.loserUserId
            ? 'You took the bad beat'
            : r.id === params.winnerUserId
              ? 'You won the hand'
              : 'You were dealt in';
        const where = r.seated
          ? 'was added to your stack at the table.'
          : 'was credited to your wallet.';
        const which = fromQueue
          ? `on hand #${params.handNumber}`
          : r.seated
            ? 'on the hand that just finished'
            : 'on a hand you were dealt into after you left the table';
        return {
          user_id: r.id,
          type: 'bonus',
          title: 'Bad Beat Jackpot - You Got Paid!',
          message: `A Bad Beat Jackpot hit ${which}. ${role}, and your share of $${money(r.share)} ${where}`,
          metadata: {
            tableId: params.tableId,
            handNumber: params.handNumber,
            amount: r.share,
            poolId: pool.id,
            placed: r.seated ? 'table_stack' : 'club_wallet',
            role:
              r.id === params.loserUserId
                ? 'bad_beat'
                : r.id === params.winnerUserId
                  ? 'hand_winner'
                  : 'table',
          },
          read: false,
        };
      });
    if (rows.length > 0) {
      const { error: notifyErr } = await supabase.from('notifications').insert(rows);
      if (notifyErr) {
        console.warn(
          `[processBBJPayout] recipient notifications failed (money already placed):`,
          notifyErr.message
        );
      } else {
        console.log(`[processBBJPayout] Notified ${rows.length} recipient(s) of their credit`);
      }
    }
  } catch (notifyEx) {
    console.warn('[processBBJPayout] recipient notification error:', notifyEx);
  }

  return {
    status: 'paid',
    result: {
      totalPayout,
      loserShare,
      winnerShare,
      tableShare: tableShareTotal,
      perPlayerShare,
      poolId: pool.id,
    },
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MINI JACKPOT PAYOUT (BBJ build plan phase 6 of 6, Dan 2026-09-07)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A flat amount per stakes tier, out of `backup_balance` - the reserve that
 * until now nothing spent - for a hand that came close to the main bar and did
 * not meet it. `fn_bbj_mini_payout` does all of the money work in one
 * transaction: it honours the same kill switch, shares the main's idempotency
 * key so one hand can pay once, holds the reserve above its floor, and credits
 * every recipient through `bbj_credit_one_recipient` - the same path, so a mini
 * inherits phase 2.3's parked-share behaviour for free.
 *
 * Mini and Main use the same original write-ahead settlement operation.
 * A transport failure cannot become a business-rule refusal or disappear
 * when the hand advances. The stored kind and tier survive engine restart.
 */
export async function processMiniBBJPayout(params: {
  tableId: string;
  clubId: string;
  handNumber: number;
  tierId: string;
  loserUserId: string;
  winnerUserId: string;
  dealtInPlayerIds: string[];
  seatedUserIds: string[];
  metadata?: Record<string, unknown>;
}): Promise<
  | { status: 'paid'; total: number; loser: number; winner: number; perPlayer: number }
  | { status: 'skipped'; reason: string }
  | { status: 'queued'; reason: string }
> {
  const outcome = await processBBJPayout({
    ...params,
    kind: 'mini',
    loserHandName: String(params.metadata?.loser_hand ?? 'Unknown'),
    winnerHandName: String(params.metadata?.winner_hand ?? 'Unknown'),
    payoutTotalPercent: 0, // Main-only field; the Mini RPC receives its tier instead.
  });
  if (outcome.status === 'queued') return { status: 'queued', reason: outcome.lastError };
  if (outcome.status !== 'paid')
    return {
      status: 'skipped',
      reason: outcome.status === 'already_paid' ? 'already_paid' : outcome.reason,
    };
  return {
    status: 'paid',
    total: outcome.result.totalPayout,
    loser: outcome.result.loserShare,
    winner: outcome.result.winnerShare,
    perPlayer: outcome.result.perPlayerShare,
  };
}

/**
 * WRITE DOWN THE JACKPOT THAT DID NOT FIRE, AND WHICH GATE REFUSED IT.
 *
 * Measured 2026-09-07: the main jackpot last paid on 2026-08-21 06:04:16 and
 * has paid nothing in the seventeen days since, while `bbj_contributions` took
 * the highest volume in the platform's history - 277,332 rows in the week of
 * 08-31 against 175,939 in the week of 08-17, which produced NINE hits.
 *
 * Nothing in the database could say whether that was the rules working or the
 * rules broken, because "no qualifying hand occurred" and "a qualifying hand
 * occurred and something refused it" were the same observation.
 * `detectBBJNearMiss` has computed the answer on every showdown since
 * 2026-08-18 and sent it to a `console.log` and a hub event that expires in
 * seconds. `bbj_hand_evidence_log` is written only by triggers on the payout
 * path, so it is empty by construction exactly when nothing pays.
 *
 * This is CLAUDE.md 10.86 rule 1 - "I could not tell" is a distinct outcome and
 * must have its own name - and rule 3 - a guard must have a reader. It is not a
 * monitor standing in for a fix (10.12); it moves no money, gates nothing, and
 * exists so the strictness of the rules is a question anyone can answer from
 * rows.
 *
 * Fire-and-forget by construction: the caller does not await a failure and a
 * throw here can never reach settlement. A jackpot must not be lost because its
 * paperwork was.
 */
export async function recordBBJNearMiss(params: {
  tableId: string;
  clubId: string | null;
  handNumber: number;
  variant: string;
  bigBlind: number | null;
  potSize: number;
  playersDealt: number;
  userId?: string;
  handName?: string;
  reason?: string;
  message?: string;
}): Promise<void> {
  const { error } = await supabase.from('bbj_near_misses').insert({
    table_id: params.tableId,
    club_id: params.clubId,
    hand_number: params.handNumber,
    variant: params.variant,
    big_blind: params.bigBlind,
    pot_size: params.potSize,
    players_dealt: params.playersDealt,
    user_id: params.userId ?? null,
    hand_name: params.handName ?? null,
    /* A near miss with no reason is a detector answering without knowing, which
       is the thing 10.86 was written about. Say so rather than write a null. */
    reason: params.reason ?? 'unspecified',
    message: params.message ?? null,
  });
  if (error) {
    reportError(error, 'bbj.near_miss_not_recorded', {
      tableId: params.tableId,
      handNumber: params.handNumber,
    });
  }
}
