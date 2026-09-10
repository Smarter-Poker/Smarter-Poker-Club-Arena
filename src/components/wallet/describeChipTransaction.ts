/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LEDGER LINE SAYS WHICH WALLET THE CHIPS LEFT AND WHICH THEY ENTERED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02, binding: "IN THE TRANSACTION LEDGER, IT NEEDS TO SPECIFY
 * WHICH WALLET A USER IS TRANSFERRING TO REGARDLESS OF ROLE - 'KINGFISH
 * TRANSFERRED XXX FROM HIS AGENT WALLET TO PLAYER WALLET' ETC."
 *
 * The ledger used to print `chip_transactions.notes`, which for a wallet move
 * is whatever the sender typed as a reason, or a stock phrase like "Club Bank
 * Send" - neither says who moved it, where it came from or where it landed.
 * The row already KNOWS all of that: every cashier RPC stamps
 * `metadata.destination`, `metadata.actor_role` and `metadata.recipient_role`,
 * and the row carries both user ids. This module turns that structure into
 * one sentence, the same sentence on every surface that lists a transaction,
 * so the Transaction Ledger and the Trade Ledger cannot disagree.
 *
 * Pure: no React, no Supabase, so it can be unit-tested against every
 * transaction type the cashier writes.
 */

import { formatChips } from '../../utils/format';

export interface ChipTransactionLike {
  transaction_type?: string | null;
  amount?: number | string | null;
  from_user_id?: string | null;
  to_user_id?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type WalletName =
  | 'Player Wallet'
  | 'Agent Wallet'
  | 'Promo Wallet'
  | 'Club Bank'
  | 'Union Bank'
  | 'Rake Treasury';

const DESTINATION_NAMES: Record<string, WalletName> = {
  player_wallet: 'Player Wallet',
  agent_wallet: 'Agent Wallet',
  promo_wallet: 'Promo Wallet',
  club_bank: 'Club Bank',
};

/** Where the chips LEFT from, per transaction type. */
const SOURCE_BY_TYPE: Record<string, WalletName> = {
  agent_wallet_send: 'Agent Wallet',
  agent_wallet_self_stake: 'Agent Wallet',
  club_bank_send: 'Club Bank',
  club_opening_grant: 'Club Bank',
  overlay_funding: 'Union Bank',
};

/**
 * The transaction types this module knows how to narrate. Anything else keeps
 * its `notes` verbatim - the point is never to INVENT a route the row does not
 * state.
 */
export const WALLET_MOVE_TYPES = new Set<string>([
  'agent_wallet_send',
  'agent_wallet_self_stake',
  'club_bank_send',
  'club_bank_reversal',
  'agent_wallet_claim_back',
  'club_bank_claim_back',
  'admin_removal',
]);

function walletName(key: unknown, fallback: WalletName): WalletName {
  const k = String(key ?? '').toLowerCase();
  return DESTINATION_NAMES[k] ?? fallback;
}

/** The ledger sentence's amount: two places always (1234.50 is "1,234.50",
 *  never "1,234.5"), through the one money formatter. */
export function formatChipAmount(amount: number | string | null | undefined): string {
  return formatChips(amount);
}

/**
 * One sentence for a wallet move, or null when the row is not a wallet move
 * (the caller then shows `notes`, exactly as before).
 *
 *   names   user id -> display name, whatever the caller has loaded. A name
 *           that is not loaded prints as "A Member" rather than a uuid.
 *   viewer  the user reading the ledger; their own name reads as "You".
 */
export function describeChipTransaction(
  row: ChipTransactionLike,
  names: ReadonlyMap<string, string> | Record<string, string> = {},
  viewer?: string | null
): string | null {
  const type = String(row.transaction_type ?? '');
  if (!WALLET_MOVE_TYPES.has(type)) return null;

  const nameOf = (id: string | null | undefined): string => {
    if (!id) return 'A Member';
    if (viewer && id === viewer) return 'You';
    const n = names instanceof Map ? names.get(id) : (names as Record<string, string>)[id];
    return n && n.trim() ? n : 'A Member';
  };
  const possessive = (id: string | null | undefined): string => {
    const n = nameOf(id);
    return n === 'You' ? 'Your' : `${n}'s`;
  };

  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const amount = formatChipAmount(row.amount);
  const actor = nameOf(row.from_user_id);
  const self = !!row.from_user_id && row.from_user_id === row.to_user_id;

  switch (type) {
    case 'agent_wallet_self_stake':
      return `${actor} Transferred ${amount} From ${possessive(row.from_user_id)} Agent Wallet To ${possessive(row.from_user_id)} Player Wallet`;
    case 'agent_wallet_send':
    case 'club_bank_send': {
      const source = SOURCE_BY_TYPE[type];
      const dest = walletName(meta.destination, 'Player Wallet');
      if (self) {
        return `${actor} Transferred ${amount} From The ${source} To ${possessive(row.to_user_id)} ${dest}`;
      }
      return `${actor} Sent ${amount} From ${type === 'club_bank_send' ? 'The Club Bank' : `${possessive(row.from_user_id)} Agent Wallet`} To ${possessive(row.to_user_id)} ${dest}`;
    }
    case 'club_bank_reversal':
    case 'club_bank_claim_back': {
      // The chips travel the other way: out of the member's wallet, back to
      // the bank. `destination` on these rows names the wallet they LEFT.
      const from = walletName(meta.destination ?? meta.source, 'Agent Wallet');
      return `${actor} Claimed Back ${amount} From ${possessive(row.to_user_id)} ${from} To The Club Bank`;
    }
    case 'agent_wallet_claim_back':
    case 'admin_removal': {
      const from = walletName(meta.destination ?? meta.source, 'Player Wallet');
      return `${actor} Claimed Back ${amount} From ${possessive(row.to_user_id)} ${from} To ${possessive(row.from_user_id)} Agent Wallet`;
    }
    default:
      return null;
  }
}

/**
 * The short "route" for a compact row: "Agent Wallet → Player Wallet". Null
 * when the row is not a wallet move.
 */
export function walletRoute(row: ChipTransactionLike): string | null {
  const type = String(row.transaction_type ?? '');
  if (!WALLET_MOVE_TYPES.has(type)) return null;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const dest = walletName(meta.destination, 'Player Wallet');
  switch (type) {
    case 'agent_wallet_self_stake':
      return 'Agent Wallet To Player Wallet';
    case 'agent_wallet_send':
      return `Agent Wallet To ${dest}`;
    case 'club_bank_send':
      return `Club Bank To ${dest}`;
    case 'club_bank_reversal':
    case 'club_bank_claim_back':
      return `${walletName(meta.destination ?? meta.source, 'Agent Wallet')} To Club Bank`;
    case 'agent_wallet_claim_back':
    case 'admin_removal':
      return `${walletName(meta.destination ?? meta.source, 'Player Wallet')} To Agent Wallet`;
    default:
      return null;
  }
}
