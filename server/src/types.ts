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
