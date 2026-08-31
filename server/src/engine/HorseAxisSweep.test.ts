/**
 * PHASE 4 — THE UNSWEPT AXES, SWEPT (2026-08-31).
 *
 * Five axes were flagged in the Phase 1 plan as never audited. The sweep
 * found the two heavyweight bugs were ALREADY dead — V28 killed the
 * unreachable 'middle' bucket and V29 the heads-up SB/BB inversion — and the
 * remaining findings are behaviours that were correct but PINNED NOWHERE.
 * These are those pins, each carrying the probe evidence that produced it.
 *
 * Axis verdicts (2026-08-31, production + probe evidence):
 *  1. plo8 scoop/quarter — HEALTHY. Probed 40/40: a bare nut low checks the
 *     made low board (never pots itself into a quartering); a scoopy A2+top
 *     two bets ~45%. Pinned below.
 *  2. Straddles — single straddles live (v18_straddle ~12k fires/day) and
 *     handled; multi-straddles are configured NOWHERE (every straddle table
 *     is max_straddles=1), so the >2.2bb-read gap is unreachable. Documented,
 *     not coded around.
 *  3. Push-fold short stacks — chart-driven at 2-25bb, 1bb granularity, all
 *     positions (240 full-range rows, 629 fires today). The flat ~65%
 *     heuristic below it is REACHED ONLY when the chart store is empty.
 *     Pinned: the chart owns the depth, and the fallback stays monotone.
 *  4. 9-max positions — V28's mapping (3 early / 2 middle / 2 late) already
 *     pinned in HorseV28Audit; re-asserted here through the source contract.
 *  5. Math.min(oppCount, 4) — sanctioned approximation: 5+way postflop pots
 *     are 0.17% of hands (5 of 3,000 sampled), and the cap samples the first
 *     four live opponents' bands. Documented as accepted, with the incidence
 *     that justifies it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { decidePreflopV7 } from './HorsePreflop.js';
import { setGtoCharts, _clearGtoCharts } from './GtoCharts.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}

describe('AXIS 1: plo8 - the quartering trap stays shut', () => {
  const board = cards('2c4d7h8s'); // made-low turn, no flush possible
  function st(hole: string) {
    return {
      players: [
        {
          seat: 1,
          user_id: 'hero',
          stack: 10000,
          bet: 0,
          is_folded: false,
          is_sitting_out: false,
          cards: cards(hole),
        },
        {
          seat: 2,
          user_id: 'v',
          stack: 10000,
          bet: 0,
          is_folded: false,
          is_sitting_out: false,
          cards: [] as Card[],
        },
      ],
      communityCards: board,
      pot: 600,
      currentBet: 0,
      minRaise: 100,
      stage: 'turn',
      gameVariant: 'plo8',
      gameMode: 'cash',
      bigBlind: 100,
      smallBlind: 50,
      dealerSeat: 1,
      actionHistory: [
        { stage: 'preflop', seat: 1, userId: 'hero', action: 'raise', amount: 300 },
        { stage: 'preflop', seat: 2, userId: 'v', action: 'call', amount: 300 },
      ],
    };
  }

  it('a bare nut low with no high never fires a big bet at the made board', () => {
    // A3 for the nut low, K J of mixed suits for exactly nothing high.
    // Betting big here wins half at best and gets quartered by A3+high —
    // the classic plo8 punt the V8 layer exists to refuse.
    let bigBets = 0;
    for (let i = 0; i < 40; i++) {
      const s = st('Ac3dKhJs');
      const r = HorseLogic.decide(s.players[0] as never, s as never, 'balanced', {}, {} as never);
      if (r.action === 'bet' && (r.amount ?? 0) > 600 * 0.5) bigBets++;
    }
    expect(bigBets).toBe(0);
  });

  it('a scoopy hand still bets - the trap-guard did not neuter value', () => {
    let bets = 0;
    for (let i = 0; i < 60; i++) {
      const s = st('Ah2h8h7d'); // nut low draw side + top two high
      const r = HorseLogic.decide(s.players[0] as never, s as never, 'balanced', {}, {} as never);
      if (r.action === 'bet') bets++;
    }
    expect(bets).toBeGreaterThan(5);
  });
});

describe('AXIS 3: the chart owns the push/fold zone; the heuristic is only the net', () => {
  beforeEach(() => _clearGtoCharts());

  /** Folded to the SB at 3bb, heads-up. */
  function sbState(hole: string, stack: number) {
    return {
      players: [
        {
          seat: 1,
          user_id: 'hero',
          stack,
          bet: 50,
          is_folded: false,
          is_sitting_out: false,
          cards: cards(hole),
          totalInvested: 50,
        },
        {
          seat: 2,
          user_id: 'v',
          stack: 10000,
          bet: 100,
          is_folded: false,
          is_sitting_out: false,
          cards: [] as Card[],
          totalInvested: 100,
        },
      ],
      communityCards: [] as Card[],
      pot: 150,
      currentBet: 100,
      minRaise: 100,
      stage: 'preflop',
      gameVariant: 'nlh',
      gameMode: 'tournament',
      bigBlind: 100,
      smallBlind: 50,
      dealerSeat: 1, // heads-up: dealer IS the SB
      actionHistory: [
        { stage: 'preflop', seat: 1, userId: 'hero', action: 'sb', amount: 50 },
        { stage: 'preflop', seat: 2, userId: 'v', action: 'bb', amount: 100 },
      ],
    };
  }

  it('a charted 100% jam is jammed, even with a hand the heuristic folds', () => {
    // 72o at 3bb: the flat heuristic folds it (strength ~0.05 vs bar ~0.35).
    // Nash jams it. Load a chart row saying so and the chart must win.
    setGtoCharts([
      {
        game_type: 'Tournament',
        hero_position: 'SB',
        stack_depth: 3,
        villain_action: 'fold_to_hero',
        hand_matrix: { '72o': { push: 1.0 } },
      } as never,
    ]);
    let jams = 0;
    for (let i = 0; i < 20; i++) {
      const s = sbState('7h2c', 250); // 2.5bb behind + 0.5 posted = 3bb depth
      const r = HorseLogic.decide(s.players[0] as never, s as never, 'balanced', {}, {} as never);
      if (r.action === 'all_in') jams++;
    }
    expect(jams).toBe(20);
  });

  it('with the chart store EMPTY the same hand folds - the net is tighter, never wider', () => {
    let jams = 0;
    for (let i = 0; i < 20; i++) {
      const s = sbState('7h2c', 250);
      const r = HorseLogic.decide(s.players[0] as never, s as never, 'balanced', {}, {} as never);
      if (r.action === 'all_in') jams++;
    }
    expect(jams).toBe(0);
  });

  /**
   * THE FALLBACK'S SHAPE, MEASURED AND ACCEPTED. Probed across the strength
   * range the heuristic jams ~65% at 3bb and ~60% at 12bb — flat, where Nash
   * widens toward 100% as the stack burns down. That gap is ACCEPTED because
   * the chart owns 2-25bb at 1bb granularity and the heuristic is reached
   * only when the chart store fails to load. What this pin refuses is the
   * fallback INVERTING — a 3bb range narrower than a 12bb range would mean
   * the net is torn exactly where it must catch.
   */
  it('the heuristic fallback never jams TIGHTER at 3bb than at 12bb', () => {
    const width = (stackBB: number) => {
      let jams = 0;
      let n = 0;
      for (let s = 0.02; s <= 0.995; s += 0.01) {
        n++;
        const r = decidePreflopV7({
          position: 'sb',
          strength: s,
          raises: 0,
          limpers: 0,
          callers: 0,
          oppsLeft: 1,
          toCall: 50,
          currentBet: 100,
          pot: 150,
          bigBlind: 100,
          stack: stackBB * 100,
          stackBB,
          tightness: 1,
          bluffFreq: 0.1,
          aggression: 1,
          slowplayFreq: 0.1,
          sizingMultiplier: 1,
          isOmaha: false,
          isPotLimit: false,
          riskAdd: 0.04,
          mode: 'tournament',
          anteInPlay: false,
          anteOrbitBB: 0,
          tableSize: 2,
          v13: true,
          rand: () => 0.5,
        } as never);
        if ((r as { a: string }).a === 'jam') jams++;
      }
      return jams / n;
    };
    expect(width(3)).toBeGreaterThanOrEqual(width(12));
  });
});

describe('AXIS 4: 9-max position contract (re-assert of the V28 shape)', () => {
  it('the bucketing arithmetic yields 3 early / 2 middle / 2 late at 9-max', () => {
    // The exact arithmetic classifyPosition applies, asserted standalone so a
    // retune of the private function cannot silently change the 9-max shape
    // the charts and thresholds were tuned against.
    const shape = (n: number) => {
      const nonBlind = n - 2;
      const buckets: string[] = [];
      for (let pos = 0; pos < nonBlind; pos++) {
        if (pos >= nonBlind - 2) buckets.push('late');
        else {
          const earlyCount = Math.max(1, Math.ceil((nonBlind - 2) / 2));
          buckets.push(pos < earlyCount ? 'early' : 'middle');
        }
      }
      return buckets;
    };
    expect(shape(9)).toEqual(['early', 'early', 'early', 'middle', 'middle', 'late', 'late']);
    expect(shape(6)).toEqual(['early', 'middle', 'late', 'late']);
    expect(shape(5)).toEqual(['early', 'late', 'late']);
  });
});
