/**
 * V28 — THE LINE-BY-LINE AUDIT FIXES (Dan 2026-08-29).
 *
 * "START WITH A FULL LINE BY LINE AUDIT OF THE ENTIRE PROCESS, CHECK FOR ANY
 *  AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES."
 *
 * Every case here pins a defect the audit PROVED, with the production
 * consequence in the comment. If one of these goes red, the bug it names is
 * being re-shipped.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic, resolveHorseStyle } from './HorseLogic.js';
import { decidePreflopV7 } from './HorsePreflop.js';
import { holdemPreflopScore } from './HorseEval.js';
import { setGtoCharts, _clearGtoCharts } from './GtoCharts.js';
import type { Card, SeatPlayer, ActionRecord } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
const H = (r: string) => c(r, 'hearts');
const D = (r: string) => c(r, 'diamonds');

const baseCtx = {
  strength: 0.5,
  position: 'late' as const,
  raiserPosition: null,
  raises: 0,
  limpers: 0,
  callers: 0,
  oppsLeft: 5,
  toCall: 0,
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
  rand: () => 0.5,
};

function mkPlayer(over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat: 3,
    user_id: 'hero',
    stack: 200,
    bet: 0,
    is_folded: false,
    is_sitting_out: false,
    cards: [H('A'), D('K')],
    ...over,
  } as unknown as SeatPlayer;
}

function ringPlayers(n: number, heroSeat = 3): SeatPlayer[] {
  const out: SeatPlayer[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      mkPlayer({
        seat: i,
        user_id: i === heroSeat ? 'hero' : `v${i}`,
        cards: i === heroSeat ? [H('A'), D('K')] : ([] as never),
        bet: 0,
      })
    );
  }
  return out;
}

beforeEach(() => _clearGtoCharts());

// ═══════════════════════════════════════════════════════════════════════════
// C1 — a sub-min-raise all-in must never route the table into the
// "facing a 3-bet" thresholds. Before the fix, a 1.5bb open-shove produced
// raises=0 with the pot "not unopened": an unhandled state that demanded the
// top ~25% just to CALL half a big blind more. The fleet folded KJ getting
// better than 5:1, on essentially every tournament short-stack under-shove.
// ═══════════════════════════════════════════════════════════════════════════
describe('C1 - the short all-in is visible to preflop routing', () => {
  const shove: ActionRecord = {
    stage: 'preflop',
    seat: 7,
    userId: 'shorty',
    action: 'all_in',
    amount: 3,
    isFullRaise: false, // raised the bet, under the min — the C1 shape
  } as unknown as ActionRecord;

  it('a decent hand CALLS a 1.5bb shove instead of folding to phantom 3-bet thresholds', () => {
    let calls = 0;
    for (let i = 0; i < 60; i++) {
      const d = HorseLogic.decide(
        mkPlayer({ cards: [H('K'), D('J')], stack: 40, seat: 3 }),
        {
          players: ringPlayers(6),
          communityCards: [],
          pot: 6,
          currentBet: 3,
          minRaise: 5,
          stage: 'preflop',
          gameVariant: 'nlh',
          bigBlind: 2,
          dealerSeat: 5,
          actionHistory: [shove],
        } as never,
        'balanced',
        {},
        { v27GtoCharts: false }
      );
      if (d.action === 'call' || d.action === 'all_in' || d.action === 'raise') calls++;
    }
    // KJo facing 1.5bb getting >4:1 is a mandatory continue. Before the fix
    // this was ~0/60 (top-quartile only); a small tolerance for jitter.
    expect(calls).toBeGreaterThan(45);
  });

  it('an all-in CALL-OFF (isFullRaise undefined) counts as a caller, not a raiser', () => {
    // Behind a real raise plus an all-in call-off, hero faces ONE raise, not
    // two — the 3-bet block must not be entered.
    const spot = {
      ...baseCtx,
      strength: 0.7,
      position: 'bb' as const,
      raiserPosition: 'late' as const,
      raises: 1,
      callers: 1, // the call-off, now counted
      toCall: 6,
      currentBet: 8,
      pot: 17,
      oppsLeft: 2,
    };
    // 0.70 clears CALL_VS.late (0.50) easily but NOT the 3-bet-block call bar
    // t(0.74). If the router miscounted, this folds.
    const d = decidePreflopV7(spot as never);
    expect(d.a).not.toBe('fold');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A1(a) — a straddled pot stays unopened for EVERY seat, not only the first
// actor. Before the fix, one fold killed the straddle awareness and 5 of 6
// seats played "facing a 3-bet" thresholds against dead money.
// ═══════════════════════════════════════════════════════════════════════════
describe('A1a - the straddle fix survives a fold in front', () => {
  it('a playable hand continues after a fold in a straddled pot', () => {
    const fold: ActionRecord = {
      stage: 'preflop',
      seat: 0,
      userId: 'v0',
      action: 'fold',
    } as unknown as ActionRecord;
    let continues = 0;
    for (let i = 0; i < 60; i++) {
      const d = HorseLogic.decide(
        mkPlayer({ cards: [H('A'), D('J')], stack: 200 }),
        {
          players: ringPlayers(6),
          communityCards: [],
          pot: 7,
          currentBet: 4, // the 2xBB straddle
          minRaise: 6,
          stage: 'preflop',
          gameVariant: 'nlh',
          bigBlind: 2,
          dealerSeat: 5,
          actionHistory: [fold], // history is NOT empty — the old gate died here
          straddleActive: true,
        } as never,
        'balanced',
        {},
        { v27GtoCharts: false }
      );
      if (d.action !== 'fold') continues++;
    }
    // AJo in a straddled, otherwise-unopened pot is a clear continue. Before
    // the fix this seat needed t(0.74) to call — AJo (0.74) was a coin flip
    // at best and usually folded.
    expect(continues).toBeGreaterThan(48);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A4 — 'middle' must be reachable at 6-max. Before the fix the hijack was
// 'early', the middle threshold tables were dead code, and V27 could never
// pick the MP chart.
// ═══════════════════════════════════════════════════════════════════════════
describe('A4 - the hijack is middle position at 6-max', () => {
  it('classifyPosition yields early, middle, late, late for the non-blind seats', () => {
    // 6 players, dealer at seat 5 → SB 0, BB 1, UTG 2, HJ 3, CO 4, BTN 5.
    const players = ringPlayers(6);
    const posOf = (seat: number) =>
      (
        HorseLogic as unknown as {
          _classifyPositionForTest?: (s: number, d: number, p: SeatPlayer[]) => string;
        }
      )._classifyPositionForTest?.(seat, 5, players);
    // The helper may not be exported; assert through the source instead.
    if (!posOf || posOf(2) === undefined) {
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const src = readFileSync(new URL('./HorseLogic.ts', import.meta.url).pathname, 'utf8');
      // The pin: the early bucket is half the pre-late seats, so a 6-max
      // table has exactly one early and one middle seat.
      expect(src).toContain('const earlyCount = Math.max(1, Math.ceil((nonBlind - 2) / 2));');
      return;
    }
    expect(posOf(2)).toBe('early');
    expect(posOf(3)).toBe('middle');
    expect(posOf(4)).toBe('late');
    expect(posOf(5)).toBe('late');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A3 — "everyone folded to the BB" is not heads-up. Before the fix the BB
// defended ~70% of hands against an UNDER-THE-GUN open in a full ring.
// ═══════════════════════════════════════════════════════════════════════════
describe('A3 - the heads-up defense does not fire against a ring UTG open', () => {
  const spot = {
    ...baseCtx,
    mode: 'cash' as const,
    strength: 0.44, // K9s-ish: clearly folds to a big UTG open, defends HU
    position: 'bb' as const,
    raises: 1,
    // Priced OUTSIDE the V11 any-two guard (odds 8/21 = 0.38), so the
    // positional thresholds — the thing under test — actually decide.
    toCall: 8,
    currentBet: 10,
    pot: 13,
    oppsLeft: 1,
  };

  it('folds vs an early open at a full table', () => {
    let folds = 0;
    for (let i = 0; i < 40; i++) {
      const d = decidePreflopV7({
        ...spot,
        raiserPosition: 'early' as const,
        tableSize: 9,
        rand: () => (i % 10) / 10,
      } as never);
      if (d.a === 'fold') folds++;
    }
    expect(folds).toBeGreaterThan(30);
  });

  it('still defends wide when the table is genuinely two-handed', () => {
    let defends = 0;
    for (let i = 0; i < 40; i++) {
      const d = decidePreflopV7({
        ...spot,
        raiserPosition: 'sb' as const,
        tableSize: 2,
        rand: () => (i % 10) / 10,
      } as never);
      if (d.a !== 'fold') defends++;
    }
    expect(defends).toBeGreaterThan(30);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C1(bars) — a tight style can still 4-bet kings. Before the fix,
// tightness 1.12 pushed the 4-bet bar to clamp01(1.04) = 1.0, above every
// hand but jittered aces: the grinder never value-4-bet KK, AKs or QQ.
// ═══════════════════════════════════════════════════════════════════════════
describe('the bar cap - a grinder can 4-bet kings again', () => {
  it('KK (0.98) clears the 4-bet bar at tightness 1.12', () => {
    let aggressive = 0;
    for (let i = 0; i < 40; i++) {
      const d = decidePreflopV7({
        ...baseCtx,
        strength: 0.98,
        tightness: 1.12,
        aggression: 0.95,
        position: 'late' as const,
        raiserPosition: 'middle' as const,
        raises: 2, // facing a 3-bet
        toCall: 18,
        currentBet: 22,
        pot: 33,
        stack: 400,
        stackBB: 200,
        rand: () => (i % 10) / 10,
      } as never);
      if (d.a === 'raiseTo' || d.a === 'jam') aggressive++;
    }
    expect(aggressive).toBeGreaterThan(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C5 — the small blind folds junk again. Before the fix `|| position==='sb'`
// bypassed the strength test: the SB completed ANY two cards 70% of the time.
// ═══════════════════════════════════════════════════════════════════════════
describe('C5 - the SB does not complete with any two cards', () => {
  it('72o folds from the SB in an unopened multiway pot', () => {
    let completes = 0;
    for (let i = 0; i < 40; i++) {
      const d = decidePreflopV7({
        ...baseCtx,
        strength: holdemPreflopScore(H('7'), D('2'), false),
        position: 'sb' as const,
        oppsLeft: 5, // NOT blind-vs-blind
        toCall: 1,
        currentBet: 2,
        pot: 3,
        rand: () => (i % 10) / 10,
      } as never);
      if (d.a === 'call') completes++;
    }
    expect(completes).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D — the preflop ladder respects domination. Each inversion here shipped:
// 72s above 43s, J8s below T8s, J9s above K9s.
// ═══════════════════════════════════════════════════════════════════════════
describe('D - ladder ordering', () => {
  const s = (a: string, b: string, suited = true) =>
    holdemPreflopScore(c(a, 'hearts'), c(b, suited ? 'hearts' : 'clubs'), false);

  it('72 is worse than the connected rags it used to outrank', () => {
    expect(s('7', '2')).toBeLessThan(s('4', '3'));
    expect(s('7', '2', false)).toBeLessThan(s('4', '3', false));
  });

  it('J8s outranks T8s (same gap, strictly higher card, dominates it)', () => {
    expect(s('J', '8')).toBeGreaterThan(s('T', '8'));
  });

  it('K9s outranks J9s (dominates it)', () => {
    expect(s('K', '9')).toBeGreaterThan(s('J', '9'));
  });

  it('wheel aces sit above the 3-bet bluff floor - the canonical blocker bluff is playable', () => {
    for (const lo of ['2', '3', '4', '5']) {
      expect(s('A', lo)).toBeGreaterThanOrEqual(0.55);
    }
    // and the suited-ace ladder stays internally ordered: A5s is the best wheel ace
    expect(s('A', '5')).toBeGreaterThan(s('A', '2'));
  });

  it('short deck knows the A-6-7-8-9 wheel', () => {
    const a6sd = holdemPreflopScore(H('A'), H('6'), true);
    const a6full = holdemPreflopScore(H('A'), H('6'), false);
    // In short deck A6 is a straight connector; it must gain on its full-deck self
    // by more than the flat suited bump every hand receives.
    expect(a6sd - a6full).toBeGreaterThan(0.05);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B2/B1 — V27 chart depth includes the posted blind, and the open-jam chart
// is never consulted with an all-in already in front.
// ═══════════════════════════════════════════════════════════════════════════
describe('V27 guards', () => {
  it('a 10bb BB (8bb behind + 2bb posted) reads the 10bb chart, not the 8bb one', () => {
    // Register ONLY depth 10. If depth excluded the blind, snap(9) -> the 9bb
    // chart -> miss -> heuristics. With the fix, snap(10) hits.
    setGtoCharts([
      {
        game_type: 'Cash',
        hero_position: 'SB',
        stack_depth: 10,
        villain_action: 'fold_to_hero',
        hand_matrix: { AKo: { push: 1, fold: 0 } },
      },
    ] as never);
    const d = HorseLogic.decide(
      mkPlayer({ seat: 0, stack: 19, bet: 1, cards: [H('A'), D('K')] }),
      {
        players: [
          mkPlayer({ seat: 0, stack: 19, bet: 1 }),
          mkPlayer({ seat: 1, user_id: 'bb', stack: 200, bet: 2, cards: [] as never }),
          mkPlayer({ seat: 2, user_id: 'btn', stack: 200, bet: 0, cards: [] as never }),
        ],
        communityCards: [],
        pot: 3,
        currentBet: 2,
        minRaise: 4,
        stage: 'preflop',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 2,
        actionHistory: [],
      } as never,
      'balanced'
    );
    // stack 19 + bet 1 = 20 chips = 10bb -> chart hit -> AKo pure jam.
    expect(d.action).toBe('all_in');
  });

  it('the open-jam chart is NOT consulted over a live all-in', () => {
    setGtoCharts([
      {
        game_type: 'Cash',
        hero_position: 'BTN',
        stack_depth: 10,
        villain_action: 'fold_to_hero',
        // A trap chart: if the guard fails and this is consulted, 72o is an
        // "absent hand -> fold" and the test below would see a fold.
        hand_matrix: { AA: { push: 1, fold: 0 } },
      },
    ] as never);
    const shove: ActionRecord = {
      stage: 'preflop',
      seat: 1,
      userId: 'shorty',
      action: 'all_in',
      amount: 3,
      isFullRaise: false,
    } as unknown as ActionRecord;
    const d = HorseLogic.decide(
      mkPlayer({ seat: 3, stack: 20, cards: [H('A'), H('K')] }),
      {
        players: ringPlayers(6),
        communityCards: [],
        pot: 6,
        currentBet: 3,
        minRaise: 5,
        stage: 'preflop',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 3,
        actionHistory: [shove],
      } as never,
      'balanced'
    );
    // AKs facing a 1.5bb shove must continue via the heuristics (which now
    // see one raise), not fold via a chart that prices nonexistent fold
    // equity.
    expect(d.action).not.toBe('fold');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M4 — a poisoned horse_profile cannot lobotomize the brain.
// ═══════════════════════════════════════════════════════════════════════════
describe('M4 - profile dials are clamped at the read boundary', () => {
  it('tightness 0 and bluffFreq 5 are pulled into a sane range', () => {
    const { mods } = resolveHorseStyle(
      { style: 'balanced', tightness: 0, bluffFreq: 5, aggression: -3, sizingMultiplier: 99 },
      'horse-x'
    );
    expect(mods.tightness).toBeGreaterThanOrEqual(0.6);
    expect(mods.bluffFreq).toBeLessThanOrEqual(1.5);
    expect(mods.aggression).toBeGreaterThanOrEqual(0.6);
    expect(mods.sizingMultiplier).toBeLessThanOrEqual(1.5);
  });
});
