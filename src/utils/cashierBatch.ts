import { parseTradeAmount, sumChips } from './cashierAmount';

export type CashierBatchOutcome =
  | 'Confirmed'
  | 'Refused'
  | 'Outcome Needs Verification'
  | 'Not Submitted';
export interface CashierBatchReceiptRow {
  userId: string;
  name: string;
  amount: number;
  destination: string;
  outcome: CashierBatchOutcome;
  reference: string;
}

/** Retain original receipts and replace only recipients from this same batch retry. */
export function mergeCashierBatchReceiptRows(
  previous: CashierBatchReceiptRow[],
  current: CashierBatchReceiptRow[]
): CashierBatchReceiptRow[] {
  const replaced = new Set(current.map((row) => row.userId));
  return [...previous.filter((row) => !replaced.has(row.userId)), ...current];
}

/** Validate the entire visible intent before any chunk may move money. */
export function cashierBatchAmounts(
  ids: string[],
  uniform: string,
  overrides: Record<string, string>
) {
  const amounts: Record<string, number> = {};
  for (const id of ids) {
    const parsed = parseTradeAmount(overrides[id] ?? uniform);
    if (!parsed.ok) return { ok: false as const, userId: id, error: parsed.error };
    if (parsed.value > 1e9)
      return { ok: false as const, userId: id, error: 'That Amount Is Too Large' };
    amounts[id] = parsed.value;
  }
  return { ok: true as const, amounts, total: sumChips(Object.values(amounts)) };
}

/** Match exactly one acknowledgement per requested recipient; ambiguity stays unknown. */
export function cashierBatchAcknowledgement(
  results: unknown[],
  userId: string
): {
  outcome: CashierBatchOutcome;
  reference?: string;
  message?: string;
} {
  const matches = results.filter(
    (row) => row && typeof row === 'object' && (row as Record<string, unknown>).user_id === userId
  );
  if (matches.length !== 1) return { outcome: 'Outcome Needs Verification' };
  const row = matches[0] as Record<string, unknown>;
  if (row.success === true)
    return {
      outcome: 'Confirmed',
      reference:
        typeof row.transaction_id === 'string'
          ? row.transaction_id
          : typeof row.ticket_id === 'string'
            ? row.ticket_id
            : undefined,
    };
  if (row.success === false)
    return {
      outcome: 'Refused',
      message: typeof row.error === 'string' ? row.error : 'Transfer Was Refused',
    };
  return { outcome: 'Outcome Needs Verification' };
}

export function cashierBatchReceiptText(
  rows: CashierBatchReceiptRow[],
  batchId: string,
  club: string
): string {
  return [
    'Smarter Poker Cashier Batch Receipt',
    `Club: ${club}`,
    `Batch: ${batchId}`,
    ...rows.map(
      (row) =>
        `${row.name}: ${row.amount.toFixed(2)} Chips | ${row.destination} | ${row.outcome} | Reference: ${row.reference}`
    ),
    `Confirmed Total: ${sumChips(rows.filter((row) => row.outcome === 'Confirmed').map((row) => row.amount)).toFixed(2)} Chips`,
    'Unconfirmed Outcomes Must Be Verified Before Starting A New Transfer.',
  ].join('\n');
}
