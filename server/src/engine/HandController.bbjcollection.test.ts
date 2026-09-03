/**
 * BBJ COLLECTION LAW (Dan 2026-08-29, BINDING):
 *
 *   "POT DOESN'T NEED TO BE 10 BB FOR THE BBJ TO BE TAKEN OUT... IF THERE IS
 *    A FLOP, BBJ SHOULD BE RAKED (3 OR MORE PLAYERS DEALT INTO THE HAND).
 *    BAD BEAT JACKPOT IS ONLY PAID OUT IF THERE IS MORE THAN 10 BB IN THE
 *    POT... BIG DIFFERENCE."
 *
 * COLLECTION gates: flop seen + 3+ players dealt in + eligible variant.
 * The 10BB minimum gates the PAYOUT only (detectBBJHit — pinned below to
 * still enforce it). Before this ruling the fee also required pot >= 10BB,
 * so every small-pot flop paid rake but fed the jackpot nothing.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import { detectBBJHit, BBJ_RULES } from '../config/RakeConfig.js';
import type { HandConfig, SeatPlayer } from '../types.js';

const TABLE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
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
      }) as SeatPlayer
  );
}

function mkController(stackList: number[], over: Partial<HandConfig> = {}): HandController {
  const config = {
    tableId: TABLE,
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    // Production shape: 3+ dealt (FIX 145), 10BB payout floor.
    bbjConfig: { enabled: true, feeBB: 0.25, minPotBB: 10, minPlayersDealt: 3 },
    ...over,
  } as HandConfig;
  const hc = new HandController(config, mkPlayers(stackList), 1);
  hc.start();
  return hc;
}

describe('BBJ fee is collected on every flop with 3+ dealt - pot size is irrelevant', () => {
  it('tiny pot (blinds only, 1.5BB) with a flop: the drop IS taken', () => {
    const hc = mkController([1000, 1000, 1000]);
    // Pot is just the blinds (15 = 1.5BB), far under the old 10BB fee gate.
    const { bbjFee } = hc.computeRakeAndBBJ(true /* flop seen */);
    expect(bbjFee).toBe(2.5); // 0.25 BB x 10
  });

  it('no flop: no drop (unchanged)', () => {
    const hc = mkController([1000, 1000, 1000]);
    const { bbjFee } = hc.computeRakeAndBBJ(false);
    expect(bbjFee).toBe(0);
  });

  it('heads-up (under 3 dealt): no drop, flop or not (unchanged)', () => {
    const hc = mkController([1000, 1000]);
    const { bbjFee } = hc.computeRakeAndBBJ(true);
    expect(bbjFee).toBe(0);
  });

  it('big pot still takes exactly one fee (no double charge from the rule change)', () => {
    const hc = mkController([1000, 1000, 1000]);
    const st = (hc as unknown as { state: { pot: number } }).state;
    st.pot = 500; // 50BB
    const { bbjFee } = hc.computeRakeAndBBJ(true);
    expect(bbjFee).toBe(2.5);
  });
});

describe('the 10BB minimum still gates the PAYOUT (detectBBJHit unchanged)', () => {
  it('BBJ_RULES keeps the payout floor at 10BB', () => {
    expect(BBJ_RULES.minPotBB).toBe(10);
    expect(BBJ_RULES.minPlayersDealt).toBe(3);
  });

  it('a qualifying beat in a sub-10BB pot does NOT pay the jackpot', () => {
    const result = detectBBJHit(
      [
        { userId: 'w', handRanking: 8, handName: 'Four of a Kind', kickers: [14] },
        { userId: 'l', handRanking: 7, handName: 'Full House', kickers: [14, 11] },
      ],
      'w',
      'nlh',
      50, // pot = 5BB — under the payout floor
      10,
      4,
      ['w', 'l', 'x', 'y']
    );
    expect(result.hit).toBe(false);
  });
});
