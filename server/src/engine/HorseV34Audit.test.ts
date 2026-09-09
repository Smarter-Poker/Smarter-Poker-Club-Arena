/**
 * V34 — the 2026-09-02 horse-brain audit. Every pin here is a defect that
 * was live in production when the audit ran, measured before it was fixed:
 *
 *  - the button opened 23% of hands (like a cutoff), the blinds folded 62%
 *    to a button open, the SB folded-to at a full ring opened 76% like a
 *    heads-up button;
 *  - a PLO tournament big blind at 25bb had NO call: 82-86% fold, the rest
 *    pot re-raises, because the pot-limit "commitment zone" swallowed every
 *    facing-a-raise decision down to a 34%-of-stack re-raise;
 *  - the V32 solver defence called 84% of the bets it judged (raw equity vs
 *    pot odds, no realization), and while a cell existed no semi-bluff
 *    raise line could ever fire;
 *  - the sb_push chart answered an SB 3-bet jam over an open as if it were
 *    an open-jam;
 *  - post_aggr/post_passive were flushed but never merged by
 *    upsert_horse_mind_stats, and the river read / check counters were never
 *    persisted at all — every deploy forgot them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { decidePreflopV7, type PreflopCtx } from './HorsePreflop.js';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { realizationFactor, gtoFacingDefense, solverBettingRange } from './GtoFacingDefenseV32.js';
import { setGtoPostflop, _clearGtoPostflop, textureClass } from './GtoPostflop.js';
import { _clearGtoPostflopV31 } from './GtoPostflopV31.js';
import { setGtoCharts, _clearGtoCharts } from './GtoCharts.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit, SeatPlayer } from '../types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}

function ctx(o: Partial<PreflopCtx>): PreflopCtx {
  return {
    strength: 0.5,
    position: 'late',
    raiserPosition: null,
    raises: 0,
    limpers: 0,
    callers: 0,
    oppsLeft: 5,
    toCall: 2,
    currentBet: 2,
    pot: 3,
    bigBlind: 2,
    stack: 200,
    stackBB: 100,
    tightness: 1,
    bluffFreq: 0.17,
    aggression: 1,
    slowplayFreq: 0.1,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0,
    mode: 'cash',
    anteOrbitBB: 0,
    tableSize: 6,
    rand: () => 0.99,
    ...o,
  };
}

beforeEach(() => seedFastRandom(0x5eed34));

/** Replayable xorshift32 for the MC-driven pins (a constant rand degenerates the sampler). */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

describe('V34 preflop ranges read against the real scale', () => {
  it('the button opens hands the cutoff folds (a button is not a second cutoff)', () => {
    const hand = ctx({ strength: 0.33, position: 'late' });
    expect(decidePreflopV7({ ...hand, isButton: false }).a).toBe('fold');
    expect(decidePreflopV7({ ...hand, isButton: true }).a).toBe('raiseTo');
    // and a genuine cutoff hand still opens from the cutoff
    expect(decidePreflopV7({ ...ctx({ strength: 0.41 }), isButton: false }).a).toBe('raiseTo');
  });

  it('full ring under the gun is tighter than a 6-max lojack', () => {
    const hand = ctx({ strength: 0.58, position: 'early' });
    expect(decidePreflopV7({ ...hand, tableSize: 6 }).a).toBe('raiseTo');
    expect(decidePreflopV7({ ...hand, tableSize: 9 }).a).toBe('fold');
  });

  it('the big blind defends a late steal wider than an early open', () => {
    const face = (vs: 'early' | 'late') =>
      decidePreflopV7(
        ctx({
          strength: 0.25,
          position: 'bb',
          raises: 1,
          raiserPosition: vs,
          oppsLeft: 1,
          toCall: 3,
          currentBet: 5,
          pot: 8,
        })
      ).a;
    expect(face('late')).toBe('call');
    expect(face('early')).toBe('fold');
  });

  it('an ante widens the big blind defence a notch further', () => {
    const face = (anteInPlay: boolean) =>
      decidePreflopV7(
        ctx({
          strength: 0.2,
          position: 'bb',
          raises: 1,
          raiserPosition: 'late',
          oppsLeft: 1,
          toCall: 2.4,
          currentBet: 4.4,
          pot: 7.4,
          mode: 'tournament',
          anteInPlay,
          anteOrbitBB: anteInPlay ? 1 : 0,
        })
      ).a;
    expect(face(true)).toBe('call');
    expect(face(false)).toBe('fold');
  });

  it('a ring small blind folded to does not open like a heads-up button', () => {
    const sb = ctx({
      strength: 0.27,
      position: 'sb',
      oppsLeft: 1,
      toCall: 1,
      currentBet: 2,
      pot: 3,
      rand: () => 0.99,
    });
    expect(decidePreflopV7({ ...sb, tableSize: 2 }).a).toBe('raiseTo');
    expect(decidePreflopV7({ ...sb, tableSize: 6 }).a).not.toBe('raiseTo');
    // the ring SB still opens a real blind-vs-blind range
    expect(decidePreflopV7({ ...sb, tableSize: 6, strength: 0.32 }).a).toBe('raiseTo');
  });
});

describe('V34 a PLO tournament blind can CALL a raise at 25bb', () => {
  const bbVsOpen = (strength: number, stackBB: number) =>
    decidePreflopV7(
      ctx({
        strength,
        position: 'bb',
        raises: 1,
        raiserPosition: 'late',
        oppsLeft: 1,
        toCall: 2.4,
        currentBet: 4.4,
        pot: 7.4,
        bigBlind: 2,
        stack: stackBB * 2 - 2,
        stackBB: stackBB - 1,
        isOmaha: true,
        isPotLimit: true,
        mode: 'tournament',
        anteInPlay: true,
        anteOrbitBB: 1,
        ploTourney: true,
        ploPriceDefense: true,
      })
    ).a;

  it('a medium hand at 25bb calls a 2.2x open instead of pot-or-fold', () => {
    // Before V34 this spot returned only 'raiseTo' or 'fold' (commitRatio
    // 0.34 >= 0.25 put every 25bb blind in the commitment zone).
    expect(bbVsOpen(0.5, 25)).toBe('call');
  });

  it('a strong hand at 25bb still re-raises (the reshove survives)', () => {
    expect(bbVsOpen(0.9, 25)).toBe('raiseTo');
  });

  it('a genuinely short stack keeps the commitment zone: pot it or fold', () => {
    const a = bbVsOpen(0.5, 9);
    expect(['raiseTo', 'fold']).toContain(a);
  });
});

describe('V34 realization: the solver defence needs more than raw pot odds', () => {
  it('the river realizes everything, the flop out of position the least', () => {
    expect(realizationFactor({ street: 'river', inPosition: false })).toBe(1);
    expect(realizationFactor({ street: 'flop', inPosition: false })).toBeLessThan(
      realizationFactor({ street: 'flop', inPosition: true })
    );
    expect(realizationFactor({ street: 'flop', inPosition: true })).toBeLessThan(
      realizationFactor({ street: 'turn', inPosition: true })
    );
    expect(realizationFactor({ street: 'flop', inPosition: false, drawy: true })).toBeGreaterThan(
      realizationFactor({ street: 'flop', inPosition: false })
    );
  });

  const BOARD = cards('Ks9d7c');
  beforeEach(() => {
    _clearGtoPostflop();
    _clearGtoPostflopV31();
    const tex = textureClass(BOARD)!;
    // The bettor bets small with everything: a pure range, so hero's equity
    // against it is hero's equity against random-ish holdings.
    const matrix: Record<string, Record<string, number>> = {};
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    for (let i = 0; i < ranks.length; i++) {
      for (let j = i; j < ranks.length; j++) {
        if (i === j) matrix[ranks[j] + ranks[i]] = { bet_small: 1 };
        else {
          matrix[ranks[j] + ranks[i] + 's'] = { bet_small: 1 };
          matrix[ranks[j] + ranks[i] + 'o'] = { bet_small: 1 };
        }
      }
    }
    setGtoPostflop([
      {
        street: 'flop',
        game_family: 'cash',
        position: 'SB',
        depth_bucket: 80,
        texture_class: tex,
        facing: 'open',
        hand_matrix: matrix,
      },
    ]);
  });
  afterEach(() => {
    _clearGtoPostflop();
    _clearGtoPostflopV31();
  });

  it('a range exists for the stocked cell', () => {
    const r = solverBettingRange({
      street: 'flop',
      family: 'cash',
      bettorPosition: 'SB',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('6h5h'),
      betFraction: 0.5,
    });
    expect(r).not.toBeNull();
  });

  it('required equity rises with lower realization and with rake, never on the river', () => {
    const base = {
      street: 'flop' as const,
      family: 'cash' as const,
      bettorPosition: 'SB',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('6h5h'),
      pot: 150,
      toCall: 50,
    };
    const raw = gtoFacingDefense({ ...base, rand: prng(7), realization: 1 });
    const oop = gtoFacingDefense({ ...base, rand: prng(7), realization: 0.75 });
    const raked = gtoFacingDefense({ ...base, rand: prng(7), realization: 1, rakeMarg: 0.1 });
    const icm = gtoFacingDefense({ ...base, rand: prng(7), realization: 1, riskPremium: 0.06 });
    expect(raw && oop && raked && icm).toBeTruthy();
    expect(icm!.required).toBeCloseTo(raw!.required + 0.06, 6);
    expect(raw!.potOdds).toBeCloseTo(50 / 200, 6);
    expect(raw!.required).toBeCloseTo(raw!.potOdds, 6);
    expect(oop!.required).toBeCloseTo(raw!.potOdds / 0.75, 6);
    expect(raked!.required).toBeGreaterThan(raw!.required);
  });

  it('a hand that clears raw pot odds but not realized odds now folds', () => {
    // 50 into 150 is a 3-to-1 price: 25% raw. Hero's weak holding sits in
    // the band that realization is meant to move.
    const base = {
      street: 'flop' as const,
      family: 'cash' as const,
      bettorPosition: 'SB',
      stackBB: 80,
      board: BOARD,
      pot: 150,
      toCall: 50,
    };
    // Find a holding whose equity lands between 0.25 and 0.334 vs the range.
    let found = false;
    for (const hole of ['4h3h', '6h5h', '8s6s', 'Jd2d', 'Qs3s', '5d4c', 'Td8d', 'Js8s']) {
      const d = gtoFacingDefense({
        ...base,
        heroCards: cards(hole),
        rand: prng(11),
        realization: 1,
      });
      if (!d || d.action === 'pass_strong') continue;
      if (d.equity >= 0.25 && d.equity < 1 / 3) {
        const oop = gtoFacingDefense({
          ...base,
          heroCards: cards(hole),
          rand: prng(11),
          realization: 0.75,
        });
        expect(d.action).toBe('call');
        expect(oop!.action).toBe('fold');
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

describe('V34 a solver call with a draw still lets the semi-bluff raise roll', () => {
  const BOARD = cards('Ks9d7c');
  function state(hole: string): { hero: SeatPlayer; gs: Record<string, unknown> } {
    const players = [
      {
        seat: 1,
        user_id: 'hero',
        username: 'hero',
        stack: 8000,
        bet: 0,
        totalInvested: 250,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        cards: cards(hole),
      },
      {
        seat: 2,
        user_id: 'villain',
        username: 'villain',
        stack: 8000,
        bet: 250,
        totalInvested: 500,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        cards: [],
      },
    ];
    return {
      hero: players[0],
      gs: {
        players,
        communityCards: BOARD,
        pot: 750,
        currentBet: 250,
        minRaise: 250,
        stage: 'flop',
        gameVariant: 'nlh',
        gameMode: 'cash',
        bigBlind: 100,
        dealerSeat: 2,
        actionHistory: [
          {
            stage: 'preflop',
            seat: 2,
            userId: 'villain',
            action: 'raise',
            amount: 250,
            timestamp: 1,
          },
          { stage: 'preflop', seat: 1, userId: 'hero', action: 'call', amount: 150, timestamp: 2 },
          { stage: 'flop', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 3 },
          { stage: 'flop', seat: 2, userId: 'villain', action: 'bet', amount: 250, timestamp: 4 },
        ],
      },
    };
  }
  beforeEach(() => {
    _clearGtoPostflop();
    _clearGtoPostflopV31();
    HorseMind.reset();
    const tex = textureClass(BOARD)!;
    const matrix: Record<string, Record<string, number>> = {};
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    for (let i = 0; i < ranks.length; i++)
      for (let j = i; j < ranks.length; j++) {
        if (i === j) matrix[ranks[j] + ranks[i]] = { bet_small: 1 };
        else {
          matrix[ranks[j] + ranks[i] + 's'] = { bet_small: 1 };
          matrix[ranks[j] + ranks[i] + 'o'] = { bet_small: 1 };
        }
      }
    setGtoPostflop([
      {
        street: 'flop',
        game_family: 'cash',
        position: 'SB',
        depth_bucket: 80,
        texture_class: tex,
        facing: 'open',
        hand_matrix: matrix,
      },
    ]);
    enableBrainTelemetry();
    drainFires();
  });
  afterEach(() => {
    _clearGtoPostflop();
    _clearGtoPostflopV31();
    HorseMind.reset();
  });

  it('a straight draw facing a bet is sometimes raised, never folded, over many rolls', () => {
    let raises = 0;
    let folds = 0;
    let calls = 0;
    let passthrough = 0;
    for (let i = 0; i < 300; i++) {
      // Td8d on Ks9d7c: an open-ended straight draw, no pair.
      const s = state('Td8d');
      const d = HorseLogic.decide(s.hero, s.gs as never, 'lag', {}, { telemetry: true });
      if (d.action === 'raise' || d.action === 'all_in') raises++;
      else if (d.action === 'fold') folds++;
      else calls++;
      const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
      if (fires['v34_defend_draw_passthrough']) passthrough++;
    }
    expect(passthrough).toBeGreaterThan(0);
    expect(folds).toBe(0);
    expect(calls).toBeGreaterThan(0);
    expect(raises).toBeGreaterThan(0);
  });
});

const fireOf = (f: string): number =>
  Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]))[f] ?? 0;

describe('V34 the sb_push chart answers only an SB open-jam', () => {
  beforeEach(() => {
    _clearGtoCharts();
    setGtoCharts([
      {
        game_type: 'Cash',
        stack_depth: 10,
        hero_position: 'BB',
        villain_action: 'sb_push',
        hand_matrix: { '72o': { call: 1, fold: 0 } }, // absurd on purpose: only a chart would call
      },
    ]);
    enableBrainTelemetry();
    drainFires();
  });
  afterEach(() => {
    _clearGtoCharts();
  });

  function bbState(
    history: Array<{ seat: number; userId: string; action: string; amount: number }>
  ) {
    const players = [
      {
        seat: 1,
        user_id: 'sb',
        username: 'sb',
        stack: 0,
        bet: 20,
        totalInvested: 20,
        is_folded: false,
        is_all_in: true,
        is_sitting_out: false,
        cards: [],
      },
      {
        seat: 2,
        user_id: 'hero',
        username: 'hero',
        stack: 18,
        bet: 2,
        totalInvested: 2,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        cards: cards('7h2d'),
      },
      {
        seat: 3,
        user_id: 'utg',
        username: 'utg',
        stack: 195,
        bet: 0,
        totalInvested: 5,
        is_folded: true,
        is_all_in: false,
        is_sitting_out: false,
        cards: [],
      },
    ];
    return {
      hero: players[1] as SeatPlayer,
      gs: {
        players,
        communityCards: [],
        pot: 27,
        currentBet: 20,
        minRaise: 15,
        stage: 'preflop',
        gameVariant: 'nlh',
        gameMode: 'cash',
        bigBlind: 2,
        dealerSeat: 3,
        actionHistory: history.map((h, i) => ({ ...h, stage: 'preflop', timestamp: i + 1 })),
      },
    };
  }

  it('an SB open-jam consults the chart', () => {
    const s = bbState([
      { seat: 3, userId: 'utg', action: 'fold', amount: 0 },
      { seat: 1, userId: 'sb', action: 'all_in', amount: 20 },
    ]);
    (s.gs.actionHistory[1] as { isFullRaise?: boolean }).isFullRaise = true;
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true, mind: false });
    expect(fireOf('v27_gto_bb_defend')).toBe(1);
  });

  it('an SB 3-bet jam over an open does NOT (a reshove is not an open-jam)', () => {
    const s = bbState([
      { seat: 3, userId: 'utg', action: 'raise', amount: 5 },
      { seat: 1, userId: 'sb', action: 'all_in', amount: 20 },
      { seat: 3, userId: 'utg', action: 'fold', amount: 0 },
    ]);
    (s.gs.actionHistory[1] as { isFullRaise?: boolean }).isFullRaise = true;
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true, mind: false });
    expect(fireOf('v27_gto_bb_defend')).toBe(0);
  });
});

describe('V34 the reads survive a deploy: every counter the mind keeps is persisted', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const persistence = readFileSync(join(here, '../services/HorseMindPersistence.ts'), 'utf8');
  const migration = readFileSync(
    join(
      here,
      '../../../supabase/migrations/20260902232420_horse_mind_persist_postflop_af_and_river_reads.sql'
    ),
    'utf8'
  );

  it('the flush carries the postflop AF, the river read and the check counters', () => {
    for (const col of [
      'post_aggr',
      'post_passive',
      'river_bet_opps',
      'river_bet_folds',
      'checks',
      'r_checks',
    ]) {
      expect(persistence).toContain(col + ':');
    }
  });

  it('the hydrate selects them back', () => {
    const select = persistence.match(/'user_id,hands,[^']+'/)?.[0] ?? '';
    for (const col of ['post_aggr', 'river_bet_opps', 'river_bet_folds', 'checks', 'r_checks']) {
      expect(select).toContain(col);
    }
  });

  it('the merge function GREATEST-merges the counters the 08-31 migration forgot', () => {
    expect(migration).toMatch(/post_aggr\s+= GREATEST\(t\.post_aggr, EXCLUDED\.post_aggr\)/);
    expect(migration).toMatch(/post_passive\s+= GREATEST/);
    expect(migration).toMatch(/river_bet_folds\s+= GREATEST/);
    expect(migration).toMatch(/checks\s+= GREATEST/);
    expect(migration).toMatch(/r_checks\s+= EXCLUDED\.r_checks/);
  });
});
