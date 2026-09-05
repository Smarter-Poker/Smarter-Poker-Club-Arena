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
 * `bbjPoolCache` lives here and ONLY here: it is module-level shared state,
 * so duplicating it into another module would silently fork the cache.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';
import { raiseFinancialAlert } from '../financialAlerts.js';

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
  /timeout|timed out|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|502|503|504|57014|too many connections|schema cache|PGRST002|PGRST001|PLATFORM_FROZEN|deadlock|could not serialize|40001|40P01/i;
const BBJ_PAYOUT_ATTEMPTS = 4;
/** 400ms, 1.2s, 3.6s - long enough to outlive a schema-cache reload retry loop, short enough to keep the felt moving. */
const BBJ_PAYOUT_BACKOFF_MS = (attempt: number): number => 400 * 3 ** (attempt - 1);

/**
 * Log BBJ contribution — splits fee into main/backup/promo pools per allocation.
 * BBJ pool ownership: union-level (if club is in union) or club-level (standalone).
 * FIX 140: Pivot-based allocation matching Bible V8 §4.13 / BBJService spec:
 *   STANDARD (<100k main pool): 50% Main, 25% Backup, 25% Promo
 *   PIVOT (>=100k main pool): 25% Main, 25% Backup, 50% Promo
 *   (Dan 2026-08-18: past the pivot, steer new rake to promo; the Back Up
 *    share stays flat at 25% because its job is to reseed main after a full
 *    hit, not to grow. Was 30/40/30.)
 *
 * A5 FIX (2026-08-08): returns whether the fee is DURABLY BANKED — `true` only
 * once bbj_record_contribution has committed (or there was nothing to
 * contribute), `false` on any failure. See the block above the RPC call: a
 * failure here destroys chips, it does not merely skip a ledger row.
 */
// IMPROVE 2026-07-21: per-hand BBJ collection used to run TWO extra queries
// per raked hand (clubs.union_id + the pool lookup). Cache the resolved pool
// id per club with a 5-minute TTL — pool membership changes are rare (a club
// joining/leaving a union), and the TTL bounds the staleness window. The
// pivot check still reads the LIVE main_balance via the cached pool id.
const bbjPoolCache = new Map<string, { poolId: string; expiresAt: number }>();
const BBJ_POOL_CACHE_TTL_MS = 5 * 60 * 1000;

export async function logBBJCollection(
  tableId: string,
  clubId: string,
  handNumber: number,
  bbjAmount: number,
  bigBlind: number,
  // Round 44 fix: hand_history.id (UUID) for FK linking the bbj_contributions
  // audit row back to the originating hand. Default null preserves caller compat.
  handId: string | null = null
): Promise<boolean> {
  // Nothing to contribute is not a failure — no chips left the pot.
  if (bbjAmount <= 0) return true;

  // FIX 140: Pivot-based allocation thresholds (Bible V8 §4.13)
  const BBJ_PIVOT_THRESHOLD = 100000; // 100,000 chips
  const BBJ_ALLOCATION = {
    STANDARD: { MAIN: 0.5, BACKUP: 0.25, PROMO: 0.25 },
    PIVOT: { MAIN: 0.25, BACKUP: 0.25, PROMO: 0.5 },
  };

  try {
    let pool: { id: string; main_balance: number | null } | null = null;

    const cached = bbjPoolCache.get(clubId);
    if (cached && cached.expiresAt > Date.now()) {
      // Cached pool id — one query for the live balance (pivot check).
      const { data: cachedPool } = await supabase
        .from('bbj_pools')
        .select('id, main_balance')
        .eq('id', cached.poolId)
        .eq('status', 'active') // HARDEN 2026-08-18: never bank into a retired pool
        .maybeSingle();
      pool = cachedPool;
      if (!pool) bbjPoolCache.delete(clubId); // pool vanished — fall through
    }

    if (!pool) {
      // Find the BBJ pool for this club (or its union)
      const { data: club } = await supabase
        .from('clubs')
        .select('union_id')
        .eq('id', clubId)
        .maybeSingle();

      if (!club) {
        console.warn(`[logBBJCollection] Club ${clubId} not found - skipping BBJ logging`);
        return false;
      }

      // Look up pool: union-level first, then club-level — include main_balance for pivot check
      // HARDEN 2026-08-18: status='active' — the column is NOT NULL DEFAULT
      // 'active' (verified in production), so this only excludes pools an
      // admin has deliberately retired.
      let poolQuery = supabase.from('bbj_pools').select('id, main_balance').eq('status', 'active');
      if (club.union_id) {
        poolQuery = poolQuery.eq('union_id', club.union_id);
      } else {
        poolQuery = poolQuery.eq('club_id', clubId);
      }
      const { data: freshPool } = await poolQuery.maybeSingle();
      pool = freshPool;
      if (pool) {
        bbjPoolCache.set(clubId, {
          poolId: pool.id,
          expiresAt: Date.now() + BBJ_POOL_CACHE_TTL_MS,
        });
      }
    }

    if (!pool) {
      // RAKE-AUDIT 2026-07-24: AUTO-CREATE the pool instead of skipping. The
      // old "no pool → skip" path meant the BBJ fee had already been deducted
      // from the pot but was banked NOWHERE — silent money destruction for any
      // club (or union) whose bbj_pools row was never seeded. Service-role
      // client bypasses RLS, so this insert is safe server-side only.
      const { data: clubRow } = await supabase
        .from('clubs')
        .select('union_id')
        .eq('id', clubId)
        .maybeSingle();
      const insertPayload = clubRow?.union_id
        ? {
            union_id: clubRow.union_id,
            main_balance: 0,
            backup_balance: 0,
            promo_balance: 0,
            status: 'active',
          }
        : {
            club_id: clubId,
            main_balance: 0,
            backup_balance: 0,
            promo_balance: 0,
            status: 'active',
          };
      const { data: newPool, error: createErr } = await supabase
        .from('bbj_pools')
        .insert(insertPayload)
        .select('id, main_balance')
        .maybeSingle();
      if (createErr || !newPool) {
        reportError(
          new Error(
            `[logBBJCollection] BBJ pool auto-create FAILED for club ${clubId} - fee of ${bbjAmount} collected but not banked: ${createErr?.message}`
          ),
          'logBBJCollection.pool_autocreate_failed'
        );
        return false;
      }
      console.log(
        `[logBBJCollection] Auto-created BBJ pool ${newPool.id} for ${clubRow?.union_id ? `union ${clubRow.union_id}` : `club ${clubId}`}`
      );
      pool = newPool;
      bbjPoolCache.set(clubId, {
        poolId: newPool.id,
        expiresAt: Date.now() + BBJ_POOL_CACHE_TTL_MS,
      });
    }

    // FIX 140: Determine allocation ratios based on current pool size
    const currentMainBalance = pool.main_balance ?? 0;
    const ratios =
      currentMainBalance >= BBJ_PIVOT_THRESHOLD ? BBJ_ALLOCATION.PIVOT : BBJ_ALLOCATION.STANDARD;

    const mainPortion = Math.round(bbjAmount * ratios.MAIN * 100) / 100;
    const backupPortion = Math.round(bbjAmount * ratios.BACKUP * 100) / 100;
    // Promo takes the remainder so the three portions always re-sum to the fee.
    // ROUND IT: in binary floating point the subtraction can land a hair below
    // zero (measured -1.7e-18), which would bank a negative promo portion —
    // harmless arithmetically, but it is a negative money value written to the
    // ledger, and that is the kind of thing a CHECK constraint or an invariant
    // trips over later.
    const promoPortion =
      Math.round((Math.round(bbjAmount * 100) / 100 - mainPortion - backupPortion) * 100) / 100;

    // Use bbj_record_contribution RPC — atomically updates pool balances + logs contribution
    // hand_id is nullable (migration 20260325) since server uses hand_history not hands table
    // FIX 205: Try with club_id first (requires migration), fall back to without
    //
    // A5 FIX (2026-08-08): this RPC is NOT optional bookkeeping. The comment that
    // used to sit below it — "Non-critical: BBJ fee already deducted from pot,
    // this is just the ledger entry" — was WRONG, and the bug was live.
    // atomic_distribute_rake computes v_net := p_rake - v_bbj and credits the club
    // wallet only v_net, deliberately withholding the BBJ slice precisely because
    // bbj_record_contribution is what banks it into the jackpot pool. So when this
    // call fails the chips are in NEITHER place: they left the pot and ceased to
    // exist.
    //
    // On the evidence, this has NOT yet bitten: an audit joining rake_records to
    // bbj_contributions on hand_id across the 20,000 most recent raked hands found
    // zero hands missing a pool row. (A windowed sum comparison appears to show a
    // 0.50 gap, but that is a boundary artifact — the two rows are written moments
    // apart, so one straddles the window edge. It reverses sign depending on the
    // window, which is the tell.) What was wrong was that a failure here would have
    // been unobservable: swallowed, and logged on one hand in a hundred.
    // Retry, then report every single failure, and hand the caller the truth about
    // where the fee actually is.
    const BBJ_RPC_MAX_ATTEMPTS = 3;
    const BBJ_RPC_RETRY_BASE_MS = 100;
    let rpcError: any = null;

    for (let attempt = 1; attempt <= BBJ_RPC_MAX_ATTEMPTS; attempt++) {
      const { error: errWithClub } = await supabase.rpc('bbj_record_contribution', {
        p_pool_id: pool.id,
        p_hand_id: handId,
        p_table_id: tableId,
        p_amount: bbjAmount,
        p_main_portion: mainPortion,
        p_backup_portion: backupPortion,
        p_promo_portion: promoPortion,
        p_big_blind: bigBlind,
        p_hand_number: handNumber,
        p_club_id: clubId,
      });

      if (errWithClub && errWithClub.code === 'PGRST202') {
        // Migration not yet applied — fall back to old signature without club_id
        const { error: errNoClub } = await supabase.rpc('bbj_record_contribution', {
          p_pool_id: pool.id,
          p_hand_id: handId,
          p_table_id: tableId,
          p_amount: bbjAmount,
          p_main_portion: mainPortion,
          p_backup_portion: backupPortion,
          p_promo_portion: promoPortion,
          p_big_blind: bigBlind,
          p_hand_number: handNumber,
        });
        rpcError = errNoClub;
      } else {
        rpcError = errWithClub;
      }

      if (!rpcError) break;

      if (attempt < BBJ_RPC_MAX_ATTEMPTS) {
        console.warn(
          `[logBBJCollection] bbj_record_contribution attempt ${attempt}/${BBJ_RPC_MAX_ATTEMPTS} ` +
            `failed for hand #${handNumber} - retrying:`,
          rpcError.message
        );
        // Short linear backoff (100ms, 200ms) — this runs on the settlement path,
        // so it must not stall the table for long.
        await new Promise((resolve) => setTimeout(resolve, BBJ_RPC_RETRY_BASE_MS * attempt));
      }
    }

    if (rpcError) {
      // Report EVERY failure — the old `handNumber % 100 === 1` sampling hid 99%
      // of them. A destroyed fee is not noise.
      reportError(
        new Error(
          `[logBBJCollection] BBJ contribution FAILED after ${BBJ_RPC_MAX_ATTEMPTS} attempts ` +
            `for hand #${handNumber} (table ${tableId}, club ${clubId}) - ${bbjAmount} chips ` +
            `were deducted from the pot and banked NOWHERE: ${rpcError.message}`
        ),
        'logBBJCollection.contribution_failed'
      );
      return false;
    }

    return true;
  } catch (e) {
    console.warn(`[logBBJCollection] BBJ logging failed for hand #${handNumber}:`, e);
    // The fee left the pot and was never banked — the caller must treat this as
    // a failed contribution, not a silent success.
    return false;
  }
}

/**
 * Everything the payout RPC needs, and everything a human needs to re-drive
 * it by hand. This is what gets queued when the live attempt fails, so it
 * has to be complete on its own: the engine's memory of the hit does not
 * survive the next hand, let alone a restart.
 */
export interface BBJPayoutParams {
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
 * Signature of the durable-queue writer, injected by FeeReconciler at boot so
 * this module does not import it (FeeReconciler imports logBBJCollection from
 * here; a static import back would be a cycle).
 */
export type BBJPayoutQueueWriter = (params: BBJPayoutParams, lastError: string) => Promise<void>;
let bbjPayoutQueueWriter: BBJPayoutQueueWriter | null = null;
/** Called once by FeeReconciler when it loads. Tests may call it with a stub. */
export function setBBJPayoutQueueWriter(writer: BBJPayoutQueueWriter | null): void {
  bbjPayoutQueueWriter = writer;
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
     * True when the reconciler is re-driving a queued payout: no re-queue on
     * failure (the reconciler bumps the row's attempt counter itself), and
     * every recipient is notified, because the table has long since moved on
     * and nobody is going to see a celebration overlay for this hand.
     */
    fromQueue?: boolean;
  } = {}
): Promise<BBJPayoutResult | null> {
  let lastError = '';

  for (let attempt = 1; attempt <= BBJ_PAYOUT_ATTEMPTS; attempt++) {
    try {
      const outcome = await attemptBBJPayoutOnce(params, options.fromQueue === true);
      return outcome;
    } catch (e) {
      if (e instanceof BBJPayoutFinal) {
        // Not a failure of the transport: the pool is empty, the club is
        // gone, the RPC refused the arguments. Retrying cannot change it.
        console.warn(`[processBBJPayout] ${e.reason}: ${e.message}`);
        return null;
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
    `${params.payoutTotalPercent}% of main): ${lastError}. ` +
    (options.fromQueue
      ? 'Re-drive from the queue failed again; the row stays open.'
      : 'Queued in pending_fee_distributions (kind bbj_payout) for the reconciler to re-drive; ') +
    `bbj_atomic_payout_v2 is idempotent on (pool, table, hand), so re-driving it by hand is safe.`;
  reportError(new Error(detail), 'processBBJPayout.exhausted');

  if (!options.fromQueue) {
    if (bbjPayoutQueueWriter) {
      try {
        await bbjPayoutQueueWriter(params, lastError);
      } catch (qErr) {
        reportError(qErr, 'processBBJPayout.queue_failed');
      }
    }
    await raiseFinancialAlert('critical', 'processBBJPayout.exhausted', detail, {
      ...params,
      attempts: BBJ_PAYOUT_ATTEMPTS,
      lastError,
      queued: bbjPayoutQueueWriter !== null,
    });
  }
  return null;
}

/**
 * One attempt: resolve the pool, call the RPC, notify. Throws a plain Error
 * for anything the caller should consider retrying, BBJPayoutFinal for
 * anything it should not.
 */
async function attemptBBJPayoutOnce(
  params: BBJPayoutParams,
  fromQueue: boolean
): Promise<BBJPayoutResult | null> {
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

  if (!pool || pool.main_balance <= 0) {
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
  const { data: rpcRows, error: rpcErr } = await supabase.rpc('bbj_atomic_payout_v2', {
    p_pool_id: pool.id,
    p_table_id: params.tableId,
    p_hand_number: params.handNumber,
    p_payout_total_percent: params.payoutTotalPercent,
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
    throw new Error(`bbj_atomic_payout_v2 failed: ${rpcErr.message}`);
  }

  const rpc = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  if (!rpc || !rpc.applied) {
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
    }
    return null;
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

  // DEPARTED-RECIPIENT NOTIFICATIONS (2026-08-18): players who left the
  // table before the payout landed get their share credited straight to
  // their wallet by the RPC — silently. Without a notification they would
  // never know a jackpot paid them. Seated players see the celebration
  // overlay, so only the departed set is notified. Non-fatal: the money is
  // already durably placed by the RPC; a failed insert only costs the note.
  //
  // BBJ AUDIT 2026-09-05: a payout re-driven from the queue has no
  // celebration to lean on - the hand is minutes old - so EVERY recipient is
  // told, seated or not, and the note says where the chips went.
  try {
    const notify = fromQueue
      ? params.dealtInPlayerIds
      : params.dealtInPlayerIds.filter((id) => !params.seatedUserIds.includes(id));
    if (notify.length > 0) {
      const shareFor = (id: string): number =>
        id === params.loserUserId
          ? loserShare
          : id === params.winnerUserId
            ? winnerShare
            : perPlayerShare;
      const rows = notify
        .map((id) => ({ id, share: shareFor(id), seated: params.seatedUserIds.includes(id) }))
        .filter((r) => r.share > 0)
        .map((r) => ({
          user_id: r.id,
          type: 'bonus',
          title: 'Bad Beat Jackpot - You Got Paid!',
          message: fromQueue
            ? `A Bad Beat Jackpot hit on hand #${params.handNumber}, a hand you were dealt into. ` +
              `Your share of $${r.share.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ` +
              (r.seated ? `was added to your stack at the table.` : `was credited to your wallet.`)
            : `A Bad Beat Jackpot hit on a hand you were dealt into after you left the table. ` +
              `Your share of $${r.share.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ` +
              `was credited to your wallet.`,
          metadata: {
            tableId: params.tableId,
            handNumber: params.handNumber,
            amount: r.share,
            poolId: pool.id,
          },
          read: false,
        }));
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
    }
  } catch (notifyEx) {
    console.warn('[processBBJPayout] recipient notification error:', notifyEx);
  }

  return {
    totalPayout,
    loserShare,
    winnerShare,
    tableShare: tableShareTotal,
    perPlayerShare,
    poolId: pool.id,
  };
}
