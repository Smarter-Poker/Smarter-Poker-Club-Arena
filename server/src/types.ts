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

// FIX 120: Added 'pineapple_discard' stage for Crazy Pineapple (discard after flop)
export type HandStage = 'preflop' | 'flop' | 'pineapple_discard' | 'turn' | 'river' | 'showdown';
// FIX 120: Added 'discard' action for Crazy Pineapple
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in' | 'discard';
// FIX 116: Dead variants removed (flh, plo, plo_hilo, mixed) — Dan's 9 approved variants only
export type GameVariant =
  | 'nlh'
  | 'plo4'
  | 'plo5'
  | 'plo6'
  | 'plo8'
  | 'pineapple'
  | 'short_deck'
  | 'ofc'
  | 'ofc_pineapple';
/** Bible V8 §3.1: Full table state machine states */
export type TableStatus =
  | 'empty'
  | 'waiting'
  | 'seating'
  | 'running'
  | 'paused'
  | 'closing'
  | 'closed';

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
  /** Bible V8 §2.3: Added in broadcast — true when heartbeat missed */
  is_disconnected?: boolean;
  /** Bible V8 §2.3: Seconds remaining in time bank pool */
  time_bank_remaining?: number;
  /** Bible V8 §2.3: Number of time bank activations left this session */
  time_bank_uses_remaining?: number;
  /** Bible V8 §2.3: Position label (BTN, SB, BB, UTG, MP, CO, HJ, etc.) */
  position?: string;
  /** Bible V8 §2.3: Player avatar URL */
  avatar_url?: string;
  /** Bible V8 §2.3: Whether this player is an AI horse */
  is_horse?: boolean;
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
  straddle_type?: 'utg'; // FIX 114: Only UTG straddle allowed (2x BB)
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
  /** Bible V8 §6.2: Whether time bank feature is enabled */
  time_bank_enabled?: boolean;
  /** Bible V8 §4.3: Whether ante is enabled */
  ante_enabled?: boolean;
  /** Bible V8 §4.22: Whether bomb pots are enabled */
  bomb_pot_enabled?: boolean;
  /** Bible V8 §4.22: Bomb pot frequency — every N hands */
  bomb_pot_frequency?: number;
  /** Bible V8 §4.22: Bomb pot ante multiplier (× BB) */
  bomb_pot_ante_multiplier?: number;
  /** Bible V8 §2.1: Minimum players to start a hand */
  min_players?: number;
  /** Bible V8 §2.1: Table display name */
  name?: string;
  /** FIX 104: Mixed game preset name (e.g., 'HOLDEM_OMAHA') */
  mixed_game_preset?: string;
  /** FIX 104: Hands per variant before rotation */
  mixed_game_hands_per_variant?: number;
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
  /** Bible V8 §2.3: Player avatar for broadcast */
  avatar_url?: string;
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
  /** Bible V8 §4.4 / FIX 114: UTG straddle only (2× BB) */
  straddles?: { seat: number; amount: number }[];
  rakeConfig: RakeConfig;
  bombPot?: {
    anteMultiplier: number;
  };
  /** Bible V8 §2.8 / §4.20: Whether Run It Twice is enabled for this hand */
  ritEnabled?: boolean;
  /** Bible V8 §2.8 / §4.19: Whether Insurance is enabled for this hand */
  insuranceEnabled?: boolean;
  /** Bible V8 §1.9 / Appendix A: BBJ config for this hand */
  bbjConfig?: {
    /** Whether BBJ is enabled for this variant */
    enabled: boolean;
    /** BBJ fee in BB units (e.g., 0.25 means 0.25 × BB per qualifying hand) */
    feeBB: number;
    /** Minimum pot in BB for BBJ eligibility */
    minPotBB: number;
    /** Minimum players dealt in for BBJ eligibility */
    minPlayersDealt: number;
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

/**
 * Bible V8 §2.4 — Hand State Broadcast Payload
 * This is the shape of the object broadcast to all clients via Supabase Realtime.
 * The server constructs this in broadcastCurrentState() and getTableState().
 */
export interface HandStateBroadcast {
  table_id: string;
  hand_number: number;
  pot: number;
  community_cards: Card[];
  current_bet: number;
  current_player: string; // user_id of player whose turn it is
  dealer_seat: number;
  stage: HandStage;
  min_raise: number;
  last_raise: number;
  /** Bible V8 §6.1: Absolute timestamp (ms) when the current turn started */
  turn_start_time_ms: number;
  /** Bible V8 §6.1: Total turn duration in ms (action_time_seconds × 1000) */
  turn_duration_ms: number;
  players: SeatPlayer[];
  pots: Pot[];
  action_history: ActionRecord[];
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
  | { type: 'ALL_IN_RUNOUT'; board: Card[]; pot: number; players: SeatPlayer[] }
  | { type: 'PINEAPPLE_DISCARD_REQUIRED'; seats: number[] } // FIX 120: Crazy Pineapple
  | { type: 'SHOWDOWN'; results: ShowdownResult[] }
  | { type: 'WINNERS'; winners: Winner[] }
  | { type: 'HAND_COMPLETE'; handNumber: number; rake: number; bbjFee: number };

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
  /** Bible V8 §2.9 / Appendix A: No rake if hand doesn't reach flop */
  noFlopNoDrop: boolean;
  /** Bible V8 §2.9: Rake caps by player count — e.g. [{players: 2, cap: 100}, {players: 5, cap: 200}] */
  playerCountCaps?: { players: number; cap: number }[];
  /** Bible V8 §2.9: Alternative timed rake (rake per time period instead of per pot) */
  timedRake?: { amountPerMinute: number };
}

export interface Winner {
  userId: string;
  amount: number;
  /** Bible V8 §2.7: Which pot (0 = main, 1+ = side pots) this win came from */
  potIndex?: number;
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
