/**
 * DEAD MONEY IS CAPPED AT THE DEAD MONEY (2026-08-18).
 *
 * The first attempt at "a player all-in for the ante must be able to win"
 * folded the dead money into pots[0] and then added that player to pots[0]'s
 * eligible list. But pots[0] is not a dead-money pot — it is the lowest LIVE
 * betting level multiplied by its contributors, PLUS all the dead money. So a
 * player who put in nothing but a 5-chip ante became eligible for the entire
 * 205-chip pot, and the 200 of live action that two other players had fought
 * over was handed to someone who never matched a single chip of it.
 *
 * PokerEngine.deadmoney.test.ts pins the eligibility half of the rule and
 * never asserts an amount, which is exactly how the over-correction survived.
 * This file pins the other half: how much they can actually win.
 *
 * The rule being enforced is the ordinary side-pot rule — you can win from
 * each opponent no more than you put in yourself. Dead money is not an
 * exception to it; it just gets its own pot at the bottom of the stack so the
 * Big Blind Ante never becomes a private side pot for the player fronting it.
 */
import { describe, it, expect } from 'vitest';
import { calculatePots, determineWinners } from './PokerEngine.js';
import type { SeatPlayer, Card } from '../types.js';

function mk(
  seat: number,
  over: Partial<SeatPlayer> & { totalInvested: number; deadInvested?: number }
): SeatPlayer {
  return {
    seat,
    user_id: `u${seat}`,
    username: `P${seat}`,
    stack: 0,
    bet: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    deadInvested: 0,
    ...over,
  } as SeatPlayer;
}

const c = (s: string): Card => ({ rank: s[0], suit: s[1] }) as unknown as Card;
const sum = (pots: { amount: number }[]) =>
  Math.round(pots.reduce((s, p) => s + p.amount, 0) * 100) / 100;
const potFor = (pots: { amount: number; eligiblePlayers: string[] }[], uid: string) =>
  Math.round(
    pots.filter((p) => p.eligiblePlayers.includes(uid)).reduce((s, p) => s + p.amount, 0) * 100
  ) / 100;

describe('a dead-money-only all-in can win the dead money and no more', () => {
  it('splits the ante off into its own pot instead of widening the live pot', () => {
    const players = [
      mk(1, { totalInvested: 100 }),
      mk(2, { totalInvested: 100 }),
      mk(3, { totalInvested: 5, deadInvested: 5, is_all_in: true }),
    ];
    const pots = calculatePots(players);

    // Still eligible for something — that was the original bug.
    expect(potFor(pots, 'u3')).toBe(5);
    // But NOT for the live action. This is what regressed.
    expect(potFor(pots, 'u3')).not.toBe(205);
    expect(sum(pots)).toBe(205);

    const livePot = pots.find((p) => !p.eligiblePlayers.includes('u3'));
    expect(livePot).toBeDefined();
    expect(livePot!.amount).toBe(200);
    expect(livePot!.eligiblePlayers).toEqual(expect.arrayContaining(['u1', 'u2']));
  });

  it('pays only the ante out even when the short player makes the best hand', () => {
    const board = [c('Ah'), c('Ad'), c('7c'), c('2d'), c('3s')];
    const players = [
      mk(1, { totalInvested: 100, cards: [c('Kh'), c('Qh')] }),
      mk(2, { totalInvested: 100, cards: [c('Jh'), c('Th')] }),
      // Quads. Best hand at the table, all-in for the ante alone.
      mk(3, { totalInvested: 5, deadInvested: 5, is_all_in: true, cards: [c('As'), c('Ac')] }),
    ];
    const pots = calculatePots(players);
    const winners = determineWinners(players, board, pots, 'nlh', 1);

    const u3 = winners.filter((w) => w.userId === 'u3').reduce((s, w) => s + w.amount, 0);
    expect(u3).toBe(5);

    const total = winners.reduce((s, w) => s + w.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(205);
  });

  it('a dead small blind that ate the whole stack is capped the same way', () => {
    const players = [
      mk(1, { totalInvested: 50 }),
      mk(2, { totalInvested: 50 }),
      mk(3, { totalInvested: 1, deadInvested: 1, is_all_in: true }),
    ];
    const pots = calculatePots(players);
    expect(potFor(pots, 'u3')).toBe(1);
    expect(sum(pots)).toBe(101);
  });

  it('a short player with SOME live money gets the ante pot AND their live level', () => {
    // Everyone antes 5. u3 has 8 total: 5 ante + 3 live, all-in.
    const players = [
      mk(1, { totalInvested: 105, deadInvested: 5 }),
      mk(2, { totalInvested: 105, deadInvested: 5 }),
      mk(3, { totalInvested: 8, deadInvested: 5, is_all_in: true }),
    ];
    const pots = calculatePots(players);
    // 15 of antes + 3 x 3 of live at u3's level = 24, which is exactly the 8
    // they put in matched by both opponents.
    expect(potFor(pots, 'u3')).toBe(24);
    expect(sum(pots)).toBe(218);
  });

  it('the ordinary case - everyone has live money - still produces one pot', () => {
    // No dead-money-only player, so the dead pot and the main pot have the same
    // eligible set and the merge step folds them back together. This is the
    // no-regression guard for the 99% path.
    const players = [
      mk(1, { totalInvested: 105, deadInvested: 5 }),
      mk(2, { totalInvested: 105, deadInvested: 5 }),
      mk(3, { totalInvested: 105, deadInvested: 5 }),
    ];
    const pots = calculatePots(players);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(315);
  });

  it('a folded dead-money player leaves their chips behind and wins nothing', () => {
    const players = [
      mk(1, { totalInvested: 100 }),
      mk(2, { totalInvested: 100 }),
      mk(3, { totalInvested: 5, deadInvested: 5, is_folded: true }),
    ];
    const pots = calculatePots(players);
    expect(potFor(pots, 'u3')).toBe(0);
    expect(sum(pots)).toBe(205);
  });
});

describe('the odd chip goes to the first seat clockwise OF the button', () => {
  const board = [c('Ah'), c('Kd'), c('7c'), c('2d'), c('3s')];

  it('heads-up: the big blind gets the odd cent, not the button', () => {
    // Identical hands -> a chop. 10.01 splits 5.005 each; one cent is odd.
    const players = [
      mk(1, { totalInvested: 5.005, cards: [c('Qh'), c('Jh')] }),
      mk(2, { totalInvested: 5.005, cards: [c('Qs'), c('Js')] }),
    ];
    const pots = [{ amount: 10.01, eligiblePlayers: ['u1', 'u2'] }];
    // Seat 1 is the button; seat 2 is the big blind.
    const winners = determineWinners(players, board, pots, 'nlh', 1);

    const button = winners.find((w) => w.userId === 'u1')!;
    const bigBlind = winners.find((w) => w.userId === 'u2')!;
    expect(bigBlind.amount).toBe(5.01);
    expect(button.amount).toBe(5.0);
  });

  it('three-handed: the seat immediately left of the button gets it', () => {
    const players = [
      mk(1, { totalInvested: 1, cards: [c('Qh'), c('Jh')] }),
      mk(2, { totalInvested: 1, cards: [c('Qs'), c('Js')] }),
      mk(3, { totalInvested: 1, cards: [c('Qd'), c('Jd')] }),
    ];
    const pots = [{ amount: 3.01, eligiblePlayers: ['u1', 'u2', 'u3'] }];
    // Button on seat 3 -> seat 1 is next clockwise.
    const winners = determineWinners(players, board, pots, 'nlh', 3);
    expect(winners.find((w) => w.userId === 'u1')!.amount).toBe(1.01);
    expect(winners.find((w) => w.userId === 'u3')!.amount).toBe(1.0);
  });

  it('with no known button it still falls back to the lowest seat', () => {
    const players = [
      mk(1, { totalInvested: 1, cards: [c('Qh'), c('Jh')] }),
      mk(2, { totalInvested: 1, cards: [c('Qs'), c('Js')] }),
    ];
    const pots = [{ amount: 2.01, eligiblePlayers: ['u1', 'u2'] }];
    const winners = determineWinners(players, board, pots, 'nlh', 0);
    expect(winners.find((w) => w.userId === 'u1')!.amount).toBe(1.01);
  });
});
