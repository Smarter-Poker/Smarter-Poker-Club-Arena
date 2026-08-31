/**
 * V24 — NO SNAP FOLDS, PLO PRICE DEFENSE, PKO BOUNTY AWARENESS
 * (Dan 2026-08-28, from a live PLO PKO tournament)
 *
 * "I just full potted 8 hands in a row in this PLO PKO tournament, and never
 *  got called once pre flop, got all snap folds almost every time... horses
 *  need to NEVER snap fold, they should always take a couple seconds, even if
 *  they already know they are going to fold."
 *
 * Two independent defects behind one experience:
 *
 *  1. TIMING. A preflop fold took the SNAP branch ~74% of the time for a
 *     fast-tempo horse, drew 180-800ms, then lost 20% to the preflop-simple
 *     discount and up to 40% more to the tempo shaper: ~180-400ms. Nobody
 *     folds to a pot-sized raise in a fifth of a second.
 *
 *  2. STRATEGY. Facing that raise, a PLO horse needed
 *     strength >= t(0.54) + riskAdd. Near the money riskAdd reaches 0.12, so
 *     the bar sat around 0.70 - a horse folded ~70% of hands rather than call
 *     3.5bb of a 100bb stack getting better than 3:1, in the variant where
 *     the WORST hand still holds ~30% against the best. And nothing preflop
 *     knew a bounty existed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { decidePreflopV7 } from './HorsePreflop.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../types.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';

beforeEach(() => seedFastRandom(0x5eed24));

function c(spec: string): Card {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
}
const cc = (...specs: string[]): Card[] => specs.map(c);

function mkPlayer(seat: number, overrides: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `horse-${seat}`,
    username: `Horse${seat}`,
    stack: 10000,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...overrides,
  } as SeatPlayer;
}

type GS = Parameters<(typeof HorseLogic)['decide']>[1];

// ─────────────────────────────────────────────────────────────────────────────
// 1. NO SNAP FOLDS — the thing Dan watched
// ─────────────────────────────────────────────────────────────────────────────

/** Dan's exact spot: a pot-sized PLO raise, hero holds junk and will fold. */
function facingPotRaise(heroId: string): { hero: SeatPlayer; gs: GS } {
  const hero = mkPlayer(1, { cards: cc('9d', '7c', '4h', '2s'), stack: 10000, bet: 0 });
  hero.user_id = heroId;
  const players = [hero, mkPlayer(2, { bet: 350 }), mkPlayer(3), mkPlayer(4)];
  const gs = {
    players,
    communityCards: [] as Card[],
    pot: 500,
    currentBet: 350,
    minRaise: 350,
    stage: 'preflop' as HandStage,
    gameVariant: 'plo4',
    bigBlind: 100,
    dealerSeat: 4,
    gameMode: 'tournament' as const,
    format: 'mtt' as const,
    ante: 12.5,
    tournament: { playersLeft: 60, spotsPaid: 50, nearBubble: true, bountyFactor: 0.5 },
    actionHistory: [
      {
        seat: 2,
        userId: 'horse-2',
        action: 'raise' as const,
        amount: 350,
        timestamp: 1,
        stage: 'preflop' as HandStage,
        isFullRaise: true,
      } as ActionRecord,
    ],
  } as unknown as GS;
  return { hero, gs };
}

describe('V24 no snap folds', () => {
  it('every horse tempo takes over a second to act facing a bet', () => {
    // Sweep many distinct horse ids so the per-horse tempo hash is exercised
    // across its whole range, fastest seats included.
    let fastest = Infinity;
    let folds = 0;
    for (let i = 0; i < 240; i++) {
      seedFastRandom(0x5eed24 + i);
      const { hero, gs } = facingPotRaise(`horse-tempo-${i}`);
      const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
      if (d.action === 'fold') {
        folds++;
        // The time-bank sentinel is a signal, not a duration - skip it.
        if (d.thinkTime < 100_000) fastest = Math.min(fastest, d.thinkTime);
      }
    }
    expect(folds).toBeGreaterThan(0);
    expect(fastest).toBeGreaterThanOrEqual(1250);
  });

  it('a free check with nothing owed may still be quick', () => {
    // The fix must not make the whole fleet ponderous: with no bet to face,
    // an instant check is human and stays allowed.
    const hero = mkPlayer(1, { cards: cc('9d', '7c', '4h', '2s'), stack: 10000, bet: 100 });
    const gs = {
      players: [hero, mkPlayer(2, { bet: 100 })],
      communityCards: [] as Card[],
      pot: 200,
      currentBet: 100,
      minRaise: 100,
      stage: 'preflop' as HandStage,
      gameVariant: 'plo4',
      bigBlind: 100,
      dealerSeat: 2,
      gameMode: 'cash' as const,
      actionHistory: [] as ActionRecord[],
    } as unknown as GS;
    let quickest = Infinity;
    for (let i = 0; i < 60; i++) {
      seedFastRandom(0x5eed24 + i);
      const d = HorseLogic.decide(
        { ...hero, user_id: `h-${i}` },
        gs,
        'balanced',
        {},
        { mind: false }
      );
      if (d.action === 'check' && d.thinkTime < 100_000) {
        quickest = Math.min(quickest, d.thinkTime);
      }
    }
    expect(quickest).toBeLessThan(1250);
    expect(quickest).toBeGreaterThanOrEqual(350);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PLO PRICE DEFENSE + risk-scaled ICM
// ─────────────────────────────────────────────────────────────────────────────

function ploCtx(extra: Record<string, unknown> = {}) {
  return {
    // A middling PLO hand: nowhere near the old 0.70 bar, comfortably worth a
    // call at better than 3:1 in a variant where equities run close.
    strength: 0.5,
    position: 'middle' as const,
    raiserPosition: 'middle' as const,
    raises: 1,
    limpers: 0,
    callers: 0,
    oppsLeft: 5,
    toCall: 350,
    currentBet: 350,
    pot: 500,
    bigBlind: 100,
    stack: 10000, // 100bb: the call is 3.5% of the stack
    stackBB: 100,
    tightness: 1.03,
    bluffFreq: 0.1,
    aggression: 1,
    slowplayFreq: 0.1,
    sizingMultiplier: 1,
    isOmaha: true,
    isPotLimit: true,
    riskAdd: 0.12, // near the money
    mode: 'tournament' as const,
    anteInPlay: true,
    // 0.125/player x 8 seats = a 1.0bb ante per ORBIT (orbit total 2.5bb),
    // the same figure the old per-player field produced here.
    anteOrbitBB: 1.0,
    tableSize: 8,
    ploPriceDefense: true,
    v13: true,
    rand: () => 0.5,
    ...extra,
  };
}

describe('V24 PLO price defense', () => {
  // THE PRICES, worked out once (a pot-sized open to 3.5bb builds a 5bb pot):
  //   BIG BLIND   already has 1bb in -> puts in 2.5 to win 7.5  = 0.33
  //   COLD CALLER            nothing -> puts in 3.5 to win 8.5  = 0.41
  // The blind is the seat that was folding at a price it should defend.

  // A raise to 4bb rather than 3.5bb, so the call is 3bb and steps OUTSIDE
  // the pre-existing `bb && toCall <= 2.5bb` fallback (pinned below). That
  // fallback is why the blind was NOT the leaking seat - the cold callers
  // were, and the risk-scaled premium is what frees them.
  const bbSpot = (extra: Record<string, unknown> = {}) =>
    ploCtx({
      position: 'bb' as const,
      toCall: 300,
      currentBet: 400,
      pot: 550,
      strength: 0.4,
      ...extra,
    });

  it('the BIG BLIND defends a pot-sized raise at 3:1 near the money', () => {
    expect(decidePreflopV7(bbSpot() as never).a).toBe('call');
  });

  it('WITHOUT the layer the same blind folds - the leak Dan watched', () => {
    expect(decidePreflopV7(bbSpot({ ploPriceDefense: false }) as never).a).toBe('fold');
  });

  it('a COLD CALLER at 1.43:1 stays tight - pot-raise pots are not cheap', () => {
    // 0.41 odds earns only ~0.09 of relief, so a middling hand still folds.
    // Widening here would be a different leak, not a fix.
    expect(decidePreflopV7(ploCtx({ strength: 0.45 }) as never).a).toBe('fold');
  });

  it('the pre-existing BB rule still defends a cheap raise on its own', () => {
    // `position === 'bb' && toCall <= 2.5bb && strength >= 0.3` predates V24.
    // Pinned here because the first cut of this suite mistook the blind for
    // the leaking seat: at a 3.5bb open the blind was ALREADY calling, with
    // or without the new layer. Deleting that rule would be a regression the
    // V24 tests would otherwise not notice.
    const cheap = ploCtx({
      position: 'bb' as const,
      toCall: 250,
      currentBet: 350,
      pot: 500,
      strength: 0.4,
      ploPriceDefense: false,
    });
    expect(decidePreflopV7(cheap as never).a).toBe('call');
  });

  it('a 4-bet sized price is a fold even in the blind', () => {
    const r = decidePreflopV7(
      bbSpot({ toCall: 3000, currentBet: 3100, pot: 1200, strength: 0.4 }) as never
    );
    expect(r.a).toBe('fold');
  });

  it('NLH is untouched by the Omaha price bend', () => {
    const nlh = bbSpot({ isOmaha: false, isPotLimit: false });
    expect(decidePreflopV7(nlh as never).a).toBe(
      decidePreflopV7({ ...nlh, ploPriceDefense: false } as never).a
    );
  });

  it('an ALL-IN call still pays the FULL survival premium', () => {
    // atRisk = 1, so riskScaled === riskAdd: ICM is undiminished exactly
    // where it prices busting.
    const shove = ploCtx({ toCall: 10000, currentBet: 10000, pot: 11000, strength: 0.62 });
    expect(decidePreflopV7(shove as never).a).toBe(
      decidePreflopV7({ ...shove, ploPriceDefense: false } as never).a
    );
  });
});

describe('V24 bounty awareness', () => {
  const coldCall = (extra: Record<string, unknown> = {}) => ploCtx({ strength: 0.45, ...extra });

  it('covering the raiser in a PKO widens the call', () => {
    expect(decidePreflopV7(coldCall() as never).a).toBe('fold');
    expect(decidePreflopV7(coldCall({ bountyFactor: 0.5, coversRaiser: true }) as never).a).toBe(
      'call'
    );
  });

  it('a bustable raiser widens it further than merely covering one', () => {
    const base = coldCall({ strength: 0.4, bountyFactor: 0.5, coversRaiser: true });
    expect(decidePreflopV7(base as never).a).toBe('fold');
    expect(decidePreflopV7({ ...base, raiserBustable: true } as never).a).toBe('call');
  });

  it('NOT covering the raiser earns no bounty discount', () => {
    // Hero's own bounty is at risk too - no free widening.
    expect(decidePreflopV7(coldCall({ bountyFactor: 0.5, coversRaiser: false }) as never).a).toBe(
      'fold'
    );
  });

  it('a freezeout (no bounty pool) is unaffected', () => {
    expect(decidePreflopV7(coldCall({ bountyFactor: 0, coversRaiser: true }) as never).a).toBe(
      'fold'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. League registration
// ─────────────────────────────────────────────────────────────────────────────

describe('V24 league registration', () => {
  it('the PLO price matchups are on the card', () => {
    for (const n of ['plo4_v24_price', 'plo6_v24_price']) {
      expect(
        LEAGUE_MATCHUPS.find((m) => m.name === n),
        n
      ).toBeDefined();
    }
  });

  it('full_vs_v2_legacy disables both V24 flags', () => {
    const legacy = LEAGUE_MATCHUPS.find((m) => m.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    expect(legacy.v24Bounty).toBe(false);
    expect(legacy.v24PloDefense).toBe(false);
  });
});
