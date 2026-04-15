/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * mapEngineSnapshot — Engine snapshot → TablePage tableState shape
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The Hetzner engine publishes state in the shape defined by
 * ServerTableEngine.broadcastCurrentState(): a flat object keyed by
 * table_id, pot, current_player (user_id), stage, dealer_seat,
 * action_history[], players[], etc.
 *
 * TablePage.tsx keeps local state in `tableState` shaped for rendering:
 * per-seat arrays indexed by (seatNumber - 1), pot, communityCards,
 * boardStage enum, currentPlayerSeat (number, not user_id), etc.
 *
 * This module is the single place that translates between the two. Keeping
 * it out of TablePage.tsx means the 5000-line page doesn't grow further and
 * the mapping is directly unit-testable.
 */

import type { EngineSnapshot } from '../services/EngineStateClient';

// ─── Raw payload type (duplicated here, not imported, so a server shape tweak
// can't silently break the client at runtime; typos surface at compile time).
export interface EnginePublicPlayer {
  seat: number;
  user_id: string;
  username?: string;
  stack: number;
  bet?: number;
  totalInvested?: number;
  cards?: Array<{ rank: string; suit: string }>;
  is_folded?: boolean;
  is_all_in?: boolean;
  is_sitting_out?: boolean;
  is_disconnected?: boolean;
  time_bank_remaining?: number;
  time_bank_uses_remaining?: number;
  position?: string;
  avatar_url?: string;
  is_horse?: boolean;
  hand_name?: string;
}

export interface EngineActionRecord {
  seat: number;
  userId: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';
  amount: number;
  timestamp: number;
  stage: string;
}

export type DisconnectFsmState = 'CONNECTED' | 'MISSING' | 'DISCONNECTED' | 'SAT_OUT';

export interface DisconnectFsmEntry {
  state: DisconnectFsmState;
  sinceMs: number;
  graceDeadlineMs: number | null;
}

export interface EnginePublishedState {
  table_id: string;
  hand_number: number;
  pot: number;
  community_cards: Array<{ rank: string; suit: string }>;
  current_bet: number;
  current_player: string | null; // user_id
  dealer_seat: number;
  stage: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'waiting';
  winner_ids?: string[];
  winners?: Array<{ user_id: string; amount: number }>;
  min_raise: number;
  last_raise: number;
  turn_start_time_ms?: number;
  turn_duration_ms?: number;
  /** Phase 1.2 PR-F: absolute wall-clock deadline for the current turn. */
  turn_deadline_ms?: number;
  /** Phase 1.2 PR-F: per-user disconnect FSM map for client UI. */
  disconnect_states?: Record<string, DisconnectFsmEntry>;
  pots: Array<{ amount: number; eligible: number[] }>;
  action_history: EngineActionRecord[];
  players: EnginePublicPlayer[];
}

// ─── Output: the fields we patch into TableState. Keeping this type open-ended
// (Partial<unknown>-shape) avoids importing the 20-field TableState type here.
export interface MappedTableStatePatch {
  pot: number;
  communityCards: Array<{ rank: string; suit: string }>;
  boardStage: string; // matches TableState['boardStage']
  dealerSeat: number;
  currentPlayerSeat: number;
  /** Per-seat last action (length maxPlayers, index = seat-1). */
  lastActions: Array<string | null>;
  /** Per-seat last bet amount (length maxPlayers, index = seat-1). */
  lastBetAmounts: number[];
  /** Per-seat position label ('BTN', 'SB', etc.) or null. */
  positions: Array<string | null>;
  /** Per-seat SeatPlayer-shape or null. */
  players: Array<{
    id: string;
    name: string;
    avatar?: string;
    stack: number;
    status: 'active' | 'folded' | 'all_in' | 'sitting_out' | 'away' | 'disconnected';
    holeCards?: Array<{ rank: string; suit: string }>;
    showCards: boolean;
    isHero: boolean;
  } | null>;
  /** Current bet for action panel. */
  currentBet: number;
  minRaise: number;
  lastRaise: number;
  /** For action timer. */
  actionTimerDeadline?: number;
  /** Server-authoritative turn start wall-clock (for CSS ring animation). */
  actionTimerStartTime?: number;
  actionTimerPlayerId?: string;
  /** hand number */
  handNumber: number;
  /** side pots */
  sidePots: Array<{ amount: number; eligibleSeats: number[] }>;
  /** Phase 1.2 PR-F: per-user disconnect FSM map for client toasts. */
  disconnectStates: Record<string, DisconnectFsmEntry>;
  /**
   * Phase 2 T1-01: winners of the current hand with net profit (winnings
   * minus their own contribution). Empty until stage === 'showdown' OR
   * end-of-hand broadcast. Drives the signature PokerBros +N yellow
   * floating text above each winner.
   */
  winners: Array<{ userId: string; seat: number; amount: number; netAmount: number }>;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

const STATUS_FROM_PLAYER = (
  p: EnginePublicPlayer
): MappedTableStatePatch['players'][number] extends infer _ | null
  ? NonNullable<MappedTableStatePatch['players'][number]>['status']
  : never => {
  if (p.is_folded) return 'folded';
  if (p.is_all_in) return 'all_in';
  if (p.is_sitting_out) return 'sitting_out';
  if (p.is_disconnected) return 'disconnected';
  return 'active';
};

/**
 * Compute the most recent action + amount for each seat, considering the
 * action history for the current hand only. Returns two arrays indexed by
 * seatNumber-1 (length maxPlayers).
 */
function derivePerSeatLastAction(
  actionHistory: EngineActionRecord[],
  maxSeats: number
): { lastActions: Array<string | null>; lastBetAmounts: number[] } {
  const lastActions: Array<string | null> = Array(maxSeats).fill(null);
  const lastBetAmounts: number[] = Array(maxSeats).fill(0);
  for (const a of actionHistory) {
    const idx = a.seat - 1;
    if (idx < 0 || idx >= maxSeats) continue;
    lastActions[idx] = a.action;
    if (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in') {
      lastBetAmounts[idx] = a.amount;
    } else if (a.action === 'call') {
      lastBetAmounts[idx] = a.amount;
    } else {
      // fold / check — retain 0
      lastBetAmounts[idx] = 0;
    }
  }
  return { lastActions, lastBetAmounts };
}

export function mapEngineSnapshot(
  raw: EngineSnapshot,
  heroUserId: string,
  maxSeats: number
): MappedTableStatePatch {
  const s = raw as unknown as EnginePublishedState;

  // Current player: engine emits a user_id; tableState stores a seat number.
  let currentPlayerSeat = 0;
  if (s.current_player) {
    const cp = s.players.find((p) => p.user_id === s.current_player);
    if (cp) currentPlayerSeat = cp.seat;
  }

  // Per-seat mapping: players array indexed by seat-1.
  const players: MappedTableStatePatch['players'] = Array(maxSeats).fill(null);
  const positions: Array<string | null> = Array(maxSeats).fill(null);
  for (const p of s.players) {
    const idx = p.seat - 1;
    if (idx < 0 || idx >= maxSeats) continue;
    players[idx] = {
      id: p.user_id,
      name: p.username ?? '',
      avatar: p.avatar_url,
      stack: p.stack,
      status: STATUS_FROM_PLAYER(p),
      holeCards: p.cards && p.cards.length > 0 ? p.cards : undefined,
      showCards: !!(p.cards && p.cards.length > 0 && p.user_id !== heroUserId),
      isHero: p.user_id === heroUserId,
    };
    positions[idx] = p.position ?? null;
  }

  const { lastActions, lastBetAmounts } = derivePerSeatLastAction(
    s.action_history ?? [],
    maxSeats
  );

  const sidePots = (s.pots ?? []).map((p) => ({
    amount: p.amount,
    eligibleSeats: p.eligible ?? [],
  }));

  // Action timer deadline.
  // Phase 1.2 PR-F: prefer the authoritative turn_deadline_ms from the
  // engine. Fall back to start+duration for backward compat with older
  // server builds (will be removed in PR-G once the engine is fully
  // upgraded and Phase 1.1 soak completes).
  let actionTimerDeadline: number | undefined;
  if (s.turn_deadline_ms && s.turn_deadline_ms > 0) {
    actionTimerDeadline = s.turn_deadline_ms;
  } else if (s.turn_start_time_ms && s.turn_duration_ms) {
    actionTimerDeadline = s.turn_start_time_ms + s.turn_duration_ms;
  }

  return {
    pot: s.pot ?? 0,
    communityCards: s.community_cards ?? [],
    boardStage: s.stage ?? 'preflop',
    dealerSeat: s.dealer_seat ?? 0,
    currentPlayerSeat,
    lastActions,
    lastBetAmounts,
    positions,
    players,
    currentBet: s.current_bet ?? 0,
    minRaise: s.min_raise ?? 0,
    lastRaise: s.last_raise ?? 0,
    actionTimerDeadline,
    actionTimerStartTime: s.turn_start_time_ms,
    actionTimerPlayerId: s.current_player ?? undefined,
    handNumber: s.hand_number ?? 0,
    sidePots,
    disconnectStates: s.disconnect_states ?? {},
    // Phase 2 T1-01: winners with net amount. Server emits winners[] with
    // total pot received per winner. We look up the player's totalInvested
    // to compute net profit (what the client wants to show as "+N").
    winners: (s.winners ?? []).map((w) => {
      const p = s.players.find((pp) => pp.user_id === w.user_id);
      const invested = p?.totalInvested ?? 0;
      return {
        userId: w.user_id,
        seat: p?.seat ?? 0,
        amount: w.amount,
        netAmount: Math.max(0, w.amount - invested),
      };
    }),
  };
}
