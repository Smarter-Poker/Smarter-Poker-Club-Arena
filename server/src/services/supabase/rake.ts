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
      // clubs.chip_treasury (+ total_rake). This is NOT clubs.chip_pool, which is
      // the separate mint-and-distribute ledger. The club_wallets accounting counter
      // was already credited above (credit_club_wallet_rake) for every club
      // regardless of where the chips settle.
      // See .agent/architecture/CLUB-MONEY-LEDGERS-CANONICAL.md.
      //
      // 2026-08-15: renamed from increment_club_chip_pool, whose name claimed
      // chip_pool while its body wrote chip_treasury. That naming trap caused the
      // two ledgers to be read as duplicates and 174.89 of rake income to be folded
      // into the mint ledger (reversed same day). The old name still exists as a
      // deprecated delegate; do not use it.
      const { error: cpErr } = await supabase.rpc('credit_club_rake_to_treasury', {
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
export type InsuranceLedgerResult =
  | { ok: true; transactionId: string; attempts: number }
  | { ok: false; reason: 'rpc_error' | 'threw' | 'not_persisted'; attempts: number };

const INSURANCE_LEDGER_MAX_ATTEMPTS = 3;

function extractInsuranceTxId(data: unknown): string | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (row && typeof row === 'object' && 'id' in row) {
    const id = (row as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

function insuranceDataHasContent(data: unknown): boolean {
  if (data == null) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === 'object') return Object.keys(data as object).length > 0;
  return true;
}

async function confirmInsuranceTx(params: {
  tableId: string;
  handNumber: number;
  playerId: string;
}): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('insurance_transactions')
      .select('id')
      .eq('table_id', params.tableId)
      .eq('hand_number', params.handNumber)
      .eq('player_id', params.playerId)
      .maybeSingle();
    if (error) return null;
    return extractInsuranceTxId(data);
  } catch {
    return null;
  }
}

/**
 * AUDIT M3 (restored): the offsetting insurance bank entry. By the time this
 * runs the table stacks were already moved (+payout, -premium) and persisted,
 * so a lost write here mints or burns chips silently. This write is therefore:
 *   - OBSERVABLE — returns a discriminated result the caller can branch on;
 *   - RETRIED — the RPC is idempotent on (table_id, hand_number, player_id), so
 *     a transient error or a dropped socket is retried up to three times;
 *   - CONFIRMED — a no-error response we cannot read an id out of triggers a
 *     read-back rather than a guess, and a definitive failure is re-checked
 *     against the row before we declare the write lost (it may have landed);
 *   - DURABLE on failure — a lost write raises a CRITICAL financial_alert (a
 *     reconcilable DB row, not just Sentry) carrying the player id and the net
 *     chip delta an operator needs to settle by hand;
 *   - TOTAL — it never rejects, so the settlement loop cannot be aborted by it.
 *
 * Regressed to a `Promise<void>` stub during the 2026-08-08 supabase.ts split;
 * this restores the contract `insuranceLedger.test.ts` still encodes.
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
  /**
   * EV CASHOUT 2026-08-28: 'ev_cashout' rows log the redirected winnings in
   * `premium` (bank in) and the locked cashout in `payout` (bank out); the
   * RPC's bank_delta = premium − payout is unchanged. Default 'insurance'.
   */
  kind?: 'insurance' | 'ev_cashout';
}): Promise<InsuranceLedgerResult> {
  const rpcArgs = {
    p_table_id: params.tableId,
    p_club_id: params.clubId,
    p_hand_number: params.handNumber,
    p_player_id: params.playerId,
    p_equity_percent: params.equityPercent,
    p_premium: params.premium,
    p_insured_amount: params.insuredAmount,
    p_payout: params.payout,
    p_player_won: params.playerWon,
    p_kind: params.kind ?? 'insurance',
  };

  let attempts = 0;
  let reason: 'rpc_error' | 'threw' | 'not_persisted' = 'not_persisted';
  let lastError: unknown = null;

  for (let i = 1; i <= INSURANCE_LEDGER_MAX_ATTEMPTS; i++) {
    attempts = i;
    let result: { data: unknown; error: unknown } | null = null;
    try {
      result = (await supabase.rpc('record_insurance_transaction', rpcArgs)) as {
        data: unknown;
        error: unknown;
      };
    } catch (e) {
      reason = 'threw';
      lastError = e;
      continue; // transient transport failure; the RPC is idempotent, so retry
    }

    const error = result?.error;
    const data = result?.data;

    if (error) {
      reason = 'rpc_error';
      lastError = error;
      continue; // retry — idempotent on (table_id, hand_number, player_id)
    }

    const id = extractInsuranceTxId(data);
    if (id) {
      return { ok: true, transactionId: id, attempts };
    }

    // No error but no readable id. If the RPC returned an unrecognised payload,
    // retrying an idempotent write returns the same shape — stop and confirm by
    // reading the row. If it returned nothing, treat it as a soft miss and retry.
    reason = 'not_persisted';
    if (insuranceDataHasContent(data)) {
      break;
    }
  }

  // Authoritative read-back: the write may have landed even when the client saw
  // an error or an unreadable payload (the RPC is idempotent).
  const confirmedId = await confirmInsuranceTx(params);
  if (confirmedId) {
    return { ok: true, transactionId: confirmedId, attempts };
  }

  // Definitive failure: the offsetting bank entry never landed, so the table
  // stack was moved with nothing on the other side.
  reportError(
    lastError instanceof Error
      ? lastError
      : new Error(
          lastError && typeof lastError === 'object'
            ? JSON.stringify(lastError)
            : `insurance ledger write ${reason}`
        ),
    `logInsuranceSettlement.RPC_failed_for_player_${params.playerId}`,
    {
      tableId: params.tableId,
      clubId: params.clubId,
      handNumber: params.handNumber,
      playerId: params.playerId,
      equityPercent: params.equityPercent,
      premium: params.premium,
      insuredAmount: params.insuredAmount,
      payout: params.payout,
      playerWon: params.playerWon,
      attempts,
      reason,
    }
  );

  try {
    const { raiseFinancialAlert } = await import('../financialAlerts.js');
    await raiseFinancialAlert(
      'critical',
      'logInsuranceSettlement.insurance_ledger_write_failed',
      `Insurance ledger write failed after ${attempts} attempts (${reason}); ` +
        `table stack moved with no offsetting bank entry`,
      {
        table_id: params.tableId,
        club_id: params.clubId,
        hand_number: params.handNumber,
        player_id: params.playerId,
        equity_percent: params.equityPercent,
        premium: params.premium,
        insured_amount: params.insuredAmount,
        payout: params.payout,
        player_won: params.playerWon,
        net_chip_delta: params.payout - params.premium,
        attempts,
        reason,
      }
    );
  } catch (alertErr) {
    // A durable alert that itself fails must not abort the settlement loop.
    console.warn('[logInsuranceSettlement] durable alert failed:', alertErr);
  }

  return { ok: false, reason, attempts };
}
