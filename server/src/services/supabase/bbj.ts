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
 * Process BBJ payout — fetch pool balance, calculate shares, deduct from pool,
 * record payout in bbj_payouts + bbj_payout_recipients, and return amounts.
 *
 * Returns null if pool not found or balance is zero.
 * Chips are credited to players' table stacks by ServerTableEngine after this returns.
 */
export async function processBBJPayout(params: {
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
}): Promise<{
  totalPayout: number;
  loserShare: number;
  winnerShare: number;
  tableShare: number;
  perPlayerShare: number;
  poolId: string;
} | null> {
  try {
    // 1. Find the club's union (if any)
    const { data: club } = await supabase
      .from('clubs')
      .select('union_id')
      .eq('id', params.clubId)
      .maybeSingle();

    if (!club) {
      console.warn(`[processBBJPayout] Club ${params.clubId} not found`);
      return null;
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
    const { data: pool } = await poolQuery.maybeSingle();

    if (!pool || pool.main_balance <= 0) {
      console.warn(`[processBBJPayout] No BBJ pool or zero balance for club ${params.clubId}`);
      return null;
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
      return null;
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
    try {
      const departed = params.dealtInPlayerIds.filter((id) => !params.seatedUserIds.includes(id));
      if (departed.length > 0) {
        const shareFor = (id: string): number =>
          id === params.loserUserId
            ? loserShare
            : id === params.winnerUserId
              ? winnerShare
              : perPlayerShare;
        const rows = departed
          .map((id) => ({ id, share: shareFor(id) }))
          .filter((r) => r.share > 0)
          .map((r) => ({
            user_id: r.id,
            type: 'bonus',
            title: 'Bad Beat Jackpot - You Got Paid!',
            message:
              `A Bad Beat Jackpot hit on a hand you were dealt into after you left the table. ` +
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
              `[processBBJPayout] departed-recipient notifications failed (money already placed):`,
              notifyErr.message
            );
          } else {
            console.log(
              `[processBBJPayout] Notified ${rows.length} departed recipient(s) of their wallet credit`
            );
          }
        }
      }
    } catch (notifyEx) {
      console.warn('[processBBJPayout] departed-recipient notification error:', notifyEx);
    }

    return {
      totalPayout,
      loserShare,
      winnerShare,
      tableShare: tableShareTotal,
      perPlayerShare,
      poolId: pool.id,
    };
  } catch (e) {
    reportError(e, 'processBBJPayout.Fatal_error');
    return null;
  }
}
