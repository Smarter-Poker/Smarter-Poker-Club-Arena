import type { ChipTransactionLike } from './describeChipTransaction';

/** Personal-wallet change, not the unsigned movement or an operator's bank action. */
export function chipTransactionBalanceChange(row: ChipTransactionLike, viewer: string): number {
  const amount = Number(row.amount);
  if (!Number.isFinite(amount)) throw new Error('Invalid chip transaction amount');
  const magnitude = Math.abs(amount);
  const from = row.from_user_id === viewer;
  const to = row.to_user_id === viewer;
  const type = row.transaction_type;
  // Bank operators are recorded as actors; the bank is not their personal wallet.
  if (type === 'club_bank_send') return to ? magnitude : 0;
  if (type === 'club_bank_claim_back' || type === 'club_bank_reversal') {
    return to ? -magnitude : 0;
  }
  if (from && to) return 0;
  // Claim-back rows retain the initiating agent as from_user_id.
  if (type === 'agent_wallet_claim_back' || type === 'admin_removal') {
    return from ? magnitude : to ? -magnitude : 0;
  }
  if (from) return -magnitude;
  if (to) return magnitude;
  // Older signed rows have no endpoints. Preserve their recorded direction.
  return !row.from_user_id && !row.to_user_id ? amount : 0;
}
