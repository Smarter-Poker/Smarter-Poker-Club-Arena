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
  type HandRow,
  type OverallStats,
  type LifetimeStats,
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
  if (!cached) return null;
  return { full: normalizeFull(cached.payload), cachedAt: cached.cachedAt };
}
export function setCachedFull(identity: StatsCacheIdentity, payload: unknown): void {
  writeStatsPersistentCache(identity, payload);
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

/**
 * Harden the notable-hands payload (Dan 2026-08-25).
 *
 * The hand list is the only section that formatted RPC values directly:
 * `h.profit.toLocaleString()`, `h.pot_size.toLocaleString()`, `h.big_blind`,
 * `new Date(h.played_at)`. `data as HandRow[]` is a compile-time claim about
 * a runtime payload; one null column and the whole page goes to the error
 * boundary, because this is also the one numeric section with no PanelBoundary
 * around it. Both halves of that are fixed - this normalizer and the boundary.
 */
export function normalizeHands(data: unknown): HandRow[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as any)?.hands)
      ? (data as any).hands
      : [];
  return rows.map((h: any, i: number) => ({
    id: str(h?.id, `hand-${i}`),
    played_at: str(h?.played_at),
    variant: str(h?.variant, 'Unknown'),
    big_blind: num(h?.big_blind),
    is_tournament: h?.is_tournament === true,
    position: typeof h?.position === 'string' ? h.position : null,
    pot_size: num(h?.pot_size),
    won: num(h?.won),
    profit: num(h?.profit),
    is_winner: h?.is_winner === true,
    players: num(h?.players),
    board: Array.isArray(h?.board) ? h.board.filter((c: unknown) => typeof c === 'string') : null,
    hole_cards: h?.hole_cards ?? null,
  }));
}

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
      hands_won: num(x?.hands_won),
      total_profit: num(x?.total_profit),
      bb100: num(x?.bb100),
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
      start_time: x?.start_time ?? null,
      variant: x?.variant ?? null,
      is_mystery_bounty: x?.is_mystery_bounty === true,
      finish_rank: typeof x?.finish_rank === 'number' ? x.finish_rank : null,
      status: x?.status ?? null,
      prize: num(x?.prize),
      bounty_winnings: num(x?.bounty_winnings),
      bounties: num(x?.bounties),
      /* An older cached payload has no total_won and its `prize` was already
         the sum. Falling back to `prize` keeps such a row's net figure right
         rather than reporting a bounty-heavy result as a loss. */
      total_won: x?.total_won == null ? num(x?.prize) : num(x?.total_won),
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
