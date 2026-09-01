import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { uuid } from '../utils/uuid';

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

export interface ManagedGameCommandReceipt {
  gameId: string;
  commandId: string;
  action: 'update' | 'close';
  status: 'processing' | 'succeeded' | 'rejected';
  versionBefore: number;
  versionAfter: number;
  createdAt: string;
  completedAt: string | null;
  reconciliationState: 'confirmed' | 'processing' | 'version_drift';
  replayed?: boolean;
}

interface ManagedGameCommandResult {
  ok?: boolean;
  reason?: string;
  message?: string | null;
  command_id?: string;
  command_status?: ManagedGameCommandReceipt['status'];
  version_before?: number;
  version_after?: number;
  contract_version_before?: number;
  contract_version_after?: number;
  current_version?: number;
  replayed?: boolean;
  created_at?: string;
  completed_at?: string | null;
  reconciliation_state?: ManagedGameCommandReceipt['reconciliationState'];
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
  contract_not_found: 'This game does not have a published contract yet. Refresh and try again.',
  stale_contract_version:
    'This game changed after you opened it. Your command was not applied. Review the latest version and try again.',
  idempotency_conflict:
    'This command identifier was already used for different work. Refresh and try again.',
  invalid_request: 'This command was incomplete. Refresh and try again.',
  invalid_payload: 'One or more game settings are invalid.',
  contract_rule_blocked: 'This command conflicts with the published game rules.',
  command_failed: 'The command could not be completed.',
};

function managementError(reason: string | null): string | null {
  return reason ? MANAGEMENT_ERRORS[reason] || reason.replace(/_/g, ' ') : null;
}

function mapCommandReceipt(
  raw: ManagedGameCommandResult & { game_id?: string; command_action?: string; status?: string }
): ManagedGameCommandReceipt {
  return {
    gameId: String(raw.game_id || ''),
    commandId: String(raw.command_id || ''),
    action: raw.command_action === 'close' ? 'close' : 'update',
    status:
      raw.command_status === 'processing' ||
      raw.command_status === 'rejected' ||
      raw.status === 'processing' ||
      raw.status === 'rejected'
        ? ((raw.command_status || raw.status) as ManagedGameCommandReceipt['status'])
        : 'succeeded',
    versionBefore: numberValue(raw.version_before ?? raw.contract_version_before),
    versionAfter: numberValue(raw.version_after ?? raw.contract_version_after),
    createdAt: String(raw.created_at || ''),
    completedAt: raw.completed_at ? String(raw.completed_at) : null,
    reconciliationState:
      raw.reconciliation_state === 'processing' || raw.reconciliation_state === 'version_drift'
        ? raw.reconciliation_state
        : 'confirmed',
    replayed: Boolean(raw.replayed),
  };
}

async function reconcileCommand(commandId: string): Promise<ManagedGameCommandResult | null> {
  try {
    const { data, error } = await supabase.rpc('fn_get_managed_game_command_receipt', {
      p_command_id: commandId,
    });
    if (error) return null;
    const result = data as {
      ok?: boolean;
      found?: boolean;
      receipt?: ManagedGameCommandResult;
    } | null;
    return result?.ok && result.found && result.receipt ? result.receipt : null;
  } catch {
    return null;
  }
}

async function executeCommand(
  kind: ManagedGameKind,
  gameId: string,
  action: 'update' | 'close',
  expectedVersion: number,
  payload: Record<string, unknown>
): Promise<ManagedGameCommandResult> {
  const commandId = uuid();

  // One bounded retry uses the identical command UUID. It is safe whether the
  // first request failed before execution, committed and lost its response, or
  // is still finishing: the database returns the one durable receipt.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await supabase.rpc('fn_execute_managed_game_command', {
      p_command_id: commandId,
      p_kind: kind,
      p_game_id: gameId,
      p_action: action,
      p_expected_version: expectedVersion,
      p_payload: payload,
    });
    if (!error) return (data || {}) as ManagedGameCommandResult;
    reportError(error, 'GameManagementService.executeCommand', {
      commandId,
      kind,
      gameId,
      action,
      attempt: attempt + 1,
    });
    const reconciled = await reconcileCommand(commandId);
    if (reconciled) return { ...reconciled, replayed: true };
  }

  const reconciled = await reconcileCommand(commandId);
  if (reconciled) return { ...reconciled, replayed: true };
  throw new Error(
    `Could not confirm command ${commandId}. Refresh Table Management before trying again.`
  );
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

  async getCommandReceipts(
    kind: ManagedGameKind,
    gameIds: string[]
  ): Promise<ManagedGameCommandReceipt[]> {
    if (gameIds.length === 0) return [];
    const { data, error } = await supabase.rpc('fn_get_managed_game_command_receipts', {
      p_kind: kind,
      p_game_ids: gameIds,
    });
    if (error) throw new Error(error.message || 'Could not load command receipts.');
    const result = data as { ok?: boolean; reason?: string; receipts?: any[] } | null;
    if (!result?.ok)
      throw new Error(
        managementError(result?.reason || null) || 'Could not load command receipts.'
      );
    return (result.receipts || []).map(mapCommandReceipt);
  },

  async update(
    kind: ManagedGameKind,
    gameId: string,
    patch: ManagedGamePatch,
    expectedVersion?: number
  ): Promise<ManagedGameCommandReceipt> {
    const version = expectedVersion || (await this.getContracts(kind, [gameId]))[0]?.version || 0;
    const data = await executeCommand(kind, gameId, 'update', version, {
      name: patch.name,
      small_blind: patch.smallBlind,
      big_blind: patch.bigBlind,
      min_buy_in: patch.minBuyIn,
      max_buy_in: patch.maxBuyIn,
      max_players: patch.maxPlayers,
      start_time: patch.startTime,
    });
    const reason = managementError(resultError(data, 'Could not update the game.'));
    if (reason) throw new Error(data.message || reason);
    masterBus.emit(
      kind === 'table' ? 'TABLE_UPDATED' : 'TOURNAMENT_UPDATED',
      kind === 'table' ? { tableId: gameId } : { tournamentId: gameId }
    );
    return mapCommandReceipt({ ...data, game_id: gameId, command_action: 'update' });
  },

  async close(
    kind: ManagedGameKind,
    gameId: string,
    expectedVersion?: number
  ): Promise<ManagedGameCommandReceipt> {
    const version = expectedVersion || (await this.getContracts(kind, [gameId]))[0]?.version || 0;
    const data = await executeCommand(kind, gameId, 'close', version, {});
    const reason = managementError(resultError(data, 'Could not close the game.'));
    if (reason) throw new Error(data.message || reason);
    if (kind === 'table') {
      masterBus.emit('TABLE_CLOSED', { tableId: gameId });
    } else {
      masterBus.emit('TOURNAMENT_CANCELLED', { tournamentId: gameId });
    }
    return mapCommandReceipt({ ...data, game_id: gameId, command_action: 'close' });
  },
};
