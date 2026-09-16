import { supabase } from '../lib/supabase';
import { parseArenaIdentity, type ArenaAccessContext } from '../../server/src/domain/ArenaContext';

/** Fresh server entitlement. No localStorage, synthetic membership or chip fallback. */
export async function getArenaContext(clubKey: string): Promise<ArenaAccessContext | null> {
  const { data, error } = await supabase.rpc('fn_poker_arena_context', { p_club_key: clubKey });
  if (error) throw new Error(error.message || 'Could Not Verify Arena Access');
  if (data === null) return null;
  const arena = parseArenaIdentity(data.arena);
  if (typeof data.member !== 'boolean') throw new Error('Invalid Arena Access Response');
  const diamond = arena.kind === 'diamond_arena';
  if (diamond && (data.member !== true || data.role !== 'player'))
    throw new Error('Invalid Diamond Entitlement');
  return {
    arena,
    member: data.member,
    automaticMembership: diamond,
    cashGamesEnabled: diamond && data.cashGamesEnabled === true,
    role: typeof data.role === 'string' ? data.role : null,
    capabilities: {
      join: !diamond,
      hierarchy: !diamond,
      chipWallet: !diamond,
      diamondTransfers: diamond,
    },
  };
}
