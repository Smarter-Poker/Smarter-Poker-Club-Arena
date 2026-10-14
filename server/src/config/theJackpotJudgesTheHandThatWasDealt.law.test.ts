/**
 * THE JACKPOT JUDGES THE HAND THAT WAS DEALT, ON BOARD ONE, AGAINST EVERY WINNER
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-10-12. Five confirmed defects in Bad Beat Jackpot detection, each fixed
 * at the line that produced it (CLAUDE.md 10.11 / 10.12) and pinned here with
 * hands taken from the REAL evaluator - the encoding settlement actually passes.
 *
 *   1. Settlement judged the jackpot by the TABLE's variant, not the variant
 *      the hand was dealt as. An NLH bomb pot on a PLO table was judged as
 *      plo4, so a board-quads hand where neither player's two cards played
 *      paid the MAIN jackpot under the Omaha rule.
 *   2. On a run-it-multiple-times hand the winner list held everyone paid on
 *      ANY run, and a loser is "anyone not a winner" - so a player who lost
 *      board one with a qualifying hand and won run two was never judged.
 *      The published rule is that only the first runout counts.
 *   3. The main near miss took one winner id and settlement passed `[0]`, so
 *      on a chop the co-winner was filed as a loser: a `both_cards_must_play`
 *      row and table toast for a player who had not lost.
 *   4. The main near miss had no double-board gate, so a double-board hand
 *      that cleared the MAIN bar came back silent and the mini then filed it
 *      as `mini_double_board`.
 *   6. The hold'em both-cards test looked at hole[0] and hole[1] only; a
 *      hold'em-family hand of any other size is now refused, never judged on
 *      its first two cards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bbjFirstRunoutWinnerIds,
  bbjJudgedVariant,
  detectBBJHit,
  detectBBJNearMiss,
  detectMiniBBJHit,
  detectMiniBBJNearMiss,
} from './RakeConfig.js';
import { evaluateHand, evaluateOmahaHand } from '../engine/PokerEngine.js';

type C = { rank: string; suit: string };
const c = (rank: string, suit: string): C => ({ rank, suit });

/** A showdown row exactly as settlement builds it: from the real evaluator. */
function row(userId: string, hole: C[], board: C[]) {
  const h = evaluateHand(hole as never, board as never, false);
  return { userId, handRanking: h.ranking, handName: h.name, kickers: h.kickers, holeCards: hole };
}
function omahaRow(userId: string, hole: C[], board: C[]) {
  const h = evaluateOmahaHand(hole as never, board as never);
  return { userId, handRanking: h.ranking, handName: h.name, kickers: h.kickers, holeCards: hole };
}

const DEALT = ['W', 'L', 'X'];
const POT = 1000;
const BB = 10;

const SRC = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

// ─── 1. THE DEALT VARIANT ───────────────────────────────────────────────────

describe('1. the jackpot judges the variant the hand was dealt as', () => {
  /* Board K K K K 2: everybody has quad kings, so nobody's two hole cards
     both play. Dealt as NLH (a bomb pot on a PLO table), the hold'em rule
     refuses it. Judged as the TABLE's plo4, the Omaha rule does not check
     both-cards at all - and it paid the main jackpot. */
  const board = [
    c('K', 'spades'),
    c('K', 'hearts'),
    c('K', 'diamonds'),
    c('K', 'clubs'),
    c('2', 'spades'),
  ];
  const rows = [
    row('W', [c('A', 'hearts'), c('3', 'clubs')], board),
    row('L', [c('Q', 'hearts'), c('4', 'clubs')], board),
  ];

  it('the dealt variant wins over the table variant, lower-cased', () => {
    expect(bbjJudgedVariant('nlh', 'plo4')).toBe('nlh');
    expect(bbjJudgedVariant('PLO4', 'nlh')).toBe('plo4');
    expect(bbjJudgedVariant('plo5', 'nlh')).toBe('plo5');
    expect(bbjJudgedVariant('pineapple', 'nlh')).toBe('pineapple');
  });

  it('falls back to the table only when the dealt variant is unknown', () => {
    expect(bbjJudgedVariant(null, 'plo4')).toBe('plo4');
    expect(bbjJudgedVariant(undefined, 'PLO8')).toBe('plo8');
    expect(bbjJudgedVariant('  ', 'flh')).toBe('flh');
    expect(bbjJudgedVariant(null, null)).toBe('nlh');
  });

  it('an NLH bomb pot on a PLO table: board quads is NOT a jackpot', () => {
    const variant = bbjJudgedVariant('nlh', 'plo4');
    expect(detectBBJHit(rows, 'W', variant, POT, BB, 3, DEALT, board).hit).toBe(false);
    expect(detectMiniBBJHit(rows, 'W', variant, POT, BB, 3, DEALT, { board }).hit).toBe(false);
  });

  it('the defect, reproduced: judged as the table plo4 the same hand paid the main', () => {
    expect(detectBBJHit(rows, 'W', 'plo4', POT, BB, 3, DEALT, board).hit).toBe(true);
  });

  it('a PLO4 bomb pot on an NLH table is judged as Omaha', () => {
    // Quad kings (two from hand, three from board) loses to quad aces.
    const ob = [
      c('K', 'spades'),
      c('K', 'clubs'),
      c('A', 'spades'),
      c('A', 'diamonds'),
      c('2', 'hearts'),
    ];
    const orows = [
      omahaRow(
        'W',
        [c('A', 'hearts'), c('A', 'clubs'), c('3', 'diamonds'), c('4', 'diamonds')],
        ob
      ),
      omahaRow('L', [c('K', 'hearts'), c('K', 'diamonds'), c('7', 'clubs'), c('8', 'clubs')], ob),
    ];
    const variant = bbjJudgedVariant('plo4', 'nlh');
    expect(variant).toBe('plo4');
    const hit = detectBBJHit(orows, 'W', variant, POT, BB, 3, DEALT, ob);
    expect(hit.hit).toBe(true);
    expect(hit.loserUserId).toBe('L');
    // Judged as the table's NLH, four hole cards are refused outright (6).
    expect(detectBBJHit(orows, 'W', 'nlh', POT, BB, 3, DEALT, ob).hit).toBe(false);
  });

  it('settlement reads the dealt variant, and the dealt variant is set at deal time', () => {
    const settlement = SRC('engine/ServerTableEngineSettlement.ts');
    expect(settlement).toContain('const variant = this.bbjVariantForThisHand();');
    expect(settlement).toMatch(
      /bbjJudgedVariant\(this\.currentHandVariant, this\.dealtGameVariant\(\)\)/
    );
    // The old table-variant read is gone from the jackpot block.
    expect(settlement).not.toContain("const variant = this.tableInfo.game_variant || 'nlh';");
    const dealing = SRC('engine/ServerTableEngineDealing.ts');
    expect(dealing).toContain('this.currentHandVariant = config.gameVariant;');
  });
});

// ─── 2. ONLY THE FIRST RUNOUT COUNTS ────────────────────────────────────────

describe('2. on a multi-run hand, only board one decides who lost', () => {
  // Board one: A A J 9 9. W's 9 9 makes quad nines; L's A J makes aces full
  // of jacks, both cards playing. L lost board one and (say) won run two.
  const board = [
    c('A', 'clubs'),
    c('A', 'diamonds'),
    c('J', 'diamonds'),
    c('9', 'hearts'),
    c('9', 'spades'),
  ];
  const rows = [
    row('W', [c('9', 'diamonds'), c('9', 'clubs')], board),
    row('L', [c('A', 'hearts'), c('J', 'hearts')], board),
  ];
  const everyRunWinners = ['W', 'L'];
  const boardOne = { handNumber: 41, ids: ['W'] };

  it('the board-one record is used for its own hand, never another', () => {
    expect(bbjFirstRunoutWinnerIds(41, boardOne, everyRunWinners)).toEqual(['W']);
    expect(bbjFirstRunoutWinnerIds(42, boardOne, everyRunWinners)).toEqual(everyRunWinners);
    expect(bbjFirstRunoutWinnerIds(41, null, everyRunWinners)).toEqual(everyRunWinners);
    expect(bbjFirstRunoutWinnerIds(41, { handNumber: 41, ids: [] }, ['W'])).toEqual(['W']);
  });

  it('the board-one loser who won run two is judged, and the jackpot hits', () => {
    const winners = bbjFirstRunoutWinnerIds(41, boardOne, everyRunWinners);
    const hit = detectBBJHit(rows, winners, 'nlh', POT, BB, 3, DEALT, board);
    expect(hit.hit).toBe(true);
    expect(hit.loserUserId).toBe('L');
    expect(hit.winnerUserId).toBe('W');
  });

  it("the defect, reproduced: with every run's winners, nobody lost", () => {
    expect(detectBBJHit(rows, everyRunWinners, 'nlh', POT, BB, 3, DEALT, board).hit).toBe(false);
  });

  it("the runout records board one's winners and settlement hands them to every detector", () => {
    const runout = SRC('engine/ServerTableEngineRunout.ts');
    expect(runout).toMatch(/for \(const id of perBoardWinners\[0\] \?\? \[\]\)/);
    expect(runout).toContain(
      'this.currentHandBoardOneWinners = { handNumber: this.handCount, ids: boardOneIds };'
    );
    const settlement = SRC('engine/ServerTableEngineSettlement.ts');
    const start = settlement.indexOf('const variant = this.bbjVariantForThisHand();');
    const end = settlement.indexOf('this.runItTwiceEngine.endHand(this.tableId);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = settlement.slice(start, end);
    // All four detectors receive board one's winners, and nothing else.
    for (const fn of [
      'detectBBJHit',
      'detectMiniBBJHit',
      'detectBBJNearMiss',
      'detectMiniBBJNearMiss',
    ]) {
      const at = block.indexOf(`${fn}(`);
      expect(at, `${fn} is called in the jackpot block`).toBeGreaterThan(-1);
      const args = block.slice(at, block.indexOf(');', at));
      expect(args, `${fn} must receive bbjWinnerIds`).toContain('bbjWinnerIds');
      expect(args, `${fn} must not receive the every-run winner list`).not.toContain(
        'this.currentHandWinnerIds'
      );
    }
  });
});

// ─── 3. A CHOPPED POT HAS TWO WINNERS IN THE NEAR MISS TOO ──────────────────

describe('3. the near miss never files a co-winner as a loser', () => {
  // Board K K K K 2: W1 and W2 both play the board's quads with a queen.
  const board = [
    c('K', 'spades'),
    c('K', 'hearts'),
    c('K', 'diamonds'),
    c('K', 'clubs'),
    c('2', 'spades'),
  ];
  const w1 = row('W1', [c('Q', 'hearts'), c('3', 'clubs')], board);
  const w2 = row('W2', [c('Q', 'diamonds'), c('4', 'clubs')], board);

  it('two players chop: no near miss for either of them', () => {
    const r = detectBBJNearMiss([w1, w2], ['W1', 'W2'], 'nlh', POT, BB, 3, board);
    expect(r.nearMiss).toBe(false);
    // ...which leaves the mini's near miss free to speak (nobody lost, so it does not).
    expect(
      detectMiniBBJNearMiss([w1, w2], ['W1', 'W2'], 'nlh', POT, BB, 3, { board }).nearMiss
    ).toBe(false);
  });

  it('the defect, reproduced: with one winner id the co-winner was a "loser"', () => {
    const r = detectBBJNearMiss([w1, w2], 'W1', 'nlh', POT, BB, 3, board);
    expect(r.nearMiss).toBe(true);
    expect(r.userId).toBe('W2');
  });

  it('the strongest winner is the one the rule is applied to, like the hit', () => {
    // A third player who genuinely lost is still reported, and never a winner.
    const l = row('L', [c('J', 'hearts'), c('5', 'clubs')], board);
    const r = detectBBJNearMiss([w1, w2, l], ['W1', 'W2'], 'nlh', POT, BB, 3, board);
    expect(r.nearMiss).toBe(true);
    expect(r.userId).toBe('L');
    expect(r.reason).toBe('both_cards_must_play');
  });
});

// ─── 4. THE DOUBLE-BOARD GATE IN THE MAIN NEAR MISS ─────────────────────────

describe('4. a double-board hand that cleared the main bar is a MAIN near miss', () => {
  const board = [
    c('A', 'clubs'),
    c('A', 'diamonds'),
    c('J', 'diamonds'),
    c('9', 'hearts'),
    c('9', 'spades'),
  ];
  const rows = [
    row('W', [c('9', 'diamonds'), c('9', 'clubs')], board),
    row('L', [c('A', 'hearts'), c('J', 'hearts')], board),
  ];

  it('the same hand is a hit on one board and refused on a double board', () => {
    expect(detectBBJHit(rows, 'W', 'nlh', POT, BB, 3, DEALT, board).hit).toBe(true);
    expect(
      detectBBJHit(rows, 'W', 'nlh', POT, BB, 3, DEALT, board, { doubleBoard: true }).hit
    ).toBe(false);
  });

  it('the main near miss names the double board, in the house style', () => {
    const r = detectBBJNearMiss(rows, ['W'], 'nlh', POT, BB, 3, board, { doubleBoard: true });
    expect(r.nearMiss).toBe(true);
    expect(r.reason).toBe('double_board');
    expect(r.userId).toBe('L');
    expect(r.message).toMatch(/^So close! .+ double-board hands do not qualify\.$/);
    expect(r.message).not.toContain(String.fromCharCode(0x2014));
  });

  it('without the double board there is nothing to report: it was a hit', () => {
    expect(detectBBJNearMiss(rows, ['W'], 'nlh', POT, BB, 3, board).nearMiss).toBe(false);
  });

  it('settlement passes the double-board flag to the main near miss', () => {
    const settlement = SRC('engine/ServerTableEngineSettlement.ts');
    const at = settlement.indexOf('const nearMiss = detectBBJNearMiss(');
    expect(at).toBeGreaterThan(-1);
    const args = settlement.slice(at, settlement.indexOf(');', at));
    expect(args).toContain('{ doubleBoard: this.currentHandCommunityCards2.length > 0 }');
  });
});

// ─── 6. EXACTLY TWO HOLE CARDS IN THE HOLD'EM FAMILY ────────────────────────

describe("6. a hold'em-family hand is judged on exactly two hole cards", () => {
  const board = [
    c('A', 'clubs'),
    c('A', 'diamonds'),
    c('J', 'diamonds'),
    c('9', 'hearts'),
    c('9', 'spades'),
  ];
  const loser = row('L', [c('A', 'hearts'), c('J', 'hearts')], board);
  /* A three-card "winner": 9 9 plus a stray deuce. Dropping either nine
     weakens the hand, so a check that looks only at hole[0] and hole[1]
     calls it "both cards play" and never sees the third card. */
  const threeCardWinner = row('W', [c('9', 'diamonds'), c('9', 'clubs'), c('2', 'hearts')], board);

  it('the main jackpot refuses it', () => {
    expect(detectBBJHit([threeCardWinner, loser], 'W', 'nlh', POT, BB, 3, DEALT, board).hit).toBe(
      false
    );
  });

  it('the main near miss reports both_cards_must_play rather than a silent "hit"', () => {
    const r = detectBBJNearMiss([threeCardWinner, loser], ['W'], 'nlh', POT, BB, 3, board);
    expect(r.nearMiss).toBe(true);
    expect(r.reason).toBe('both_cards_must_play');
  });

  it('the mini refuses it too, and so does a three-card loser', () => {
    expect(
      detectMiniBBJHit([threeCardWinner, loser], 'W', 'nlh', POT, BB, 3, DEALT, { board }).hit
    ).toBe(false);
    const winner = row('W', [c('9', 'diamonds'), c('9', 'clubs')], board);
    const threeCardLoser = row('L', [c('A', 'hearts'), c('J', 'hearts'), c('3', 'spades')], board);
    expect(detectBBJHit([winner, threeCardLoser], 'W', 'nlh', POT, BB, 3, DEALT, board).hit).toBe(
      false
    );
    expect(
      detectMiniBBJHit([winner, threeCardLoser], 'W', 'nlh', POT, BB, 3, DEALT, { board }).hit
    ).toBe(false);
  });

  it('two hole cards still pay, so the gate costs nothing legitimate', () => {
    const winner = row('W', [c('9', 'diamonds'), c('9', 'clubs')], board);
    expect(detectBBJHit([winner, loser], 'W', 'nlh', POT, BB, 3, DEALT, board).hit).toBe(true);
    expect(detectBBJHit([winner, loser], 'W', 'pineapple', POT, BB, 3, DEALT, board).hit).toBe(
      false // quad kings or better must LOSE in pineapple; aces full does not qualify
    );
  });
});
