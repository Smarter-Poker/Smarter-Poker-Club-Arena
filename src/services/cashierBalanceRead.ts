import { supabase } from '../lib/supabase';
import { isUUID, resolveClubUUID } from '../utils/clubIdResolver';
import type { CashierWalletType } from '../components/wallet/cashierModes';

const amount = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Same authenticated, RLS-protected rows the cashier reads at open time. */
export async function readCashierBalances(
  clubId: string,
  userId: string,
  walletType: CashierWalletType,
  signal: AbortSignal
) {
  const uuid = await resolveClubUUID(clubId);
  if (!isUUID(uuid)) throw new Error('That club could not be resolved');
  const [club, agent] = await Promise.all([
    supabase
      .from('clubs')
      .select('id, name, union_id, chip_treasury, promo_balance')
      .eq('id', uuid)
      .abortSignal(signal)
      .maybeSingle(),
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
  if (club.error) throw club.error;
  if (agent.error) throw agent.error;
  if (!club.data) throw new Error('The club balance is unavailable');
  return {
    clubId: uuid,
    name: club.data.name || 'Club',
    inUnion: Boolean(club.data.union_id),
    bank:
      walletType === 'club_bank'
        ? amount(club.data.chip_treasury)
        : amount(agent.data?.agent_wallet_balance),
    promoPot: amount(club.data.promo_balance),
    promoFloat: amount(agent.data?.promo_wallet_balance),
  };
}
