/**
 * Types and constants shared by the Player Stats page and its per-tab chunks
 * (Stats Page Programme phase 2). Moved verbatim out of PlayerStatsPage.tsx;
 * the page imports them from here so a tab chunk can type its props without
 * importing the page (which would pull the page into every tab's chunk).
 */
import type { StatsContractMetadata } from '../../services/statsContract';

// ── Types matching the ca_player_stats_overview_v2 RPC payload ──
export interface OverallStats {
  total_hands: number;
  cash_hands: number;
  tourney_hands: number;
  tournaments_with_hands: number;
  hands_won: number;
  hands_lost: number;
  vpip: number; // fraction 0..1
  pfr: number;
  three_bet_percent: number;
  fold_to_three_bet: number;
  cbet_flop: number;
  aggression_factor: number;
  showdowns_total: number;
  showdowns_won: number;
  wtsd: number;
  total_profit: number;
  total_winnings: number;
  total_invested: number;
  biggest_pot_won: number;
  biggest_hand_loss: number;
  bb_per_100: number;
  hours_played: number;
  // Analysis window. The RPC scores the player's most recent `hand_cap` hands;
  // `hands_capped` is true when that limit actually bit, so the UI can say so
  // instead of presenting a truncated total as a lifetime figure.
  hand_cap: number;
  hands_capped: boolean;
  first_hand_at?: string;
  last_hand_at?: string;
}

export interface DailyPoint {
  date: string;
  hands: number;
  profit: number;
}

export interface SessionRow {
  id: number;
  date: string;
  ended: string;
  duration_minutes: number;
  hands_played: number;
  buy_in: number;
  cash_out: number;
  profit_loss: number;
}

export interface PositionRow {
  position: string;
  hands_played: number;
  vpip_count: number;
  pfr_count: number;
  three_bet_count: number;
  hands_won: number;
  total_profit: number;
  bb100: number;
}

export interface VariantRow {
  variant: string;
  hands: number;
  hands_won: number;
  profit: number;
  bb100: number;
}

export interface LifetimeStats {
  hands: number;
  first_hand_at: string | null;
  last_hand_at: string | null;
  /** False while the indexer is still walking back through older history. */
  indexed_complete: boolean;
}

export interface HandRow {
  id: string;
  played_at: string;
  variant: string;
  big_blind: number;
  is_tournament: boolean;
  position: string | null;
  pot_size: number;
  won: number;
  profit: number;
  is_winner: boolean;
  players: number;
  board: string[] | null;
  hole_cards: unknown;
}

export type HandMode = 'biggest_won' | 'biggest_lost' | 'recent';

export interface StakeRow {
  big_blind: number;
  hands: number;
  hands_won: number;
  profit: number;
  bb100: number;
}

export interface TournamentSummary {
  entries: number;
  cashes: number;
  wins: number;
  best_finish: number | null;
  itm_percent: number;
  total_buyins: number;
  /** Placement prizes PLUS bounty earnings. Unchanged meaning. */
  total_winnings: number;
  /** Placement prizes only (Dan section 37). */
  total_prizes: number;
  /** Every bounty collected, mystery and flat alike. */
  total_bounty_winnings: number;
  /** Knockouts that paid. */
  total_bounties: number;
  net_profit: number;
  roi: number;
}

/**
 * One past event (Dan section 45).
 *
 * `prize` is the PLACEMENT prize only and `total_won` is prize + bounties. Until
 * 2026-08-25 the RPC returned a single `prize` field that was already the sum,
 * which made a mystery bounty result unreadable: a min-cash plus a 5,000 chest
 * reported "prize 5,040" and nothing could get the split back. See
 * supabase/migrations/20260825600000_player_history_splits_prize_from_bounty.sql.
 */
export interface RecentTournament {
  tournament_id: string | null;
  name: string;
  start_time: string | null;
  variant: string | null;
  is_mystery_bounty: boolean;
  finish_rank: number | null;
  status: string | null;
  /** Placement prize only. */
  prize: number;
  /** Bounty earnings. */
  bounty_winnings: number;
  /** Knockouts that paid. */
  bounties: number;
  /** prize + bounty_winnings. */
  total_won: number;
  buyin: number;
}

export interface FullStats {
  contract: StatsContractMetadata;
  overall: OverallStats;
  lifetime: LifetimeStats;
  window_days: number | null;
  daily: DailyPoint[];
  sessions: SessionRow[];
  positions: PositionRow[];
  variants: VariantRow[];
  stakes: StakeRow[];
  tournaments: TournamentSummary;
  recent_tournaments: RecentTournament[];
}

/** The filters View Hand Histories can carry into /hand-history. */
export interface HandEvidenceFilter {
  variant?: string;
  position?: string;
  bigBlind?: number;
}

// Analysis ranges. `null` = no time bound (the most recent hand_cap hands,
// whenever they were played) — the previous, only behaviour.
export const RANGES: { key: string; days: number | null; label: string }[] = [
  { key: '7d', days: 7, label: '7 Days' },
  { key: '30d', days: 30, label: '30 Days' },
  { key: '90d', days: 90, label: '90 Days' },
  { key: 'all', days: null, label: 'All' },
];

// ── RPC payload hardening ──────────────────────────────────────────────────
// Every number the UI formats goes through `num()`. A spread over defaults only
// fills in MISSING keys — an explicit null (which Postgres aggregates can
// produce) would survive it and blow up the first .toFixed()/.toLocaleString()
// in the hero, taking the whole page down rather than one tile.
export const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : fallback;

export const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.length > 0 ? v : fallback;
