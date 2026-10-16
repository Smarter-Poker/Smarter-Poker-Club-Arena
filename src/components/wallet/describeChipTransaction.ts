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

import { compactChips } from '../../utils/format';

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
 * The transaction types this module knows how to narrate, spelled exactly as
 * their writers insert them. Anything else keeps its `notes` verbatim - the
 * point is never to INVENT a route the row does not state.
 *
 * WHO IS FROM AND WHO IS TO, per writer (audit C1-4 / C3-2, 2026-10-09). The
 * three money-back types are written with the chips' direction, not the
 * actor's: `from_user_id` is the member whose wallet was debited and
 * `to_user_id` is the operator the row is booked to.
 *
 *   agent_wallet_send        from = sender        to = recipient
 *                            metadata.destination = the wallet credited
 *   club_bank_send           from = staff sender  to = recipient (destination)
 *   agent_wallet_self_stake  from = to = the agent (agent wallet -> own player wallet)
 *   agent_wallet_claim_back  from = holder        to = the claiming agent
 *                            metadata.source = the wallet debited; the chips
 *                            land in the claimer's agent wallet
 *   club_bank_claim          from = holder        to = the claiming staff
 *                            metadata.source; the chips land in the club treasury
 *   club_bank_reversal       from = original recipient  to = original sender
 *                            metadata.destination = the wallet debited back;
 *                            the chips return to the club treasury
 *   admin_removal            from = player        to = the removing staff
 *                            source player_wallet; into the club treasury
 *
 * The narration used to read every one of those as `from` = actor, so a
 * claim back told the agent "Bob Claimed Back 500 From Your Player Wallet To
 * Bob's Agent Wallet", and an admin removal sent the chips to an agent wallet
 * they never reached. `club_bank_claim_back` was listed although no writer has
 * ever used that spelling, so real Club Bank claims got no sentence at all.
 */
export const WALLET_MOVE_TYPES = new Set<string>([
  'agent_wallet_send',
  'promo_wallet_send',
  'club_promo_send',
  'peer_transfer',
  'agent_wallet_self_stake',
  'club_bank_send',
  'club_bank_reversal',
  'agent_wallet_claim_back',
  'club_bank_claim',
  'admin_removal',
]);

function walletName(key: unknown, fallback: WalletName): WalletName {
  const k = String(key ?? '').toLowerCase();
  return DESTINATION_NAMES[k] ?? fallback;
}

/**
 * A HORSE IS NEVER NAMED, NOT EVEN BY ITS KIND (Dan, binding: "NOTHING SHOULD
 * EVER REVEAL A HORSES IDENTITY" and "HORSES ARE NEVER EVER EXCLUDED BY
 * DESIGN"; cashier launch round 3, contract 2, 2026-10-09).
 *
 * The treasury writers book a horse's seat funding, its rebuy shortfall and
 * its bankroll top-up under a kind of their own: from nobody, to the horse, no
 * metadata, and a stock note naming a horse. Printed under that kind, one
 * search of the Trade record listed every horse in the club. The movement is
 * the Club Bank paying a member, which is what a Club Bank send to a player
 * wallet is, so a ledger surface presents it as exactly that: the human kind,
 * the human route and sentence, no note. The row is never dropped (its amount
 * counts in every total) and its recipient is named the way every member is.
 * The ledger RPC is being moved to return the human kind itself; until that
 * migration is installed, the legacy spelling is mapped here.
 *
 * A ledger surface passes every row through this before anything reads its
 * kind, note or metadata. describeChipTransaction and walletRoute apply it as
 * well, so no caller can narrate the legacy kind on its own.
 */
const LEGACY_CLUB_BANK_SEND_KINDS = new Set<string>(['horse_treasury_funding']);

export function presentChipTransaction<T extends ChipTransactionLike>(row: T): T {
  if (!LEGACY_CLUB_BANK_SEND_KINDS.has(String(row.transaction_type ?? ''))) return row;
  return {
    ...row,
    transaction_type: 'club_bank_send',
    notes: null,
    metadata: { destination: 'player_wallet' },
  } as T;
}

/**
 * The sending side of a row, as someone who is not in it reads it. A Club Bank
 * send is the bank paying a member, so a third party reads the pot that paid,
 * never the staff member who pressed the button: exactly the Statement's rule
 * (20261009223439, rule 3: the pot is the side). That is also what keeps a
 * send nobody pressed (a treasury-funded seat, mapped above) reading the same
 * as one somebody did. Every other kind names the member who sent it.
 */
export function thirdPartySender(
  row: ChipTransactionLike,
  fromName: string | null | undefined
): string {
  if (String(row.transaction_type ?? '') === 'club_bank_send') return 'Club Bank';
  return fromName && fromName.trim() ? fromName : 'A Member';
}

/**
 * A chip figure in a forward-facing sentence: whole chips, compacted, rounded
 * down (#ClubArenaConsole; audit C1-14). The sentence used to print
 * "Sent 1,250.5" under a receipt headline that read "1.2K".
 */
export function formatChipAmount(amount: number | string | null | undefined): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '0';
  return compactChips(n);
}

/**
 * One sentence for a wallet move, or null when the row is not a wallet move
 * (the caller then shows `notes`, exactly as before).
 *
 *   names   user id -> display name, whatever the caller has loaded. A name
 *           that is not loaded prints as "A Member" rather than a uuid.
 *   viewer  the user reading the ledger; their own name reads as "You". A
 *           Club Bank send names its operator only to the operator and to the
 *           member paid; anyone else, or an unknown reader, reads the pot
 *           (thirdPartySender).
 *   figure  how the amount prints. A list sentence keeps the compact console
 *           reading (formatChipAmount); a receipt passes its own exact
 *           formatter, so the sentence agrees with the figure printed above it
 *           (launch audit 2026-10-09 P-10 with C1-14).
 */
export function describeChipTransaction(
  row: ChipTransactionLike,
  names: ReadonlyMap<string, string> | Record<string, string> = {},
  viewer?: string | null,
  figure: (amount: ChipTransactionLike['amount']) => string = formatChipAmount
): string | null {
  const shown = presentChipTransaction(row);
  const type = String(shown.transaction_type ?? '');
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

  const meta = (shown.metadata ?? {}) as Record<string, unknown>;
  const amount = figure(shown.amount);
  const from = shown.from_user_id;
  const to = shown.to_user_id;
  const actor = nameOf(from);
  const self = !!from && from === to;

  switch (type) {
    case 'agent_wallet_self_stake':
      return `${actor} Transferred ${amount} From ${possessive(from)} Agent Wallet To ${possessive(from)} Player Wallet`;
    case 'agent_wallet_send':
    case 'club_bank_send': {
      const source = SOURCE_BY_TYPE[type];
      const dest = walletName(meta.destination, 'Player Wallet');
      // The operator of a Club Bank send is named only to the two people in
      // it; everyone else reads the pot that paid (thirdPartySender).
      const operatorShown = !!from && !!viewer && (from === viewer || to === viewer);
      if (type === 'club_bank_send' && !operatorShown) {
        return `The Club Bank Sent ${amount} To ${possessive(to)} ${dest}`;
      }
      if (self) {
        return `${actor} Transferred ${amount} From The ${source} To ${possessive(to)} ${dest}`;
      }
      return `${actor} Sent ${amount} From ${type === 'club_bank_send' ? 'The Club Bank' : `${possessive(from)} Agent Wallet`} To ${possessive(to)} ${dest}`;
    }
    case 'promo_wallet_send':
    case 'club_promo_send': {
      const dest =
        meta.destination === 'cashier_agent_wallet'
          ? 'Agent Wallet'
          : meta.destination === 'player_wallet'
            ? 'Player Wallet'
            : 'Promo Wallet';
      const source =
        type === 'club_promo_send' ? 'The Club Promo Wallet' : `${possessive(from)} Promo Wallet`;
      return `${actor} Sent ${amount} From ${source} To ${possessive(to)} ${dest}`;
    }
    case 'peer_transfer':
      return meta.source === 'player_wallet' && meta.destination
        ? `${actor} Sent ${amount} From ${possessive(from)} Player Wallet To ${possessive(to)} ${walletName(meta.destination, 'Player Wallet')}`
        : null;
    case 'club_bank_claim': {
      const source = walletName(meta.source, 'Agent Wallet');
      return `${nameOf(to)} Claimed Back ${amount} From ${possessive(from)} ${source} To The Club Bank`;
    }
    case 'club_bank_reversal': {
      const source = walletName(meta.destination ?? meta.source, 'Agent Wallet');
      return `${nameOf(to)} Reversed ${amount} From ${possessive(from)} ${source} To The Club Bank`;
    }
    case 'agent_wallet_claim_back': {
      const source = walletName(meta.source ?? meta.destination, 'Player Wallet');
      return `${nameOf(to)} Claimed Back ${amount} From ${possessive(from)} ${source} To ${possessive(to)} Agent Wallet`;
    }
    case 'admin_removal': {
      const source = walletName(meta.source, 'Player Wallet');
      return `${nameOf(to)} Removed ${amount} From ${possessive(from)} ${source} To The Club Bank`;
    }
    default:
      return null;
  }
}

/**
 * The short "route" for a compact row: "Agent Wallet To Player Wallet". Null
 * when the row is not a wallet move.
 */
export function walletRoute(row: ChipTransactionLike): string | null {
  const shown = presentChipTransaction(row);
  const type = String(shown.transaction_type ?? '');
  if (!WALLET_MOVE_TYPES.has(type)) return null;
  const meta = (shown.metadata ?? {}) as Record<string, unknown>;
  const dest = walletName(meta.destination, 'Player Wallet');
  switch (type) {
    case 'agent_wallet_self_stake':
      return 'Agent Wallet To Player Wallet';
    case 'agent_wallet_send':
      return `Agent Wallet To ${dest}`;
    case 'club_bank_send':
      return `Club Bank To ${dest}`;
    case 'promo_wallet_send':
    case 'club_promo_send': {
      const dest =
        meta.destination === 'cashier_agent_wallet'
          ? 'Agent Wallet'
          : meta.destination === 'player_wallet'
            ? 'Player Wallet'
            : 'Promo Wallet';
      return `${type === 'club_promo_send' ? 'Club Promo Wallet' : 'Promo Wallet'} To ${dest}`;
    }
    case 'peer_transfer':
      return meta.source === 'player_wallet' && meta.destination
        ? `Player Wallet To ${dest}`
        : null;
    case 'club_bank_claim':
      return `${walletName(meta.source, 'Agent Wallet')} To Club Bank`;
    case 'club_bank_reversal':
      return `${walletName(meta.destination ?? meta.source, 'Agent Wallet')} To Club Bank`;
    case 'agent_wallet_claim_back':
      return `${walletName(meta.source ?? meta.destination, 'Player Wallet')} To Agent Wallet`;
    case 'admin_removal':
      return `${walletName(meta.source, 'Player Wallet')} To Club Bank`;
    default:
      return null;
  }
}
