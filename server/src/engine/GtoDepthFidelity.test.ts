/**
 * PHASE 3 — DEPTH FIDELITY (2026-08-31).
 *
 * Two fixes, one theme: which depth cell answers, and whether anyone can
 * tell.
 *
 * 1. THE 10bb FALLBACK. The lookup comment always promised "the neighbouring
 *    bucket"; the code delivered `[depth, ...DEPTH_BUCKETS].slice(0,2)`,
 *    whose second element is DEPTH_BUCKETS[0] = 10 for every depth but 10.
 *    A 150bb hero whose 150 cell was missing was answered with 10bb
 *    strategy — the jam-happiest cells in the warehouse, served at the one
 *    depth where jamming is most wrong. depthCandidates() now orders by
 *    log-distance from the RAW stack.
 *
 * 2. EFFECTIVE STACK. Cells are keyed by eff_stack_bb (the shorter stack —
 *    what the solver solved for), but the consult keyed on hero's stack
 *    alone: a 100bb hero against a 25bb villain consulted the 80 cell for a
 *    pot only ~25bb can ever enter. Known deferred gap from Phase 1.
 *
 * 3. gto_depth_fallback: a neighbour-cell answer now COUNTS itself, so hit
 *    rate splits into "right cell" and "degraded" instead of lumping them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  depthCandidates,
  snapDepthBucket,
  setGtoPostflop,
  _clearGtoPostflop,
  textureClass,
  gtoStreetAdvice,
} from './GtoPostflop.js';
import { _clearGtoPostflopV31 } from './GtoPostflopV31.js';
import { HorseLogic } from './HorseLogic.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}

beforeEach(() => {
  _clearGtoPostflop();
  _clearGtoPostflopV31();
});

describe('depthCandidates - nearest first, in log space', () => {
  it('THE REGRESSION: a deep stack never falls back to the 10bb cell', () => {
    expect(depthCandidates(150)).toEqual([150, 80]);
    expect(depthCandidates(200)).toEqual([150, 80]);
    expect(depthCandidates(100)).toEqual([80, 150]);
  });

  it('mid stacks pick their true neighbours', () => {
    expect(depthCandidates(35)).toEqual([40, 20]);
    expect(depthCandidates(50)).toEqual([40, 80]);
    expect(depthCandidates(25)).toEqual([20, 40]);
    expect(depthCandidates(30)).toEqual([20, 40]); // snap wins the primary
  });

  it('short stacks: the only depths where the old fallback was already right', () => {
    expect(depthCandidates(8)).toEqual([10, 20]);
    // snap(15) is 20 (the <=12 boundary), and its log-nearest other is 10 —
    // identical to the old behaviour at this one depth.
    expect(depthCandidates(15)).toEqual([20, 10]);
  });

  /**
   * THE INVARIANT THAT KEEPS THIS CHANGE A FALLBACK FIX AND NOT A RE-HOMING:
   * the primary is snapDepthBucket for every stack, including the depths
   * where log-nearest disagrees with the hand-tuned snap boundaries
   * (snap(30) = 20 while 40 is log-nearer). Cells were built against the
   * snap boundaries; only the fallback may use log distance.
   */
  it('the primary is always snapDepthBucket, so no live hit changes cell', () => {
    for (const bb of [5, 12, 15, 18, 30, 45, 70, 100, 140, 250]) {
      expect(depthCandidates(bb)[0], `${bb}bb`).toBe(snapDepthBucket(bb));
    }
  });

  it('the two candidates are never the same bucket', () => {
    for (const bb of [5, 15, 30, 60, 110, 200]) {
      const [a, b] = depthCandidates(bb);
      expect(a).not.toBe(b);
    }
  });

  it('garbage in, 40bb default out - matching snapDepthBucket', () => {
    expect(depthCandidates(0)[0]).toBe(40);
    expect(depthCandidates(NaN)[0]).toBe(40);
  });
});

const BOARD = cards('Ks9d7c2h');

describe('the fallback actually serves the neighbour now', () => {
  it('a 150bb spot with only an 80 cell answers from 80 - and only-10 stays silent', () => {
    const tex = textureClass(BOARD)!;
    const mk = (depth: number) =>
      ({
        street: 'turn',
        game_family: 'cash',
        position: 'BTN',
        depth_bucket: depth,
        texture_class: tex,
        facing: 'open',
        hand_matrix: { AKs: { check: 1.0 } },
      }) as never;

    setGtoPostflop([mk(80)]);
    const fromNeighbour = gtoStreetAdvice({
      street: 'turn',
      family: 'cash',
      position: 'BTN',
      stackBB: 150,
      board: BOARD,
      hand: 'AKs',
    });
    expect(fromNeighbour).not.toBeNull();
    expect(fromNeighbour!.cell).toContain('|80|');

    _clearGtoPostflop();
    setGtoPostflop([mk(10)]);
    const fromTen = gtoStreetAdvice({
      street: 'turn',
      family: 'cash',
      position: 'BTN',
      stackBB: 150,
      board: BOARD,
      hand: 'AKs',
    });
    // The old code would have ANSWERED here, with 10bb strategy at 150bb.
    expect(fromTen).toBeNull();
  });
});

describe('effective stack keys the cell', () => {
  /** Heads-up turn, hero on the BTN(SB) with the lead, checked to hero. */
  function state(heroStack: number, villainStack: number) {
    return {
      players: [
        {
          seat: 1,
          user_id: 'hero',
          stack: heroStack,
          bet: 0,
          is_folded: false,
          is_sitting_out: false,
          cards: cards('AsKs'),
        },
        {
          seat: 2,
          user_id: 'villain',
          stack: villainStack,
          bet: 0,
          is_folded: false,
          is_sitting_out: false,
          cards: [],
        },
      ],
      communityCards: BOARD,
      pot: 400,
      currentBet: 0,
      minRaise: 100,
      stage: 'turn',
      gameVariant: 'nlh',
      gameMode: 'cash',
      bigBlind: 100,
      smallBlind: 50,
      dealerSeat: 1,
      actionHistory: [
        { stage: 'preflop', seat: 1, userId: 'hero', action: 'raise', amount: 300 },
        { stage: 'preflop', seat: 2, userId: 'villain', action: 'call', amount: 300 },
      ],
    };
  }

  it('a 100bb hero against a 25bb villain consults the SHORT cell', () => {
    const tex = textureClass(BOARD)!;
    // ONLY a depth-20 cell exists. Keyed on hero's stack (100bb -> 80, then
    // neighbour 150) this can never hit; keyed on the effective 25bb it does.
    setGtoPostflop([
      {
        street: 'turn',
        game_family: 'cash',
        position: 'SB',
        depth_bucket: 20,
        texture_class: tex,
        facing: 'open',
        hand_matrix: { AKs: { check: 1.0 } },
      } as never,
    ]);
    enableBrainTelemetry();
    drainFires();
    const st = state(10000, 2500);
    for (let i = 0; i < 8; i++)
      HorseLogic.decide(st.players[0] as never, st as never, 'balanced', {}, {
        telemetry: true,
      } as never);
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    // v30_gto_turn_open firing proves the 20 cell answered a "100bb" hero.
    expect(fires['v30_gto_turn_open'] ?? 0).toBe(8);
  });

  it('and the neighbour-cell answer counts itself as degraded', () => {
    const tex = textureClass(BOARD)!;
    // effective 25bb -> primary 20 missing, neighbour 40 present
    setGtoPostflop([
      {
        street: 'turn',
        game_family: 'cash',
        position: 'SB',
        depth_bucket: 40,
        texture_class: tex,
        facing: 'open',
        hand_matrix: { AKs: { check: 1.0 } },
      } as never,
    ]);
    enableBrainTelemetry();
    drainFires();
    const st = state(10000, 2500);
    for (let i = 0; i < 8; i++)
      HorseLogic.decide(st.players[0] as never, st as never, 'balanced', {}, {
        telemetry: true,
      } as never);
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(fires['gto_depth_fallback'] ?? 0).toBe(8);
    expect(fires['v30_gto_turn_open'] ?? 0).toBe(8);
  });

  it('a primary-cell answer does NOT count as degraded', () => {
    const tex = textureClass(BOARD)!;
    setGtoPostflop([
      {
        street: 'turn',
        game_family: 'cash',
        position: 'SB',
        depth_bucket: 20,
        texture_class: tex,
        facing: 'open',
        hand_matrix: { AKs: { check: 1.0 } },
      } as never,
    ]);
    enableBrainTelemetry();
    drainFires();
    const st = state(10000, 2500);
    for (let i = 0; i < 8; i++)
      HorseLogic.decide(st.players[0] as never, st as never, 'balanced', {}, {
        telemetry: true,
      } as never);
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(fires['gto_depth_fallback'] ?? 0).toBe(0);
  });
});
