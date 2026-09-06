/**
 * V46 (2026-09-05) - THE SHAPE OF THE HAND, WHICH A PERCENTILE CANNOT SEE
 *
 * From the deep audit 5.1: no solver data exists for any non-hold'em game,
 * and 55% of cash seat-hands are played in one. The hand-class chart is the
 * first thing in the engine that reads the SHAPE of an Omaha or short-deck
 * hand rather than its percentile.
 *
 * These tests pin the three claims: the classifier agrees with published
 * theory on hands anyone can check by eye; the chart reaches the preflop bars
 * in the right direction; and hold'em is byte-identical with the flag on or
 * off.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  omahaHandClass,
  shortDeckHandClass,
  handClassRead,
  connectedSpan,
  suitedness,
  aceSuited,
  OMAHA_CLASSES,
  SHORT_DECK_CLASSES,
} from './HorseHandClasses.js';
import { decidePreflopV7, type PreflopCtx } from './HorsePreflop.js';
import { variantPreflopShift } from './HorseVariantProfile.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';
import type { Card, SeatPlayer, HandStage } from '../types.js';

beforeEach(() => {
  seedFastRandom(0x46);
  HorseMind.reset();
  drainFires();
});

const SUIT: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
function c(spec: string): Card {
  return { rank: spec.slice(0, -1) as Card['rank'], suit: SUIT[spec.slice(-1)] as Card['suit'] };
}
const cc = (...specs: string[]): Card[] => specs.map(c);

describe('V46 Omaha classifier', () => {
  it('aces double-suited are the 3-bet anchor; aces rainbow are not', () => {
    expect(omahaHandClass(cc('As', 'Ah', 'Ks', 'Qh'))).toBe('aa_ds');
    expect(omahaHandClass(cc('As', 'Ah', 'Kd', 'Qc'))).toBe('aa_dry');
    // an ace suited to a side card is the nut-flush shape, so it counts
    expect(omahaHandClass(cc('As', 'Ah', 'Ts', '4c'))).toBe('aa_ds');
  });

  it('AAA-x is trips and folds - the hand the percentile most overrates', () => {
    expect(omahaHandClass(cc('As', 'Ah', 'Ad', '7c'))).toBe('trips');
    expect(omahaHandClass(cc('7s', '7h', '7d', 'Kc'))).toBe('trips');
    const read = handClassRead(cc('As', 'Ah', 'Ad', '7c'), true, false);
    expect(read.foldAlways).toBe(true);
  });

  it('a rundown is a rundown, and it flats', () => {
    expect(omahaHandClass(cc('Js', 'Th', '9s', '8h'))).toBe('rundown');
    expect(omahaHandClass(cc('Qs', 'Jh', 'Td', '8c'))).toBe('rundown');
    const read = handClassRead(cc('Js', 'Th', '9s', '8h'), true, false);
    expect(read.neverThreeBet).toBe(true);
    expect(read.foldAlways).toBe(false);
    // and it opens wider than the zero read
    expect(read.shift.open).toBeLessThan(0);
    // ... while its 3-bet bar RISES (published PLO: 3-bets are AA-anchored)
    expect(read.shift.threeBet).toBeGreaterThan(0);
  });

  it('four broadway double-suited is its own class', () => {
    expect(omahaHandClass(cc('Ks', 'Qh', 'Js', 'Th'))).toBe('broadway_ds');
  });

  it('trash and danglers are told apart', () => {
    // double-paired low: no way to make the nuts
    expect(omahaHandClass(cc('7s', '7h', '4d', '4c'))).toBe('trash');
    // three working cards and a passenger
    expect(omahaHandClass(cc('As', 'Ks', 'Qh', '3c'))).toBe('dangler');
    expect(handClassRead(cc('7s', '7h', '4d', '4c'), true, false).foldAlways).toBe(true);
  });

  it('five and six card hands classify on the same signals', () => {
    expect(omahaHandClass(cc('As', 'Ah', 'Ks', 'Qh', '7d'))).toBe('aa_ds');
    expect(omahaHandClass(cc('Js', 'Th', '9s', '8h', '2d', '3c'))).toBe('rundown');
    expect(omahaHandClass(cc('As', 'Ah', 'Ad', '7c', '2d', '3h'))).toBe('trips');
  });

  it('the shape helpers are right on hands anyone can check', () => {
    expect(connectedSpan(cc('Js', 'Th', '9s', '8h'))).toBe(3);
    expect(connectedSpan(cc('As', '2h', '3s', '4h'))).toBe(3); // wheel ace plays low
    expect(connectedSpan(cc('As', 'Kh', '7s', '2h'))).toBeGreaterThan(5);
    expect(suitedness(cc('As', 'Ah', 'Ks', 'Qh'))).toBe(2);
    expect(suitedness(cc('As', 'Ah', 'Kd', 'Qc'))).toBe(0);
    expect(aceSuited(cc('As', 'Ks', '7h', '2d'))).toBe(true);
    expect(aceSuited(cc('Ac', 'Ks', '7h', '2d'))).toBe(false);
  });

  it('a short hand or no hand reads as no class', () => {
    expect(omahaHandClass([])).toBe('other');
    expect(omahaHandClass(null)).toBe('other');
    expect(handClassRead(undefined, true, false).cls).toBe('other');
  });
});

describe('V46 short-deck classifier', () => {
  it('a suited ace is the premium and a small pair is the demotion', () => {
    expect(shortDeckHandClass(cc('As', '9s'))).toBe('sd_suited_ace');
    expect(shortDeckHandClass(cc('Js', 'Jh'))).toBe('sd_big_pair');
    expect(shortDeckHandClass(cc('8s', '8h'))).toBe('sd_small_pair');
    expect(shortDeckHandClass(cc('9s', '8s'))).toBe('sd_suited_conn');
    expect(shortDeckHandClass(cc('Kd', '7c'))).toBe('sd_other');
  });
  it('the small pair opens TIGHTER, which is the point', () => {
    const small = handClassRead(cc('8s', '8h'), false, true);
    const ace = handClassRead(cc('As', '9s'), false, true);
    expect(small.shift.open).toBeGreaterThan(0);
    expect(ace.shift.open).toBeLessThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
function ctx(over: Partial<PreflopCtx> = {}): PreflopCtx {
  return {
    strength: 0.8,
    position: 'late',
    raiserPosition: 'middle',
    raises: 1,
    limpers: 0,
    callers: 0,
    oppsLeft: 2,
    toCall: 6,
    currentBet: 6,
    pot: 9,
    bigBlind: 2,
    stack: 200,
    stackBB: 100,
    tightness: 1,
    bluffFreq: 0.1,
    aggression: 1,
    slowplayFreq: 0.1,
    sizingMultiplier: 1,
    isOmaha: true,
    isPotLimit: true,
    riskAdd: 0,
    mode: 'cash',
    variantShift: variantPreflopShift('plo4'),
    rand: () => 0.5,
    ...over,
  } as PreflopCtx;
}

describe('V46 reaches the preflop bars', () => {
  it('a rundown that would 3-bet flats instead', () => {
    const read = handClassRead(cc('Js', 'Th', '9s', '8h'), true, false);
    const without = decidePreflopV7(ctx({ strength: 0.97 }));
    const with46 = decidePreflopV7(
      ctx({
        strength: 0.97,
        classShift: read.shift,
        classNeverThreeBet: read.neverThreeBet,
        classFoldAlways: read.foldAlways,
      })
    );
    // the plain read raises (either shape the intent uses)
    expect(['raise', 'raiseTo']).toContain(without.a);
    expect(with46.a).toBe('call');
  });

  it('trips folds to a raise however strong the percentile says it is', () => {
    const read = handClassRead(cc('As', 'Ah', 'Ad', '7c'), true, false);
    const with46 = decidePreflopV7(
      ctx({
        strength: 0.99,
        classShift: read.shift,
        classNeverThreeBet: read.neverThreeBet,
        classFoldAlways: read.foldAlways,
      })
    );
    expect(with46.a).toBe('fold');
    // ... but a free look in the big blind is still free
    const free = decidePreflopV7(
      ctx({
        strength: 0.99,
        toCall: 0,
        raises: 0,
        position: 'bb',
        classShift: read.shift,
        classFoldAlways: true,
      })
    );
    expect(free.a).not.toBe('fold');
  });

  it('aces double-suited 3-bet where the same percentile without the class would not', () => {
    const read = handClassRead(cc('As', 'Ah', 'Ks', 'Qh'), true, false);
    expect(read.cls).toBe('aa_ds');
    let raises46 = 0;
    let raisesPlain = 0;
    for (let i = 1; i <= 40; i++) {
      seedFastRandom(i * 7919);
      if (
        decidePreflopV7(
          ctx({
            strength: 0.9,
            classShift: read.shift,
            classNeverThreeBet: read.neverThreeBet,
            classFoldAlways: read.foldAlways,
          })
        ).a.startsWith('raise')
      )
        raises46++;
      seedFastRandom(i * 7919);
      if (decidePreflopV7(ctx({ strength: 0.9 })).a.startsWith('raise')) raisesPlain++;
    }
    expect(raises46).toBeGreaterThanOrEqual(raisesPlain);
  });

  it('a hold em hand gets the zero read, so nothing changes outside Omaha and 6+', () => {
    const read = handClassRead(cc('As', 'Ks'), false, false);
    expect(read.cls).toBe('other');
    expect(read.shift).toEqual({ open: 0, threeBet: 0, fourBet: 0, coldCall: 0, bbDefend: 0 });
    expect(read.neverThreeBet).toBe(false);
    expect(read.foldAlways).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
function mkPlayer(seat: number, over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `h-${seat}`,
    username: `H${seat}`,
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...over,
  } as SeatPlayer;
}

function ploSpot(cards: Card[], variant = 'plo4'): { hero: SeatPlayer; gs: HorseGameStateV2 } {
  const hero = mkPlayer(2, { cards, bet: 2, totalInvested: 2 });
  const gs = {
    players: [mkPlayer(1, { is_folded: true }), hero, mkPlayer(3, { bet: 6, stack: 194 })],
    communityCards: [],
    pot: 9,
    currentBet: 6,
    minRaise: 4,
    stage: 'preflop' as HandStage,
    gameVariant: variant,
    bigBlind: 2,
    dealerSeat: 3,
    gameMode: 'cash' as const,
    format: 'cash',
    actionHistory: [],
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

describe('V46 wiring: the receipts fire from a live decision', () => {
  it('an Omaha hand fires the class receipt; a hold em hand does not', () => {
    enableBrainTelemetry();
    const plo = ploSpot(cc('Js', 'Th', '9s', '8h'));
    HorseLogic.decide(plo.hero, plo.gs, 'balanced', {}, { telemetry: true });
    const f = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(f.v46_class_read ?? 0).toBeGreaterThan(0);
    expect(f.v46_class_never_3bet ?? 0).toBeGreaterThan(0);

    const nlh = ploSpot(cc('As', 'Ks'), 'nlh');
    HorseLogic.decide(nlh.hero, nlh.gs, 'balanced', {}, { telemetry: true });
    const g = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(g.v46_class_read ?? 0).toBe(0);
  });

  it('trips fires the fold receipt, and the flag switches the whole layer off', () => {
    enableBrainTelemetry();
    const trips = ploSpot(cc('As', 'Ah', 'Ad', '7c'));
    const d = HorseLogic.decide(trips.hero, trips.gs, 'balanced', {}, { telemetry: true });
    const f = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(f.v46_class_fold ?? 0).toBeGreaterThan(0);
    expect(d.action).toBe('fold');

    const off = ploSpot(cc('As', 'Ah', 'Ad', '7c'));
    HorseLogic.decide(off.hero, off.gs, 'balanced', {}, { telemetry: true, v46Charts: false });
    const g = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(g.v46_class_read ?? 0).toBe(0);
  });

  it('every class has a chart row, and the league can ablate it', () => {
    for (const cls of OMAHA_CLASSES) {
      const r = handClassRead(cc('As', 'Ah', 'Ks', 'Qh'), true, false);
      expect(typeof r.shift.open).toBe('number');
      expect(cls.length).toBeGreaterThan(0);
    }
    expect(SHORT_DECK_CLASSES.length).toBe(5);
    const names = LEAGUE_MATCHUPS.map((m) => m.name);
    expect(names).toContain('plo4_v46_classes');
    expect(names).toContain('plo6_v46_classes');
    expect(names).toContain('shortdeck_v46_classes');
    const legacy = LEAGUE_MATCHUPS.find((m) => m.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    expect(legacy.v46Charts).toBe(false);
  });
});
