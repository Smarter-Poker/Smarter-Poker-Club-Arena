import { useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { parseTableArenaIdentity, type ArenaIdentity } from '../../server/src/domain/ArenaContext';
import { fetchLightningAnchorSeat, type LightningPoolEntry } from './lightningSession';

/** A room has no tables row. Its verified own anchor supplies funding identity. */
export async function readLightningFundingArena(
  clusterId: string,
  poolSessionId: string
): Promise<ArenaIdentity | null> {
  const anchor = await fetchLightningAnchorSeat(clusterId, poolSessionId);
  if (!anchor) return null;
  const { data, error } = await supabase
    .from('tables')
    .select(
      'id, cluster_id, club_id, union_id, arena:clubs!fk_tables_club_id(id, asset, is_platform, union_id)'
    )
    .eq('id', anchor.anchorTableId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.id !== anchor.anchorTableId || data.cluster_id !== clusterId)
    throw new Error('Lightning Funding Anchor Unverified');
  return parseTableArenaIdentity(data);
}

/** One read on room/account change, with no cashier refresh or money write. */
export function useLightningFundingArena({
  room,
  userId,
  onArena,
  readArena = readLightningFundingArena,
}: {
  room: LightningPoolEntry | null;
  userId: string | null | undefined;
  onArena: (poolSessionId: string, arena: ArenaIdentity) => void;
  readArena?: typeof readLightningFundingArena;
}) {
  const poolSessionId = room?.poolSessionId;
  const clusterId = room?.clusterId;
  useEffect(() => {
    if (!poolSessionId || !clusterId || !userId || userId === 'guest') return;
    let current = true;
    void readArena(clusterId, poolSessionId)
      .then((arena) => {
        if (current && arena) onArena(poolSessionId, arena);
      })
      .catch((error) => {
        if (current)
          reportError(error, 'TablePage.lightning_funding_arena_read_failed', { clusterId });
      });
    return () => {
      current = false;
    };
  }, [poolSessionId, clusterId, userId, onArena, readArena]);
}
