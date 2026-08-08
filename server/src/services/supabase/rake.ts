/**
 * Supabase helpers — rake collection and insurance settlement ledgers.
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

/**
 * Log rake collection — every chip documented.
 * Rake goes to union owner (if club is in a union) or club owner (standalone).
 * Union holds all rake and distributes 90% back to clubs weekly.
 */
export async function logRakeCollection(
  tableId: string,
  clubId: string,
  handNumber: number,
  rakeAmount: number,
  potAmount: number,
  // Round 42 fix: BBJ amount threaded through so club_wallets.period_bbj_contribution
  // gets credited and chip_balance reflects the correct net (rake - bbj). Default
  // 0 keeps backwards-compat for any caller that doesn't pass it yet.
  bbjAmount: number = 0,
  // Round 43 fix: hand_history.id (UUID) for FK linking the
  // club_wallet_transactions audit row back to the originating hand.
  handId: string | null = null
): Promise<void> {
  if (rakeAmount <= 0) return;

  // Phase J: rake_history was a write-only legacy table. Verified no readers
  // anywhere in the codebase (engine, workers, World Hub, frontend). The
  // canonical hand-level rake ledger is rake_records (settler input + R73
  // hand_id linkage). rake_history had grown to 1.37M rows / ~295 MB at
  // ~1,128 rows/day with zero queriers. Insert removed — table will be
  // dropped in a follow-up cleanup migration.

  // Credit rake to the correct entity wallet:
  // - Club NOT in a union → credit to CLUB wallet (clubs.chip_pool)
  // - Club IN a union → credit to UNION wallet (union_wallets.rake_wallet)
  // NEVER goes to a player's personal wallet.
  //
  // Round 42 fix: ALWAYS update club_wallets accumulators (period + lifetime
  // rake/BBJ counters + audit transaction row) regardless of standalone vs
  // union, because club_wallets is the canonical audit / dashboard counter.
  // Pre-fix, club_wallets stayed at zero for every active club (verified
  // live: Shark Club had $5,020 of 24h rake but club_wallets read $0).
  try {
    const { data: club, error: clubErr } = await supabase
      .from('clubs')
      .select('owner_id, union_id, name')
      .eq('id', clubId)
      .maybeSingle();

    if (clubErr) {
      console.warn(`[DB] Failed to look up club ${clubId} for rake credit:`, clubErr.message);
      return;
    }
    if (!club) return;

    // Round 42: update club_wallets accumulators + audit ledger BEFORE the
    // entity-specific credit (union or chip_pool). Independent of where the
    // chips actually settle — this is the rake-collected counter.
    {
      const { error: cwErr } = await supabase.rpc('credit_club_wallet_rake', {
        p_club_id: clubId,
        p_rake: rakeAmount,
        p_bbj: bbjAmount,
        p_hand_id: handId,
        p_hand_number: handNumber,
      });
      if (cwErr) {
        reportError(
          new Error(`[logRakeCollection] club_wallets credit failed: ${cwErr.message}`),
          'logRakeCollection.club_wallets_credit_failed'
        );
      }
    }

    if (club.union_id) {
      // Club is in a union — ALL rake held by union wallet until weekly settlement
      // FIX-232: Atomic increment via RPC — eliminates read-then-write race condition
      const { error: uwErr } = await supabase.rpc('increment_union_wallet', {
        p_union_id: club.union_id,
        p_amount: rakeAmount,
      });
      if (uwErr) {
        reportError(
          new Error(`[logRakeCollection] Union wallet credit failed: ${uwErr.message}`),
          'logRakeCollection.Union_wallet_credit_failed'
        );
      }

      // Log union transaction for audit trail (BUG 013 FIX — was union_transactions, that
      // table doesn't exist; actual audit table is union_wallet_transactions with required
      // fields amount + wallet + direction + tx_type + balance_after).
      // ROUND 16 FIX: wallet must be one of {chip_balance, rake_wallet, bbj_wallet,
      // promo_wallet} per union_wallet_transactions_wallet_check; 'main' was rejected
      // by the CHECK constraint, silently dropping every union rake audit row. Rake
      // collection credits the rake_wallet sub-account.
      {
        const { data: wallet } = await supabase
          .from('union_wallets')
          .select('rake_wallet')
          .eq('union_id', club.union_id)
          .maybeSingle();
        await supabase.from('union_wallet_transactions').insert({
          union_id: club.union_id,
          club_id: clubId,
          amount: rakeAmount,
          tx_type: 'rake',
          wallet: 'rake_wallet',
          direction: 'credit',
          balance_after: wallet?.rake_wallet ?? null,
          notes: `Cash game rake: hand #${handNumber} (${club.name || 'club'})`,
        });
      }
    } else {
      // Standalone club — the rake chips settle into the club's OPERATIONAL BANK,
      // clubs.chip_treasury. NOTE the naming trap: increment_club_chip_pool writes
      // chip_treasury (+ total_rake), NOT chip_pool (chip_pool is the separate
      // mint-and-distribute ledger). The club_wallets accounting counter was already
      // credited above (credit_club_wallet_rake) for every club regardless of where
      // the chips settle. See .agent/architecture/CLUB-MONEY-LEDGERS-CANONICAL.md.
      const { error: cpErr } = await supabase.rpc('increment_club_chip_pool', {
        p_club_id: clubId,
        p_amount: rakeAmount,
      });
      if (cpErr) {
        reportError(
          new Error(`[logRakeCollection] Club chip_pool credit failed: ${cpErr.message}`),
          'logRakeCollection.Club_chip_pool_credit_failed'
        );
      }
    }
  } catch (e) {
    console.warn(`[DB] Rake wallet credit failed for hand #${handNumber}:`, e);
  }
}

/**
 * Log insurance settlement — Bible V8 §4.19.
 * Records premium collection and payout, routed to union bank or club bank.
 * - Union clubs: premiums/payouts flow through union bank
 * - Standalone clubs: premiums/payouts flow through club main bank
 */
export async function logInsuranceSettlement(params: {
  tableId: string;
  clubId: string;
  handNumber: number;
  playerId: string;
  equityPercent: number;
  premium: number;
  insuredAmount: number;
  payout: number;
  playerWon: boolean;
}): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_insurance_transaction', {
      p_table_id: params.tableId,
      p_club_id: params.clubId,
      p_hand_number: params.handNumber,
      p_player_id: params.playerId,
      p_equity_percent: params.equityPercent,
      p_premium: params.premium,
      p_insured_amount: params.insuredAmount,
      p_payout: params.payout,
      p_player_won: params.playerWon,
    });

    if (error) {
      reportError(error, 'logInsuranceSettlement.RPC_failed_for_player_paramspl');
    }
  } catch (e) {
    console.warn(`[logInsuranceSettlement] Failed for hand #${params.handNumber}:`, e);
  }
}
