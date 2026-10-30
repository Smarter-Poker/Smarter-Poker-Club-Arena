import { supabase } from '../lib/supabase';
import { parseTableArenaIdentity } from '../../server/src/domain/ArenaContext';
import { getDiamondCustodyBalance } from './DiamondCustodyService';
import { WalletService } from './WalletService';
import { getLightningPoolSession, fetchLightningAnchorSeat } from '../lightning/lightningSession';

/** Resolve the actual table before selecting its financial read door. */
export async function readTableFundingBalance(
  userId: string,
  opts: { tableId?: string | null }
): Promise<{ balance: number | null }> {
  if (!userId || userId === 'guest' || !opts.tableId) return { balance: null };
  try {
    let fundingTableId = opts.tableId;
    const room = getLightningPoolSession(fundingTableId);
    if (room) {
      const anchor = await fetchLightningAnchorSeat(room.clusterId, fundingTableId);
      if (!anchor) return { balance: null };
      fundingTableId = anchor.anchorTableId;
    }
    const { data, error } = await supabase
      .from('tables')
      .select('club_id, union_id, arena:clubs!fk_tables_club_id(id, asset, is_platform, union_id)')
      .eq('id', fundingTableId)
      .maybeSingle();
    if (error || !data) return { balance: null };
    const arena = parseTableArenaIdentity(data);
    if (arena.asset === 'diamonds') {
      const balance = await getDiamondCustodyBalance();
      return { balance: balance.available };
    }
    return WalletService.readPlayerBalance(userId, { tableId: fundingTableId });
  } catch {
    return { balance: null };
  }
}
