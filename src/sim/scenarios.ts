/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLIENT SIM — SCENARIOS
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pre-scripted hand snapshots. Each scenario is a list of "steps" — snapshots
 * of the authoritative engine state at a specific moment. The SimPage plays
 * them back with Prev / Next / Auto-advance controls.
 *
 * Step state matches the SimViewState shape, which is the subset of
 * TableState that drives SeatSlot, CommunityCards, and PotDisplay.
 */

import type { SeatPlayer, PositionBadge, LastAction, Card } from '../components/table/SeatSlot';

export interface SimStep {
  /** One-line description of what just happened. Shown in the event log. */
  label: string;
  /** Which emitted server event this step represents. */
  event:
    | 'HAND_STARTED'
    | 'BLINDS_POSTED'
    | 'HOLE_CARDS_DEALT'
    | 'TURN_CHANGE'
    | 'PLAYER_ACTION'
    | 'COMMUNITY_CARDS_DEALT'
    | 'POT_UPDATE'
    | 'SHOWDOWN'
    | 'POT_WIN'
    | 'HAND_COMPLETE';
  state: SimViewState;
  /** Optional assertion text — what the UI SHOULD show at this step. */
  expect?: string;
}

export interface SimViewState {
  handNumber: number;
  boardStage: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  communityCards: Card[];
  pot: number;
  players: (SeatPlayer | null)[];
  positions: PositionBadge[];
  lastActions: LastAction[];
  lastBetAmounts: number[];
  currentPlayerSeat: number;
  dealerSeat: number;
  currentBet: number;
  heroSeat: number;
  winnerIds: string[];
  winningHandName: string;
  maxPlayers: number;
  blinds: string;
}

export interface Scenario {
  id: string;
  name: string;
  bug?: string;
  description: string;
  steps: SimStep[];
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers — keep scenarios readable.
// ─────────────────────────────────────────────────────────────────────────

function p(
  seat: number,
  name: string,
  stack: number,
  opts: {
    isHero?: boolean;
    status?: SeatPlayer['status'];
    holeCards?: Card[];
  } = {}
): SeatPlayer {
  return {
    id: `seat-${seat}`,
    name,
    avatar: undefined,
    stack,
    status: opts.status ?? 'active',
    holeCards: opts.holeCards,
    showCards: !!opts.holeCards && !opts.isHero,
    isHero: !!opts.isHero,
  } as SeatPlayer;
}

function card(rank: Card['rank'], suit: Card['suit']): Card {
  return { rank, suit };
}

const EMPTY_SLOTS = Array<null>(6).fill(null);

// Four seated players for a 6-max NLH 1/2 hand. Hero at seat 3 (BB).
const BASE_PLAYERS = (): (SeatPlayer | null)[] => [
  p(1, 'Cornhusker', 200),
  p(2, 'Jester', 200),
  p(3, 'TestAlias99', 200, { isHero: true }),
  p(4, 'Lockdown', 200),
  null,
  null,
];

const BASE_POSITIONS = (): PositionBadge[] => ['BTN', 'SB', 'BB', 'UTG', null, null];

function cloneState(s: SimViewState, patch: Partial<SimViewState>): SimViewState {
  return {
    ...s,
    ...patch,
    // Deep-clone arrays that steps mutate on a per-step basis.
    players: patch.players ?? s.players.map((p) => (p ? { ...p } : null)),
    positions: patch.positions ?? [...s.positions],
    lastActions: patch.lastActions ?? [...s.lastActions],
    lastBetAmounts: patch.lastBetAmounts ?? [...s.lastBetAmounts],
    communityCards: patch.communityCards ?? [...s.communityCards],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 01 — Normal hand, 4 players, preflop limp → flop bet → turn
// bet + fold. Baseline sanity check.
// ─────────────────────────────────────────────────────────────────────────

const s01: SimViewState = {
  handNumber: 1,
  boardStage: 'preflop',
  communityCards: [],
  pot: 3, // SB 1 + BB 2
  players: BASE_PLAYERS(),
  positions: BASE_POSITIONS(),
  lastActions: [null, null, null, null, null, null],
  lastBetAmounts: [0, 1, 2, 0, 0, 0], // blinds visible in front of SB/BB seats
  currentPlayerSeat: 4, // UTG acts first
  dealerSeat: 1,
  currentBet: 2,
  heroSeat: 3,
  winnerIds: [],
  winningHandName: '',
  maxPlayers: 6,
  blinds: '1/2',
};

export const scenario01: Scenario = {
  id: 'scenario-01',
  name: '01 — Normal hand (baseline)',
  description: '4 players, limp preflop, bet/fold turn. Sanity check for the sim itself.',
  steps: [
    {
      label: 'Hand started — blinds posted, hole cards dealt',
      event: 'HAND_STARTED',
      state: cloneState(s01, {
        players: [
          p(1, 'Cornhusker', 200),
          p(2, 'Jester', 199), // SB posted
          p(3, 'TestAlias99', 198, { isHero: true, holeCards: [card('Q', 's'), card('J', 'd')] }),
          p(4, 'Lockdown', 200),
          null,
          null,
        ],
      }),
      expect: 'Pot shows 3. SB (seat 2) chip in front = 1. BB (seat 3) chip in front = 2.',
    },
    {
      label: 'UTG (seat 4) calls 2',
      event: 'PLAYER_ACTION',
      state: cloneState(s01, {
        players: [
          p(1, 'Cornhusker', 200),
          p(2, 'Jester', 199),
          p(3, 'TestAlias99', 198, { isHero: true, holeCards: [card('Q', 's'), card('J', 'd')] }),
          p(4, 'Lockdown', 198),
          null,
          null,
        ],
        pot: 5,
        lastActions: [null, null, null, 'call', null, null],
        lastBetAmounts: [0, 1, 2, 2, 0, 0],
        currentPlayerSeat: 1,
      }),
    },
    {
      label: 'BTN (seat 1) calls 2',
      event: 'PLAYER_ACTION',
      state: cloneState(s01, {
        players: [
          p(1, 'Cornhusker', 198),
          p(2, 'Jester', 199),
          p(3, 'TestAlias99', 198, { isHero: true, holeCards: [card('Q', 's'), card('J', 'd')] }),
          p(4, 'Lockdown', 198),
          null,
          null,
        ],
        pot: 7,
        lastActions: [null, null, null, 'call', null, null].map((a, i) =>
          i === 0 ? 'call' : a
        ) as LastAction[],
        lastBetAmounts: [2, 1, 2, 2, 0, 0],
        currentPlayerSeat: 2,
      }),
    },
    {
      label: 'SB (seat 2) completes — calls 1 more',
      event: 'PLAYER_ACTION',
      state: cloneState(s01, {
        players: [
          p(1, 'Cornhusker', 198),
          p(2, 'Jester', 198),
          p(3, 'TestAlias99', 198, { isHero: true, holeCards: [card('Q', 's'), card('J', 'd')] }),
          p(4, 'Lockdown', 198),
          null,
          null,
        ],
        pot: 8,
        lastActions: ['call', 'call', null, 'call', null, null],
        lastBetAmounts: [2, 2, 2, 2, 0, 0],
        currentPlayerSeat: 3,
      }),
    },
    {
      label: 'BB (hero seat 3) checks',
      event: 'PLAYER_ACTION',
      state: cloneState(s01, {
        pot: 8,
        lastActions: ['call', 'call', 'check', 'call', null, null],
        lastBetAmounts: [2, 2, 2, 2, 0, 0],
        currentPlayerSeat: 2, // Flop starts — SB first to act
      }),
    },
    {
      label: 'Flop dealt — chips collected into pot',
      event: 'COMMUNITY_CARDS_DEALT',
      state: cloneState(s01, {
        boardStage: 'flop',
        communityCards: [card('2', 'd'), card('6', 'c'), card('9', 's')],
        pot: 8,
        lastActions: [null, null, null, null, null, null],
        lastBetAmounts: [0, 0, 0, 0, 0, 0], // swept to pot
        currentPlayerSeat: 2,
        currentBet: 0,
      }),
      expect: 'Board shows 3 cards. All per-seat chip stacks cleared. Pot = 8.',
    },
    {
      label: 'SB (seat 2) bets 5',
      event: 'PLAYER_ACTION',
      state: cloneState(s01, {
        boardStage: 'flop',
        communityCards: [card('2', 'd'), card('6', 'c'), card('9', 's')],
        players: [
          p(1, 'Cornhusker', 198),
          p(2, 'Jester', 193),
          p(3, 'TestAlias99', 198, { isHero: true, holeCards: [card('Q', 's'), card('J', 'd')] }),
          p(4, 'Lockdown', 198),
          null,
          null,
        ],
        pot: 13,
        lastActions: [null, 'bet', null, null, null, null],
        lastBetAmounts: [0, 5, 0, 0, 0, 0],
        currentPlayerSeat: 3,
        currentBet: 5,
      }),
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 02 — BUG 029: turn bet must clear on river.
// ─────────────────────────────────────────────────────────────────────────

export const scenario02: Scenario = {
  id: 'scenario-02',
  name: '02 — BUG 029: turn bet clears on river',
  bug: 'BUG 029',
  description:
    'Seat 1 bets 20 on turn, seat 2 calls. River is dealt. The bet-chip in front of both seats MUST disappear. Before the mapEngineSnapshot street-filter fix, those chips persisted.',
  steps: [
    {
      label: 'State at end of turn — seat1 bet 20, seat2 called',
      event: 'PLAYER_ACTION',
      state: {
        handNumber: 7,
        boardStage: 'turn',
        communityCards: [card('2', 'd'), card('6', 'c'), card('9', 's'), card('K', 'h')],
        pot: 48,
        players: [
          p(1, 'Cornhusker', 150),
          p(2, 'Jester', 150, { isHero: true, holeCards: [card('A', 'h'), card('A', 's')] }),
          p(3, 'TestAlias99', 180),
          p(4, 'Lockdown', 180),
          null,
          null,
        ],
        positions: ['BTN', 'SB', 'BB', 'UTG', null, null],
        lastActions: ['call', 'bet', null, null, null, null],
        lastBetAmounts: [20, 20, 0, 0, 0, 0],
        currentPlayerSeat: 0,
        dealerSeat: 1,
        currentBet: 20,
        heroSeat: 2,
        winnerIds: [],
        winningHandName: '',
        maxPlayers: 6,
        blinds: '1/2',
      },
      expect: 'Both seats show bet-20 chip in front. Pot = 48.',
    },
    {
      label: 'River dealt — street advanced (BUG 029: chips must clear)',
      event: 'COMMUNITY_CARDS_DEALT',
      state: {
        handNumber: 7,
        boardStage: 'river',
        communityCards: [
          card('2', 'd'),
          card('6', 'c'),
          card('9', 's'),
          card('K', 'h'),
          card('4', 's'),
        ],
        pot: 48,
        players: [
          p(1, 'Cornhusker', 150),
          p(2, 'Jester', 150, { isHero: true, holeCards: [card('A', 'h'), card('A', 's')] }),
          p(3, 'TestAlias99', 180),
          p(4, 'Lockdown', 180),
          null,
          null,
        ],
        positions: ['BTN', 'SB', 'BB', 'UTG', null, null],
        lastActions: [null, null, null, null, null, null], // cleared by fix
        lastBetAmounts: [0, 0, 0, 0, 0, 0], // cleared by fix
        currentPlayerSeat: 2, // hero SB acts first on river
        dealerSeat: 1,
        currentBet: 0,
        heroSeat: 2,
        winnerIds: [],
        winningHandName: '',
        maxPlayers: 6,
        blinds: '1/2',
      },
      expect:
        'Both bet chips GONE from seats 1 and 2. Board shows 5 cards. Hero (seat 2) is active (highlighted).',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 03 — BUG 030: winner hand-strength label must not bleed into
// the next hand when cycle faster than 3s.
// ─────────────────────────────────────────────────────────────────────────

export const scenario03: Scenario = {
  id: 'scenario-03',
  name: '03 — BUG 030: "Three of a Kind" cleared on new hand',
  bug: 'BUG 030',
  description:
    'Previous hand ended with Lockdown winning with Three of a Kind. Next hand starts in under 3 seconds. The floating "Three of a Kind" label MUST be gone before the next hand renders its pot and hole cards.',
  steps: [
    {
      label: 'Hand #7 complete — Lockdown wins with Three of a Kind',
      event: 'HAND_COMPLETE',
      state: {
        handNumber: 7,
        boardStage: 'showdown',
        communityCards: [
          card('2', 'd'),
          card('6', 'c'),
          card('9', 's'),
          card('2', 'h'),
          card('5', 's'),
        ],
        pot: 0,
        players: [
          p(1, 'Cornhusker', 154),
          p(2, 'Jester', 23),
          p(3, 'TestAlias99', 178, { isHero: true, holeCards: [card('Q', 's'), card('T', 'h')] }),
          p(4, 'Lockdown', 362),
          null,
          null,
        ],
        positions: ['BB', 'SB', 'BTN', 'UTG', null, null],
        lastActions: ['check', 'check', 'check', 'check', null, null],
        lastBetAmounts: [0, 0, 0, 0, 0, 0],
        currentPlayerSeat: 0,
        dealerSeat: 3,
        currentBet: 0,
        heroSeat: 3,
        winnerIds: ['seat-4'],
        winningHandName: 'Three of a Kind',
        maxPlayers: 6,
        blinds: '1/2',
      },
      expect:
        '"Three of a Kind" hand-strength label visible in center of board. Lockdown (seat 4) highlighted.',
    },
    {
      label: 'Hand #8 starts < 3s later — stale label MUST be gone',
      event: 'HAND_STARTED',
      state: {
        handNumber: 8,
        boardStage: 'preflop',
        communityCards: [],
        pot: 3,
        players: [
          p(1, 'Cornhusker', 153),
          p(2, 'Jester', 21),
          p(3, 'TestAlias99', 178, { isHero: true, holeCards: [card('A', 'c'), card('K', 'c')] }),
          p(4, 'Lockdown', 362),
          null,
          null,
        ],
        positions: ['SB', 'BB', 'UTG', 'BTN', null, null],
        lastActions: [null, null, null, null, null, null],
        lastBetAmounts: [1, 2, 0, 0, 0, 0],
        currentPlayerSeat: 3,
        dealerSeat: 4,
        currentBet: 2,
        heroSeat: 3,
        winnerIds: [], // cleared by BUG 030 fix
        winningHandName: '', // cleared by BUG 030 fix
        maxPlayers: 6,
        blinds: '1/2',
      },
      expect:
        'NO hand-strength label anywhere. Fresh preflop state. Hero seat 3 = UTG = first to act.',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 04 — Blinds must appear in pot in the SAME snapshot that shows
// the stacks decremented.
// ─────────────────────────────────────────────────────────────────────────

export const scenario04: Scenario = {
  id: 'scenario-04',
  name: '04 — BUG 031: blinds-to-pot atomicity',
  bug: 'BUG 031',
  description:
    'User reported: SB/BB taken from stacks but pot showed 0. Snapshot must be atomic — the SB + BB amounts must be in pot in the SAME tick that shows the stacks reduced.',
  steps: [
    {
      label: 'Hand start — pre-blinds (freshly dealt)',
      event: 'HAND_STARTED',
      state: {
        handNumber: 10,
        boardStage: 'preflop',
        communityCards: [],
        pot: 0,
        players: [
          p(1, 'Cornhusker', 200),
          p(2, 'Jester', 200),
          p(3, 'TestAlias99', 200, { isHero: true }),
          p(4, 'Lockdown', 200),
          null,
          null,
        ],
        positions: ['BTN', 'SB', 'BB', 'UTG', null, null],
        lastActions: [null, null, null, null, null, null],
        lastBetAmounts: [0, 0, 0, 0, 0, 0],
        currentPlayerSeat: 0,
        dealerSeat: 1,
        currentBet: 0,
        heroSeat: 3,
        winnerIds: [],
        winningHandName: '',
        maxPlayers: 6,
        blinds: '1/2',
      },
    },
    {
      label: 'Blinds posted — stacks AND pot both update atomically',
      event: 'BLINDS_POSTED',
      state: {
        handNumber: 10,
        boardStage: 'preflop',
        communityCards: [],
        pot: 3, // must be 3, not 0
        players: [
          p(1, 'Cornhusker', 200),
          p(2, 'Jester', 199), // SB -1
          p(3, 'TestAlias99', 198, { isHero: true, holeCards: [card('7', 'd'), card('2', 'h')] }), // BB -2
          p(4, 'Lockdown', 200),
          null,
          null,
        ],
        positions: ['BTN', 'SB', 'BB', 'UTG', null, null],
        lastActions: [null, null, null, null, null, null],
        lastBetAmounts: [0, 1, 2, 0, 0, 0],
        currentPlayerSeat: 4,
        dealerSeat: 1,
        currentBet: 2,
        heroSeat: 3,
        winnerIds: [],
        winningHandName: '',
        maxPlayers: 6,
        blinds: '1/2',
      },
      expect: 'Pot = 3 in the SAME snapshot SB is 199 and BB is 198. Never a 0-pot frame.',
    },
  ],
};

export const ALL_SCENARIOS: Scenario[] = [scenario01, scenario02, scenario03, scenario04];
