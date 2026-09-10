import { supabase } from '../lib/supabase';
import { parseTableArenaIdentity } from '../../server/src/domain/ArenaContext';
import { getDiamondCustodyBalance } from './DiamondCustodyService';
import { WalletService } from './WalletService';

/** Resolve the actual table before selecting its financial read door. */
export async function readTableFundingBalance(
  userId: string,
  opts: { tableId?: string | null }
): Promise<{ balance: number | null }> {
  if (!opts.tableId) return { balance: null };
  try {
    const { data, error } = await supabase
      .from('tables')
      .select('club_id, union_id, arena:clubs!fk_tables_club_id(id, asset, is_platform, union_id)')
      .eq('id', opts.tableId)
      .maybeSingle();
    if (error || !data) return { balance: null };
    const arena = parseTableArenaIdentity(data);
    if (arena.asset === 'diamonds') {
      const balance = await getDiamondCustodyBalance();
      return { balance: balance.available };
    }
    return WalletService.readPlayerBalance(userId, opts);
  } catch {
    return { balance: null };
  }
}
