import { afterEach, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import * as preflop from './HorseTournamentPreflop.js';
import * as icm from './IcmModel.js';
import * as certified from './GtoPostflopV31.js';
import { gtoV31Position } from './GtoDecisionContext.js';
import type { SeatPlayer } from '../types.js';

afterEach(() => vi.restoreAllMocks());

function state(): HorseGameStateV2 {
  const players = [1, 2, 3, 4].map((seat) => ({
    seat,
    user_id: `tournament-${seat}`,
    username: `Horse ${seat}`,
    stack: seat === 1 ? 8000 : seat === 2 ? 8000 : seat === 3 ? 6000 : 1500,
    bet: 0,
    totalInvested: seat === 1 ? 2000 : 0,
    cards:
      seat === 1
        ? [
            { rank: 'A', suit: 'spades' },
            { rank: 'K', suit: 'hearts' },
          ]
        : [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  })) as SeatPlayer[];
  return {
    players,
    dealtSeatIds: [1, 2, 3, 4],
    heroSeat: 1,
    communityCards: [],
    pot: 2000,
    currentBet: 100,
    minRaise: 100,
    stage: 'preflop',
    gameVariant: 'nlh',
    gameMode: 'tournament',
    format: 'mtt',
    bigBlind: 100,
    dealerSeat: 4,
    tournament: {
      schemaVersion: 1,
      contextStatus: 'complete',
      playersAtTable: 4,
      playersLeft: 4,
      spotsPaid: 3,
      stacks: [10000, 8000, 6000, 1500],
      stackByUser: {
        'tournament-1': 10000,
        'tournament-2': 8000,
        'tournament-3': 6000,
        'tournament-4': 1500,
      },
      payoutPct: [50, 30, 20],
      m: preflop.buildTournamentMState({
        stackChips: 8000,
        smallBlind: 50,
        bigBlind: 100,
        ante: 0,
        anteType: 'none',
        playersAtTable: 4,
      }),
    },
  };
}

function decide(gs: HorseGameStateV2) {
  return HorseLogic.decide(
    gs.players[0],
    gs,
    'balanced',
    {},
    {
      mind: false,
      v27GtoCharts: false,
      v38Ev: false,
      phase7Utility: false,
      phase8Postflop: 'off',
      phase13Joint: 'off',
      v9: false,
    }
  );
}

it('replaces the identified horse cached stack, not a different player with the closest stack', () => {
  const gs = state();
  const original = structuredClone(gs);
  const factor = vi.spyOn(icm, 'bubbleFactor');
  expect(decide(gs).policyFallback).toBeUndefined();
  expect(factor).toHaveBeenCalledWith([8000, 8000, 6000, 1500], [50, 30, 20], 0, 8000);
  expect(gs).toEqual(original);
});

it.each(['missing', 'unmatched', 'invalid'] as const)(
  'does not label %s canonical horse identity as real ICM evidence',
  (kind) => {
    const gs = state();
    if (kind === 'missing') delete gs.tournament!.stackByUser;
    else gs.tournament!.stackByUser!['tournament-1'] = kind === 'unmatched' ? 9999 : NaN;
    const factor = vi.spyOn(icm, 'bubbleFactor');
    const decision = decide(gs);
    expect(factor).not.toHaveBeenCalled();
    expect(decision.policyFallback).toBeUndefined();
    expect(['call', 'raise', 'all_in', 'fold', 'check']).toContain(decision.action);
  }
);

it('uses the dealt census for the Phase 6 atlas even when an undealt seat is present', () => {
  const gs = state();
  gs.players.push({
    ...gs.players[3],
    seat: 5,
    user_id: 'spectator',
    cards: [],
    stack: 0,
    is_folded: true,
    is_sitting_out: true,
  });
  const policy = vi.spyOn(preflop, 'tournamentPreflopPolicy');
  expect(decide(gs).policyFallback).toBeUndefined();
  expect(policy).toHaveBeenCalledWith(
    expect.objectContaining({ tableSize: 4, heroPosition: 'SB' })
  );
});

it('keeps a folded disconnected seat in the certified postflop lookup coordinate', () => {
  const gs = state();
  gs.gameMode = 'cash';
  gs.format = 'cash';
  delete gs.tournament;
  gs.stage = 'flop';
  gs.currentBet = 0;
  gs.actionHistory = [];
  gs.communityCards = [
    { rank: '2', suit: 'clubs' },
    { rank: '7', suit: 'diamonds' },
    { rank: '9', suit: 'spades' },
  ];
  gs.players[2].is_folded = true;
  gs.players[2].is_sitting_out = true;
  gs.players[3].is_folded = true;
  const lookup = vi.spyOn(certified, 'gtoStreetAdviceV31');
  expect(decide(gs).policyFallback).toBeUndefined();
  expect(lookup).toHaveBeenCalledWith(
    expect.objectContaining({ tableSize: 4, heroPosition: 'SB', opponentPosition: 'BB' })
  );
});

it.each([
  [1, 1, 2, 4],
  [2, 3, 4],
  [1, 2, 3, 11],
])('refuses a contradictory certified census %j instead of guessing a ring', (...dealtSeatIds) => {
  expect(
    gtoV31Position({ seat: 1, dealerSeat: 4, players: state().players, dealtSeatIds })
  ).toBeNull();
});
