/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RAKE + BBJ COLLECTION LAW (Dan 2026-08-29, BINDING — NO EXCEPTIONS)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim:
 *   "POT DOESN'T NEED TO BE 10 BB FOR THE BBJ TO BE TAKEN OUT... IF THERE IS
 *    A FLOP, BBJ SHOULD BE RAKED (3 OR MORE PLAYERS DEALT INTO THE HAND).
 *    BAD BEAT JACKPOT IS ONLY PAID OUT IF THERE IS MORE THEN 10 BB IN THE
 *    POT... BIG DIFFERENCE."
 *   "harden the rake and bbj process collection and tracking so it can't
 *    regress or break ever."
 *
 * THIS FILE IS THAT HARDENING. Every pin below is a bug that actually
 * shipped, or a hole found in the sweep that closed it:
 *
 *   1. THE FEE CARRIED THE PAYOUT'S POT GATE. All three fee sites required
 *      pot >= 10BB — the PAYOUT rule. 5,051 of 10,267 raked hands (49%) fed
 *      the jackpot nothing. Pinned: a 1.5BB pot with a flop IS charged.
 *   2. finalizeRunout HAD NO POT-OVERAGE CLAMP. completeHand and
 *      computeRakeAndBBJ clamped rake+bbj to the pot; the RIT path did not,
 *      so a small RIT pot could be charged more than it held and MINT chips.
 *      Found by the hardening sweep before it bit. Pinned: deductions never
 *      exceed the pot, on every path.
 *   3. THREE HAND-COPIES OF THE SAME ARITHMETIC. That is how both of the
 *      above happened. There is now ONE pricer, priceDeductions(), and this
 *      file pins that the other paths route through it.
 *
 * If a pin here goes red you are re-shipping one of those. Fix the change,
 * never the pin. A deliberate rule change moves the pin IN THE SAME COMMIT
 * and says so in the PR.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HandController } from './HandController.js';
import { BBJ_RULES, detectBBJHit } from '../config/RakeConfig.js';
import type { HandConfig, SeatPlayer } from '../types.js';

const TABLE = 'aaaaaaaa-1111-2222-3333-444444444444';

function mkPlayers(n: number, stack = 1000): SeatPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    seat: i + 1,
    user_id: `u${i + 1}`,
    username: `P${i + 1}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
}

function mkHC(players: number, over: Partial<HandConfig> = {}): HandController {
  const cfg = {
    tableId: TABLE,
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    bbjConfig: { enabled: true, feeBB: 0.25, minPotBB: 10, minPlayersDealt: 3 },
    ...over,
  } as HandConfig;
  const hc = new HandController(cfg, mkPlayers(players), 1);
  hc.start();
  // 2026-08-31: priceDeductions now requires a BOARD before it will take a
  // drop — `sawFlop` alone stopped being enough the day the rake-law alarm
  // caught 20 live preflop folds being raked on a true flag and an empty
  // board. Every pin below that passes `flopSeen = true` means "a hand that
  // saw the flop", so give these controllers the flop they are describing.
  // The pins themselves are unchanged; the no-flop pins pass `false` and are
  // unaffected either way.
  giveFlop(hc);
  return hc;
}

/** Three community cards in the controller's own state — a real flop. */
function giveFlop(hc: HandController): void {
  (hc as unknown as { state: { communityCards: unknown[] } }).state.communityCards = [
    { rank: 'A', suit: 'spades' },
    { rank: '7', suit: 'hearts' },
    { rank: '2', suit: 'clubs' },
  ];
}

function setPot(hc: HandController, pot: number): void {
  (hc as unknown as { state: { pot: number } }).state.pot = pot;
}

describe('LAW 1 — the BBJ drop is collected on every flop with 3+ dealt', () => {
  it('charges the drop in a pot far below the 10BB PAYOUT floor', () => {
    const hc = mkHC(3);
    setPot(hc, 15); // 1.5 BB
    expect(hc.priceDeductions(true, 15).bbjFee).toBe(2.5);
  });

  it('charges the drop at exactly 1 BB', () => {
    const hc = mkHC(3);
    expect(hc.priceDeductions(true, 10).bbjFee).toBeGreaterThan(0);
  });

  it('never charges without a flop', () => {
    const hc = mkHC(3);
    expect(hc.priceDeductions(false, 500).bbjFee).toBe(0);
  });

  it('never charges with fewer than 3 players dealt in', () => {
    const hc = mkHC(2);
    expect(hc.priceDeductions(true, 500).bbjFee).toBe(0);
  });

  it('the fee is a flat BB multiple — it does NOT scale with the pot', () => {
    const hc = mkHC(4);
    const small = hc.priceDeductions(true, 30).bbjFee;
    const large = hc.priceDeductions(true, 5000).bbjFee;
    expect(small).toBe(large);
  });
});

describe('LAW 2 — deductions can never exceed the pot, on EVERY path', () => {
  it('clamps when rake + drop would outrun a tiny pot', () => {
    const hc = mkHC(3);
    for (const pot of [0.5, 1, 2, 3, 5, 10, 25, 100]) {
      const { rake, bbjFee } = hc.priceDeductions(true, pot);
      expect(rake + bbjFee, `pot=${pot}`).toBeLessThanOrEqual(pot + 1e-9);
      expect(rake).toBeGreaterThanOrEqual(0);
      expect(bbjFee).toBeGreaterThanOrEqual(0);
    }
  });

  it('the BBJ drop yields before the rake does', () => {
    const hc = mkHC(3, { rakeConfig: { percent: 100, cap: 1000, noFlopNoDrop: true } });
    const { rake, bbjFee } = hc.priceDeductions(true, 4);
    expect(bbjFee).toBe(0);
    expect(rake).toBeLessThanOrEqual(4);
  });

  it('a zero pot is charged nothing', () => {
    const hc = mkHC(3);
    const { rake, bbjFee } = hc.priceDeductions(true, 0);
    expect(rake).toBe(0);
    expect(bbjFee).toBe(0);
  });
});

describe('LAW 3 — one pricer; no path may hand-copy the arithmetic', () => {
  const src = readFileSync(resolve(__dirname, 'HandController.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('priceDeductions exists and is the only place the fee is multiplied out', () => {
    expect(code).toMatch(/public priceDeductions\(/);
    const feeSites = code.match(/bbjCfg\.feeBB/g) ?? [];
    expect(feeSites.length).toBe(1);
  });

  it('completeHand, finalizeRunout and computeRakeAndBBJ all route through it', () => {
    const calls = code.match(/this\.priceDeductions\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('no fee site may re-introduce a pot-size gate', () => {
    // minPotBB belongs to detectBBJHit (payout) only — never to a fee path.
    expect(code).not.toMatch(/minPotBB/);
    expect(code).not.toMatch(/potInBB/);
  });
});

describe('LAW 4 — the 10BB floor still gates the PAYOUT, untouched', () => {
  it('BBJ_RULES keeps the published payout floor and dealt-in minimum', () => {
    expect(BBJ_RULES.minPotBB).toBe(10);
    expect(BBJ_RULES.minPlayersDealt).toBe(3);
  });

  it('a qualifying bad beat in a sub-10BB pot does NOT pay out', () => {
    const res = detectBBJHit(
      [
        { userId: 'w', handRanking: 8, handName: 'Four of a Kind', kickers: [14] },
        { userId: 'l', handRanking: 7, handName: 'Full House', kickers: [14, 11] },
      ],
      'w',
      'nlh',
      50, // 5 BB
      10,
      4,
      ['w', 'l', 'x', 'y']
    );
    expect(res.hit).toBe(false);
  });

  it('fewer than 3 dealt never pays out either', () => {
    const res = detectBBJHit(
      [
        { userId: 'w', handRanking: 8, handName: 'Four of a Kind', kickers: [14] },
        { userId: 'l', handRanking: 7, handName: 'Full House', kickers: [14, 11] },
      ],
      'w',
      'nlh',
      5000,
      10,
      2,
      ['w', 'l']
    );
    expect(res.hit).toBe(false);
  });
});
