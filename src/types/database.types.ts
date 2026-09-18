/**
 * ♠ CLUB ARENA — Database Types
 * TypeScript types for Supabase tables
 *
 * NOTE: Club and ClubSettings are now re-exported from club.types.ts
 * (the canonical source). This eliminates the type mismatch that caused
 * errors when mixing ClubsService (club.types) with pages (database.types).
 */

// Re-export Club from the canonical source
export type { Club, ClubSettings as ClubTypeSettings } from './club.types';
import type { Club } from './club.types';

import type { ClubRole } from './clubRoles';
// Legacy ClubSettings alias — database.types consumers expect this shape.
export interface ClubSettings {
  default_rake_percent: number;
  rake_cap: number;
  allow_straddle: boolean;
  allow_run_it_twice: boolean;
  min_buy_in_bb: number;
  max_buy_in_bb: number;
}

export interface Database {
  public: {
    Tables: {
      clubs: {
        Row: Club;
        Insert: Omit<Club, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Club, 'id'>>;
      };
      club_members: {
        Row: ClubMember;
        Insert: Omit<ClubMember, 'id' | 'joined_at'>;
        Update: Partial<Omit<ClubMember, 'id'>>;
      };
      tables: {
        Row: PokerTable;
        Insert: Omit<PokerTable, 'id' | 'created_at'>;
        Update: Partial<Omit<PokerTable, 'id'>>;
      };
      chip_transactions: {
        Row: ChipTransaction;
        Insert: Omit<ChipTransaction, 'id' | 'created_at'>;
        Update: never;
      };
      unions: {
        Row: Union;
        Insert: Omit<Union, 'id' | 'created_at'>;
        Update: Partial<Omit<Union, 'id'>>;
      };
    };
  };
}

export interface ClubMember {
  id?: string; // Optional — column may not exist in all DB schemas
  club_id: string;
  user_id: string;
  role: MemberRole;
  nickname: string | null;
  chip_balance: number;
  joined_at: string;
  status: MemberStatus;
  agent_id: string | null; // If this member is managed by an agent
  tier?: string | null;
  credit_used?: number;
  diamonds?: number;
  trust_score?: number;
  rank_level?: number;
  sessions_played?: number;
  orange_ball_status?: string | null;
  parent_agent_id?: string | null;
  chips?: number;
  total_hands?: number;
  total_won?: number;
  total_lost?: number;
  rake_generated?: number;
  profile?: { username?: string; avatar_url?: string }[];
}

export type MemberRole = ClubRole;
export type MemberStatus = 'active' | 'pending' | 'suspended' | 'banned';

export interface PokerTable {
  id: string;
  club_id: string;
  tournament_id?: string | null;
  name: string;
  game_type: GameType;
  game_variant: GameVariant;
  stakes: string; // e.g., "1/2", "5/10"
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  max_players: number;
  current_players: number;
  status: TableStatus;
  settings: TableSettings;
  created_at: string;
}

export type GameType = 'cash' | 'tournament' | 'sit_n_go';
// FIX 116: Dead variants removed — Dan's 9 approved variants only
export type GameVariant = 'nlh' | 'plo4' | 'plo5' | 'plo6' | 'plo8' | 'pineapple' | 'short_deck';
export type TableStatus = 'waiting' | 'running' | 'active' | 'paused' | 'closed' | 'deleted';

export interface TableSettings {
  // ── Core Features ──
  straddle_enabled: boolean;
  straddle_type: 'utg'; // FIX 114: UTG straddle only
  run_it_twice: boolean;
  /**
   * EXACTNESS PASS 2026-08-26: how the runs are decided. 'mandatory_twice' /
   * 'mandatory_three' skip the consent question entirely (the host already
   * decided — engine reads the tables.run_it_mode column). Previously only
   * TableConfigPage could set this; a table created from CreateTableModal
   * could never be mandatory.
   */
  run_it_mode?: 'none' | 'player_choice' | 'mandatory_twice' | 'mandatory_three';
  bomb_pot_enabled: boolean;
  bomb_pot_frequency: number; // Every N hands
  bomb_pot_ante_bb: number;
  /** DOUBLE-BOARD BOMB POT 2026-08-20: deal two boards, split pots across them. */
  bomb_pot_double_board?: boolean;
  /* BOMB POT STANDARDIZATION 2026-08-27 (spec §3) — canonical config.
     board_count (1-3) supersedes the double-board boolean. */
  bomb_pot_board_count?: number;
  bomb_pot_trigger_mode?: 'every_n_hands' | 'once_per_orbit' | 'timed' | 'bomb_pot_only';
  bomb_pot_interval_seconds?: number | null;
  bomb_pot_min_players?: number;
  bomb_pot_ante_fixed?: number | null;
  /** VARIANT OVERRIDE (spec §10.1): bomb hand variant; NULL = same as table. */
  bomb_pot_variant?: 'nlh' | 'plo4' | 'plo5' | 'plo6' | null;
  /** TIMED PERSISTENCE (spec §4.3): engine-written next due timestamp. */
  bomb_pot_next_due_at?: string | null;
  // 2026-08-18: time_bank_seconds is gone. A time bank is a flat 20s grant,
  // 2 per street (Bible V8 s6.2) — there is no per-table "seconds per
  // activation" any more, and the engine never read the column. Whether a
  // table offers time banks at all is time_bank_enabled.
  time_bank_enabled: boolean;
  auto_muck: boolean;

  // ── Additional Game Features ──
  vpip_display: boolean; // Show VPIP % on player seats
  ante_enabled: boolean; // BB ante or regular ante
  ante_amount: number; // Ante in chips (0 = no ante)
  no_rathole: boolean; // Prevent players from leaving and re-sitting with fewer chips
  seven_deuce_enabled?: boolean; // 7-2 game: post-flop 7-2 winner collects a bounty
  seven_deuce_amount?: number; // 7-2 bounty in big blinds each other player pays (default 2)
  double_board: boolean; // Double board run-out
  time_limit_minutes: number; // Auto-close table after N minutes (0 = unlimited)
  action_time_seconds: number; // Per-action time limit (default 15)
  min_buyin_bb: number; // Minimum buy-in in big blinds
  max_buyin_bb: number; // Maximum buy-in in big blinds
  insurance_enabled: boolean; // All-in insurance
  auto_restart: boolean; // Auto restart after hand finishes
  call_time_enabled: boolean; // Shot clock / call time

  // ── Blind Entry Policies (Bible V8 4.3) ──
  wait_for_big_blind: boolean; // New players must wait for BB
  auto_post_blinds: boolean; // Auto-post blinds when returning from sit-out
  post_dead_blind: boolean; // Require missed blind post when re-entering

  // ── Showdown Reveal Policy (Bible V8 4.21) ──
  showdown_reveal: 'last_aggressor_first' | 'clockwise_from_button' | 'auto_show_all';
  auto_muck_losers: boolean; // Auto-muck non-winning hands

  // ── Anti-Ratholing ──
  rathole_cooldown_minutes: number; // Cooldown before re-sitting after leaving (0 = disabled)
}

export interface ChipTransaction {
  id: string;
  club_id: string;
  from_user_id: string | null; // null = club/system
  to_user_id: string;
  amount: number;
  type: TransactionType;
  transaction_type: string; // Transaction category
  notes: string | null;
  created_at: string;
}

export type TransactionType =
  | 'deposit'
  | 'withdrawal'
  | 'buy_in'
  | 'cash_out'
  | 'agent_transfer'
  | 'rake'
  | 'bonus';

export interface Union {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  club_count: number;
  member_count: number;
  created_at: string;
  settings: UnionSettings;
}

export interface UnionSettings {
  revenue_share_percent: number;
  shared_player_pool: boolean;
  cross_club_tournaments: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Agent System (premium-style chip distribution)
// ═══════════════════════════════════════════════════════════════════════════════

export interface Agent {
  id: string;
  club_id: string;
  user_id: string;
  member_id: string; // Link to club_members
  name: string;
  agent_wallet_balance: number;
  player_wallet_balance: number;
  promo_wallet_balance: number;
  credit_limit: number;
  is_prepaid: boolean;
  commission_rate: number; // % commission agent earns from club
  player_count: number;
  is_active: boolean;
  created_at: string;
}

export interface AgentPlayer {
  id: string;
  agent_id: string;
  user_id: string;
  nickname: string;
  chip_balance: number;
  rakeback_percent: number;
  joined_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// User Profile
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserProfile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  vip_level: VipLevel;
  stats: PlayerStats;
  created_at: string;
}

export type VipLevel = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

export interface PlayerStats {
  total_hands: number;
  vpip: number;
  pfr: number;
  aggression_factor: number;
  bb_per_100: number;
  biggest_pot: number;
  total_profit: number;
  games_played: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Game State Types (shared with engine)
// ═══════════════════════════════════════════════════════════════════════════════

export type CardSuit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type CardRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  rank: CardRank;
  suit: CardSuit;
}

export interface HandState {
  id: string;
  table_id: string;
  hand_number: number;
  pot: number;
  community_cards: Card[];
  current_bet: number;
  current_player: string | null;
  dealer_seat: number;
  stage: HandStage;
  players: SeatPlayer[];
}

// FIX 120: Added 'pineapple_discard' for Crazy Pineapple
export type HandStage = 'preflop' | 'flop' | 'pineapple_discard' | 'turn' | 'river' | 'showdown';

export interface SeatPlayer {
  seat: number;
  user_id: string;
  username: string;
  stack: number;
  bet: number;
  totalInvested: number; // Cumulative chips invested across all streets (never reset)
  cards: Card[];
  is_folded: boolean;
  is_all_in: boolean;
  is_sitting_out: boolean;
  // Bible V8 2.4 / 2.8: Extended seat state
  waiting_for_big_blind?: boolean;
  forced_post_required?: boolean;
  auto_time_bank_used_this_hand?: boolean;
  manual_time_banks_used_this_hand?: number;
  timeout_count_session?: number;
}

// FIX 120: Added 'discard' for Crazy Pineapple
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in' | 'discard';

export interface PlayerAction {
  type: ActionType;
  amount?: number;
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tournament Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface Tournament {
  format_contract?: unknown;
  id: string;
  club_id: string;
  name: string;
  description?: string;
  game_type: string; // NLH, PLO4, PLO5, etc.
  variant?: string;
  buy_in_amount: number;
  buy_in_fee: number;
  starting_chips: number;
  max_players: number | null;
  min_players?: number;
  current_players: number;
  status: string; // TEXT column: REGISTERING, RUNNING, COMPLETED, etc.
  blind_structure: BlindLevel[];
  payout_structure: PayoutEntry[];
  prize_pool: number;
  guaranteed_prize: number;
  start_time: string;
  late_reg_mins?: number;
  late_reg_levels?: number;
  current_level?: number;
  /** Amounts committed by the engine for exactly this zero-based level. */
  blind_level_state?: {
    index: number;
    small_blind: number;
    big_blind: number;
    ante: number;
  } | null;
  started_at?: string;
  ended_at?: string;
  created_at: string;
  updated_at?: string;
  rebuy_cost?: number;
  rebuy_chips?: number;
  is_reentry?: boolean;
  addon_cost?: number;
  addon_chips?: number;
  addon_levels?: number;
  settings?: any;
  [key: string]: any;
}

export type TournamentType =
  | 'sng'
  | 'mtt'
  | 'satellite'
  | 'spin'
  | 'bounty'
  | 'mystery_bounty'
  | 'progressive_bounty';
export type TournamentStatus =
  | 'REGISTERING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'ANNOUNCED'
  | 'LATE_REG';

export interface BlindLevel {
  level: number;
  small_blind?: number; // Canonical snake_case
  smallBlind?: number; // Legacy camelCase
  big_blind?: number; // Canonical snake_case
  bigBlind?: number; // Legacy camelCase
  ante: number;
  duration_minutes?: number; // Canonical snake_case
  durationMinutes?: number; // Legacy camelCase
  /* SECONDS, and a third spelling. TournamentRecurringService.createSpin
     writes `duration: tier.levelMinutes * 60` — every Spin and every Spin
     restarted by TournamentManagerBase carries its level length only here.
     blindLevelMinutes reads all three. */
  duration?: number;
  isBreak?: boolean;
}

export interface PayoutEntry {
  place: number;
  percentage: number;
}

export interface TournamentPlayer {
  id: string;
  tournament_id: string;
  user_id: string;
  username: string;
  chips: number;
  status: TournamentPlayerStatus;
  position: number | null;
  prize: number | null;
  table_id?: string | null;
  seat_number?: number | null;
  rebuys?: number;
  rebuys_used?: number; // Canonical field name
  add_on?: boolean;
  addon_used?: boolean; // Canonical field name
  registered_at: string;
  eliminated_at?: string;
  bounties_collected: number;
  bounty_winnings: number;
  current_bounty: number;
  mystery_bounty_value?: number | null;
  is_satellite_qualifier?: boolean;
}

export type TournamentPlayerStatus = 'registered' | 'playing' | 'eliminated' | 'winner';
