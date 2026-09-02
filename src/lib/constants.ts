/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ POKER CONSTANTS — Game Rules & Configuration
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// GAME VARIANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const GAME_VARIANTS = {
  NLH: "No-Limit Hold'em",
  PLO4: 'Pot-Limit Omaha 4',
  PLO5: 'Pot-Limit Omaha 5',
  PLO6: 'Pot-Limit Omaha 6',
  SHORT_DECK: '6+ Short Deck',
  PINEAPPLE: 'Crazy Pineapple',
  STUD: 'Seven Card Stud',
  RAZZ: 'Razz',
  HORSE: 'H.O.R.S.E.',
} as const;

export type GameVariant = keyof typeof GAME_VARIANTS;

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE LIMITS
// ═══════════════════════════════════════════════════════════════════════════════

export const BETTING_TYPES = {
  NL: 'No-Limit',
  PL: 'Pot-Limit',
  FL: 'Fixed-Limit',
} as const;

export type BettingType = keyof typeof BETTING_TYPES;

// ═══════════════════════════════════════════════════════════════════════════════
// COMMON STAKES
// ═══════════════════════════════════════════════════════════════════════════════

export const COMMON_STAKES = [
  { sb: 0.01, bb: 0.02, label: 'Micro: 0.01/0.02' },
  { sb: 0.05, bb: 0.1, label: 'Micro: 0.05/0.10' },
  { sb: 0.1, bb: 0.25, label: 'Low: 0.10/0.25' },
  { sb: 0.25, bb: 0.5, label: 'Low: 0.25/0.50' },
  { sb: 0.5, bb: 1.0, label: 'Low: 0.50/1.00' },
  { sb: 1, bb: 2, label: 'Standard: 1/2' },
  { sb: 2, bb: 5, label: 'Standard: 2/5' },
  { sb: 5, bb: 10, label: 'Mid: 5/10' },
  { sb: 10, bb: 25, label: 'Mid: 10/25' },
  { sb: 25, bb: 50, label: 'High: 25/50' },
  { sb: 50, bb: 100, label: 'High: 50/100' },
  { sb: 100, bb: 200, label: 'Nosebleed: 100/200' },
  { sb: 200, bb: 400, label: 'Nosebleed: 200/400' },
  { sb: 500, bb: 1000, label: 'Nosebleed: 500/1000' },
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE SIZES
// ═══════════════════════════════════════════════════════════════════════════════

export const TABLE_SIZES = {
  HEADS_UP: 2,
  SHORT_HANDED: 6,
  FULL_RING: 9,
} as const;

export const MAX_PLAYERS_OPTIONS = [2, 4, 6, 8, 9] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// POSITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const POSITIONS = {
  BTN: 'Button',
  SB: 'Small Blind',
  BB: 'Big Blind',
  UTG: 'Under The Gun',
  UTG1: 'UTG+1',
  UTG2: 'UTG+2',
  MP: 'Middle Position',
  MP1: 'MP+1',
  HJ: 'Hijack',
  CO: 'Cutoff',
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// BETTING ROUNDS
// ═══════════════════════════════════════════════════════════════════════════════

export const BETTING_ROUNDS = {
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
} as const;

export type BettingRound = keyof typeof BETTING_ROUNDS;

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export const ACTIONS = {
  FOLD: 'fold',
  CHECK: 'check',
  CALL: 'call',
  BET: 'bet',
  RAISE: 'raise',
  ALL_IN: 'all-in',
} as const;

export type PokerAction = keyof typeof ACTIONS;

// ═══════════════════════════════════════════════════════════════════════════════
// HAND RANKINGS
// ═══════════════════════════════════════════════════════════════════════════════

export const HAND_RANKING_NAMES = [
  'High Card',
  'Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
  'Royal Flush',
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export const TOURNAMENT_TYPES = {
  FREEZEOUT: 'Freezeout',
  REBUY: 'Rebuy',
  BOUNTY: 'Bounty',
  PKO: 'Progressive Knockout',
  SATELLITE: 'Satellite',
  SPIN_AND_GO: 'Spin & Go',
  SHOOTOUT: 'Shootout',
  HEADS_UP: 'Heads Up',
} as const;

export const TOURNAMENT_SPEEDS = {
  TURBO: { name: 'Turbo', levelDuration: 3, blindIncreasePercent: 25 },
  HYPER: { name: 'Hyper Turbo', levelDuration: 2, blindIncreasePercent: 33 },
  REGULAR: { name: 'Regular', levelDuration: 10, blindIncreasePercent: 20 },
  DEEP: { name: 'Deep Stack', levelDuration: 15, blindIncreasePercent: 15 },
  SLOW: { name: 'Slow', levelDuration: 20, blindIncreasePercent: 12 },
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// VIP LEVELS
// ═══════════════════════════════════════════════════════════════════════════════

export const VIP_LEVELS = {
  BRONZE: { name: 'Bronze', minPoints: 0, rakeback: 5 },
  SILVER: { name: 'Silver', minPoints: 1000, rakeback: 10 },
  GOLD: { name: 'Gold', minPoints: 5000, rakeback: 15 },
  PLATINUM: { name: 'Platinum', minPoints: 15000, rakeback: 20 },
  DIAMOND: { name: 'Diamond', minPoints: 50000, rakeback: 30 },
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT ROLES
// ═══════════════════════════════════════════════════════════════════════════════

export const AGENT_ROLES = {
  SUPER_AGENT: 'super_agent',
  AGENT: 'agent',
  SUB_AGENT: 'sub_agent',
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// MEMBER ROLES
// ═══════════════════════════════════════════════════════════════════════════════

export const MEMBER_ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  AGENT: 'agent',
  MEMBER: 'member',
} as const;

export type MemberRole = keyof typeof MEMBER_ROLES;

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/* DEFAULT_TABLE_CONFIG removed 2026-08-25. Exported, never imported, and every
   key in it had a real owner elsewhere that disagreed with it: buy-in bounds
   come from the table row, run-it-twice and rabbit hunt from the `run_it_twice`
   and `allow_rabbit_hunt` columns, the time bank from fn_consume_time_bank,
   straddle from `straddle_enabled`. A defaults object nothing reads is worse
   than none: the next person to find it reasonably assumes it is authoritative
   and edits it expecting something to change. */

export const DEFAULT_RAKE_CONFIG = {
  percent: 5,
  cap: 3,
  noFlop: true, // No flop, no drop
  minPotForRake: 5,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY LIMITS — Supabase .limit() values for different query categories
// Centralised so pagination limits can be tuned globally.
// ═══════════════════════════════════════════════════════════════════════════════

export const QUERY_LIMITS = {
  /** Feeds, lists, recent items (default) */
  LIST: 200,
  /** Moderate-size queries: members, agents, achievements */
  MODERATE: 500,
  /** Large page/dashboard data loads */
  LARGE: 1_000,
  /** Bulk operations: settlements, leaderboards, member rosters */
  BULK: 5_000,
  /** Full aggregations: rake history, player snapshots */
  AGGREGATE: 10_000,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURED CLUBS — Well-known club numeric IDs
// ═══════════════════════════════════════════════════════════════════════════════

/** Shark Club — the platform's featured/demo club displayed on the home carousel */
export const SHARK_CLUB_ID = 25450;
