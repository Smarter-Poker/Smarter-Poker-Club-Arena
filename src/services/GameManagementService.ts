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

const MANAGEMENT_ERRORS: Record<string, string> = {
  players_seated:
    'This table cannot be closed while players are seated. Ask every player to leave first.',
  players_registered:
    'This tournament cannot be changed or cancelled after a player has registered.',
  already_closed: 'This game is already closed.',
  not_authorized: 'You do not have permission to manage this game.',
  game_not_found: 'This game could not be found.',
};

function managementError(reason: string | null): string | null {
  return reason ? MANAGEMENT_ERRORS[reason] || reason.replace(/_/g, ' ') : null;
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
    const reason = managementError(resultError(data, 'Could not update the game.'));
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
    const reason = managementError(resultError(data, 'Could not close the game.'));
    if (reason) throw new Error(reason);
    masterBus.emit(
      kind === 'table' ? 'TABLE_CLOSED' : 'TOURNAMENT_CANCELLED',
      kind === 'table' ? { tableId: gameId } : { tournamentId: gameId }
    );
  },
};
