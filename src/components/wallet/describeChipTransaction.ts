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
  | 'Club Promo Wallet'
  | 'Club Bank'
  | 'Union Bank'
  | 'Rake Treasury';

const DESTINATION_NAMES: Record<string, WalletName> = {
  player_wallet: 'Player Wallet',
  agent_wallet: 'Agent Wallet',
  promo_wallet: 'Promo Wallet',
  club_bank: 'Club Bank',
  club_promo_wallet: 'Club Promo Wallet',
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

/**
 * THE CASH-OUT LEGS (Dan, 2026-10-24: "WHO EVER APPROVES THE CASH OUT, THOSE
 * CHIPS ARE CREDITED TO THAT PERSONS AGENT WALLET ... AND IT SHOULD BE APART
 * OF THE CASHIER TRANSACTION REPORT").
 *
 * fn_cashier_cashout_transition writes one chip_transactions row per leg, and
 * the row's two user ids are NOT the wallets that moved:
 *
 *   cashout_request_escrow  from = player    to = ASSIGNED agent
 *                           the player's wallet is debited into a hold;
 *                           the assigned agent receives nothing
 *   cashout_approved        from = player    to = whoever ACCEPTED it
 *                           the hold is released into the ACCEPTER's agent
 *                           wallet; the player's wallet does not move again
 *   cashout_denied          from = canceller to = player  (hold -> player)
 *   cashout_cancelled       from = player    to = player  (hold -> player)
 *   cashout_expired_refund  from = nobody    to = player  (hold -> player)
 *
 * Read by from/to alone, the report credited the ASSIGNED agent with every
 * request (an owner who accepted a downline player's cash-out showed it
 * against the agent who never touched it), counted the player's chips out
 * twice, and booked the canceller as paying a refund out of their own wallet.
 * ledgerDirection reads each leg by the wallet that actually moved, exactly
 * as the Full Statement already does
 * (tests/the-statement-counts-each-move-once.db.law.test.ts).
 */
export const CASHOUT_LEG_TYPES = new Set<string>([
  'cashout_request_escrow',
  'cashout_approved',
  'cashout_denied',
  'cashout_cancelled',
  'cashout_expired_refund',
]);

export type LedgerDirection = 'in' | 'out' | 'managed';

/**
 * Kinds the Full Statement never books into or out of a member's wallet: a
 * union promo move, a mint and a burn change a pot, not the viewer's chips.
 */
export const STATEMENT_MANAGED_TYPES = new Set<string>([
  'union_promo_to_club',
  'union_promo_clawback',
  'mint',
  'treasury_mint',
  'treasury_burn',
]);

/**
 * Which way a ledger row moved the VIEWER's own chips, by the Full Statement's
 * rule (fn_cashier_statement_rows), so the history and the statement can never
 * disagree: a cash-out leg is read by the wallet that moved; a pot move is
 * managed; otherwise the recipient is in, the sender is out, and a self move
 * or a row the viewer is not a side of is managed. fn_cashier_history_totals
 * sums by exactly this rule.
 */
export function ledgerDirection(
  row: ChipTransactionLike,
  viewer: string | null | undefined
): LedgerDirection {
  const type = String(row.transaction_type ?? '');
  const from = row.from_user_id ?? null;
  const to = row.to_user_id ?? null;
  if (!viewer) return 'managed';
  if (CASHOUT_LEG_TYPES.has(type)) {
    if (type === 'cashout_request_escrow') return from === viewer ? 'out' : 'managed';
    return to === viewer ? 'in' : 'managed';
  }
  if (STATEMENT_MANAGED_TYPES.has(type)) return 'managed';
  if (to === viewer && from !== viewer) return 'in';
  if (from === viewer && to !== viewer) return 'out';
  return 'managed';
}

/**
 * The line a history row prints for a cash-out leg, in plain words, so a
 * request never reads as a transfer to the agent it was sent to (it moved no
 * chips to him) and an acceptance names who took the chips. Null for any
 * other kind: the row keeps its usual "To / From / Transfer" line.
 */
export function cashoutRowTitle(
  row: ChipTransactionLike,
  fromName: string | null | undefined,
  toName: string | null | undefined,
  viewer: string | null | undefined
): string | null {
  const type = String(row.transaction_type ?? '');
  if (!CASHOUT_LEG_TYPES.has(type)) return null;
  const from = row.from_user_id ?? null;
  const to = row.to_user_id ?? null;
  const fromIsMe = !!viewer && from === viewer;
  const toIsMe = !!viewer && to === viewer;
  const fromN = fromName && fromName.trim() ? fromName : 'A Member';
  const toN = toName && toName.trim() ? toName : 'A Member';
  switch (type) {
    case 'cashout_request_escrow':
      // from = the player, to = the agent the request was sent to.
      if (fromIsMe) return `Cash-Out Request To ${toN}`;
      if (toIsMe) return `${fromN} Requested A Cash-Out From You`;
      return `${fromN} Requested A Cash-Out From ${toN}`;
    case 'cashout_approved':
      // from = the player, to = whoever accepted it.
      if (toIsMe) return `You Accepted ${fromN}'s Cash-Out`;
      if (fromIsMe) return `${toN} Accepted Your Cash-Out`;
      return `${toN} Accepted ${fromN}'s Cash-Out`;
    case 'cashout_denied':
      // from = whoever cancelled it, to = the player.
      if (toIsMe) return `${fromN} Cancelled Your Cash-Out`;
      if (fromIsMe) return `You Cancelled ${toN}'s Cash-Out`;
      return `${fromN} Cancelled ${toN}'s Cash-Out`;
    case 'cashout_cancelled':
      return toIsMe ? 'You Withdrew Your Cash-Out' : `${toN} Withdrew A Cash-Out`;
    default:
      return toIsMe ? 'Your Cash-Out Expired' : `${toN}'s Cash-Out Expired`;
  }
}

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
  if (!WALLET_MOVE_TYPES.has(type) && !CASHOUT_LEG_TYPES.has(type)) return null;

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
  const returned = typeof meta.returned_amount === 'number' ? figure(meta.returned_amount) : amount;
  const repayment =
    Number(meta.credit_repaid) > 0
      ? `. ${figure(Number(meta.credit_repaid))} Repaid The Original Credit Draw`
      : '';
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
      return `${nameOf(to)} Claimed Back ${returned} From ${possessive(from)} ${source} To ${meta.destination === 'club_promo_wallet' ? 'The Club Promo Wallet' : meta.destination && meta.destination !== 'club_bank' ? `${possessive(to)} ${walletName(meta.destination, 'Club Bank')}` : 'The Club Bank'}${repayment}`;
    }
    case 'club_bank_reversal': {
      const source = walletName(meta.destination ?? meta.source, 'Agent Wallet');
      return `${nameOf(to)} Reversed ${amount} From ${possessive(from)} ${source} To The Club Bank`;
    }
    case 'agent_wallet_claim_back': {
      const source = walletName(meta.source ?? meta.destination, 'Player Wallet');
      return `${nameOf(to)} Claimed Back ${returned} From ${possessive(from)} ${source} To ${possessive(to)} ${walletName(meta.source ? meta.destination : null, 'Agent Wallet')}${repayment}`;
    }
    case 'admin_removal': {
      const source = walletName(meta.source, 'Player Wallet');
      return `${nameOf(to)} Removed ${amount} From ${possessive(from)} ${source} To The Club Bank`;
    }
    // The cash-out legs (CASHOUT_LEG_TYPES): the accepter is the to side of
    // an acceptance, and the chips land in THAT person's agent wallet.
    case 'cashout_request_escrow':
      return `${actor} Requested A Cash-Out Of ${amount} From ${possessive(from)} Player Wallet. The Chips Are Held Until It Is Accepted Or Cancelled`;
    case 'cashout_approved':
      return `${nameOf(to)} Accepted ${possessive(from)} Cash-Out Of ${amount}. The Chips Went To ${possessive(to)} Agent Wallet`;
    case 'cashout_denied':
      return `${actor} Cancelled ${possessive(to)} Cash-Out Of ${amount}. The Chips Went Back To ${possessive(to)} Player Wallet`;
    case 'cashout_cancelled':
      return `${nameOf(to)} Withdrew ${nameOf(to) === 'You' ? 'Your' : 'Their'} Cash-Out Of ${amount}. The Chips Went Back To ${possessive(to)} Player Wallet`;
    case 'cashout_expired_refund':
      return `${possessive(to)} Cash-Out Of ${amount} Expired. The Chips Went Back To ${possessive(to)} Player Wallet`;
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
  switch (type) {
    case 'cashout_request_escrow':
      return 'Player Wallet To Held Cash-Out';
    case 'cashout_approved':
      return 'Held Cash-Out To Agent Wallet';
    case 'cashout_denied':
    case 'cashout_cancelled':
    case 'cashout_expired_refund':
      return 'Held Cash-Out To Player Wallet';
    default:
      break;
  }
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
      return `${walletName(meta.source, 'Agent Wallet')} To ${walletName(meta.destination, 'Club Bank')}`;
    case 'club_bank_reversal':
      return `${walletName(meta.destination ?? meta.source, 'Agent Wallet')} To Club Bank`;
    case 'agent_wallet_claim_back':
      return `${walletName(meta.source ?? meta.destination, 'Player Wallet')} To ${walletName(meta.source ? meta.destination : null, 'Agent Wallet')}`;
    case 'admin_removal':
      return `${walletName(meta.source, 'Player Wallet')} To Club Bank`;
    default:
      return null;
  }
}
