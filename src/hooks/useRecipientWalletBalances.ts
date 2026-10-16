import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { resolveClubUUID } from '../utils/clubIdResolver';
import type { ClubBankRecipientWallet } from '../components/wallet/cashierModes';

/**
 * THE RECIPIENT'S CURRENT BALANCE IN EACH WALLET THEY HOLD (2026-10-16).
 *
 * Dan, 2026-10-15, on the send screens: "AND IT SHOULD HAVE THERE CURRENT CHIP
 * BALANCES AS WELL." The Send Out screen reads them from
 * fn_cashier_recipient_wallet_balances, which checks the caller's cashier role
 * and downline before it returns anything. Every other send form reads the same
 * function through this hook, so a wallet choice is never shown without its
 * balance on one screen and with it on another.
 *
 * A wallet the recipient does not hold comes back null from the server and is
 * left out here. A read that fails or is refused yields null for the whole
 * recipient: the forms then print "Unknown", never a fabricated zero.
 */
export type RecipientWalletBalances = Partial<Record<ClubBankRecipientWallet, number>>;

const WALLETS: readonly ClubBankRecipientWallet[] = [
  'agent_wallet',
  'promo_wallet',
  'player_wallet',
];

export function parseRecipientWalletBalances(
  data: unknown,
  userId: string
): RecipientWalletBalances | null {
  if (!Array.isArray(data)) return null;
  const row = data.find(
    (entry) =>
      !!entry && typeof entry === 'object' && (entry as { user_id?: unknown }).user_id === userId
  ) as Record<string, unknown> | undefined;
  if (!row) return null;
  const balances: RecipientWalletBalances = {};
  for (const wallet of WALLETS) {
    const value = row[wallet];
    if (value === null || value === undefined) continue;
    const amount = Number(value);
    if (Number.isFinite(amount)) balances[wallet] = amount;
  }
  return balances;
}

export function useRecipientWalletBalances(
  clubId: string | null | undefined,
  userId: string | null | undefined,
  refreshKey: unknown = 0
): RecipientWalletBalances | null {
  const [balances, setBalances] = useState<RecipientWalletBalances | null>(null);

  useEffect(() => {
    let live = true;
    setBalances(null);
    if (!clubId || !userId) return;
    void (async () => {
      try {
        const clubUuid = await resolveClubUUID(clubId);
        const { data, error } = await supabase.rpc('fn_cashier_recipient_wallet_balances', {
          p_club_id: clubUuid,
          p_user_ids: [userId],
        });
        if (!live || error) return;
        setBalances(parseRecipientWalletBalances(data, userId));
      } catch {
        // Left null: the form says Unknown rather than guessing.
      }
    })();
    return () => {
      live = false;
    };
  }, [clubId, userId, refreshKey]);

  return balances;
}

/** "Agent Wallet: 100,000" or "Agent Wallet" while the balance is unread. */
export function walletOptionLabel(
  label: string,
  balances: RecipientWalletBalances | null,
  wallet: ClubBankRecipientWallet
): string {
  const amount = balances?.[wallet];
  return amount === undefined ? label : `${label}: ${amount.toLocaleString()}`;
}
