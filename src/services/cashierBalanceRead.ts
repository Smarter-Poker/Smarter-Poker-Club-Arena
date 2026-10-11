import { supabase } from '../lib/supabase';
import { isUUID, resolveClubUUID } from '../utils/clubIdResolver';
import type { CashierWalletType } from '../components/wallet/cashierModes';

const amount = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const objectValue = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface CashierBalanceSnapshot {
  clubId: string;
  name: string;
  inUnion: boolean;
  /** Club Bank or the viewer's Agent Wallet, by walletType. null = unavailable, never 0. */
  bank: number | null;
  /** The club's promo pot (clubs.promo_balance through the role-checked panel). */
  promoPot: number | null;
  /** The viewer's own promo float (agents.promo_wallet_balance). */
  promoFloat: number | null;
  /**
   * D-16 (2026-10-09): false when the viewer simply has no `agents` row, so the
   * Agent Wallet row can say "No Agent Float Yet" instead of "Unavailable";
   * true when the float row exists; null when the float was not read at all
   * (club_bank cashier) or could not be read (then `bank` is also null).
   */
  hasFloat: boolean | null;
}

/**
 * The balances the cashier paints at open time.
 *
 * S-07 (2026-10-09): Club Bank and the promo pot used to be read straight off
 * `clubs.chip_treasury` / `clubs.promo_balance`. Production grants SELECT on
 * those columns to every signed-in (and anonymous) API caller, so the cashier
 * role gate for that figure was client-only. `fn_club_money_panel` is the
 * SECURITY DEFINER read that answers the same question behind a server role
 * check (member, club staff or union staff), and is what DynamicWallet already
 * uses. A refused or unreadable panel throws, so the modal shows Unavailable;
 * it never resolves to 0.
 */
export async function readCashierBalances(
  clubId: string,
  userId: string,
  walletType: CashierWalletType,
  signal: AbortSignal
): Promise<CashierBalanceSnapshot> {
  const uuid = await resolveClubUUID(clubId);
  if (!isUUID(uuid)) throw new Error('That club could not be resolved');
  const [panel, agent] = await Promise.all([
    supabase.rpc('fn_club_money_panel', { p_club_id: uuid }).abortSignal(signal),
    walletType !== 'club_bank'
      ? supabase
          .from('agents')
          .select('agent_wallet_balance, promo_wallet_balance')
          .eq('club_id', uuid)
          .eq('user_id', userId)
          .abortSignal(signal)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (panel.error) throw panel.error;
  if (agent.error) throw agent.error;
  // A jsonb RPC hands back the object; a TABLE one would hand back an array.
  const money = Array.isArray(panel.data) ? panel.data[0] : panel.data;
  // `{authorized:false, reason}` is a RESOLVED rpc with no `error`: a refusal,
  // not a balance. It must reach the modal's error path, never paint 0.00.
  if (!objectValue(money) || money.authorized !== true)
    throw new Error('The club balance is unavailable');
  const floatRead = walletType !== 'club_bank';
  const hasFloat = floatRead ? agent.data !== null : null;
  return {
    clubId: uuid,
    name: typeof money.club_name === 'string' && money.club_name ? money.club_name : 'Club',
    inUnion: money.in_union === true || Boolean(money.union_id),
    bank:
      walletType === 'club_bank'
        ? amount(money.club_treasury)
        : hasFloat
          ? amount(agent.data?.agent_wallet_balance)
          : 0,
    promoPot: amount(money.club_promo_wallet),
    promoFloat: floatRead ? (hasFloat ? amount(agent.data?.promo_wallet_balance) : 0) : null,
    hasFloat,
  };
}
