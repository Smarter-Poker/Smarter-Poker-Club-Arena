import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';

export type ManagedGameKind = 'table' | 'tournament';

export interface ManagedGamePatch {
  name?: string;
  smallBlind?: number;
  bigBlind?: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  maxPlayers?: number;
  startTime?: string;
}

function resultError(data: unknown, fallback: string): string | null {
  if (!data || typeof data !== 'object') return fallback;
  const result = data as { ok?: boolean; reason?: string };
  return result.ok ? null : result.reason || fallback;
}

export const gameManagementService = {
  async update(kind: ManagedGameKind, gameId: string, patch: ManagedGamePatch): Promise<void> {
    const { data, error } = await supabase.rpc('fn_update_managed_game', {
      p_kind: kind,
      p_game_id: gameId,
      p_patch: {
        name: patch.name,
        small_blind: patch.smallBlind,
        big_blind: patch.bigBlind,
        min_buy_in: patch.minBuyIn,
        max_buy_in: patch.maxBuyIn,
        max_players: patch.maxPlayers,
        start_time: patch.startTime,
      },
    });
    if (error) throw new Error(error.message || 'Could not update the game.');
    const reason = resultError(data, 'Could not update the game.');
    if (reason) throw new Error(reason);
    masterBus.emit(
      kind === 'table' ? 'TABLE_UPDATED' : 'TOURNAMENT_UPDATED',
      kind === 'table' ? { tableId: gameId } : { tournamentId: gameId }
    );
  },

  async close(kind: ManagedGameKind, gameId: string): Promise<void> {
    const { data, error } = await supabase.rpc('fn_close_managed_game', {
      p_kind: kind,
      p_game_id: gameId,
    });
    if (error) throw new Error(error.message || 'Could not close the game.');
    const reason = resultError(data, 'Could not close the game.');
    if (reason) throw new Error(reason);
    masterBus.emit(
      kind === 'table' ? 'TABLE_CLOSED' : 'TOURNAMENT_CANCELLED',
      kind === 'table' ? { tableId: gameId } : { tournamentId: gameId }
    );
    masterBus.emit('BALANCE_UPDATED', { source: `${kind}_management_close` });
  },
};
