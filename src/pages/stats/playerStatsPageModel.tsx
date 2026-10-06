import { useEffect, useState } from 'react';
import {
  readStatsPersistentCache,
  writeStatsPersistentCache,
  type StatsCacheIdentity,
} from '../../lib/statsCache';
import { normalizeStatsContractMetadata } from '../../services/statsContract';
import { NOT_YET_MEASURED } from './format';
import {
  RANGES,
  num,
  str,
  type FullStats,
  type OverallStats,
  type LifetimeStats,
  type TournamentSummary,
} from './types';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CachedFull {
  full: FullStats;
  cachedAt: number;
}

export interface StatsClubOption {
  id: string;
  name: string;
}

export type ClubComparisonSort =
  | 'club'
  | 'hands'
  | 'profit'
  | 'bb100'
  | 'vpip'
  | 'pfr'
  | 'rake'
  | 'tournaments'
  | 'lastPlay';

export interface ClubComparisonRow {
  club: StatsClubOption;
  hands: number;
  profit: number;
  bb100: number;
  vpip: number;
  pfr: number;
  hours: number | null;
  rake: number;
  tournamentEntries: number;
  tournamentCashes: number;
  tournamentWins: number;
  tournamentWinnings: number;
  lastPlayedAt: string | null;
}

export const CLUB_SORTS: Array<{ key: ClubComparisonSort; label: string }> = [
  { key: 'club', label: 'Club' },
  { key: 'hands', label: 'Hands' },
  { key: 'profit', label: 'Profit' },
  { key: 'bb100', label: 'BB/100' },
  { key: 'vpip', label: 'VPIP' },
  { key: 'pfr', label: 'PFR' },
  { key: 'rake', label: 'Rake' },
  { key: 'tournaments', label: 'Tournaments' },
  { key: 'lastPlay', label: 'Last Play' },
];

export function validRangeKey(value: string | null): string {
  return RANGES.some((range) => range.key === value) ? (value as string) : 'all';
}

export function validTab(value: string | null): StatCategory {
  return value && value in TAB_LABELS ? (value as StatCategory) : 'overview';
}

export function validClubSort(value: string | null): ClubComparisonSort {
  return CLUB_SORTS.some((sort) => sort.key === value) ? (value as ClubComparisonSort) : 'club';
}

export function getCachedFull(identity: StatsCacheIdentity): CachedFull | null {
  const cached = readStatsPersistentCache(identity, CACHE_TTL_MS);
  if (!cached || !isFullStatsPayload(cached.payload)) return null;
  return { full: normalizeFull(cached.payload), cachedAt: cached.cachedAt };
}
export function setCachedFull(identity: StatsCacheIdentity, payload: unknown): void {
  writeStatsPersistentCache(identity, payload);
}

const validDateTime = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))
    ? value
    : null;

const optionalText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const positiveRank = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;

const nonnegativeCount = (value: unknown): number => {
  const parsed = num(value, Number.NaN);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const nonnegativeInteger = (value: unknown): value is number =>
  finiteNumber(value) && Number.isSafeInteger(value) && value >= 0;

const allFinite = (row: Record<string, unknown>, fields: readonly string[]): boolean =>
  fields.every((field) => finiteNumber(row[field]));

const allCounts = (row: Record<string, unknown>, fields: readonly string[]): boolean =>
  fields.every((field) => nonnegativeInteger(row[field]));

const optionalFinite = (row: Record<string, unknown>, fields: readonly string[]): boolean =>
  fields.every((field) => row[field] === undefined || finiteNumber(row[field]));

const optionalCounts = (row: Record<string, unknown>, fields: readonly string[]): boolean =>
  fields.every((field) => row[field] === undefined || nonnegativeInteger(row[field]));

const nonnegativeFinite = (value: unknown): value is number => finiteNumber(value) && value >= 0;

const unitFraction = (value: unknown): value is number =>
  finiteNumber(value) && value >= 0 && value <= 1;

const exactCents = (value: unknown): number | null => {
  if (!finiteNumber(value)) return null;
  const scaled = value * 100;
  return Math.abs(scaled - Math.round(scaled)) <= 1e-8 ? Math.round(scaled) : null;
};

const exactCentSum = (actual: unknown, left: unknown, right: unknown): boolean => {
  const actualCents = exactCents(actual);
  const leftCents = exactCents(left);
  const rightCents = exactCents(right);
  return (
    actualCents !== null &&
    leftCents !== null &&
    rightCents !== null &&
    actualCents === leftCents + rightCents
  );
};

const roundedFraction = (numerator: number, denominator: number, places: number): number => {
  if (denominator === 0) return 0;
  const scale = 10 ** places;
  const raw = numerator / denominator;
  return (raw < 0 ? -1 : 1) * (Math.round(Math.abs(raw) * scale + Number.EPSILON) / scale);
};

const exactRoundedFraction = (
  actual: unknown,
  numerator: number,
  denominator: number,
  places: number
): boolean =>
  finiteNumber(actual) &&
  Math.abs(actual - roundedFraction(numerator, denominator, places)) <= 1e-9;

const nullableTimestamp = (value: unknown): boolean =>
  value === null ||
  (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value)));

/**
 * Runtime contract for the owner overview RPC.
 *
 * `normalizeFull` is deliberately tolerant at the presentation boundary so one
 * nullable legacy field cannot crash a tile. It must not, however, decide that
 * a malformed successful financial response means zero. This validator runs
 * before cache or render and distinguishes a verified zero/empty payload from
 * an unreadable one.
 */
export function isFullStatsPayload(value: unknown): boolean {
  const data = record(value);
  const overall = record(data?.overall);
  const lifetime = record(data?.lifetime);
  const tournaments = record(data?.tournaments);
  const quality = record(data?.quality);
  const coverage = record(data?.coverage);
  if (!data || !overall || !lifetime || !tournaments || !quality || !coverage) return false;

  if (
    !allCounts(overall, [
      'total_hands',
      'cash_hands',
      'tourney_hands',
      'tournaments_with_hands',
      'hands_won',
      'hands_lost',
      'showdowns_total',
      'showdowns_won',
      'hand_cap',
    ]) ||
    !allFinite(overall, [
      'vpip',
      'pfr',
      'three_bet_percent',
      'fold_to_three_bet',
      'cbet_flop',
      'aggression_factor',
      'wtsd',
      'total_profit',
      'total_winnings',
      'total_invested',
      'biggest_pot_won',
      'biggest_hand_loss',
      'bb_per_100',
      'hours_played',
    ]) ||
    typeof overall.hands_capped !== 'boolean' ||
    !nullableTimestamp(overall.first_hand_at ?? null) ||
    !nullableTimestamp(overall.last_hand_at ?? null)
  ) {
    return false;
  }

  const verifiedOverall = overall as unknown as OverallStats;
  if (
    verifiedOverall.hand_cap <= 0 ||
    verifiedOverall.cash_hands + verifiedOverall.tourney_hands !== verifiedOverall.total_hands ||
    verifiedOverall.hands_won + verifiedOverall.hands_lost !== verifiedOverall.total_hands ||
    verifiedOverall.tournaments_with_hands > verifiedOverall.tourney_hands ||
    verifiedOverall.showdowns_won > verifiedOverall.showdowns_total ||
    verifiedOverall.showdowns_total > verifiedOverall.total_hands ||
    !unitFraction(verifiedOverall.vpip) ||
    !unitFraction(verifiedOverall.pfr) ||
    verifiedOverall.pfr > verifiedOverall.vpip ||
    !unitFraction(verifiedOverall.three_bet_percent) ||
    !unitFraction(verifiedOverall.fold_to_three_bet) ||
    !unitFraction(verifiedOverall.cbet_flop) ||
    !unitFraction(verifiedOverall.wtsd) ||
    !nonnegativeFinite(verifiedOverall.aggression_factor) ||
    !nonnegativeFinite(verifiedOverall.total_winnings) ||
    !nonnegativeFinite(verifiedOverall.total_invested) ||
    !nonnegativeFinite(verifiedOverall.biggest_pot_won) ||
    !nonnegativeFinite(verifiedOverall.hours_played)
  ) {
    return false;
  }

  const exactCashHands = quality.exact_cash_hands;
  const expectedCashSource =
    verifiedOverall.cash_hands === 0 || exactCashHands === verifiedOverall.cash_hands
      ? 'exact_settlement'
      : exactCashHands === 0
        ? 'reconstructed_actions'
        : 'mixed';
  if (
    !nonnegativeInteger(exactCashHands) ||
    exactCashHands > verifiedOverall.cash_hands ||
    typeof quality.cash_money_exact !== 'boolean' ||
    quality.cash_money_exact !==
      (verifiedOverall.cash_hands === 0 || exactCashHands === verifiedOverall.cash_hands) ||
    quality.cash_money_source !== expectedCashSource ||
    !nonnegativeInteger(coverage.analysis_hand_cap) ||
    coverage.analysis_hand_cap <= 0 ||
    coverage.analysis_hand_cap !== verifiedOverall.hand_cap ||
    typeof coverage.analysis_hands_capped !== 'boolean' ||
    coverage.analysis_hands_capped !== verifiedOverall.total_hands > coverage.analysis_hand_cap
  ) {
    return false;
  }

  if (
    !allCounts(lifetime, ['hands']) ||
    typeof lifetime.indexed_complete !== 'boolean' ||
    !nullableTimestamp(lifetime.first_hand_at ?? null) ||
    !nullableTimestamp(lifetime.last_hand_at ?? null)
  ) {
    return false;
  }

  if (
    !allCounts(tournaments, ['entries', 'cashes', 'wins']) ||
    !allFinite(tournaments, [
      'itm_percent',
      'total_buyins',
      'total_winnings',
      'net_profit',
      'roi',
    ]) ||
    !allFinite(tournaments, ['total_prizes', 'total_bounty_winnings']) ||
    !optionalFinite(tournaments, ['total_bounties']) ||
    !(
      tournaments.best_finish === null ||
      (nonnegativeInteger(tournaments.best_finish) && tournaments.best_finish >= 1)
    )
  ) {
    return false;
  }
  const verifiedTournaments = tournaments as unknown as TournamentSummary;
  if (
    verifiedTournaments.cashes > verifiedTournaments.entries ||
    verifiedTournaments.wins > verifiedTournaments.cashes ||
    !exactRoundedFraction(
      verifiedTournaments.itm_percent,
      verifiedTournaments.cashes,
      verifiedTournaments.entries,
      4
    ) ||
    !nonnegativeFinite(verifiedTournaments.total_buyins) ||
    !nonnegativeFinite(verifiedTournaments.total_winnings) ||
    !nonnegativeFinite(verifiedTournaments.total_prizes) ||
    !nonnegativeFinite(verifiedTournaments.total_bounty_winnings) ||
    !exactCentSum(
      verifiedTournaments.total_winnings,
      verifiedTournaments.total_prizes,
      verifiedTournaments.total_bounty_winnings
    ) ||
    !exactCentSum(
      verifiedTournaments.total_winnings,
      verifiedTournaments.net_profit,
      verifiedTournaments.total_buyins
    ) ||
    !exactRoundedFraction(
      verifiedTournaments.roi,
      verifiedTournaments.net_profit,
      verifiedTournaments.total_buyins,
      4
    ) ||
    (verifiedTournaments.total_bounties !== undefined &&
      !nonnegativeInteger(verifiedTournaments.total_bounties))
  ) {
    return false;
  }

  if (!(data.window_days === null || nonnegativeInteger(data.window_days))) return false;

  const daily = Array.isArray(data.daily) ? data.daily : null;
  const sessions = Array.isArray(data.sessions) ? data.sessions : null;
  const positions = Array.isArray(data.positions) ? data.positions : null;
  const variants = Array.isArray(data.variants) ? data.variants : null;
  const stakes = Array.isArray(data.stakes) ? data.stakes : null;
  const recentTournaments = Array.isArray(data.recent_tournaments) ? data.recent_tournaments : null;
  if (!daily || !sessions || !positions || !variants || !stakes || !recentTournaments) return false;

  if (
    daily.some((value) => {
      const row = record(value);
      return (
        !row ||
        typeof row.date !== 'string' ||
        !Number.isFinite(Date.parse(row.date)) ||
        !allCounts(row, ['hands']) ||
        !allFinite(row, ['profit'])
      );
    }) ||
    sessions.some((value) => {
      const row = record(value);
      if (
        !row ||
        !allCounts(row, ['id', 'duration_minutes', 'hands_played']) ||
        !allFinite(row, ['buy_in', 'cash_out', 'profit_loss']) ||
        row.id === 0 ||
        row.duration_minutes === 0 ||
        !nonnegativeFinite(row.buy_in) ||
        !nonnegativeFinite(row.cash_out) ||
        typeof row.date !== 'string' ||
        typeof row.ended !== 'string' ||
        !nullableTimestamp(row.date) ||
        !nullableTimestamp(row.ended)
      ) {
        return true;
      }
      return (
        Date.parse(row.ended) < Date.parse(row.date) ||
        !exactCentSum(row.cash_out, row.buy_in, row.profit_loss)
      );
    }) ||
    positions.some((value) => {
      const row = record(value);
      if (
        !row ||
        !allCounts(row, ['hands_played', 'vpip_count', 'pfr_count', 'hands_won']) ||
        !optionalCounts(row, ['three_bet_count', 'three_bet_opps']) ||
        !allFinite(row, ['total_profit']) ||
        !(row.bb100 === null || finiteNumber(row.bb100))
      ) {
        return true;
      }
      const hands = row.hands_played as number;
      const vpip = row.vpip_count as number;
      const pfr = row.pfr_count as number;
      const won = row.hands_won as number;
      const threeBet = row.three_bet_count as number | undefined;
      const threeBetOpps = row.three_bet_opps as number | undefined;
      return (
        vpip > hands ||
        pfr > vpip ||
        won > hands ||
        (threeBet !== undefined && threeBet > hands) ||
        (threeBetOpps !== undefined && threeBetOpps > hands) ||
        (threeBet !== undefined && threeBetOpps !== undefined && threeBet > threeBetOpps)
      );
    }) ||
    variants.some((value) => {
      const row = record(value);
      if (!row || !allCounts(row, ['hands', 'hands_won']) || !allFinite(row, ['profit', 'bb100'])) {
        return true;
      }
      return (row.hands_won as number) > (row.hands as number);
    }) ||
    stakes.some((value) => {
      const row = record(value);
      if (
        !row ||
        !allCounts(row, ['hands', 'hands_won']) ||
        !allFinite(row, ['big_blind', 'profit', 'bb100'])
      ) {
        return true;
      }
      return (row.hands_won as number) > (row.hands as number) || (row.big_blind as number) <= 0;
    }) ||
    recentTournaments.some((value) => {
      const row = record(value);
      return (
        !row ||
        typeof row.tournament_id !== 'string' ||
        row.tournament_id.trim() === '' ||
        typeof row.name !== 'string' ||
        row.name.trim() === '' ||
        typeof row.is_mystery_bounty !== 'boolean' ||
        !allFinite(row, ['prize', 'bounty_winnings', 'total_won', 'buyin']) ||
        !allCounts(row, ['bounties']) ||
        !nonnegativeFinite(row.prize) ||
        !nonnegativeFinite(row.bounty_winnings) ||
        !nonnegativeFinite(row.total_won) ||
        !nonnegativeFinite(row.buyin) ||
        !exactCentSum(row.total_won, row.prize, row.bounty_winnings) ||
        !(
          row.finish_rank === undefined ||
          row.finish_rank === null ||
          (nonnegativeInteger(row.finish_rank) && row.finish_rank >= 1)
        ) ||
        !nullableTimestamp(row.start_time ?? null) ||
        typeof row.ended_at !== 'string' ||
        !nullableTimestamp(row.ended_at)
      );
    })
  ) {
    return false;
  }

  return true;
}

// Types, RANGES and num/str live in ./stats/types.ts (phase 2 split).

export type StatCategory =
  | 'overview'
  | 'performance'
  | 'positions'
  | 'hands'
  | 'tournaments'
  | 'analysis'
  | 'trophies'
  | 'rake'
  | 'workspace';

// Single source of truth for the tabs: the swipe handler and the pill row both
// read this, so they can never drift out of sync.
//
// PRIVACY: 'hands' is NOT in this list. It renders the 13x13 hole-card grid,
// which is built from ca_hand_facts.hole_cards — holdings that were never shown
// at showdown. /stats/:userId is an existing route that renders this page for
// any user, so the tab is appended for the profile owner only. The database
// refuses a cross-user read regardless (ca_assert_self), but a tab that exists
// and then errors is worse than a tab that was never offered.
export const BASE_TABS: StatCategory[] = [
  'overview',
  'performance',
  'positions',
  'tournaments',
  'analysis',
];

export const TAB_LABELS: Record<StatCategory, string> = {
  overview: 'Overview',
  performance: 'Performance',
  positions: 'Positions',
  hands: 'Hands',
  tournaments: 'Tournaments',
  analysis: 'Analysis',
  trophies: 'Trophies',
  rake: 'Rake',
  workspace: 'Workspace',
};

/**
 * A saved dashboard layout controls order, never feature availability. Older
 * builds accepted arbitrary JSON strings, so treat preferences as untrusted:
 * keep valid unique tabs, append every omitted available tab, and leave the
 * owner-only Workspace tab last.
 */
export function normalizeDashboardLayout(
  values: unknown,
  available: readonly StatCategory[]
): StatCategory[] {
  const availableWithoutWorkspace = available.filter((tab) => tab !== 'workspace');
  const allowed = new Set<StatCategory>(availableWithoutWorkspace);
  const ordered: StatCategory[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || value === 'workspace') continue;
    const tab = value as StatCategory;
    if (allowed.has(tab) && !ordered.includes(tab)) ordered.push(tab);
  }
  for (const tab of availableWithoutWorkspace) {
    if (!ordered.includes(tab)) ordered.push(tab);
  }
  if (available.includes('workspace')) ordered.push('workspace');
  return ordered;
}

export const EMPTY_OVERALL: OverallStats = {
  total_hands: 0,
  cash_hands: 0,
  tourney_hands: 0,
  tournaments_with_hands: 0,
  hands_won: 0,
  hands_lost: 0,
  vpip: 0,
  pfr: 0,
  three_bet_percent: 0,
  fold_to_three_bet: 0,
  cbet_flop: 0,
  aggression_factor: 0,
  showdowns_total: 0,
  showdowns_won: 0,
  wtsd: 0,
  total_profit: 0,
  total_winnings: 0,
  total_invested: 0,
  biggest_pot_won: 0,
  biggest_hand_loss: 0,
  bb_per_100: 0,
  hours_played: 0,
  hand_cap: 0,
  hands_capped: false,
};

export const EMPTY_LIFETIME: LifetimeStats = {
  hands: 0,
  first_hand_at: null,
  last_hand_at: null,
  indexed_complete: false,
};

export const EMPTY_FULL: FullStats = {
  contract: normalizeStatsContractMetadata(null),
  overall: EMPTY_OVERALL,
  lifetime: EMPTY_LIFETIME,
  window_days: null,
  daily: [],
  sessions: [],
  positions: [],
  variants: [],
  stakes: [],
  tournaments: {
    entries: 0,
    cashes: 0,
    wins: 0,
    best_finish: null,
    itm_percent: 0,
    total_buyins: 0,
    total_winnings: 0,
    total_prizes: 0,
    total_bounty_winnings: 0,
    total_bounties: 0,
    net_profit: 0,
    roi: 0,
  },
  recent_tournaments: [],
};

export function normalizeFull(data: any): FullStats {
  const o = data?.overall ?? {};
  const t = data?.tournaments ?? {};
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

  const lt = data?.lifetime ?? {};

  return {
    contract: normalizeStatsContractMetadata(data),
    window_days: typeof data?.window_days === 'number' ? data.window_days : null,
    lifetime: {
      hands: num(lt.hands),
      first_hand_at: lt.first_hand_at ?? null,
      last_hand_at: lt.last_hand_at ?? null,
      indexed_complete: lt.indexed_complete === true,
    },
    overall: {
      total_hands: num(o.total_hands),
      cash_hands: num(o.cash_hands),
      tourney_hands: num(o.tourney_hands),
      tournaments_with_hands: num(o.tournaments_with_hands),
      hands_won: num(o.hands_won),
      hands_lost: num(o.hands_lost),
      vpip: num(o.vpip),
      pfr: num(o.pfr),
      three_bet_percent: num(o.three_bet_percent),
      fold_to_three_bet: num(o.fold_to_three_bet),
      cbet_flop: num(o.cbet_flop),
      aggression_factor: num(o.aggression_factor),
      showdowns_total: num(o.showdowns_total),
      showdowns_won: num(o.showdowns_won),
      wtsd: num(o.wtsd),
      total_profit: num(o.total_profit),
      total_winnings: num(o.total_winnings),
      total_invested: num(o.total_invested),
      biggest_pot_won: num(o.biggest_pot_won),
      biggest_hand_loss: num(o.biggest_hand_loss),
      bb_per_100: num(o.bb_per_100),
      hours_played: num(o.hours_played),
      hand_cap: num(o.hand_cap),
      hands_capped: o.hands_capped === true,
      first_hand_at: o.first_hand_at ?? undefined,
      last_hand_at: o.last_hand_at ?? undefined,
    },
    daily: arr(data?.daily).map((d) => ({
      date: str(d?.date),
      hands: num(d?.hands),
      profit: num(d?.profit),
    })),
    sessions: arr(data?.sessions).map((x) => ({
      id: num(x?.id),
      date: str(x?.date),
      ended: str(x?.ended),
      duration_minutes: num(x?.duration_minutes),
      hands_played: num(x?.hands_played),
      buy_in: num(x?.buy_in),
      cash_out: num(x?.cash_out),
      profit_loss: num(x?.profit_loss),
    })),
    positions: arr(data?.positions).map((x) => ({
      position: str(x?.position, 'UNK'),
      hands_played: num(x?.hands_played),
      vpip_count: num(x?.vpip_count),
      pfr_count: num(x?.pfr_count),
      three_bet_count: num(x?.three_bet_count),
      three_bet_opps: nonnegativeCount(x?.three_bet_opps),
      hands_won: num(x?.hands_won),
      total_profit: num(x?.total_profit),
      bb100:
        (typeof x?.bb100 === 'number' || typeof x?.bb100 === 'string') &&
        String(x.bb100).trim() !== '' &&
        Number.isFinite(Number(x.bb100))
          ? Number(x.bb100)
          : null,
    })),
    variants: arr(data?.variants).map((x) => ({
      variant: str(x?.variant, 'unknown'),
      hands: num(x?.hands),
      hands_won: num(x?.hands_won),
      profit: num(x?.profit),
      bb100: num(x?.bb100),
    })),
    stakes: arr(data?.stakes).map((x) => ({
      big_blind: num(x?.big_blind),
      hands: num(x?.hands),
      hands_won: num(x?.hands_won),
      profit: num(x?.profit),
      bb100: num(x?.bb100),
    })),
    tournaments: {
      entries: num(t.entries),
      cashes: num(t.cashes),
      wins: num(t.wins),
      best_finish: typeof t.best_finish === 'number' ? t.best_finish : null,
      itm_percent: num(t.itm_percent),
      total_buyins: num(t.total_buyins),
      total_winnings: num(t.total_winnings),
      total_prizes: num(t.total_prizes),
      total_bounty_winnings: num(t.total_bounty_winnings),
      total_bounties: num(t.total_bounties),
      net_profit: num(t.net_profit),
      roi: num(t.roi),
    },
    recent_tournaments: arr(data?.recent_tournaments).map((x) => ({
      tournament_id: typeof x?.tournament_id === 'string' ? x.tournament_id : null,
      name: str(x?.name, 'Tournament'),
      start_time: validDateTime(x?.start_time),
      ended_at: validDateTime(x?.ended_at),
      variant: optionalText(x?.variant),
      is_mystery_bounty: x?.is_mystery_bounty === true,
      finish_rank: positiveRank(x?.finish_rank),
      status: optionalText(x?.status),
      prize: num(x?.prize),
      bounty_winnings: num(x?.bounty_winnings),
      bounties: num(x?.bounties),
      total_won: num(x?.total_won),
      buyin: num(x?.buyin),
    })),
  };
}

// ── Animated counter hook ──
function useCountUpNumber(target: number, duration: number = 400) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let startTime: number;
    let rafId: number;
    const animate = (now: number) => {
      if (!startTime) startTime = now;
      const progress = Math.min((now - startTime) / duration, 1);
      setDisplay(Math.floor(target * progress));
      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      } else {
        setDisplay(target);
      }
    };
    rafId = requestAnimationFrame(animate);
    // requestAnimationFrame does not fire in a hidden tab, so a page opened in
    // the background read "0%" beside a correctly drawn arc until the next
    // frame. The value is the value, whatever the frame rate: settle it on a
    // timer as well (seen live 2026-09-03).
    const settle = window.setTimeout(() => setDisplay(target), duration + 50);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(settle);
    };
  }, [target, duration]);
  return display;
}

// ── Hands-won gauge ──
// Share of hands won sits around 10-20% in real poker (you fold most hands).
// This was previously labelled "Win Rate" and banded at 35/45/55, so every
// honest player rendered red on a near-empty arc. Bands are now calibrated to
// hands-won, and the arc is scaled against a 40% ceiling so typical values
// produce a readable sweep instead of a sliver.
const HANDS_WON_ARC_CEILING = 40;

/** `null` = no hand scored in this window: not 0%, and not the losing red (2026-09-20). */
export function HandsWonGauge({ handsWonPct }: { handsWonPct: number | null }) {
  const measured = handsWonPct !== null;
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  // Math.min(100, Math.max(0, NaN)) is NaN, and NaN reaches strokeDashoffset
  // (silently dropped by the browser, so the arc renders FULL) and the label
  // (rendered as "NaN%"). A non-finite input is a bug upstream; refuse it here
  // rather than drawing a confident 100% ring.
  const value = Number.isFinite(handsWonPct) ? Math.min(100, Math.max(0, handsWonPct ?? 0)) : 0;
  const arcPercent = Math.min(100, (value / HANDS_WON_ARC_CEILING) * 100);
  const dashOffset = circumference - (arcPercent / 100) * circumference;

  const getColor = () => {
    if (!measured) return 'rgba(138, 154, 170, 0.8)';
    if (value >= 22) return '#10b981';
    if (value >= 15) return '#00d4ff';
    if (value >= 10) return '#f59e0b';
    return '#ef4444';
  };

  const countedRate = useCountUpNumber(Math.floor(value), 800);

  return (
    <div className="hero-gauge">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle className="gauge-bg" cx="50" cy="50" r={radius} />
        <circle
          className="gauge-fill"
          cx="50"
          cy="50"
          r={radius}
          stroke={getColor()}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ filter: `drop-shadow(0 0 6px ${getColor()}40)` }}
        />
      </svg>
      <div className="gauge-center">
        {measured ? (
          <span className="gauge-value" style={{ color: getColor() }}>
            {countedRate}%
          </span>
        ) : (
          <span className="gauge-label">{NOT_YET_MEASURED}</span>
        )}
        <span className="gauge-label">Hands Won</span>
      </div>
    </div>
  );
}
