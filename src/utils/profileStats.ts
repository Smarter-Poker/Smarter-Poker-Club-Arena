/**
 * The profile page's read of `ca_player_stats_overview_v2` (contract v2).
 *
 * Pure: takes the JSON the RPC returns, gives back the numbers the credential
 * renders. Kept out of the page so the reader can be unit-tested without
 * mounting React, Supabase or a CSS module. Every ratio in the payload is a
 * 0-1 fraction; every percentage here is x100 and is formatted (rounded) by
 * utils/format before it reaches the DOM.
 */

export interface PokerStats {
  totalHands: number;
  lifetimeHands: number;
  analysisCapped: boolean;
  vpip: number;
  pfr: number;
  threeBet: number;
  aggression: number;
  bbPer100: number;
  biggestPot: number;
  biggestLoss: number;
  totalProfit: number;
  winRate: number;
  wtsd: number;
  showdownWinRate: number;
  hoursPlayed: number;
  cashHands: number;
  tourneyHands: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
  tournamentCashes: number;
  itmPercent: number;
  bestFinish: number;
  tournamentNet: number;
  bountyKOs: number;
  roi: number;
  firstHandAt: string | null;
  lastHandAt: string | null;
  daily: Array<{ date: string; hands: number; profit: number }>;
  sessions: Array<{
    id: number | string;
    date: string;
    buyIn: number;
    cashOut: number;
    profit: number;
    hands: number;
    minutes: number;
  }>;
  variants: Array<{ variant: string; hands: number; profit: number; bb100: number }>;
}

export const EMPTY_STATS: PokerStats = {
  totalHands: 0,
  lifetimeHands: 0,
  analysisCapped: false,
  vpip: 0,
  pfr: 0,
  threeBet: 0,
  aggression: 0,
  bbPer100: 0,
  biggestPot: 0,
  biggestLoss: 0,
  totalProfit: 0,
  winRate: 0,
  wtsd: 0,
  showdownWinRate: 0,
  hoursPlayed: 0,
  cashHands: 0,
  tourneyHands: 0,
  tournamentsPlayed: 0,
  tournamentsWon: 0,
  tournamentCashes: 0,
  itmPercent: 0,
  bestFinish: 0,
  tournamentNet: 0,
  bountyKOs: 0,
  roi: 0,
  firstHandAt: null,
  lastHandAt: null,
  daily: [],
  sessions: [],
  variants: [],
};

export const finiteStat = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isoOrNull = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

/** Reads the owner-only v2 contract. Returns null for anything else. */
export function profileStatsFromV2(payload: any): PokerStats | null {
  if (payload?.contract_version !== 2 || !payload?.overall) return null;
  const overall = payload.overall;
  const tournaments = payload.tournaments ?? {};
  const lifetime = payload.lifetime ?? {};
  const coverage = payload.coverage ?? {};
  const totalHands = finiteStat(overall.total_hands);
  const handsWon = finiteStat(overall.hands_won);
  const showdownsTotal = finiteStat(overall.showdowns_total);
  const showdownsWon = finiteStat(overall.showdowns_won);

  const daily = Array.isArray(payload.daily)
    ? payload.daily
        .filter((d: any) => d && typeof d.date === 'string')
        .map((d: any) => ({
          date: d.date,
          hands: finiteStat(d.hands),
          profit: finiteStat(d.profit),
        }))
    : [];

  const sessions = Array.isArray(payload.sessions)
    ? payload.sessions
        .filter((s: any) => s && typeof s.date === 'string')
        .map((s: any) => ({
          id: s.id ?? s.date,
          date: s.date,
          buyIn: finiteStat(s.buy_in),
          cashOut: finiteStat(s.cash_out),
          profit: finiteStat(s.profit_loss),
          hands: finiteStat(s.hands_played),
          minutes: finiteStat(s.duration_minutes),
        }))
    : [];

  const variants = Array.isArray(payload.variants)
    ? payload.variants
        .filter((v: any) => v && typeof v.variant === 'string')
        .map((v: any) => ({
          variant: v.variant,
          hands: finiteStat(v.hands),
          profit: finiteStat(v.profit),
          bb100: finiteStat(v.bb100),
        }))
    : [];

  return {
    totalHands,
    lifetimeHands: Math.max(totalHands, finiteStat(lifetime.hands)),
    analysisCapped: overall.hands_capped === true,
    vpip: finiteStat(overall.vpip) * 100,
    pfr: finiteStat(overall.pfr) * 100,
    threeBet: finiteStat(overall.three_bet_percent) * 100,
    aggression: finiteStat(overall.aggression_factor),
    bbPer100: finiteStat(overall.bb_per_100),
    biggestPot: finiteStat(overall.biggest_pot_won),
    biggestLoss: finiteStat(overall.biggest_hand_loss),
    totalProfit: finiteStat(overall.total_profit),
    winRate: totalHands > 0 ? (handsWon / totalHands) * 100 : 0,
    wtsd: finiteStat(overall.wtsd) * 100,
    showdownWinRate: showdownsTotal > 0 ? (showdownsWon / showdownsTotal) * 100 : 0,
    hoursPlayed: finiteStat(overall.hours_played),
    cashHands: finiteStat(overall.cash_hands),
    tourneyHands: finiteStat(overall.tourney_hands),
    tournamentsPlayed: finiteStat(tournaments.entries),
    tournamentsWon: finiteStat(tournaments.wins),
    tournamentCashes: finiteStat(tournaments.cashes),
    itmPercent: finiteStat(tournaments.itm_percent) * 100,
    bestFinish: finiteStat(tournaments.best_finish),
    tournamentNet: finiteStat(tournaments.net_profit),
    bountyKOs: finiteStat(tournaments.total_bounties),
    roi: finiteStat(tournaments.roi) * 100,
    firstHandAt: isoOrNull(coverage.first_hand_at ?? lifetime.first_hand_at),
    lastHandAt: isoOrNull(coverage.last_hand_at ?? lifetime.last_hand_at ?? overall.last_hand_at),
    daily,
    sessions,
    variants,
  };
}
