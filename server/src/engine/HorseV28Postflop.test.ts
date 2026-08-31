/**
 * V28 part 2 — THE POSTFLOP / EVALUATOR / OPPONENT-MODEL AUDIT FIXES
 * (Dan 2026-08-29: "...MOVE ONTO FLOP, TURN AND MOST IMPORTANTLY RIVER.")
 *
 * Each case pins a defect the audit PROVED, with its production consequence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { connectsBoard, nlhNutStatus } from './HorseEval.js';
import type { Card, SeatPlayer, ActionRecord } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
const H = (r: string) => c(r, 'hearts');
const D = (r: string) => c(r, 'diamonds');
const S = (r: string) => c(r, 'spades');
const CL = (r: string) => c(r, 'clubs');

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

// ═══════════════════════════════════════════════════════════════════════════
// A1 — EFFECTIVE-STACK POT ODDS. The largest single leak found: facing a jam
// that dwarfed hero's stack, potOdds priced the full wager. Risk 50 to win
// 200 is 25%; the code demanded ~48% and folded correct calls against any
// covering opponent — worst on short stacks and tournament bubbles.
// ═══════════════════════════════════════════════════════════════════════════
describe('A1 - a covering overbet jam no longer inflates the price', () => {
  it('a strong hand calls off a short stack against a monster covering jam', () => {
    // Hero: top pair top kicker on a dry river, 50 behind, pot was 100,
    // villain jams 500. True price: 50 to win 200 = 25%. TPTK is far ahead
    // of the required equity vs a range; the old code demanded ~48% + commit
    // premiums and folded most of the time.
    let calls = 0;
    for (let i = 0; i < 40; i++) {
      const d = HorseLogic.decide(
        mkPlayer({ stack: 50, bet: 0, cards: [H('A'), D('K')] }),
        {
          players: [
            mkPlayer({ stack: 50 }),
            {
              seat: 1,
              user_id: 'villain',
              stack: 0,
              bet: 500,
              is_folded: false,
              is_all_in: true,
              cards: [],
            },
          ],
          communityCards: [S('A'), D('7'), CL('2'), H('9'), CL('3')],
          pot: 600, // includes the 500 jam
          currentBet: 500,
          minRaise: 1000,
          stage: 'river',
          gameVariant: 'nlh',
          bigBlind: 2,
          dealerSeat: 3,
          actionHistory: [
            {
              stage: 'river',
              seat: 1,
              userId: 'villain',
              action: 'all_in',
              amount: 500,
              isFullRaise: true,
            } as unknown as ActionRecord,
          ],
        } as never,
        'balanced'
      );
      if (d.action === 'call' || d.action === 'all_in') calls++;
    }
    expect(calls).toBeGreaterThan(32);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Evaluator A1 — connectsBoard on a paired board. 32o on K-K-7 "connected"
// with the board's own kings via the fall-through, making the V12/V16
// aggressor conditioning a no-op on ~17% of flops.
// ═══════════════════════════════════════════════════════════════════════════
describe('connectsBoard - the board is not the hand', () => {
  it('32o on K K 7 does NOT connect', () => {
    expect(connectsBoard([D('3'), S('2')], [H('K'), D('K'), CL('7')], false)).toBeLessThan(2);
  });

  it('32o on a K K 7 9 A river does NOT connect either (the river shortcut had the same hole)', () => {
    expect(
      connectsBoard([D('3'), S('2')], [H('K'), D('K'), CL('7'), S('9'), H('A')], false)
    ).toBeLessThan(2);
  });

  it('a pocket pair still counts as contact, and real improvement still reports its category', () => {
    expect(
      connectsBoard([D('5'), S('5')], [H('K'), D('K'), CL('7')], false)
    ).toBeGreaterThanOrEqual(2);
    expect(
      connectsBoard([D('K'), S('9')], [H('K'), D('2'), CL('7')], false)
    ).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Evaluator A3 — playing the board on a monotone five-card river is NOT the
// nut flush. higherFlushRanks defaulted to 0, which every consumer read as
// "nut flush", leaving the stack-off path open for a can-only-chop hand.
// ═══════════════════════════════════════════════════════════════════════════
describe('nlhNutStatus - playing the board flush', () => {
  it('zero suited hole cards on a monotone board reports a dominated flush', () => {
    const ns = nlhNutStatus(
      [H('Q'), H('J')], // no clubs at all
      [CL('A'), CL('K'), CL('9'), CL('5'), CL('3')],
      false
    );
    expect(ns.higherFlushRanks).toBeGreaterThanOrEqual(1);
  });

  it('a real suited hole card still measures against live higher ranks', () => {
    const ns = nlhNutStatus(
      [CL('Q'), H('J')],
      [CL('A'), CL('K'), CL('9'), CL('5'), CL('3')],
      false
    );
    // Q-high flush with A and K on the board: no live higher rank beats it.
    expect(ns.higherFlushRanks).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mind B2/B3/B5/B6/B8 — the opponent-model fixes.
// ═══════════════════════════════════════════════════════════════════════════
describe('HorseMind - the reads mean what their names say', () => {
  beforeEach(() => {
    HorseMind.reset();
  });

  const act = (
    userId: string,
    action: string,
    stage = 'preflop',
    amount = 0,
    extra: Record<string, unknown> = {}
  ): ActionRecord =>
    ({
      stage,
      seat: 0,
      userId,
      action,
      amount,
      timestamp: Math.random() * 1e12,
      ...extra,
    }) as unknown as ActionRecord;

  it('B2 - a limp in an unraised pot is NOT "faced aggression"', () => {
    // 20 hands of pure limping: no aggression ever faced.
    for (let h = 0; h < 20; h++) {
      HorseMind.observe([act('limper', 'call', 'preflop', 2, { timestamp: h * 1000 + 1 })], []);
    }
    const s = HorseMind.getStats('limper');
    expect(s?.facedAggr ?? 0).toBe(0);
  });

  it('B2 - a raise OVER a bet counts in the faced-aggression denominator', () => {
    for (let h = 0; h < 12; h++) {
      HorseMind.observe(
        [
          act('bettor', 'bet', 'flop', 10, { timestamp: h * 1000 + 1 }),
          act('raiser', 'raise', 'flop', 30, { timestamp: h * 1000 + 2 }),
        ],
        []
      );
    }
    const s = HorseMind.getStats('raiser');
    // 12 raises over a live bet: 12 faced, 0 folds — a genuinely aggressive
    // player, no longer classifiable as a folder.
    expect(s?.facedAggr ?? 0).toBe(12);
    expect(s?.folds ?? 0).toBe(0);
  });

  it('B5 - a table of pure folders finally raises the multiway bluff mod', () => {
    // Build three opponents who fold to aggression relentlessly.
    for (let h = 0; h < 40; h++) {
      for (const v of ['f1', 'f2', 'f3']) {
        HorseMind.observe(
          [
            act('hero', 'bet', 'flop', 10, { timestamp: h * 5000 + 1 }),
            act(v, 'fold', 'flop', 0, { timestamp: h * 5000 + 2 + v.charCodeAt(1) }),
          ],
          []
        );
      }
    }
    const players = [
      { seat: 0, user_id: 'hero', is_folded: false, is_sitting_out: false },
      { seat: 1, user_id: 'f1', is_folded: false, is_sitting_out: false },
      { seat: 2, user_id: 'f2', is_folded: false, is_sitting_out: false },
      { seat: 3, user_id: 'f3', is_folded: false, is_sitting_out: false },
    ] as never;
    const e = HorseMind.tableExploit(0, players, false);
    // min(1.45, 1.45, 1.45) = 1.45 — before the fix, min(1, ...) = 1 and the
    // upward exploit was unreachable in every multiway pot.
    expect(e.bluffMod).toBeGreaterThan(1.2);
  });

  it('B8 - a 4-bet is read as a top-few-percent range, not a 3-bet range', () => {
    const history = [
      act('opener', 'raise', 'preflop', 6, { timestamp: 1, isFullRaise: true }),
      act('threebettor', 'raise', 'preflop', 18, { timestamp: 2, isFullRaise: true }),
      act('fourbettor', 'raise', 'preflop', 44, { timestamp: 3, isFullRaise: true }),
    ];
    const bands = HorseMind.bandsForOpponents(
      1,
      [
        { seat: 0, user_id: 'fourbettor', is_folded: false, is_sitting_out: false },
        { seat: 1, user_id: 'hero', is_folded: false, is_sitting_out: false },
      ] as never,
      history as never,
      2
    );
    const fourBetBand = bands[0];
    expect(fourBetBand).not.toBeNull();
    // [0.86, 1.0] — before the fix this was [0.62, 1.0], pricing hero's hand
    // against a range four times too wide in the biggest preflop pots.
    expect(fourBetBand![0]).toBeGreaterThanOrEqual(0.8);
  });

  it('B9 - the ace blocks the wheel, and a nine can block a low straight', () => {
    // Wheel window on board: the ace is the canonical blocker.
    expect(HorseMind.hasBlocker([H('A'), D('8')], [S('2'), D('3'), CL('4'), H('9'), S('K')])).toBe(
      true
    );
    // 5-6-7 board: the nine completes 9-8 — a real straight blocker below the
    // old hr >= 10 floor.
    expect(HorseMind.hasBlocker([H('9'), D('8')], [S('5'), D('6'), CL('7'), H('K'), S('2')])).toBe(
      true
    );
  });
});
