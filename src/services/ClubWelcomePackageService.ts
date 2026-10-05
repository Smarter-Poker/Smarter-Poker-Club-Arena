import { supabase } from '../lib/supabase';

export type ClubWelcomePackageStatus =
  | 'not_eligible'
  | 'not_configured'
  | 'ready'
  | 'provisioned'
  | 'reset';

export interface ClubWelcomePackageItem {
  slotKey: string;
  entityKind: 'cash_game' | 'tournament_schedule';
  entityId: string;
  initialTableId: string | null;
  retiredAt: string | null;
}

export interface ClubWelcomePackageEconomics {
  bbjEnabled: boolean;
  bbjSeed: number;
  spinsEnabled: boolean;
  spinMaxStake: number;
  spinSeed: number;
  leaderboardMode: 'display_only';
  leaderboardSeed: number;
  promoEnabled: boolean;
  diamondSpinsStatus: 'owner_acceptance_required';
}

export interface ClubWelcomePackageState {
  clubId: string;
  eligible: boolean;
  status: ClubWelcomePackageStatus;
  ownerAcceptanceRequired: boolean;
  displayTimeZone: 'UTC' | null;
  displayTimeLabel: '7:00 PM UTC' | null;
  items: ClubWelcomePackageItem[];
  economics: ClubWelcomePackageEconomics | null;
}

export interface ClubWelcomePackageResetImpact {
  clubId: string;
  authorized: boolean;
  canReset: boolean;
  cashGameIds: string[];
  tournamentIds: string[];
  blocking: {
    activeSeats: number;
    openSessions: number;
    waitingPlayers: number;
    pendingMoves: number;
    registeredPlayers: number;
    runningTournaments: number;
    executingCommands: number;
    handHistory: number;
    resourceActivity: number;
    economicsPristine: boolean;
  };
  removable: {
    cashGames: number;
    tournaments: number;
    tables: number;
    schedules: number;
    bbjSeed: number;
    spinSeed: number;
  };
}

export interface ClubWelcomePackageResetReceipt {
  replayed: boolean;
  clubId: string;
  operationId: string;
  removed: {
    cashGameIds: string[];
    tournamentIds: string[];
    tableIds: string[];
    scheduleIds: string[];
  };
  returnedToTreasury: { bbj: number; spin: number };
  ownerAcceptanceReceiptsPreserved: boolean;
  completedAt: string;
}

type JsonObject = Record<string, unknown>;

// Persisted PostgreSQL UUIDs include seeded club IDs without RFC version bits.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACKAGE_VERSION = 'welcome-v1';
const objectValue = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uuidValue = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
const timestampValue = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
const countValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const uuidList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every(uuidValue) ? value : null;
const packageEnvelope = (value: unknown): JsonObject | null => {
  const row = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return objectValue(row) && row.package_version === PACKAGE_VERSION ? row : null;
};

function parseItems(value: unknown): ClubWelcomePackageItem[] | null {
  if (!Array.isArray(value)) return null;
  if (
    !value.every(
      (entry) =>
        objectValue(entry) &&
        typeof entry.slot_key === 'string' &&
        (entry.entity_kind === 'cash_game' || entry.entity_kind === 'tournament_schedule') &&
        uuidValue(entry.entity_id) &&
        (entry.initial_table_id === null || uuidValue(entry.initial_table_id)) &&
        (entry.retired_at === null || timestampValue(entry.retired_at))
    )
  )
    return null;
  return value.map((entry) => ({
    slotKey: entry.slot_key as string,
    entityKind: entry.entity_kind as ClubWelcomePackageItem['entityKind'],
    entityId: entry.entity_id as string,
    initialTableId: entry.initial_table_id as string | null,
    retiredAt: entry.retired_at as string | null,
  }));
}

function parseEconomics(value: unknown): ClubWelcomePackageEconomics | null {
  if (!objectValue(value)) return null;
  const numbers = ['bbj_seed', 'spin_max_stake', 'spin_seed', 'leaderboard_seed'] as const;
  if (
    !numbers.every((key) => finiteNumber(value[key])) ||
    typeof value.bbj_enabled !== 'boolean' ||
    typeof value.spins_enabled !== 'boolean' ||
    typeof value.promo_enabled !== 'boolean' ||
    value.leaderboard_mode !== 'display_only' ||
    value.diamond_spins_status !== 'owner_acceptance_required'
  )
    return null;
  return {
    bbjEnabled: value.bbj_enabled,
    bbjSeed: value.bbj_seed as number,
    spinsEnabled: value.spins_enabled,
    spinMaxStake: value.spin_max_stake as number,
    spinSeed: value.spin_seed as number,
    leaderboardMode: value.leaderboard_mode,
    leaderboardSeed: value.leaderboard_seed as number,
    promoEnabled: value.promo_enabled,
    diamondSpinsStatus: value.diamond_spins_status,
  };
}

function parsePackageState(value: unknown, clubId: string): ClubWelcomePackageState | null {
  const row = packageEnvelope(value);
  if (!row || row.ok !== true || row.club_id !== clubId || !uuidValue(row.club_id)) return null;
  if (
    typeof row.eligible !== 'boolean' ||
    !['not_eligible', 'not_configured', 'ready', 'provisioned', 'reset'].includes(
      String(row.status)
    ) ||
    row.owner_acceptance_required !== true
  ) {
    return null;
  }
  const items = parseItems(row.items);
  if (!items) return null;
  const mayOmitEconomics = row.status === 'not_eligible' || row.status === 'not_configured';
  const economics = row.economics === undefined ? null : parseEconomics(row.economics);
  if (!economics && !mayOmitEconomics) return null;
  const displayTimeZone = row.display_time_zone ?? null;
  const displayTimeLabel = row.display_time_label ?? null;
  if (
    (displayTimeZone !== null && displayTimeZone !== 'UTC') ||
    (displayTimeLabel !== null && displayTimeLabel !== '7:00 PM UTC')
  ) {
    return null;
  }
  if (!mayOmitEconomics && (displayTimeZone !== 'UTC' || displayTimeLabel !== '7:00 PM UTC')) {
    return null;
  }
  return {
    clubId,
    eligible: row.eligible,
    status: row.status as ClubWelcomePackageStatus,
    ownerAcceptanceRequired: true,
    displayTimeZone,
    displayTimeLabel,
    items,
    economics,
  };
}

function parseResetImpact(value: unknown, clubId: string): ClubWelcomePackageResetImpact | null {
  const row = packageEnvelope(value);
  if (
    !row ||
    row.ok !== true ||
    row.club_id !== clubId ||
    !uuidValue(row.club_id) ||
    typeof row.authorized !== 'boolean' ||
    typeof row.can_reset !== 'boolean' ||
    !objectValue(row.blocking) ||
    !objectValue(row.removable)
  ) {
    return null;
  }
  const cashGameIds = uuidList(row.cash_game_ids);
  const tournamentIds = uuidList(row.tournament_ids);
  const rawBlocking = row.blocking as JsonObject;
  const rawRemovable = row.removable as JsonObject;
  const legacyBlockingKeys = [
    'active_seats',
    'open_sessions',
    'waiting_players',
    'pending_moves',
    'registered_players',
    'running_tournaments',
    'executing_commands',
    'hand_history',
  ] as const;
  const removableKeys = ['cash_games', 'tournaments', 'tables', 'schedules'] as const;
  const modernBlocking =
    countValue(rawBlocking.resource_activity) &&
    typeof rawBlocking.economics_pristine === 'boolean';
  const legacyBlocking = legacyBlockingKeys.every((key) => countValue(rawBlocking[key]));
  if (
    !cashGameIds ||
    !tournamentIds ||
    (!modernBlocking && !legacyBlocking) ||
    !removableKeys.every((key) => countValue(rawRemovable[key]))
  )
    return null;
  const blocking = rawBlocking as Record<(typeof legacyBlockingKeys)[number], number>;
  const removable = rawRemovable as Record<(typeof removableKeys)[number], number>;
  return {
    clubId,
    authorized: row.authorized,
    canReset: row.can_reset,
    cashGameIds,
    tournamentIds,
    blocking: {
      activeSeats: blocking.active_seats ?? 0,
      openSessions: blocking.open_sessions ?? 0,
      waitingPlayers: blocking.waiting_players ?? 0,
      pendingMoves: blocking.pending_moves ?? 0,
      registeredPlayers: blocking.registered_players ?? 0,
      runningTournaments: blocking.running_tournaments ?? 0,
      executingCommands: blocking.executing_commands ?? 0,
      handHistory: blocking.hand_history ?? 0,
      resourceActivity: modernBlocking ? (rawBlocking.resource_activity as number) : 0,
      economicsPristine: modernBlocking ? (rawBlocking.economics_pristine as boolean) : true,
    },
    removable: {
      cashGames: removable.cash_games,
      tournaments: removable.tournaments,
      tables: removable.tables,
      schedules: removable.schedules,
      bbjSeed: finiteNumber(rawRemovable.bbj_seed) ? rawRemovable.bbj_seed : 0,
      spinSeed: finiteNumber(rawRemovable.spin_seed) ? rawRemovable.spin_seed : 0,
    },
  };
}

function parseResetReceipt(
  value: unknown,
  clubId: string,
  operationId: string
): ClubWelcomePackageResetReceipt | null {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  const row = objectValue(candidate) ? candidate : null;
  if (
    !row ||
    row.ok !== true ||
    typeof row.replayed !== 'boolean' ||
    row.club_id !== clubId ||
    row.operation_id !== operationId ||
    !uuidValue(row.club_id) ||
    !uuidValue(row.operation_id) ||
    !timestampValue(row.completed_at) ||
    !objectValue(row.removed)
  ) {
    return null;
  }
  const lists = ['cash_game_ids', 'tournament_ids', 'table_ids', 'schedule_ids'] as const;
  const removed = row.removed as JsonObject;
  const parsed = lists.map((key) => uuidList(removed[key]));
  if (parsed.some((value) => value === null)) return null;
  const [cashGameIds, tournamentIds, tableIds, scheduleIds] = parsed as string[][];
  const returned = row.returned_to_treasury;
  const modernReceipt =
    objectValue(returned) &&
    finiteNumber(returned.bbj) &&
    finiteNumber(returned.spin) &&
    row.owner_acceptance_receipts_preserved === true;
  const legacyReceipt = row.owner_acceptance_required === true;
  if (!modernReceipt && !legacyReceipt) return null;
  return {
    replayed: row.replayed,
    clubId,
    operationId,
    removed: { cashGameIds, tournamentIds, tableIds, scheduleIds },
    returnedToTreasury: modernReceipt
      ? { bbj: returned.bbj as number, spin: returned.spin as number }
      : { bbj: 0, spin: 0 },
    ownerAcceptanceReceiptsPreserved: modernReceipt,
    completedAt: row.completed_at,
  };
}

export function welcomePackageImpactHasNoBlockers(impact: ClubWelcomePackageResetImpact): boolean {
  return (
    impact.authorized &&
    impact.canReset &&
    impact.blocking.resourceActivity === 0 &&
    impact.blocking.economicsPristine &&
    [
      impact.blocking.activeSeats,
      impact.blocking.openSessions,
      impact.blocking.waitingPlayers,
      impact.blocking.pendingMoves,
      impact.blocking.registeredPlayers,
      impact.blocking.runningTournaments,
      impact.blocking.executingCommands,
      impact.blocking.handHistory,
    ].every((count) => count === 0) &&
    impact.cashGameIds.length === impact.removable.cashGames &&
    impact.tournamentIds.length === impact.removable.tournaments
  );
}

export const clubWelcomePackageService = {
  async get(clubId: string): Promise<ClubWelcomePackageState> {
    const { data, error } = await supabase.rpc(
      'fn_get_club_welcome_package' as never,
      {
        p_club_id: clubId,
      } as never
    );
    if (error) throw error;
    const state = parsePackageState(data, clubId);
    if (!state) throw new Error('Welcome Package Status Could Not Be Confirmed');
    return state;
  },

  async getResetImpact(clubId: string): Promise<ClubWelcomePackageResetImpact> {
    const { data, error } = await supabase.rpc(
      'fn_get_club_welcome_package_reset_impact' as never,
      { p_club_id: clubId } as never
    );
    if (error) throw error;
    const impact = parseResetImpact(data, clubId);
    if (!impact) throw new Error('Removal Impact Could Not Be Confirmed');
    return impact;
  },

  async remove(clubId: string, operationId: string): Promise<ClubWelcomePackageResetReceipt> {
    const { data, error } = await supabase.rpc(
      'fn_remove_first_club_welcome_games' as never,
      { p_club_id: clubId, p_operation_id: operationId } as never
    );
    if (error) throw error;
    const receipt = parseResetReceipt(data, clubId, operationId);
    if (!receipt) throw new Error('Removal Could Not Be Confirmed. No Retry Key Was Changed');
    return receipt;
  },
};
