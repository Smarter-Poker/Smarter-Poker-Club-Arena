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

export interface GameManagementHealth {
  latestEventSequence: number;
  lastEventAt: string | null;
  eventsLastHour: number;
  commandsLast24h: number;
  rejectedLast24h: number;
  integrityAlerts: number;
  scheduledPending: number;
  scheduledRejected24h: number;
  eventRows: number;
  retentionDays: number;
}

export interface ManagedGameSchedule {
  scheduleId: string;
  executeAt: string;
  status: 'scheduled' | 'executing' | 'succeeded' | 'rejected' | 'cancelled';
}

export interface ManagedGameListCursor {
  sortAt: string;
  kind: ManagedGameKind;
  id: string;
  /**
   * The priority bucket the row sits in - 0 live, 1 scheduled, 2 closed. It is
   * the FIRST key the board orders by, so it is also the first key of the
   * keyset cursor: without it, paging past the end of the live games would
   * restart from the beginning of the next bucket instead of continuing.
   */
  bucket: number;
}

export interface ManagedGameListResult {
  items: any[];
  /**
   * Null means UNCHANGED, never zero.
   *
   * The counters describe the whole scope, so fn_list_managed_games computes
   * them on the first page only - on Midway Union that scan is most of the
   * page's time budget and paging cannot alter a whole-scope total. A caller
   * that reads null as 0 will wipe the header on Load More.
   */
  counts: {
    total: number;
    live: number;
    scheduled: number;
    closed: number;
    closedWithinHorizon: number;
    closedHorizonDays: number;
  } | null;
  nextCursor: ManagedGameListCursor | null;
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

const ENGINE_BASE_URL =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_ENGINE_URL ??
  'https://engine.smarter.poker';

function engineAuthHeader(): Record<string, string> {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem('smarter-poker-auth') : null;
    const token = raw ? (JSON.parse(raw) as { access_token?: string }).access_token : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function executeEngineAdminAction(
  tableId: string,
  action: 'pause' | 'resume'
): Promise<void> {
  const response = await fetch(`${ENGINE_BASE_URL}/admin/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...engineAuthHeader() },
    body: JSON.stringify({
      tableId,
      ...(action === 'pause' ? { reason: 'Table Management operator pause' } : {}),
    }),
  });
  const result = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
  };
  if (!response.ok || result.success === false) {
    throw new Error(result.error || `Could not ${action} this table.`);
  }
  masterBus.emit('TABLE_UPDATED', { tableId, status: action === 'pause' ? 'paused' : 'running' });
}

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
  invalid_schedule: 'Choose a time from two minutes to one year from now.',
  schedule_not_found: 'This scheduled command no longer exists.',
  schedule_not_pending: 'This scheduled command has already started or finished.',
  contract_rule_blocked: 'This command conflicts with the published game rules.',
  command_failed: 'The command could not be completed.',
};

function managementError(reason: string | null): string | null {
  return reason ? MANAGEMENT_ERRORS[reason] || reason.replace(/_/g, ' ') : null;
}

/**
 * One contract projection, used by both readers.
 *
 * fn_list_managed_games now returns each row's published contract inline, so
 * the board no longer makes a second round trip for it. That is only safe
 * while the two are mapped identically - a second copy of this object literal
 * is how the board and the contract dialog would start disagreeing about the
 * same contract.
 */
function mapContractSummary(row: any): ManagedGameContractSummary {
  return {
    gameId: String(row.game_id),
    version: numberValue(row.version),
    contractHash: String(row.contract_hash || ''),
    publishedAt: String(row.published_at || ''),
    changeReason: String(row.change_reason || 'published'),
    contractLocked: Boolean(row.contract_locked),
    readiness: mapReadiness(row.readiness),
  };
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
  async pause(tableId: string): Promise<void> {
    await executeEngineAdminAction(tableId, 'pause');
  },

  async resume(tableId: string): Promise<void> {
    await executeEngineAdminAction(tableId, 'resume');
  },

  async list(
    scope: 'club' | 'union',
    scopeId: string,
    cursor: ManagedGameListCursor | null = null,
    /**
     * Restrict the page to one priority bucket - 0 live, 1 scheduled, 2 closed.
     * This is what makes a board tab a QUERY rather than a filter over whichever
     * page happened to load; null is the All tab. The counts come back
     * unfiltered either way, so the header always describes the whole scope.
     */
    bucket: number | null = null
  ): Promise<ManagedGameListResult> {
    const { data, error } = await supabase.rpc('fn_list_managed_games', {
      p_scope: scope,
      p_scope_id: scopeId,
      p_cursor: cursor?.sortAt || null,
      p_cursor_kind: cursor?.kind || null,
      p_cursor_id: cursor?.id || null,
      p_limit: 100,
      p_cursor_bucket: cursor?.bucket ?? null,
      p_bucket: bucket,
    });
    if (error) throw new Error(error.message || 'Could not load managed games.');
    const result = data as any;
    if (!result?.ok)
      throw new Error(managementError(result?.reason || null) || 'Could not load managed games.');
    return {
      // The row arrives whole: fn_list_managed_games folds in the published
      // contract and the latest command receipt, so the caller does not make
      // four more round trips to assemble what it is about to draw.
      items: (Array.isArray(result.items) ? result.items : []).map((row: any) => ({
        ...row,
        contract: row.contract ? mapContractSummary(row.contract) : null,
        lastCommand: row.last_command ? mapCommandReceipt(row.last_command) : null,
      })),
      counts: result.counts
        ? {
            total: numberValue(result.counts.total),
            live: numberValue(result.counts.live),
            scheduled: numberValue(result.counts.scheduled),
            closed: numberValue(result.counts.closed),
            closedWithinHorizon: numberValue(result.counts.closed_within_horizon),
            closedHorizonDays: numberValue(result.counts.closed_horizon_days),
          }
        : null,
      nextCursor: result.next_cursor
        ? {
            sortAt: String(result.next_cursor.sort_at),
            kind: result.next_cursor.kind as ManagedGameKind,
            id: String(result.next_cursor.id),
            bucket: numberValue(result.next_cursor.bucket),
          }
        : null,
    };
  },

  async scheduleClose(
    kind: ManagedGameKind,
    gameId: string,
    expectedVersion: number,
    executeAt: string
  ): Promise<ManagedGameSchedule> {
    const { data, error } = await supabase.rpc('fn_schedule_managed_game_close', {
      p_kind: kind,
      p_game_id: gameId,
      p_expected_version: expectedVersion,
      p_execute_at: executeAt,
    });
    if (error) throw new Error(error.message || 'Could not schedule this command.');
    const result = data as any;
    const reason = managementError(resultError(result, 'Could not schedule this command.'));
    if (reason) throw new Error(reason);
    return {
      scheduleId: String(result.schedule.schedule_id),
      executeAt: String(result.schedule.execute_at),
      status: result.schedule.status,
    };
  },

  async cancelSchedule(scheduleId: string): Promise<void> {
    const { data, error } = await supabase.rpc('fn_cancel_managed_game_schedule', {
      p_schedule_id: scheduleId,
    });
    if (error) throw new Error(error.message || 'Could not cancel this schedule.');
    const reason = managementError(resultError(data, 'Could not cancel this schedule.'));
    if (reason) throw new Error(reason);
  },

  async getHealth(scope: 'club' | 'union', scopeId: string): Promise<GameManagementHealth> {
    const [{ data, error }, { data: scaleData, error: scaleError }] = await Promise.all([
      supabase.rpc('fn_get_game_management_health', {
        p_scope: scope,
        p_scope_id: scopeId,
      }),
      supabase.rpc('fn_get_game_management_scale_health', {
        p_scope: scope,
        p_scope_id: scopeId,
      }),
    ]);
    if (error || scaleError)
      throw new Error(error?.message || scaleError?.message || 'Could not load management health.');
    const result = data as Record<string, unknown> | null;
    const scale = scaleData as Record<string, unknown> | null;
    if (!result?.ok || !scale?.ok)
      throw new Error('Management health is not available for this scope.');
    return {
      latestEventSequence: numberValue(result.latest_event_sequence),
      lastEventAt: typeof result.last_event_at === 'string' ? result.last_event_at : null,
      eventsLastHour: numberValue(result.events_last_hour),
      commandsLast24h: numberValue(result.commands_last_24h),
      rejectedLast24h: numberValue(result.rejected_last_24h),
      integrityAlerts: numberValue(result.integrity_alerts),
      scheduledPending: numberValue(scale.scheduled_pending),
      scheduledRejected24h: numberValue(scale.scheduled_rejected_24h),
      eventRows: numberValue(scale.event_rows),
      retentionDays: numberValue(scale.retention_days),
    };
  },

  /**
   * Re-read ONE game, enriched exactly as it arrives in the list - same
   * function, same projection, so a row cannot mean two things.
   *
   * Returns null when the game is no longer visible in this scope (closed and
   * filtered out, moved, deleted). The caller must treat null as "I do not
   * know any more" and fall back to a full load rather than dropping the row.
   *
   * counts and next_cursor come back null from a single-game read, by design:
   * it skips both whole-scope scans, which is the entire saving.
   */
  async getGame(
    scope: 'club' | 'union',
    scopeId: string,
    kind: ManagedGameKind,
    gameId: string
  ): Promise<any | null> {
    const { data, error } = await supabase.rpc('fn_list_managed_games', {
      p_scope: scope,
      p_scope_id: scopeId,
      p_cursor: null,
      p_cursor_kind: null,
      p_cursor_id: null,
      p_limit: 1,
      p_cursor_bucket: null,
      p_bucket: null,
      p_game_kind: kind,
      p_game_id: gameId,
    });
    if (error) throw new Error(error.message || 'Could not refresh the game.');
    const result = data as any;
    if (!result?.ok)
      throw new Error(managementError(result?.reason || null) || 'Could not refresh the game.');
    const row = Array.isArray(result.items) ? result.items[0] : null;
    if (!row) return null;
    return {
      ...row,
      contract: row.contract ? mapContractSummary(row.contract) : null,
      lastCommand: row.last_command ? mapCommandReceipt(row.last_command) : null,
    };
  },

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
    return (result.contracts || []).map(mapContractSummary);
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
