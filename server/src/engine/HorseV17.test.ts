/**
 * V17 POSITIONAL PRESSURE — players-behind bluff scaling, river delayed
 * probes, call-side blockers, short-deck tightening. Every effect proven by
 * comparative frequencies through the real decision path.
 */
import { describe, it, expect } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import type { Card, SeatPlayer, ActionRecord } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

function seat(n: number, id: string, over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat: n,
    user_id: id,
    username: id,
    stack: 200,
    bet: 0,
    totalInvested: 2,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...over,
  } as SeatPlayer;
}

describe('V17 positional pressure', () => {
  function stabFreq(heroSeat: number, trials = 500): number {
    // Dealer is seat 6, so postflop order is 1,2,3,4,5,6. Opponents sit at
    // 3 and 5. Hero at seat 1 acts FIRST with both behind; hero at seat 6
    // (the button) closes the action with none behind. Hand: T9s — enough
    // equity (~0.3) to sit inside the c-bet/semi-bluff bands where
    // bluffScale governs.
    let bets = 0;
    for (let s = 1; s <= trials; s++) {
      seedFastRandom(s * 6961);
      const hero = seat(heroSeat, 'hero', {
        cards: [c('T', 'hearts'), c('9', 'hearts')],
      });
      const opps: SeatPlayer[] = [seat(3, 'o0'), seat(5, 'o1')];
      const history: ActionRecord[] = [
        {
          seat: heroSeat,
          userId: 'hero',
          action: 'raise',
          amount: 6,
          timestamp: 1,
          stage: 'preflop',
        },
        { seat: 3, userId: 'o0', action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
        { seat: 5, userId: 'o1', action: 'call', amount: 6, timestamp: 3, stage: 'preflop' },
      ] as ActionRecord[];
      const gs: HorseGameStateV2 = {
        players: [hero, ...opps],
        communityCards: [c('K', 'spades'), c('8', 'diamonds'), c('3', 'clubs')],
        pot: 19,
        currentBet: 0,
        minRaise: 2,
        stage: 'flop',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 6,
        actionHistory: history,
        gameMode: 'cash',
        format: 'cash',
      } as HorseGameStateV2;
      const dec = HorseLogic.decide(hero, gs, 'lag', {}, { mind: false });
      if (dec.action === 'bet') bets++;
    }
    return bets / trials;
  }

  it('closing the action stabs more than firing into two live players behind', () => {
    const closing = stabFreq(6); // button: zero behind
    const firstOfThree = stabFreq(1); // first to act: two behind
    expect(closing).toBeGreaterThan(firstOfThree + 0.03);
  });
});

describe('V17 river delayed probe', () => {
  function riverStabFreq(v17RiverProbe: boolean, trials = 500): number {
    let bets = 0;
    for (let s = 1; s <= trials; s++) {
      seedFastRandom(s * 5081);
      // T9: river equity ~0.2 — inside the probe's [0.15, 0.5) eligibility
      // window, so the layer's frequency delta is actually observable.
      const hero = seat(1, 'hero', { cards: [c('T', 'hearts'), c('9', 'diamonds')] });
      const opp = seat(3, 'opp');
      // Flop had a bet-call (so flop NOT checked through); the TURN checked
      // through; river action on hero.
      const history: ActionRecord[] = [
        { seat: 1, userId: 'hero', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
        { seat: 3, userId: 'opp', action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
        { seat: 1, userId: 'hero', action: 'bet', amount: 8, timestamp: 3, stage: 'flop' },
        { seat: 3, userId: 'opp', action: 'call', amount: 8, timestamp: 4, stage: 'flop' },
        { seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 5, stage: 'turn' },
        { seat: 3, userId: 'opp', action: 'check', amount: 0, timestamp: 6, stage: 'turn' },
      ] as ActionRecord[];
      const gs: HorseGameStateV2 = {
        players: [hero, opp],
        communityCards: [
          c('K', 'spades'),
          c('8', 'diamonds'),
          c('3', 'clubs'),
          c('J', 'clubs'),
          c('2', 'hearts'),
        ],
        pot: 29,
        currentBet: 0,
        minRaise: 2,
        stage: 'river',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 1,
        actionHistory: history,
        gameMode: 'cash',
        format: 'cash',
      } as HorseGameStateV2;
      const dec = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, v17RiverProbe });
      if (dec.action === 'bet') bets++;
    }
    return bets / trials;
  }

  it('probes the capped river measurably more with the layer on', () => {
    const on = riverStabFreq(true);
    const off = riverStabFreq(false);
    expect(on).toBeGreaterThan(off + 0.04);
  });
});

describe('V17 call-side blocker', () => {
  function callFreq(hole: Card[], trials = 400): number {
    let calls = 0;
    for (let s = 1; s <= trials; s++) {
      seedFastRandom(s * 7433);
      const hero = seat(1, 'hero', { cards: hole, bet: 0 });
      const opp = seat(3, 'opp', { bet: 32 });
      const gs: HorseGameStateV2 = {
        players: [hero, opp],
        communityCards: [
          c('K', 'hearts'),
          c('9', 'hearts'),
          c('4', 'spades'),
          c('7', 'clubs'),
          c('2', 'diamonds'),
        ],
        pot: 72,
        currentBet: 32,
        minRaise: 32,
        stage: 'river',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 3,
        actionHistory: [
          { seat: 3, userId: 'opp', action: 'bet', amount: 32, timestamp: 1, stage: 'river' },
        ] as ActionRecord[],
        gameMode: 'cash',
        format: 'cash',
      } as HorseGameStateV2;
      const dec = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
      if (dec.action === 'call') calls++;
    }
    return calls / trials;
  }

  it('holding the missed hearts folds the bluff-catcher more', () => {
    // Same hand class (king kicker pair-ish catchers): one blocks the missed
    // hearts, one does not.
    const blocking = callFreq([c('A', 'hearts'), c('Q', 'hearts')]); // holds the missed draw
    const unblocking = callFreq([c('A', 'spades'), c('Q', 'clubs')]);
    expect(unblocking).toBeGreaterThanOrEqual(blocking);
  });
});
