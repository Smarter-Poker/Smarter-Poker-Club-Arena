/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SMARTER POKER — Server-Side Types
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shared types for the server-side game engine.
 * Mirrors client types but standalone — NO imports from client code.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Card Types
// ─────────────────────────────────────────────────────────────────────────────

export type CardSuit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type CardRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  rank: CardRank;
  suit: CardSuit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Game Types
// ─────────────────────────────────────────────────────────────────────────────

export type HandStage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';
export type GameVariant =
  | 'nlh'
  | 'flh'
  | 'plo'
  | 'plo4'
  | 'plo5'
  | 'plo6'
  | 'plo_hilo'
  | 'plo8'
  | 'short_deck'
  | 'ofc'
  | 'ofc_pineapple';
export type TableStatus = 'waiting' | 'running' | 'paused' | 'closed';

// ─────────────────────────────────────────────────────────────────────────────
// Player Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SeatPlayer {
  seat: number;
  user_id: string;
  username: string;
  stack: number;
  bet: number;
  totalInvested: number;
  cards: Card[];
  is_folded: boolean;
  is_all_in: boolean;
  is_sitting_out: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TableInfo {
  id: string;
  club_id: string;
  small_blind: number;
  big_blind: number;
  game_variant: GameVariant;
  max_players: number;
  ante?: number;
  game_type?: string;
  tournament_id?: string;
  action_time_seconds?: number;
  time_bank_seconds?: number;
  /** Bible V8 §4.3: Big Blind Ante — BB posts ante for entire table */
  big_blind_ante_enabled?: boolean;
  /** Bible V8 §4.4: Straddle settings */
  straddle_enabled?: boolean;
  straddle_type?: 'utg' | 'mississippi';
  max_straddles?: number;
  /** Bible V8 §4.20: Run It Twice */
  run_it_twice_enabled?: boolean;
  /** Bible V8 §4.19: Insurance */
  insurance_enabled?: boolean;
  /** Bible V8 §4.21: Auto-muck losing hands at showdown */
  auto_muck_enabled?: boolean;
  /** Bible V8 §4.21: Allow players to voluntarily show hand */
  show_hand_enabled?: boolean;
  /** Bible V8 §6.3: Disconnect timeout in seconds */
  disconnect_timeout_seconds?: number;
  /** Bible V8 §1.7.6: Auto sit-out after N consecutive timeouts */
  max_consecutive_timeouts?: number;
  /** Bible V8 §1.7.4: Prefer check over fold on disconnect */
  prefer_check_over_fold?: boolean;
  /** Bible V8 §6.2: Time bank uses per session */
  time_bank_max_uses?: number;
}

export interface SeatedPlayer {
  user_id: string;
  username: string;
  stack: number;
  seat_number: number;
  is_horse: boolean;
  horse_profile?: string;
  time_bank_remaining?: number;
  time_bank_uses_remaining?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hand Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HandConfig {
  tableId: string;
  handNumber: number;
  gameVariant: GameVariant;
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  /** Bible V8 §4.3: Big Blind Ante — BB posts ante for entire table */
  bigBlindAnte?: boolean;
  /** Bible V8 §4.4: Straddle positions queued for this hand (UTG or Mississippi) */
  straddles?: { seat: number; amount: number }[];
  rakeConfig: RakeConfig;
  bombPot?: {
    anteMultiplier: number;
  };
}

export interface GameState {
  stage: HandStage;
  deck: any; // Internal Deck instance — not serialized to clients
  communityCards: Card[];
  pot: number;
  currentBet: number;
  lastRaise: number;
  minRaise: number;
  dealerSeat: number;
  currentPlayerSeat: number;
  players: SeatPlayer[];
  pots: Pot[];
  actionHistory: ActionRecord[];
  sawFlop: boolean;
}

export interface ActionRecord {
  seat: number;
  userId: string;
  action: ActionType;
  amount: number;
  timestamp: number;
  stage: HandStage;
  /** Bible V8 §4.14: Short all-in (less than a full raise) does NOT reopen betting */
  isFullRaise?: boolean;
}

export type HandEvent =
  | { type: 'HAND_START'; handNumber: number; players: SeatPlayer[] }
  | { type: 'CARDS_DEALT'; seat: number; cards: Card[] }
  | { type: 'COMMUNITY_CARDS'; stage: HandStage; cards: Card[] }
  | { type: 'PLAYER_ACTION'; seat: number; action: ActionType; amount: number }
  | { type: 'POT_UPDATE'; pot: number; pots: Pot[] }
  | { type: 'TURN_CHANGE'; seat: number; availableActions: ActionType[] }
  | { type: 'SHOWDOWN'; results: ShowdownResult[] }
  | { type: 'WINNERS'; winners: Winner[] }
  | { type: 'HAND_COMPLETE'; handNumber: number; rake: number };

export interface ShowdownResult {
  seat: number;
  userId: string;
  cards: Card[];
  hand: EvaluatedHand;
}

// ─────────────────────────────────────────────────────────────────────────────
// Poker Engine Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluatedHand {
  ranking: number;
  name: string;
  cards: Card[];
  kickers: number[];
}

export interface Pot {
  amount: number;
  eligiblePlayers: string[];
}

export interface BettingState {
  currentBet: number;
  minRaise: number;
  pot: number;
  toCall: number;
  /** Bible V8 §4.14: Max raise — Infinity for NL, pot+call for PL */
  maxRaise?: number;
}

export interface RakeConfig {
  percent: number;
  cap: number;
  noFlop: boolean;
}

export interface Winner {
  userId: string;
  amount: number;
  hand?: EvaluatedHand;
}

// ─────────────────────────────────────────────────────────────────────────────
// Horse AI Types
// ─────────────────────────────────────────────────────────────────────────────

export type HorseStyle = 'tag' | 'lag' | 'balanced' | 'tricky' | 'grinder';

export interface HorseDecision {
  action: ActionType;
  amount?: number;
  thinkTime: number;
}

/** @deprecated Use HorseDecision */
export type BotDecision = HorseDecision;

export interface HorseGameState {
  players: SeatPlayer[];
  communityCards: Card[];
  pot: number;
  currentBet: number;
  minRaise: number;
  stage: HandStage;
  gameVariant: string;
  bigBlind: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tournament Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
}

export interface PayoutEntry {
  place: number;
  percentage: number;
}

export type TournamentStatus =
  | 'ANNOUNCED'
  | 'REGISTERING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'LATE_REG';

// ─────────────────────────────────────────────────────────────────────────────
// Rake Distribution Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DealtInPlayer {
  userId: string;
  clubId: string;
  isSittingOut: boolean;
  hasCards: boolean;
  wentToFlop: boolean;
}
