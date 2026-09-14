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
 * Compatibility entry point for cash rake. The authoritative transaction owns
 * routing, counters, journal and replay: union rake is retained; standalone
 * rake is retired. BBJ remains a separately collected drop.
 */
export async function logRakeCollection(
  tableId: string,
  clubId: string,
  handNumber: number,
  rakeAmount: number,
  potAmount: number,
  bbjAmount: number = 0,
  handId: string | null = null
): Promise<void> {
  if (rakeAmount <= 0) return;
  const { error } = await supabase.rpc('atomic_distribute_rake', {
    p_table_id: tableId,
    p_club_id: clubId,
    p_hand_id: handId,
    p_hand_number: handNumber,
    p_rake: rakeAmount,
    p_bbj: bbjAmount,
    p_pot: potAmount,
  });
  if (error) {
    reportError(error, 'logRakeCollection.atomic_distribution_failed');
    throw error;
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

type InsuranceSettlementParams = {
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
};
const insuranceCents = (value: number): number => Math.round(value * 100) / 100;

function extractInsuranceTxId(data: unknown, params: InsuranceSettlementParams): string | null {
  const row = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
  if (!row || typeof row !== 'object') return null;
  const receipt = row as Record<string, unknown>;
  if (
    typeof receipt.id !== 'string' ||
    receipt.id.length === 0 ||
    receipt.table_id !== params.tableId ||
    receipt.club_id !== params.clubId ||
    receipt.player_id !== params.playerId ||
    receipt.hand_number !== params.handNumber ||
    receipt.player_won !== params.playerWon ||
    receipt.kind !== (params.kind ?? 'insurance')
  )
    return null;
  for (const [key, expected] of [
    ['equity_percent', params.equityPercent],
    ['premium', params.premium],
    ['insured_amount', params.insuredAmount],
    ['payout', params.payout],
  ] as const) {
    if (receipt[key] == null || Number(receipt[key]) !== insuranceCents(expected)) return null;
  }
  return receipt.id;
}

function insuranceDataHasContent(data: unknown): boolean {
  if (data == null) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === 'object') return Object.keys(data as object).length > 0;
  return true;
}

async function confirmInsuranceTx(params: InsuranceSettlementParams): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('insurance_transactions')
      .select(
        'id,table_id,club_id,hand_number,player_id,equity_percent,premium,insured_amount,payout,player_won,kind'
      )
      .eq('table_id', params.tableId)
      .eq('hand_number', params.handNumber)
      .eq('player_id', params.playerId)
      .maybeSingle();
    if (error) return null;
    return extractInsuranceTxId(data, params);
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
export async function logInsuranceSettlement(
  params: InsuranceSettlementParams
): Promise<InsuranceLedgerResult> {
  const rpcArgs = {
    p_table_id: params.tableId,
    p_club_id: params.clubId,
    p_hand_number: params.handNumber,
    p_player_id: params.playerId,
    p_equity_percent: insuranceCents(params.equityPercent),
    p_premium: insuranceCents(params.premium),
    p_insured_amount: insuranceCents(params.insuredAmount),
    p_payout: insuranceCents(params.payout),
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

    const id = extractInsuranceTxId(data, params);
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

  // The payment could not be confirmed. A lost response is not proof that
  // the bank transaction failed to commit.
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
      `Insurance payment could not be confirmed after ${attempts} attempts (${reason}); ` +
        `no matching committed bank receipt was confirmed`,
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
