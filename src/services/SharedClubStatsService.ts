import { supabase } from '../lib/supabase';

export interface SharedStatsClub {
  id: string;
  name: string;
}
export interface SharedClubOverview {
  hands: number;
  cash_hands: number;
  tournament_hands: number;
  hands_won: number;
  vpip: number;
  pfr: number;
  bb_per_100: number;
  last_played_at: string | null;
}

export interface SharedClubStatsPayload {
  contract_version: 2;
  scope: {
    target_user_id: string;
    club_id: string;
    asset: string;
    range_days: number | null;
    range_tz: string;
    visibility: 'shared_club';
  };
  overview: SharedClubOverview;
  tournaments: {
    entries: number;
    cashes: number;
    wins: number;
  };
  generated_at: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const timestampOrNull = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value)));

const assertScope = (
  data: unknown,
  targetUserId: string,
  asset: string,
  expected?: { clubId: string; days: number | null; timezone: string }
) => {
  const payload = record(data);
  const scope = record(payload?.scope);
  if (
    payload?.contract_version !== 2 ||
    scope?.visibility !== 'shared_club' ||
    scope.target_user_id !== targetUserId ||
    scope.asset !== asset ||
    (expected !== undefined &&
      (scope.club_id !== expected.clubId ||
        scope.range_days !== expected.days ||
        scope.range_tz !== expected.timezone))
  ) {
    throw new Error('Shared Stats Scope Mismatch');
  }
};

function parseSharedClubs(data: unknown): SharedStatsClub[] {
  const payload = record(data);
  if (!payload || !Array.isArray(payload.clubs)) {
    throw new Error('Shared Stats Club List Could Not Be Verified');
  }
  const clubs = payload.clubs.map((value) => {
    const club = record(value);
    if (
      !club ||
      typeof club.id !== 'string' ||
      club.id.trim() === '' ||
      typeof club.name !== 'string' ||
      club.name.trim() === ''
    ) {
      throw new Error('Shared Stats Club List Could Not Be Verified');
    }
    return { id: club.id, name: club.name };
  });
  if (new Set(clubs.map((club) => club.id)).size !== clubs.length) {
    throw new Error('Shared Stats Club List Could Not Be Verified');
  }
  return clubs;
}

function parseSharedOverview(data: unknown): SharedClubStatsPayload {
  const payload = record(data);
  const scope = record(payload?.scope);
  const overview = record(payload?.overview);
  const tournaments = record(payload?.tournaments);
  if (!payload || !scope || !overview || !tournaments) {
    throw new Error('Shared Stats Readout Could Not Be Verified');
  }

  const hands = overview.hands;
  const cashHands = overview.cash_hands;
  const tournamentHands = overview.tournament_hands;
  const handsWon = overview.hands_won;
  const entries = tournaments.entries;
  const cashes = tournaments.cashes;
  const wins = tournaments.wins;
  if (
    !nonnegativeInteger(hands) ||
    !nonnegativeInteger(cashHands) ||
    !nonnegativeInteger(tournamentHands) ||
    !nonnegativeInteger(handsWon) ||
    !nonnegativeInteger(entries) ||
    !nonnegativeInteger(cashes) ||
    !nonnegativeInteger(wins) ||
    !finiteNumber(overview.vpip) ||
    overview.vpip < 0 ||
    overview.vpip > 1 ||
    !finiteNumber(overview.pfr) ||
    overview.pfr < 0 ||
    overview.pfr > 1 ||
    overview.pfr > overview.vpip ||
    !finiteNumber(overview.bb_per_100) ||
    !timestampOrNull(overview.last_played_at) ||
    cashHands + tournamentHands !== hands ||
    handsWon > hands ||
    cashes > entries ||
    wins > cashes ||
    typeof payload.generated_at !== 'string' ||
    !Number.isFinite(Date.parse(payload.generated_at))
  ) {
    throw new Error('Shared Stats Readout Could Not Be Verified');
  }

  return data as SharedClubStatsPayload;
}

export const SharedClubStatsService = {
  async listClubs(targetUserId: string, asset: string): Promise<SharedStatsClub[]> {
    const { data, error } = await supabase.rpc('ca_player_stats_shared_clubs', {
      p_target_user: targetUserId,
      p_asset: asset,
    });
    if (error) throw error;
    assertScope(data, targetUserId, asset);
    return parseSharedClubs(data);
  },
  async getOverview(
    targetUserId: string,
    clubId: string,
    days: number | null,
    timezone: string,
    asset: string
  ): Promise<SharedClubStatsPayload> {
    const { data, error } = await supabase.rpc('ca_player_stats_shared_overview_v1', {
      p_target_user: targetUserId,
      p_club_id: clubId,
      p_days: days,
      p_tz: timezone,
      p_asset: asset,
    });
    if (error) throw error;
    assertScope(data, targetUserId, asset, { clubId, days, timezone });
    return parseSharedOverview(data);
  },
};
