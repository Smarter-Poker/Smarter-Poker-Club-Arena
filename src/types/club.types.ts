/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Type Definitions
 * ═══════════════════════════════════════════════════════════════════════════════
 * Smarter Poker Platform
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
  bbj_rake_enabled: boolean;
  spins_enabled: boolean;
  spins_preseed_amount: number;
  spins_wallet_funding: string;
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
  trust_score?: number;
  rank_level?: number;
  sessions_played?: number;
  orange_ball_status?: string | null;
  agent_id?: string | null;
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

  // Bible V8 2.1: Extended Table Object fields
  variant_config?: VariantConfig; // Embedded variant rules
  timing_config?: TableTimingConfig; // All timing parameters
  presence_config?: TablePresenceConfig; // Connection/heartbeat thresholds
  notification_config?: TableNotificationConfig; // Per-table notification rules
  sound_config?: TableSoundConfig; // Sound preferences
  animation_config?: TableAnimationConfig; // Animation speed/style
  security_config?: TableSecurityConfig; // Anti-cheat settings
  hand_sequence_number?: number; // Monotonic hand counter for this table
  seat_order_clockwise?: number[]; // Seat numbers in clockwise dealing order
  current_highest_wager?: number; // Current street's highest bet/raise
  current_minimum_raise_increment?: number; // Min raise increment for current street
  deck_state?: 'shuffled' | 'dealing' | 'dealt' | 'exhausted'; // Current deck lifecycle
  board_state?: 'empty' | 'flop' | 'turn' | 'river'; // Community card stage
  pot_state?: 'collecting' | 'distributing' | 'settled'; // Pot lifecycle
  pause_lock?: boolean; // Admin pause active
  maintenance_lock?: boolean; // System maintenance lock
  recovery_state?: 'healthy' | 'desync_detected' | 'resyncing' | 'recovery_failed';
}

/** Bible V8 2.1: Timing configuration sub-object */
export interface TableTimingConfig {
  time_to_act_seconds: number; // Primary shot clock (default 15-30)
  time_bank_max_activations_per_hand: number; // Max 2 per Bible V8 6.4
  time_bank_max_activations_per_session: number; // VIP pool
  disconnect_grace_period_ms: number; // Before marking disconnected
  heartbeat_interval_ms: number; // Client heartbeat frequency
  heartbeat_timeout_ms: number; // Server-side heartbeat miss threshold
  inter_hand_delay_ms: number; // Phase 1 result display (1500ms)
  board_clear_delay_ms: number; // Phase 2 board clear (500ms)
  deal_card_interval_ms: number; // Delay between dealing each card
}

/** Bible V8 2.1: Presence/connection configuration */
export interface TablePresenceConfig {
  heartbeat_interval_ms: number;
  heartbeat_timeout_ms: number;
  disconnect_grace_period_ms: number;
  max_consecutive_timeouts: number; // Triggers sit-out (default 3)
  reconnect_window_ms: number; // Time allowed to reconnect
  away_detection_idle_ms: number; // Idle time before marking "away"
}

/** Bible V8 2.1: Notification configuration */
export interface TableNotificationConfig {
  your_turn_enabled: boolean;
  your_turn_reminder_enabled: boolean;
  reminder_delay_ms: number; // Delay before sending reminder
  max_notifications_per_turn: number; // Anti-spam (default 2)
  tournament_alerts_enabled: boolean;
  sound_enabled: boolean;
  haptics_enabled: boolean;
  push_enabled: boolean;
  dnd_mode: boolean;
}

/** Bible V8 2.1: Sound configuration */
export interface TableSoundConfig {
  master_volume: number; // 0.0-1.0
  effects_enabled: boolean;
  deal_sound: boolean;
  action_sounds: boolean;
  timer_warning_sound: boolean;
  win_celebration_sound: boolean;
  chat_notification_sound: boolean;
}

/** Bible V8 2.1: Animation configuration */
export interface TableAnimationConfig {
  animation_speed: 'slow' | 'normal' | 'fast'; // Multiplier for all animations
  chip_animations: boolean;
  card_animations: boolean;
  confetti_on_win: boolean;
  screen_shake: boolean;
  particle_effects: boolean;
  reduced_motion: boolean; // Respects prefers-reduced-motion
}

/** Bible V8 2.1: Security configuration */
export interface TableSecurityConfig {
  gps_verification: boolean;
  ip_restriction: boolean;
  device_fingerprint: boolean;
  max_tables_per_player: number; // Multi-tabling limit
  allow_observers: boolean;
  observer_delay_seconds: number;
  observer_show_cards_at_showdown: boolean;
  anti_collusion_enabled: boolean;
  hand_integrity_hashing: boolean;
}

export type TableStatus = 'waiting' | 'running' | 'paused' | 'closed';

export type GameType = 'cash' | 'tournament' | 'sng' | 'spin';

// FIX 116: Dead variants removed — Dan's approved variants only.
//
// 2026-08-23: `flh` restored and `flo8` added. FIX 116 called them dead because
// nothing could create one, but the lobby's LIMIT tab and ClubHomePage's
// cashKind() never stopped classifying on them — so the tab could only ever be
// empty, which is the bug this change exists to fix. The engine now actually
// plays them fixed-limit; see server/src/engine/BettingStructure.ts. Keep in
// lockstep with the identical union in server/src/types.ts.
export type GameVariant =
  | 'nlh' // No-Limit Hold'em
  | 'plo4' // Pot-Limit Omaha 4-card
  | 'plo5' // Pot-Limit Omaha 5-card
  | 'plo6' // Pot-Limit Omaha 6-card
  | 'plo8' // Omaha Hi-Lo (8 or better)
  | 'pineapple' // Pineapple Hold'em
  | 'short_deck' // Short Deck (6+)
  | 'flh' // Fixed Limit Hold'em
  | 'flo8'; // Fixed Limit Omaha Hi-Lo

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
  /** DOUBLE-BOARD BOMB POT 2026-08-20: deal two boards, split pots across them. */
  bomb_pot_double_board?: boolean;
  /* BOMB POT STANDARDIZATION 2026-08-27 (spec §3): canonical config — board
     count 1-3 supersedes the boolean; trigger mode, timed interval, minimum
     players and optional fixed ante. */
  bomb_pot_board_count?: number;
  bomb_pot_trigger_mode?: 'every_n_hands' | 'once_per_orbit' | 'timed' | 'bomb_pot_only';
  bomb_pot_interval_seconds?: number | null;
  bomb_pot_min_players?: number;
  bomb_pot_ante_fixed?: number | null;
  /** VARIANT OVERRIDE (spec §10.1): bomb hand variant; NULL = same as table. */
  bomb_pot_variant?: 'nlh' | 'plo4' | 'plo5' | 'plo6' | null;
  double_board: boolean;

  // Table Rules
  show_vpip: boolean;
  action_table: boolean; // Require minimum hands played
  action_table_percentage: number;

  // Blind Entry Policies (Bible V8 4.3)
  wait_for_big_blind: boolean; // New players must wait for BB before being dealt in
  auto_post_blinds: boolean; // Auto-post blinds when returning from sit-out
  post_dead_blind: boolean; // Require missed blind post when re-entering

  // Showdown Reveal Policy (Bible V8 4.21)
  showdown_reveal: ShowdownRevealPolicy;
  auto_muck_losers: boolean; // Auto-muck non-winning hands

  // Anti-Ratholing
  no_rathole: boolean; // Prevent leaving and re-sitting with fewer chips
  rathole_cooldown_minutes: number; // Cooldown before re-sitting after leaving

  // Security
  gps_enabled: boolean;
  ip_restriction: boolean;
  allow_observers: boolean;
}

// FIX 114: UTG straddle only — Mississippi and all_positions removed per Dan's directive
export type StraddleType = 'none' | 'utg';

// Bible V8 4.21: Showdown reveal ordering
export type ShowdownRevealPolicy =
  | 'last_aggressor_first' // Last player who bet/raised shows first (standard)
  | 'clockwise_from_button' // First left of dealer shows first
  | 'auto_show_all'; // All hands revealed automatically

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

  // Bible V8 2.4: Extended seat fields
  waiting_for_big_blind: boolean; // Player waiting to post BB before playing
  sit_out_next_hand: boolean; // Will sit out after current hand
  auto_post_blinds_enabled: boolean; // Auto-post blinds preference
  forced_post_required: boolean; // Must post dead blind to re-enter
  timeout_count_session: number; // Timeouts this session (triggers sit-out after 3)
  auto_rebuy_enabled: boolean; // Auto rebuy when stack drops below threshold
  auto_rebuy_amount: number; // Amount to auto rebuy (in BB)

  // Bible V8 2.4: Visual/action state fields
  force_sit_out_pending: boolean; // Will be force-sat-out after current hand
  current_visual_state: SeatVisualState; // CSS class driver
  current_highlight_state: SeatHighlightState; // Glow/border style
  action_pending_here: boolean; // True when it's this seat's turn
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  `rebuy_prompt_active` DELETED 2026-08-27 — IT NEVER EXISTED
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It was declared here as a non-optional `boolean` on the seat row, and no
   * such column has ever existed on `table_seats` — nor anywhere else in the
   * schema. Nothing read it, which is the only reason a required field that is
   * always `undefined` at runtime never became a crash.
   *
   * The real state lives on the TOURNAMENT entry, not the seat, and it is not a
   * boolean: `tournament_players.rebuy_prompt_until timestamptz NULL`. It is
   * declared as `TournamentRebuyPrompt` below. A boolean cannot express the
   * thing that matters here, which is HOW LONG the server is still holding the
   * seat — the elimination sweep must not eliminate while
   * `now() < rebuy_prompt_until`, and a client reading a boolean would be right
   * back to inventing its own window.
   */

  // Bible V8 2.8: Per-hand player state
  manual_time_banks_used_this_hand: number;
  auto_time_bank_used_this_hand: boolean;
  total_time_banks_used_this_hand: number;
  eligible_pot_ids: string[]; // Which pots this player can win
  hand_evaluation_result?: HandEvaluationResult; // Computed at showdown
  revealed_at_showdown: boolean; // Cards shown at showdown
  mucked_at_showdown: boolean; // Cards mucked at showdown
}

/** Bible V8 2.4: Visual state enum for seat CSS */
export type SeatVisualState =
  | 'default' // Normal seated
  | 'in_hand' // Dealt cards, in current hand
  | 'active' // Currently acting (bright highlight)
  | 'folded' // Folded (dimmed)
  | 'all_in' // All-in (red glow)
  | 'winner' // Won the hand (gold glow)
  | 'sitting_out' // Sitting out (greyed)
  | 'disconnected'; // Disconnected badge

/** Bible V8 2.4: Highlight state for seat borders/glows */
export type SeatHighlightState =
  | 'none'
  | 'active_turn' // Neon yellow glow — your turn
  | 'winner_glow' // Gold pulsing glow
  | 'all_in_glow' // Red border glow
  | 'fold_dim' // Opacity reduction
  | 'disconnected_badge'; // Gray with disconnect icon

/** Bible V8 2.8/2.20: Hand evaluation result */
export interface HandEvaluationResult {
  rank: number; // Numeric hand rank (1 = high card ... 10 = royal flush)
  rank_name: string; // "Full House", "Straight", etc.
  best_five: Card[]; // Best 5-card hand
  kickers: Card[]; // Kicker cards for tiebreaking
  is_winner: boolean;
  pot_share: number; // Amount won from pot
}

export type PlayerStatus =
  | 'waiting' // Waiting to be dealt in
  | 'active' // In hand
  | 'folded' // Folded this hand
  | 'all_in' // All-in
  | 'sitting_out' // Sitting out
  | 'away' // Marked away
  | 'disconnected'; // FIX 186: Bible V8 §2.3 — Disconnected from server

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

  // Bible V8 2.7: Extended Hand Object fields
  timer_log?: TimerLogEntry[]; // All timer events this hand
  notification_log?: NotificationLogEntry[]; // All notifications sent
  showdown_result?: ShowdownResult; // Full showdown evaluation
  settlement_result?: SettlementResult; // Pot distribution details
  dealer_seat?: number; // Button position for this hand
  small_blind_seat?: number;
  big_blind_seat?: number;
  button_progression?: number; // Which button position in rotation
}

/** Bible V8 2.7: Showdown evaluation result */
export interface ShowdownResult {
  eligible_players: Array<{
    user_id: string;
    seat: number;
    hand: Card[];
    best_five: Card[];
    rank: number;
    rank_name: string;
    revealed: boolean;
    mucked: boolean;
  }>;
  winning_hands: Array<{
    user_id: string;
    rank_name: string;
    best_five: Card[];
  }>;
  board: Card[];
}

/** Bible V8 2.7: Settlement/pot distribution result */
export interface SettlementResult {
  distributions: Array<{
    user_id: string;
    pot_id: string; // 'main' or side pot ID
    amount: number;
    net_profit: number; // amount - total_invested
  }>;
  rake: number;
  rake_cap_applied: boolean;
  bbj_contribution: number;
  total_distributed: number;
  chip_conservation_verified: boolean; // StateVerifier confirmation
}

/** Bible V8 2.5: Player Preference Object */
export interface PlayerPreference {
  user_id: string;

  // Display
  theme: 'dark' | 'light' | 'auto';
  table_felt_color: string; // Hex color
  card_back_style: string; // 'classic' | 'modern' | etc.
  deck_style: '4color' | '2color';
  avatar_frame: string;
  show_hand_strength: boolean;
  show_pot_odds: boolean;
  show_vpip: boolean;
  four_color_deck: boolean;

  // Sound & Haptics
  sound_enabled: boolean;
  sound_volume: number; // 0.0-1.0
  haptics_enabled: boolean;
  notification_sound_enabled: boolean;
  deal_sound_enabled: boolean;
  action_sound_enabled: boolean;

  // Notifications
  push_notifications_enabled: boolean;
  your_turn_notifications: boolean;
  tournament_notifications: boolean;
  dnd_mode: boolean;
  dnd_schedule?: { start_hour: number; end_hour: number };

  // Gameplay
  auto_muck_losing_hands: boolean;
  confirm_all_in: boolean;
  auto_post_blinds: boolean;
  show_bet_size_presets: boolean;
  default_buy_in_bb: number; // Preferred buy-in as BB multiple
  auto_rebuy: boolean;
  auto_rebuy_threshold_bb: number;
  auto_rebuy_amount_bb: number;
  preferred_seat?: number; // 1-9

  // Accessibility
  reduced_motion: boolean;
  high_contrast: boolean;
  screen_reader_mode: boolean;
  font_size_multiplier: number; // 1.0 = normal, 1.5 = large

  // i18n
  locale: string; // 'en', 'es', etc.
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE REBUY PROMPT IS A DEADLINE THE SERVER OWNS (2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `public.tournament_players.rebuy_prompt_until timestamptz NULL`, live in
 * production. It replaces the `rebuy_prompt_active: boolean` that TablePlayer
 * declared above and that no database has ever had.
 *
 * THE CONTRACT:
 *   - On bust the server sets `rebuy_prompt_until = now() + window`.
 *   - The elimination sweep MUST NOT eliminate while `now() < rebuy_prompt_until`.
 *   - Accepting OR declining clears it, so a decline releases the table at once.
 *   - NULL means no prompt is open.
 *
 * A boolean could not carry this. The client used to hold the rebuy modal for a
 * flat 120,000 ms of its own choosing while the sweep ran on a five-second
 * clock: a player who took six seconds to read the price was refused with "No
 * live seat for this rebuy" for a rebuy they were entitled to, and had already
 * been stamped with a finishing position. The window has to be a number the
 * server states and the client reads, and the client may only ever shorten it.
 *
 * `tournament_players` carries a SELECT policy and nothing else, so the CLIENT
 * only ever READS this column: a browser UPDATE returns zero rows with no
 * error, which is a silent no-op. Writing and clearing it belongs to the engine
 * and to `process_tournament_rebuy`.
 *
 * ISO 8601 string, as PostgREST returns it. Parse with `Date.parse`.
 */
export interface TournamentRebuyPrompt {
  rebuy_prompt_until: string | null;
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
    description: 'Basic Pre-Flop Scenarios',
    timer_seconds: 30,
    difficulty: 'easy',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 2,
    name: 'Position Play',
    description: 'Positional Awareness',
    timer_seconds: 28,
    difficulty: 'easy',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 3,
    name: 'Bet Sizing',
    description: 'Optimal Bet Sizes',
    timer_seconds: 25,
    difficulty: 'medium',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 4,
    name: 'C-Bet Strategy',
    description: 'Continuation Betting',
    timer_seconds: 22,
    difficulty: 'medium',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 5,
    name: 'Turn Decisions',
    description: 'Complex Turn Strategy',
    timer_seconds: 20,
    difficulty: 'medium',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 6,
    name: 'River Play',
    description: 'River Value & Bluffs',
    timer_seconds: 18,
    difficulty: 'hard',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 7,
    name: '3-Bet Pots',
    description: 'Navigating 3-Bet Pots',
    timer_seconds: 15,
    difficulty: 'hard',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
  {
    level: 8,
    name: 'Multi-Way Pots',
    description: 'Multi-Way Dynamics',
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
    description: 'Solver-Level Play',
    timer_seconds: 8,
    difficulty: 'master',
    min_questions: 20,
    mastery_threshold: 0.85,
  },
];

export const MASTERY_GATE_THRESHOLD = 0.85; // 85% accuracy to unlock next level
export const MASTERY_MIN_QUESTIONS = 20; // Minimum questions to evaluate mastery

// ═══════════════════════════════════════════════════════════════════════════════
//  BIBLE V8 CHAPTER 2 — EXTENDED OBJECT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bible V8 2.2: Variant Configuration Object
 * Data-driven variant rules instead of code-branched logic.
 * Each variant maps to one of these configs.
 */
export interface VariantConfig {
  variant: GameVariant;
  display_name: string;
  hole_cards: number; // 2 for NLH, 4 for PLO4, etc.
  mandatory_hole_card_usage: 'exactly_2' | 'any' | 'none'; // PLO = exactly_2, NLH = any
  board_cards_total: 5; // Always 5 for community games
  board_reveal_pattern: [number, number, number]; // [3, 1, 1] = flop/turn/river
  discard_phase_enabled: boolean; // true for Pineapple
  discard_after_street: 'flop' | null; // Pineapple discards after flop
  discard_count: number; // 1 for Pineapple
  hi_lo_enabled: boolean; // true for PLO8
  hi_lo_qualifier: number | null; // 8 for PLO8
  short_deck: boolean; // true for Short Deck (6+)
  short_deck_min_rank: CardRank | null; // '6' for Short Deck
  betting_structure: 'no_limit' | 'pot_limit' | 'fixed_limit';
  min_players: number;
  max_players: number;
}

/** Default variant configs for all supported variants */
export const VARIANT_CONFIGS: Record<GameVariant, VariantConfig> = {
  // ── LIMIT (2026-08-23) ────────────────────────────────────────────────────
  // `betting_structure` has carried a 'fixed_limit' member since this interface
  // was written; there was simply never a variant that used it, because FIX 116
  // had removed them all. These two deal exactly like nlh and plo8 — only the
  // BETTING differs, which is what server/src/engine/BettingStructure.ts now
  // enforces: fixed wager sizes, small bet preflop and flop, big bet turn and
  // river, capped at one bet and three raises per street.
  flh: {
    variant: 'flh',
    display_name: "Fixed Limit Hold'em",
    hole_cards: 2,
    mandatory_hole_card_usage: 'any',
    board_cards_total: 5,
    board_reveal_pattern: [3, 1, 1],
    discard_phase_enabled: false,
    discard_after_street: null,
    discard_count: 0,
    hi_lo_enabled: false,
    hi_lo_qualifier: null,
    short_deck: false,
    short_deck_min_rank: null,
    betting_structure: 'fixed_limit',
    min_players: 2,
    max_players: 9,
  },
  flo8: {
    variant: 'flo8',
    display_name: 'Fixed Limit Omaha Hi-Lo',
    hole_cards: 4,
    mandatory_hole_card_usage: 'exactly_2',
    board_cards_total: 5,
    board_reveal_pattern: [3, 1, 1],
    discard_phase_enabled: false,
    discard_after_street: null,
    discard_count: 0,
    hi_lo_enabled: true,
    hi_lo_qualifier: 8,
    short_deck: false,
    short_deck_min_rank: null,
    betting_structure: 'fixed_limit',
    min_players: 2,
    max_players: 9,
  },
  nlh: {
    variant: 'nlh',
    display_name: "No-Limit Hold'em",
    hole_cards: 2,
    mandatory_hole_card_usage: 'any',
    board_cards_total: 5,
    board_reveal_pattern: [3, 1, 1],
    discard_phase_enabled: false,
    discard_after_street: null,
    discard_count: 0,
    hi_lo_enabled: false,
    hi_lo_qualifier: null,
    short_deck: false,
    short_deck_min_rank: null,
    betting_structure: 'no_limit',
    min_players: 2,
    max_players: 9,
  },
  plo4: {
    variant: 'plo4',
    display_name: 'Pot-Limit Omaha',
    hole_cards: 4,
    mandatory_hole_card_usage: 'exactly_2',
    board_cards_total: 5,
    board_reveal_pattern: [3, 1, 1],
    discard_phase_enabled: false,
    discard_after_street: null,
    discard_count: 0,
    hi_lo_enabled: false,
    hi_lo_qualifier: null,
    short_deck: false,
    short_deck_min_rank: null,
    betting_structure: 'pot_limit',
    min_players: 2,
    max_players: 9,
  },
  plo5: {
    variant: 'plo5',
    display_name: 'PLO-5 Card',
    hole_cards: 5,
    mandatory_hole_card_usage: 'exactly_2',
    board_cards_total: 5,
    board_reveal_pattern: [3, 1, 1],
    discard_phase_enabled: false,
    discard_after_street: null,
    discard_count: 0,
    hi_lo_enabled: false,
    hi_lo_qualifier: null,
    short_deck: false,
    short_deck_min_rank: null,
    betting_structure: 'pot_limit',
    min_players: 2,
    max_players: 6,
  },
  plo6: {
    variant: 'plo6',
    display_name: 'PLO-6 Card',
    hole_cards: 6,
    mandatory_hole_card_usage: 'exactly_2',
    board_cards_total: 5,
    board_reveal_pattern: [3, 1, 1],
    discard_phase_enabled: false,
    discard_after_street: null,
    discard_count: 0,
    hi_lo_enabled: false,
    hi_lo_qualifier: null,
    short_deck: false,
    short_deck_min_rank: null,
    betting_structure: 'pot_limit',
    min_players: 2,
    max_players: 6,
  },
  plo8: {
    variant: 'plo8',
    display_name: 'Omaha Hi-Lo',
    hole_cards: 4,
    mandatory_hole_card_usage: 'exactly_2',
    board_cards_total: 5,
    board_reveal_pattern: [3, 1, 1],
    discard_phase_enabled: false,
    discard_after_street: null,
    discard_count: 0,
    hi_lo_enabled: true,
    hi_lo_qualifier: 8,
    short_deck: false,
    short_deck_min_rank: null,
    betting_structure: 'pot_limit',
    min_players: 2,
    max_players: 9,
  },
  pineapple: {
    variant: 'pineapple',
    display_name: 'Crazy Pineapple',
    hole_cards: 3,
    mandatory_hole_card_usage: 'any',
    board_cards_total: 5,
    board_reveal_pattern: [3, 1, 1],
    discard_phase_enabled: true,
    discard_after_street: 'flop',
    discard_count: 1,
    hi_lo_enabled: false,
    hi_lo_qualifier: null,
    short_deck: false,
    short_deck_min_rank: null,
    betting_structure: 'no_limit',
    min_players: 2,
    max_players: 9,
  },
  short_deck: {
    variant: 'short_deck',
    display_name: 'Short Deck (6+)',
    hole_cards: 2,
    mandatory_hole_card_usage: 'any',
    board_cards_total: 5,
    board_reveal_pattern: [3, 1, 1],
    discard_phase_enabled: false,
    discard_after_street: null,
    discard_count: 0,
    hi_lo_enabled: false,
    hi_lo_qualifier: null,
    short_deck: true,
    short_deck_min_rank: '6',
    betting_structure: 'no_limit',
    min_players: 2,
    max_players: 9,
  },
};

/**
 * Bible V8 2.13: Bet Input Object
 * Tracks the state of the bet input UI for the current action.
 */
export interface BetInputState {
  min_bet: number; // Minimum legal bet/raise
  max_bet: number; // Maximum legal bet/raise (= stack for NL)
  current_value: number; // Current slider/input value
  presets: BetPreset[]; // Preset buttons (1/3 pot, 1/2 pot, etc.)
  pot_size: number; // Current pot for pot-relative calculations
  is_pot_limit: boolean; // Whether max is capped at pot
  slider_step: number; // Step size for slider
}

export interface BetPreset {
  label: string; // Display label ("1/2 Pot", "3x BB")
  amount: number; // Calculated amount
  type: 'pot_fraction' | 'bb_multiple' | 'fixed'; // How it's calculated
}

/**
 * Bible V8 2.14: Extended Action Record
 * Full action log entry with audit trail.
 */
export interface ActionRecord {
  id: string;
  hand_id: string;
  user_id: string;
  seat_number: number;
  street: HandStatus;
  action_type: ActionType;
  amount: number; // 0 for fold/check
  total_invested_after: number; // Cumulative chips in pot after this action
  pot_after_action: number; // Total pot after this action
  timestamp: string; // ISO 8601
  action_time_ms: number; // How long the player took to act
  time_bank_used: boolean; // Was time bank activated for this action
  time_bank_seconds_used: number; // Seconds of time bank consumed
  action_source: ActionSource; // How the action was taken
  is_timeout: boolean; // Was this an auto-fold/auto-check from timeout
  legal_action_set_snapshot: ActionType[]; // What actions were legal at time of action
}

export type ActionSource =
  | 'manual' // Player clicked/tapped
  | 'pre_action' // Pre-action queue (check/fold in advance)
  | 'timeout' // Auto-action from timer expiry
  | 'disconnect' // Auto-action from disconnect timeout
  | 'auto_post'; // Auto-post blind

/**
 * Bible V8 2.15: Timer Log Entry
 * Records timer events for audit and telemetry.
 */
export interface TimerLogEntry {
  hand_id: string;
  user_id: string;
  seat_number: number;
  street: HandStatus;
  event: TimerEvent;
  timestamp: string;
  primary_time_remaining_ms: number;
  time_bank_remaining_ms: number;
  time_bank_type?: 'auto' | 'manual';
}

export type TimerEvent =
  | 'turn_started' // Primary clock begins
  | 'time_bank_auto_activated' // Auto time bank kicked in
  | 'time_bank_manual_activated' // Player used manual time bank
  | 'timer_warning' // <5s warning fired
  | 'timeout' // Timer expired, auto-action triggered
  | 'action_committed'; // Player acted, timer stopped

/**
 * Bible V8 2.16: Notification Log Entry
 * Records notifications sent per hand for anti-spam auditing.
 */
export interface NotificationLogEntry {
  hand_id: string;
  user_id: string;
  notification_type: NotificationType;
  channel: NotificationChannel;
  timestamp: string;
  was_delivered: boolean;
  suppressed_reason?: string; // 'anti_spam' | 'user_disabled' | 'not_absent'
}

export type NotificationType =
  | 'your_turn' // It's your turn to act
  | 'your_turn_reminder' // Reminder after 5s of inaction
  | 'time_bank_active' // Time bank activated
  | 'hand_won' // You won the pot
  | 'tournament_starting' // Tournament about to start
  | 'table_closing' // Table closing soon
  | 'new_hand'; // New hand started (for absent players)

export type NotificationChannel = 'in_app' | 'push' | 'sound' | 'haptic' | 'browser';

/**
 * Bible V8 2.17: Recovery/Error State
 * Tracks desync detection and recovery.
 */
export interface RecoveryState {
  last_confirmed_server_seq: number; // Last sequence number confirmed from server
  last_client_seq: number; // Last sequence number processed by client
  desync_detected: boolean; // True if client and server are out of sync
  desync_detected_at?: string; // When desync was first detected
  recovery_attempts: number; // Number of resync attempts
  last_recovery_attempt?: string; // Timestamp of last recovery
  recovery_status:
    | 'synced'
    | 'desync_detected'
    | 'resync_in_progress'
    | 'resync_complete'
    | 'resync_failed';
}

/**
 * Bible V8 2.18: Hand History Output Layers
 * Four tiers of hand history for different consumers.
 */
export interface HandHistoryLayers {
  /** Layer 1: Raw event stream — every event as it happened, no transformation */
  raw_events: HandHistoryRawEvent[];
  /** Layer 2: Normalized audit log — structured, queryable, with computed fields */
  audit_log: ActionRecord[];
  /** Layer 3: Player-facing summary — what the player sees in hand history UI */
  player_summary: HandHistoryPlayerSummary;
  /** Layer 4: Dispute review — complete evidence package for disputes */
  dispute_review: HandHistoryDisputePackage;
}

export interface HandHistoryRawEvent {
  seq: number; // Sequence number
  type: string; // Event type (e.g., 'deal', 'action', 'board', 'showdown')
  timestamp: string;
  data: Record<string, any>; // Raw event payload
}

export interface HandHistoryPlayerSummary {
  hand_id: string;
  hand_number: number;
  game_variant: GameVariant;
  stakes: string; // "1/2"
  community_cards: Card[];
  my_cards: Card[];
  my_position: string; // "BTN", "SB", "BB", "UTG", etc.
  my_result: number; // +/- chips
  pot_total: number;
  winner_description: string; // "Player1 wins $500 with Full House"
  actions_summary: string[]; // ["Preflop: Hero raises to $10", "Flop: Hero checks"]
}

export interface HandHistoryDisputePackage {
  hand_id: string;
  raw_events: HandHistoryRawEvent[];
  audit_log: ActionRecord[];
  deck_seed?: string; // For verifying shuffle integrity
  server_state_snapshots: Record<string, any>[]; // State at each decision point
  timer_log: TimerLogEntry[];
  notification_log: NotificationLogEntry[];
  connection_log: ConnectionLogEntry[];
}

export interface ConnectionLogEntry {
  user_id: string;
  event: 'connected' | 'disconnected' | 'reconnected' | 'heartbeat_missed';
  timestamp: string;
  latency_ms?: number;
}

/**
 * Bible V8 2.6: Player Presence State (extended)
 * Comprehensive presence tracking beyond basic connected/disconnected.
 */
export interface PlayerPresenceState {
  user_id: string;
  is_connected: boolean;
  is_focused: boolean; // Browser tab is focused
  app_state: 'foreground' | 'background' | 'inactive'; // App visibility
  last_heartbeat: string;
  last_action_at: string;
  latency_ms: number;
  consecutive_timeouts: number;
  is_sitting_out: boolean;
  sit_out_reason?: 'manual' | 'timeout' | 'disconnect' | 'admin';
  network_quality: 'good' | 'degraded' | 'poor' | 'disconnected';
  push_notification_available: boolean;
  device_type: 'mobile' | 'tablet' | 'desktop' | 'unknown';
}

/**
 * Bible V8 2.19: Security Objects
 * Integrity verification and observer controls.
 */
export interface HandIntegrity {
  hand_id: string;
  shuffle_seed_hash: string; // SHA-256 of shuffle seed (revealed post-hand)
  action_sequence_hash: string; // Rolling hash of all actions
  pot_verification_hash: string; // Hash of final pot distribution
  created_at: string;
}

export interface ObserverPermissions {
  can_view_board: boolean;
  can_view_pot: boolean;
  can_view_player_stacks: boolean;
  can_view_bet_amounts: boolean;
  can_view_player_cards: boolean; // Always false for non-showdown
  can_view_hand_history: boolean;
  can_chat: boolean;
  delay_seconds: number; // Observation delay (0 = real-time, 30 = standard delay)
}

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
