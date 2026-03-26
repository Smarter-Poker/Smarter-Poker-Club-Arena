/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Type Definitions
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone — Better
 * Complete type system for clubs, tables, games, and players
 */

// ═══════════════════════════════════════════════════════════════════════════════
//  CLUBS
// ═══════════════════════════════════════════════════════════════════════════════

export interface Club {
  id: string;
  club_id: number; // 6-digit public Club ID for joining
  name: string;
  slug?: string;
  description?: string | null;
  avatar_url?: string | null;
  logo_url?: string | null;
  banner_url?: string | null;
  owner_id: string;
  color_theme?: string; // DB column name (not ClubTheme enum)
  is_public: boolean;
  requires_approval: boolean;
  gps_restricted?: boolean;
  member_count: number;
  online_count?: number;
  table_count?: number;
  chip_treasury?: number; // DB column name (was 'total_chips')

  // 50-Level System Capacity Metrics
  level?: number;
  player_level?: number;
  hierarchy_level?: number;
  hierarchy_units?: number;
  hierarchy_units_rounded_up?: number;
  player_threshold_current?: number;
  player_threshold_next?: number;
  hierarchy_threshold_current?: number;
  hierarchy_threshold_next?: number;

  union_id?: string | null;
  settings?: ClubSettings | Record<string, any>;
  created_at: string;
  updated_at: string;
}

export type ClubTheme = 'blue' | 'green' | 'red' | 'purple' | 'gold' | 'black';

export interface ClubSettings {
  gps_restriction: boolean;
  ip_restriction: boolean;
  device_restriction: boolean;
  auto_approve: boolean;
  rake_percentage: number; // 0-10%
  rake_cap_bb: number; // Rake cap in big blinds
  allow_rakeback: boolean;
  rakeback_percentage: number;
  default_time_bank: number; // seconds
}

export interface ClubWithDistance extends Club {
  distance_km: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIONS (Club Networks)
// ═══════════════════════════════════════════════════════════════════════════════

export interface Union {
  id: string;
  name: string;
  description?: string;
  owner_id: string;
  club_ids: string[];
  member_count: number;
  rules: UnionRules;
  created_at: string;

  // 50-Level System (mirrors clubs — same formula)
  level?: number;
  player_level?: number;
  hierarchy_level?: number;
  total_players?: number;
  total_admins?: number;
  total_super_agents?: number;
  total_agents?: number;
  hierarchy_units?: number;
  hierarchy_units_rounded_up?: number;
  club_count?: number;
  player_threshold_current?: number;
  player_threshold_next?: number;
  hierarchy_threshold_current?: number;
  hierarchy_threshold_next?: number;
}

export interface UnionRules {
  standardized_rake: boolean;
  shared_blacklist: boolean;
  rake_percentage: number;
  rake_cap_bb: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MEMBERS & ROLES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClubMember {
  id?: string; // Optional — column may not exist in all DB schemas
  user_id: string;
  club_id: string;
  role: MemberRole;
  status?: string;
  tier?: string | null;
  chip_balance?: number; // DB column name (was 'chips')
  credit_used?: number;
  diamonds?: number;
  reputation_xp?: number;
  trust_score?: number;
  rank_level?: number;
  sessions_played?: number;
  orange_ball_status?: string | null;
  parent_agent_id?: string | null;
  hands_played?: number; // DB column name (was 'total_hands')
  chips_won?: number; // DB column name (was 'total_won')
  chips_lost?: number; // DB column name (was 'total_lost')
  total_rake_paid?: number; // DB column name (was 'rake_generated')
  notes?: string; // Admin notes
  joined_at: string;
  last_active?: string;
  profile?: UserProfile | { username?: string; avatar_url?: string }[];
}

export type MemberRole = 'owner' | 'super_agent' | 'agent' | 'manager' | 'member' | 'guest';

export const ROLE_PERMISSIONS: Record<MemberRole, string[]> = {
  owner: ['all'],
  super_agent: ['manage_chips', 'manage_agents', 'view_reports'],
  agent: ['manage_chips', 'invite_players'],
  manager: ['manage_tables', 'kick_players', 'manage_games'],
  member: ['play', 'view_lobby'],
  guest: ['view_lobby'],
};

// ═══════════════════════════════════════════════════════════════════════════════
//  USER PROFILES
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserProfile {
  id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  avatar_frame?: string;
  is_online: boolean;
  status: UserStatus;
  vip_level: VIPLevel;
  created_at: string;
}

export type UserStatus = 'online' | 'offline' | 'away' | 'playing';

export type VIPLevel = 'none' | 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

// ═══════════════════════════════════════════════════════════════════════════════
//  TABLES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Table {
  id: string;
  club_id: string;
  name: string;
  game_type: GameType;
  game_variant: GameVariant;
  status: TableStatus;
  seats: number; // 2-9
  players: TablePlayer[];
  settings: TableSettings;
  pot_total: number;
  current_hand_id?: string;
  created_at: string;
  created_by: string;
}

export type TableStatus = 'waiting' | 'running' | 'paused' | 'closed';

export type GameType = 'cash' | 'tournament' | 'sng' | 'spin';

export type GameVariant =
  | 'nlh' // No-Limit Hold'em
  | 'short_deck' // Short Deck (6+)
  | 'plo4' // Pot-Limit Omaha 4-card
  | 'plo5' // Pot-Limit Omaha 5-card
  | 'plo6' // Pot-Limit Omaha 6-card
  | 'plo8' // Omaha Hi-Lo (8 or better)
  | 'ofc' // Open Face Chinese
  | 'ofc_pineapple' // OFC Pineapple
  | 'pineapple'; // Pineapple Hold'em

export interface TableSettings {
  // Blinds & Stakes
  small_blind: number;
  big_blind: number;
  ante: number;
  min_buy_in: number; // In BB
  max_buy_in: number; // In BB

  // Time Settings
  time_to_act: number; // seconds
  time_bank: number; // seconds per player

  // Features
  straddle_allowed: boolean;
  straddle_type: StraddleType;
  run_it_twice: boolean;
  bomb_pot_enabled: boolean;
  bomb_pot_frequency: number; // Every X hands, 0 = disabled
  bomb_pot_ante_bb: number; // In big blinds
  double_board: boolean;

  // Table Rules
  show_vpip: boolean;
  action_table: boolean; // Require minimum hands played
  action_table_percentage: number;

  // Security
  gps_enabled: boolean;
  ip_restriction: boolean;
  allow_observers: boolean;
}

export type StraddleType = 'none' | 'utg'; // FIX 114: UTG straddle only

// ═══════════════════════════════════════════════════════════════════════════════
// 🪑 TABLE PLAYERS
// ═══════════════════════════════════════════════════════════════════════════════

export interface TablePlayer {
  id: string;
  user_id: string;
  table_id: string;
  seat_number: number; // 1-9
  stack: number; // Current chips at table
  status: PlayerStatus;
  is_dealer: boolean;
  is_small_blind: boolean;
  is_big_blind: boolean;
  cards?: Card[]; // Hole cards (only visible to player/showdown)
  current_bet: number;
  time_bank_remaining: number;
  vpip: number; // Session VPIP %
  pfr: number; // Session PFR %
  hands_played: number;
  session_profit: number;
  profile: UserProfile;
}

export type PlayerStatus =
  | 'waiting' // Waiting to be dealt in
  | 'active' // In hand
  | 'folded' // Folded this hand
  | 'all_in' // All-in
  | 'sitting_out' // Sitting out
  | 'away'; // Marked away

// ═══════════════════════════════════════════════════════════════════════════════
//  CARDS & HANDS
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
  rank: CardRank;
  suit: CardSuit;
}

export type CardRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type CardSuit = 'h' | 'd' | 'c' | 's'; // hearts, diamonds, clubs, spades

export function cardToString(card: Card): string {
  return `${card.rank}${card.suit}`;
}

export function cardColor(suit: CardSuit): 'red' | 'black' {
  return suit === 'h' || suit === 'd' ? 'red' : 'black';
}

export interface Hand {
  id: string;
  table_id: string;
  hand_number: number;
  status: HandStatus;
  community_cards: Card[];
  pot: number;
  side_pots: SidePot[];
  actions: HandAction[];
  winners?: HandWinner[];
  started_at: string;
  ended_at?: string;
}

export type HandStatus = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';

export interface SidePot {
  amount: number;
  eligible_players: string[]; // user_ids
}

export interface HandAction {
  id: string;
  hand_id: string;
  user_id: string;
  action: ActionType;
  amount?: number;
  street: HandStatus;
  timestamp: string;
}

export type ActionType =
  | 'fold'
  | 'check'
  | 'call'
  | 'bet'
  | 'raise'
  | 'all_in'
  | 'post_sb'
  | 'post_bb'
  | 'post_ante'
  | 'straddle';

export interface HandWinner {
  user_id: string;
  amount: number;
  hand_description: string; // e.g., "Full House, Aces full of Kings"
  cards_shown: Card[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TOURNAMENTS
// ═══════════════════════════════════════════════════════════════════════════════

export interface Tournament {
  id: string;
  club_id: string;
  union_id?: string | null; // For XMTT tournaments
  name: string;
  type?: TournamentType; // Legacy field
  tournament_type?: string; // MTT, SNG, SPIN
  game_variant?: GameVariant; // Legacy field
  game_type?: string; // NLH, PLO4, etc. — text field, not enum
  variant?: string; // freezeout, bounty, sng, spin
  status: TournamentStatus;
  buy_in?: number; // Legacy field name
  buy_in_amount: number; // Canonical: decimal amount
  buy_in_fee: number; // Fee/rake on buy-in
  starting_chips: number;
  blind_structure: BlindLevel[];
  payout_structure: PayoutEntry[]; // Canonical field name
  current_level: number;
  level_duration_minutes?: number; // Legacy
  registered_players?: number; // Legacy
  current_players: number; // Canonical field
  max_players?: number;
  min_players: number;
  prize_pool: number;
  guaranteed_prize: number; // For guaranteed tournaments
  prize_pool_finalized: boolean; // When payouts are finalized

  // Late registration
  late_registration_levels?: number; // Legacy
  late_reg_levels?: number; // Canonical
  late_reg_mins: number; // Minutes of late registration

  // Rebuy system
  is_rebuy: boolean;
  rebuy_cost: number;
  rebuy_chips: number;
  rebuy_levels: number;
  is_reentry?: boolean; // Legacy field

  // Add-on system
  add_on_available: boolean;
  addon_available?: boolean; // Alias
  addon_cost: number;
  addon_chips: number;
  addon_allowed?: boolean; // Legacy

  // Bounty tournaments
  is_bounty: boolean;
  bounty_amount: number;
  is_pko: boolean; // Progressive Knockout
  is_mystery_bounty: boolean;
  mystery_bounty_min: number;
  mystery_bounty_max: number;

  // Multi-day tournaments
  is_multi_day: boolean;
  total_days: number;
  day_number: number;
  flight_number: number;

  // Spin & Go
  spin_type: string; // standard, progressive, etc.
  spin_multiplier?: number | null;
  is_premium_spin: boolean;

  // Union/Cross-Club
  is_xmtt: boolean; // Union Multi-Table Tournament

  // Accounting
  total_rake: number;

  // Visibility/Ordering
  is_pinned?: boolean;

  // Timing
  starts_at?: string; // Legacy field
  start_time?: string; // Canonical field (TIMESTAMPTZ)
  scheduled_start?: string; // Legacy alias
  started_at?: string;
  ended_at?: string;

  // Aliases for compatibility
  reentry_allowed?: boolean;
  rebuy_allowed?: boolean;

  created_at: string;
  updated_at?: string;
  settings?: TournamentConfig; // Tournament-specific settings
  [key: string]: any; // For flexibility
}

export type TournamentType = 'mtt' | 'sng' | 'spin' | 'satellite';

export type TournamentStatus =
  | 'registering'
  | 'late_registration'
  | 'running'
  | 'final_table'
  | 'complete'
  | 'cancelled';

export interface BlindLevel {
  level: number;
  small_blind: number;
  big_blind: number;
  ante: number;
  isBreak?: boolean; // Optional break marker
  duration_mins?: number; // Duration in minutes
}

export interface PayoutTier {
  position: number;
  percentage: number;
}

// Alias for database naming consistency
export type PayoutEntry = PayoutTier;

// Spin & multiplier configuration
export interface SpinMultiplier {
  multiplier: number;
  weight?: number; // Probability weight for random selection
}

// Bounty configuration for tournaments
export interface BountyConfig {
  is_bounty: boolean;
  bounty_amount: number;
  is_pko: boolean; // Progressive Knockout
  is_mystery_bounty: boolean;
  mystery_bounty_min: number;
  mystery_bounty_max: number;
}

// Tournament configuration (composition of tournament settings)
export interface TournamentConfig {
  late_registration_levels?: number;
  re_entry_allowed?: boolean;
  re_entry_max?: number;
  addon_allowed?: boolean;
  bounty_enabled?: boolean;
  [key: string]: any;
}

export interface TournamentEntry {
  id: string;
  tournament_id: string;
  user_id: string;
  username: string;
  chips: number;
  status: TournamentPlayerStatus;
  position?: number;
  prize?: number | null;
  reentries?: number; // Legacy alias
  rebuys?: number | null; // Legacy alias
  rebuys_used?: number; // Canonical
  addon_taken?: boolean; // Legacy alias
  addon_used?: boolean; // Canonical
  registered_at: string;
  eliminated_at?: string;
  table_id?: string | null;
  seat_number?: number | null;
  bounties_collected: number;
  bounty_winnings: number;
  current_bounty: number;
  mystery_bounty_value?: number | null;
}

export type TournamentPlayerStatus = 'registered' | 'playing' | 'eliminated' | 'winner';

// ═══════════════════════════════════════════════════════════════════════════════
//  ECONOMY
// ═══════════════════════════════════════════════════════════════════════════════

// ChipTransaction + TransactionType: canonical definition in database.types.ts
// (removed duplicate — use `import { ChipTransaction } from './database.types'`)

export interface DiamondTransaction {
  id: string;
  user_id: string;
  type: 'purchase' | 'conversion' | 'bonus';
  amount: number;
  cost_usd?: number; // For purchases
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PLAYER STATISTICS
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlayerStats {
  user_id: string;
  total_hands: number;
  vpip: number; // %
  pfr: number; // %
  three_bet: number; // %
  cbet_flop: number; // %
  wtsd: number; // Went to showdown %
  won_at_sd: number; // Won at showdown %
  bb_per_100: number; // BB won per 100 hands
  total_profit: number;
  biggest_pot_won: number;
  games_played: number;
  roi_tournaments: number; // Tournament ROI %
  updated_at: string;
}

export interface PlayerStyleIcon {
  type: 'newbie' | 'rock' | 'fish' | 'shark' | 'whale' | 'maniac';
  vpip_range: [number, number];
  pfr_range: [number, number];
}

export const PLAYER_STYLES: PlayerStyleIcon[] = [
  { type: 'rock', vpip_range: [0, 15], pfr_range: [0, 12] },
  { type: 'fish', vpip_range: [40, 100], pfr_range: [0, 15] },
  { type: 'maniac', vpip_range: [40, 100], pfr_range: [30, 100] },
  { type: 'shark', vpip_range: [18, 28], pfr_range: [15, 25] },
  { type: 'whale', vpip_range: [30, 50], pfr_range: [20, 35] },
  { type: 'newbie', vpip_range: [0, 100], pfr_range: [0, 100] }, // Default
];

// ═══════════════════════════════════════════════════════════════════════════════
//  IN-APP ITEMS
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlayerInventory {
  user_id: string;
  time_bank_seconds: number;
  emojis: string[]; // Emoji IDs owned
  rabbit_cam_uses: number;
  vip_card_expires?: string;
}

export interface Emoji {
  id: string;
  name: string;
  image_url: string;
  is_premium: boolean;
  price_diamonds: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECURITY
// ═══════════════════════════════════════════════════════════════════════════════

export interface BlacklistEntry {
  id: string;
  club_id?: string; // null = union-wide
  union_id?: string;
  user_id: string;
  reason: string;
  banned_by: string;
  banned_at: string;
  expires_at?: string;
}

export interface SecurityLog {
  id: string;
  user_id: string;
  event_type: SecurityEventType;
  ip_address?: string;
  device_id?: string;
  gps_coords?: { lat: number; lng: number };
  details: Record<string, any>;
  created_at: string;
}

export type SecurityEventType =
  | 'login'
  | 'table_join'
  | 'suspicious_activity'
  | 'captcha_failed'
  | 'gps_violation'
  | 'ip_violation';

// ═══════════════════════════════════════════════════════════════════════════════
//  JACKPOTS
// ═══════════════════════════════════════════════════════════════════════════════

export interface BadBeatJackpot {
  id: string;
  club_id: string;
  current_amount: number;
  contribution_rate: number; // % of qualifying pots
  qualifying_hand: string; // e.g., "Quad Jacks or better beaten"
  last_hit?: string;
  last_winner_id?: string;
  last_amount_won?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🌡️ ARENA TRAFFIC & HEAT
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClubTrafficData {
  club_id: string;
  active_tables: number;
  active_players: number;
  waiting_players: number;
  waiting_list_total?: number;
  avg_pot_size: number;
  heat_level: HeatLevel;
}

export interface StakeInfo {
  stake_level?: number;
  small_blind: number;
  big_blind: number;
  label: string; // e.g., "1/2", "2/5"
}

// Heat level is numeric 0-5 for granular control
export type HeatLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface HeatConfig {
  level: number;
  name: string;
  minPlayers: number;
  minWaiting: number;
  color: string;
}

export const HEAT_LEVELS: HeatConfig[] = [
  { level: 0, name: 'COLD', color: '#4A5568', minPlayers: 0, minWaiting: 0 },
  { level: 1, name: 'WARM', color: '#48BB78', minPlayers: 10, minWaiting: 2 },
  { level: 2, name: 'ACTIVE', color: '#ECC94B', minPlayers: 25, minWaiting: 5 },
  { level: 3, name: 'HOT', color: '#ED8936', minPlayers: 50, minWaiting: 10 },
  { level: 4, name: 'VERY HOT', color: '#F56565', minPlayers: 75, minWaiting: 15 },
  { level: 5, name: 'RED HOT', color: '#E53E3E', minPlayers: 100, minWaiting: 20 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 📍 CLUB LOCATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClubLocation {
  club_id: string;
  latitude: number;
  longitude: number;
  city?: string;
  country?: string;
  timezone?: string;
}

export interface ClubChallenge {
  id: string;
  club_id: string;
  title: string;
  description: string;
  reward_chips: number;
  reward_diamonds?: number;
  starts_at: string;
  ends_at: string;
  is_active: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🎓 TRAINING SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

export interface TrainingSession {
  id: string;
  user_id: string;
  club_id?: string;
  level: number;
  status: TrainingStatus;
  score: number;
  questions_attempted: number;
  correct_answers: number;
  time_remaining?: number;
  created_at?: string;
  completed_at?: string;
}

export type TrainingStatus = 'active' | 'paused' | 'complete' | 'failed' | 'abandoned' | 'idle';

export type TrainingDifficulty = 'easy' | 'medium' | 'hard' | 'expert' | 'master';

export interface TrainingLevel {
  level: number;
  name: string;
  description: string;
  timer_seconds: number;
  difficulty: TrainingDifficulty;
  min_questions: number;
  mastery_threshold: number;
}

export const TRAINING_LEVELS: TrainingLevel[] = [
  {
    level: 1,
    name: 'Foundations',
    description: 'Basic pre-flop scenarios',
    timer_seconds: 30,
    difficulty: 'easy',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 2,
    name: 'Position Play',
    description: 'Positional awareness',
    timer_seconds: 28,
    difficulty: 'easy',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 3,
    name: 'Bet Sizing',
    description: 'Optimal bet sizes',
    timer_seconds: 25,
    difficulty: 'medium',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 4,
    name: 'C-Bet Strategy',
    description: 'Continuation betting',
    timer_seconds: 22,
    difficulty: 'medium',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 5,
    name: 'Turn Decisions',
    description: 'Complex turn strategy',
    timer_seconds: 20,
    difficulty: 'medium',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 6,
    name: 'River Play',
    description: 'River value & bluffs',
    timer_seconds: 18,
    difficulty: 'hard',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 7,
    name: '3-Bet Pots',
    description: 'Navigating 3-bet pots',
    timer_seconds: 15,
    difficulty: 'hard',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 8,
    name: 'Multi-Way Pots',
    description: 'Multi-way dynamics',
    timer_seconds: 12,
    difficulty: 'expert',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 9,
    name: 'MTT Strategy',
    description: 'Tournament ICM',
    timer_seconds: 10,
    difficulty: 'expert',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 10,
    name: 'Elite GTO',
    description: 'Solver-level play',
    timer_seconds: 8,
    difficulty: 'master',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
];

export const MASTERY_GATE_THRESHOLD = 0.85; // 85% accuracy to unlock next level
export const MASTERY_MIN_QUESTIONS = 20; // Minimum questions to evaluate mastery

// ═══════════════════════════════════════════════════════════════════════════════
//  ARENA STATS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ArenaStats {
  total_clubs: number;
  active_tables: number;
  active_players: number;
  total_hands_24h: number;
  biggest_pot_24h: number;
  training_sessions_active: number;
}
