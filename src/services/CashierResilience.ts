export interface CashierReceiptFields {
  id: string;
  createdAt: string;
  type: string;
  amount: number;
  direction: 'in' | 'out';
  counterparty: string;
}

const receiptLabel = (value: string): string =>
  value
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/**
 * Produce a plain-text receipt that remains useful outside the application.
 * The transaction id is deliberately included in full: it is the immutable
 * reference support and the ledger use to identify the exact movement.
 */
export function cashierReceiptText(row: CashierReceiptFields, clubName: string): string {
  const signedAmount = `${row.direction === 'in' ? '+' : '-'}${row.amount.toFixed(2)}`;
  return [
    'Smarter Poker Cashier Receipt',
    `Club: ${clubName || 'Club Cashier'}`,
    `Reference: ${row.id}`,
    `Recorded: ${new Date(row.createdAt).toISOString()}`,
    `Entry: ${receiptLabel(row.type) || 'Transfer'}`,
    `${row.direction === 'in' ? 'From' : 'To'}: ${row.counterparty}`,
    `Amount: ${signedAmount} Chips`,
    'Status: Recorded In Ledger',
  ].join('\n');
}

/** Browser online state is advisory; the server still authorizes every move. */
export function readCashierOnlineState(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export async function copyCashierText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    return copied;
  } catch {
    return false;
  }
}
