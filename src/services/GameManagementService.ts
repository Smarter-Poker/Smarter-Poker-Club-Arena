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

export interface ManagedGameReadiness {
  state: 'ready' | 'funding_blocked' | 'incomplete' | 'closed' | 'missing';
  canStart: boolean;
  contractLocked: boolean;
  guaranteeEnforced: boolean;
  guaranteedPrize: number;
  currentPrizePool: number;
  overlayRequired: number;
  bankType: 'club' | 'union' | null;
  bankBalance: number;
  bankFloor: number;
  otherLiveExposure: number;
  shortBy: number;
}

export interface ManagedGameContractSummary {
  gameId: string;
  version: number;
  contractHash: string;
  publishedAt: string;
  changeReason: string;
  contractLocked: boolean;
  readiness: ManagedGameReadiness;
}

export interface ManagedGameContractVersion {
  version: number;
  contractHash: string;
  contract: Record<string, unknown>;
  publishedAt: string;
  changeReason: string;
}

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

function mapReadiness(raw: any): ManagedGameReadiness {
  return {
    state: raw?.state || 'missing',
    canStart: Boolean(raw?.can_start),
    contractLocked: Boolean(raw?.contract_locked),
    guaranteeEnforced: Boolean(raw?.guarantee_enforced),
    guaranteedPrize: numberValue(raw?.guaranteed_prize),
    currentPrizePool: numberValue(raw?.current_prize_pool),
    overlayRequired: numberValue(raw?.overlay_required),
    bankType: raw?.bank_type === 'club' || raw?.bank_type === 'union' ? raw.bank_type : null,
    bankBalance: numberValue(raw?.bank_balance),
    bankFloor: numberValue(raw?.bank_floor),
    otherLiveExposure: numberValue(raw?.other_live_exposure),
    shortBy: numberValue(raw?.short_by),
  };
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
  async getContracts(
    kind: ManagedGameKind,
    gameIds: string[]
  ): Promise<ManagedGameContractSummary[]> {
    if (gameIds.length === 0) return [];
    const { data, error } = await supabase.rpc('fn_get_managed_game_contracts', {
      p_kind: kind,
      p_game_ids: gameIds,
    });
    if (error) throw new Error(error.message || 'Could not load published game contracts.');
    const result = data as { ok?: boolean; reason?: string; contracts?: any[] } | null;
    if (!result?.ok)
      throw new Error(
        managementError(result?.reason || null) || 'Could not load published game contracts.'
      );
    return (result.contracts || []).map((row) => ({
      gameId: String(row.game_id),
      version: numberValue(row.version),
      contractHash: String(row.contract_hash || ''),
      publishedAt: String(row.published_at || ''),
      changeReason: String(row.change_reason || 'published'),
      contractLocked: Boolean(row.contract_locked),
      readiness: mapReadiness(row.readiness),
    }));
  },

  async getContractHistory(
    kind: ManagedGameKind,
    gameId: string
  ): Promise<ManagedGameContractVersion[]> {
    const { data, error } = await supabase.rpc('fn_get_managed_game_contract_history', {
      p_kind: kind,
      p_game_id: gameId,
    });
    if (error) throw new Error(error.message || 'Could not load contract history.');
    const result = data as { ok?: boolean; reason?: string; versions?: any[] } | null;
    if (!result?.ok)
      throw new Error(
        managementError(result?.reason || null) || 'Could not load contract history.'
      );
    return (result.versions || []).map((row) => ({
      version: numberValue(row.version),
      contractHash: String(row.contract_hash || ''),
      contract: row.contract && typeof row.contract === 'object' ? row.contract : {},
      publishedAt: String(row.published_at || ''),
      changeReason: String(row.change_reason || 'published'),
    }));
  },

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
    if (kind === 'table') {
      masterBus.emit('TABLE_CLOSED', { tableId: gameId });
    } else {
      masterBus.emit('TOURNAMENT_CANCELLED', { tournamentId: gameId });
    }
  },
};
