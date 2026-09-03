/**
 * V38 — the EV engine: the arithmetic behind every choice (2026-09-03).
 * Closed-form pins first, then the wiring into decide() for the games with
 * no solver export and for the river line of every game.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateSpot,
  mdfFold,
  continuingEquity,
  riverCallVerdict,
  type EvSpot,
} from './HorseEvEngine.js';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit, SeatPlayer } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}
const fires = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));

function spot(o: Partial<EvSpot>): EvSpot {
  return {
    equity: 0.5,
    pot: 100,
    toCall: 0,
    stack: 1000,
    effectiveStack: 1000,
    street: 'flop',
    inPosition: true,
    opponents: 1,
    realization: 1,
    minBet: 2,
    maxBet: Infinity,
    rand: () => 0.99, // deterministic: the best action wins every mix
    ...o,
  };
}

describe('V38 the arithmetic', () => {
  it('a solver opponent folds by minimum defence frequency', () => {
    expect(mdfFold(100, 100)).toBeCloseTo(0.5, 6); // pot bet: half the range
    expect(mdfFold(100, 50)).toBeCloseTo(1 / 3, 6); // half pot: a third
    expect(mdfFold(100, 100, 1.5)).toBeCloseTo(0.75, 6); // a folder folds more
    expect(mdfFold(100, 0)).toBe(0);
  });

  it('the folds come out of the hands hero was beating', () => {
    expect(continuingEquity(0.5, 0)).toBe(0.5);
    expect(continuingEquity(0.5, 0.5)).toBeLessThan(0.5);
    expect(continuingEquity(0.9, 0.5)).toBeGreaterThan(0.9); // a monster gets stronger vs the callers
  });

  it('EV(call) is realized equity times the pot after the call, minus the call', () => {
    const v = evaluateSpot(spot({ equity: 0.4, pot: 150, toCall: 50, street: 'river' }));
    const call = v.candidates.find((c) => c.kind === 'call')!;
    expect(call.ev).toBeCloseTo(0.4 * 200 - 50, 6); // +30
    expect(v.best.kind).not.toBe('fold');
  });

  it('a hand below the price folds, at the price is indifferent', () => {
    const under = evaluateSpot(spot({ equity: 0.2, pot: 150, toCall: 50, street: 'river' }));
    expect(under.best.kind).toBe('fold');
    const at = evaluateSpot(spot({ equity: 0.25, pot: 150, toCall: 50, street: 'river' }));
    const call = at.candidates.find((c) => c.kind === 'call')!;
    expect(Math.abs(call.ev)).toBeLessThan(1e-6);
  });

  it('air checks, a monster bets, and the monster prefers a bigger size', () => {
    const air = evaluateSpot(spot({ equity: 0.15 }));
    expect(air.best.kind).toBe('check');
    const nuts = evaluateSpot(spot({ equity: 0.95 }));
    expect(nuts.best.kind).toBe('bet');
    const sizes = nuts.candidates.filter((c) => c.kind === 'bet') as Array<{
      sizeFrac: number;
      ev: number;
    }>;
    const biggest = sizes.reduce((a, b) => (a.sizeFrac > b.sizeFrac ? a : b));
    const smallest = sizes.reduce((a, b) => (a.sizeFrac < b.sizeFrac ? a : b));
    expect(biggest.ev).toBeGreaterThan(smallest.ev);
  });

  it('a draw with the lead bets more often than the same draw without it', () => {
    let withLead = 0;
    let without = 0;
    for (let i = 0; i < 200; i++) {
      const r = i / 200;
      if (evaluateSpot(spot({ equity: 0.42, initiative: true, rand: () => r })).pick.kind === 'bet')
        withLead++;
      if (
        evaluateSpot(spot({ equity: 0.42, initiative: false, rand: () => r })).pick.kind === 'bet'
      )
        without++;
    }
    expect(withLead).toBeGreaterThanOrEqual(without);
  });

  it('a folder makes a bluff worth more', () => {
    const solver = evaluateSpot(spot({ equity: 0.25, sizes: [0.75] }));
    const folder = evaluateSpot(spot({ equity: 0.25, sizes: [0.75], models: [{ foldMul: 1.6 }] }));
    const bet = (v: ReturnType<typeof evaluateSpot>) =>
      v.candidates.find((c) => c.kind === 'bet')!.ev;
    expect(bet(folder)).toBeGreaterThan(bet(solver));
  });

  it('a bluff into three players is worth less than the same bluff into one', () => {
    const hu = evaluateSpot(spot({ equity: 0.25, sizes: [0.75], opponents: 1 }));
    const mw = evaluateSpot(spot({ equity: 0.25, sizes: [0.75], opponents: 3 }));
    const bet = (v: ReturnType<typeof evaluateSpot>) =>
      v.candidates.find((c) => c.kind === 'bet')!.ev;
    expect(bet(mw)).toBeLessThan(bet(hu));
  });

  it('pot limit caps the ladder at the pot; a jam is always on the menu when legal', () => {
    const pl = evaluateSpot(spot({ equity: 0.9, maxBet: 100, sizes: [0.5, 1.0, 1.5] }));
    const amounts = pl.candidates
      .filter((c) => c.kind === 'bet')
      .map((c) => (c as { amount: number }).amount);
    expect(Math.max(...amounts)).toBeLessThanOrEqual(100);
    const nl = evaluateSpot(spot({ equity: 0.9, stack: 300, effectiveStack: 300, sizes: [0.5] }));
    const nlAmounts = nl.candidates
      .filter((c) => c.kind === 'bet')
      .map((c) => (c as { amount: number }).amount);
    expect(nlAmounts).toContain(300);
  });

  it('the river line: required = raked pot odds + the survival premium on the share at risk', () => {
    const v = riverCallVerdict({ equity: 0.3, pot: 150, toCall: 50, stack: 1000, rand: () => 0.5 });
    expect(v.required).toBeCloseTo(0.25, 6);
    expect(v.call).toBe(true);
    const raked = riverCallVerdict({
      equity: 0.26,
      pot: 150,
      toCall: 50,
      stack: 1000,
      rakeMarg: 0.1,
      rand: () => 0.5,
    });
    expect(raked.required).toBeCloseTo(0.25 / 0.9, 6);
    expect(raked.call).toBe(false);
    const icm = riverCallVerdict({
      equity: 0.3,
      pot: 150,
      toCall: 50,
      stack: 100,
      riskPremium: 0.1,
      rand: () => 0.5,
    });
    expect(icm.required).toBeCloseTo(0.25 + 0.1 * Math.sqrt(0.5), 6);
    expect(icm.call).toBe(false);
  });

  it('at indifference the river line mixes', () => {
    let calls = 0;
    for (let i = 0; i < 100; i++) {
      const v = riverCallVerdict({
        equity: 0.25,
        pot: 150,
        toCall: 50,
        stack: 1000,
        rand: () => i / 100,
      });
      if (v.call) calls++;
    }
    expect(calls).toBeGreaterThan(30);
    expect(calls).toBeLessThan(70);
  });
});

describe('V38 wiring: the engine reaches decide()', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed38);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });

  function state(
    variant: string,
    hole: string,
    board: string,
    stage: 'flop' | 'river',
    bet: number
  ) {
    const players: SeatPlayer[] = [
      {
        seat: 1,
        user_id: 'hero',
        username: 'h',
        stack: 400,
        bet: 0,
        totalInvested: 10,
        cards: cards(hole),
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 2,
        user_id: 'villain',
        username: 'v',
        stack: 400 - bet,
        bet,
        totalInvested: 10 + bet,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ];
    const history = [
      { stage: 'preflop', seat: 2, userId: 'villain', action: 'raise', amount: 6, timestamp: 1 },
      { stage: 'preflop', seat: 1, userId: 'hero', action: 'call', amount: 4, timestamp: 2 },
    ];
    if (stage === 'river') {
      for (const st of ['flop', 'turn']) {
        history.push({
          stage: st,
          seat: 1,
          userId: 'hero',
          action: 'check',
          amount: 0,
          timestamp: history.length + 1,
        });
        history.push({
          stage: st,
          seat: 2,
          userId: 'villain',
          action: 'check',
          amount: 0,
          timestamp: history.length + 1,
        });
      }
    }
    if (bet > 0)
      history.push({
        stage,
        seat: 2,
        userId: 'villain',
        action: 'bet',
        amount: bet,
        timestamp: history.length + 1,
      });
    else
      history.push({
        stage,
        seat: 2,
        userId: 'villain',
        action: 'check',
        amount: 0,
        timestamp: history.length + 1,
      });
    return {
      hero: players[0],
      gs: {
        players,
        communityCards: cards(board),
        pot: 20 + bet,
        currentBet: bet,
        minRaise: Math.max(2, bet),
        stage,
        gameVariant: variant,
        gameMode: 'cash',
        bigBlind: 2,
        dealerSeat: 1,
        actionHistory: history,
      },
    };
  }

  it('a PLO flop facing a bet is priced by the EV engine', () => {
    const s = state('plo4', 'AhKh7c2d', 'Qh9h3s', 'flop', 15);
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true, mind: false });
    const f = fires();
    expect((f['v38_ev_call'] ?? 0) + (f['v38_ev_fold'] ?? 0)).toBe(1);
  });

  it('a PLO flop checked to hero below the value bars is decided by the EV engine', () => {
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      const s = state('plo4', '9c8d4h2s', 'AhKd7c', 'flop', 0);
      HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true, mind: false });
      const f = fires();
      hits += (f['v38_ev_bet'] ?? 0) + (f['v38_ev_check'] ?? 0);
    }
    expect(hits).toBe(20);
  });

  it('a hold em river facing a bet is the MDF line, not a flat margin', () => {
    const s = state('nlh', 'AhKh', 'Qh9d3s7c2c', 'river', 15);
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true, mind: false });
    const f = fires();
    expect((f['v38_river_call'] ?? 0) + (f['v38_river_fold'] ?? 0)).toBe(1);
  });

  it('ablated, the river falls back to the heuristic line', () => {
    const s = state('nlh', 'AhKh', 'Qh9d3s7c2c', 'river', 15);
    HorseLogic.decide(
      s.hero,
      s.gs as never,
      'balanced',
      {},
      { telemetry: true, mind: false, v38Ev: false }
    );
    const f = fires();
    expect((f['v38_river_call'] ?? 0) + (f['v38_river_fold'] ?? 0)).toBe(0);
  });

  it('a PLO preflop jam is called or folded on equity against the jammer', () => {
    const players: SeatPlayer[] = [
      {
        seat: 1,
        user_id: 'hero',
        username: 'h',
        stack: 60,
        bet: 2,
        totalInvested: 2,
        cards: cards('AhAdKhKd'),
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 2,
        user_id: 'villain',
        username: 'v',
        stack: 0,
        bet: 50,
        totalInvested: 50,
        cards: [],
        is_folded: false,
        is_all_in: true,
        is_sitting_out: false,
      },
    ];
    const gs = {
      players,
      communityCards: [],
      pot: 53,
      currentBet: 50,
      minRaise: 48,
      stage: 'preflop',
      gameVariant: 'plo4',
      gameMode: 'cash',
      bigBlind: 2,
      dealerSeat: 2,
      actionHistory: [
        {
          stage: 'preflop',
          seat: 2,
          userId: 'villain',
          action: 'all_in',
          amount: 50,
          timestamp: 1,
          isFullRaise: true,
        },
      ],
    };
    const d = HorseLogic.decide(
      players[0],
      gs as never,
      'balanced',
      {},
      { telemetry: true, mind: false }
    );
    expect(['call', 'all_in']).toContain(d.action);
    expect(fires()['v38_preflop_allin_price']).toBe(1);
    // four napkins fold the same jam
    players[0].cards = cards('9c4d2h7s');
    const d2 = HorseLogic.decide(
      players[0],
      gs as never,
      'balanced',
      {},
      { telemetry: true, mind: false }
    );
    expect(d2.action).toBe('fold');
  });
});
