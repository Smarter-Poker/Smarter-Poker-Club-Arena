/**
 * calculatePots is the canonical pot partition that real settlement uses. On
 * 2026-10-08 its level construction and merge were rewritten for speed (one
 * pass per level instead of two filters, a sorted copy instead of a Set, and
 * element comparison instead of formatting both eligible lists as JSON) so the
 * Horse Phase 8 continuation, which calls it thousands of times per decision,
 * fits more spots inside its unchanged work budget.
 *
 * The rewrite must not change one result. This suite keeps the previous
 * implementation verbatim as the reference and requires byte-identical output
 * (same pots, same order, same eligible lists, the same floating-point
 * amounts) across seeded random tables that cover folds, all-ins, ties at
 * every level, individual antes (full and short), Big Blind Antes and dead
 * blinds, seats with nothing invested, the `bet` fallback for a missing
 * `totalInvested`, and the everyone-folded-to-dead-money cases.
 */
import { describe, expect, it } from 'vitest';
import { calculatePots } from './PokerEngine.js';
import type { Pot, SeatPlayer } from '../types.js';

/** The implementation before 2026-10-08, kept verbatim as the oracle. */
function referenceCalculatePots(players: SeatPlayer[]): Pot[] {
  const activePlayers = players.filter((p) => !p.is_folded);
  if (activePlayers.length === 0) return [];
  const getInvestment = (p: SeatPlayer) =>
    Math.max(
      0,
      Math.round(
        ((p.totalInvested ?? p.bet ?? 0) -
          (p.deadInvested ?? 0) +
          (p.individualAnteInvested ?? 0)) *
          100
      ) / 100
    );
  const deadTotal =
    Math.round(
      players.reduce((s, p) => s + (p.deadInvested ?? 0) - (p.individualAnteInvested ?? 0), 0) * 100
    ) / 100;
  const allContributors = players
    .map((player) => ({ player, investment: getInvestment(player) }))
    .filter((entry) => entry.investment > 0);
  if (allContributors.length === 0) {
    if (deadTotal <= 0) return [];
    return [{ amount: deadTotal, eligiblePlayers: activePlayers.map((p) => p.user_id) }];
  }
  const sortedInvestments = [...new Set(allContributors.map((entry) => entry.investment))].sort(
    (a, b) => a - b
  );
  const pots: Pot[] = [];
  let previousLevel = 0;
  let orphaned = 0;
  for (const level of sortedInvestments) {
    if (level === 0) continue;
    const contribution = level - previousLevel;
    const totalContributors = allContributors.filter((entry) => entry.investment >= level).length;
    const eligiblePlayers = allContributors.filter(
      (entry) => !entry.player.is_folded && entry.investment >= level
    );
    if (totalContributors > 0 && eligiblePlayers.length > 0) {
      pots.push({
        amount: contribution * totalContributors,
        eligiblePlayers: eligiblePlayers.map((entry) => entry.player.user_id),
      });
    } else if (totalContributors > 0) {
      orphaned = Math.round((orphaned + contribution * totalContributors) * 100) / 100;
    }
    previousLevel = level;
  }
  if (orphaned > 0 && pots.length > 0) {
    pots[0].amount = Math.round((pots[0].amount + orphaned) * 100) / 100;
    orphaned = 0;
  }
  const deadPool = Math.round((deadTotal + orphaned) * 100) / 100;
  if (pots.length > 0 && deadPool > 0) {
    const deadEligible = activePlayers.filter((p) => (p.totalInvested ?? p.bet ?? 0) > 0);
    pots.unshift({
      amount: deadPool,
      eligiblePlayers: deadEligible.map((p) => p.user_id),
    });
  }
  if (pots.length === 0) {
    return deadPool > 0
      ? [{ amount: deadPool, eligiblePlayers: activePlayers.map((p) => p.user_id) }]
      : [];
  }
  const merged: Pot[] = [pots[0]];
  for (let i = 1; i < pots.length; i++) {
    const last = merged[merged.length - 1];
    if (JSON.stringify(last.eligiblePlayers) === JSON.stringify(pots[i].eligiblePlayers)) {
      last.amount += pots[i].amount;
    } else {
      merged.push(pots[i]);
    }
  }
  return merged;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTable(random: () => number): SeatPlayer[] {
  const seats = 2 + Math.floor(random() * 9);
  // A small level menu makes exact ties between contributors common.
  const menu = [0, 0.01, 0.5, 1, 2, 2, 3.33, 5, 7.77, 10, 10, 25.5, 100, 1281.48, 811.33];
  const cents = random() < 0.5;
  const ante = random() < 0.3 ? [0.25, 1, 5][Math.floor(random() * 3)] : 0;
  const bba = !ante && random() < 0.2 ? [1, 2, 4][Math.floor(random() * 3)] : 0;
  const players: SeatPlayer[] = [];
  for (let i = 0; i < seats; i++) {
    let live = menu[Math.floor(random() * menu.length)];
    if (cents) live = Math.round(random() * 50000) / 100;
    const individual = ante
      ? random() < 0.15
        ? Math.round(ante * random() * 100) / 100
        : ante
      : 0;
    const deadBlind = random() < 0.08 ? 0.5 : 0;
    const shared = bba && i === 0 ? bba : 0;
    const dead = individual + deadBlind + shared;
    const player: SeatPlayer = {
      seat: i + 1,
      user_id: `u${i + 1}`,
      username: `p${i + 1}`,
      stack: Math.round(random() * 100000) / 100,
      bet: random() < 0.5 ? live : 0,
      totalInvested: Math.round((live + dead) * 100) / 100,
      cards: [],
      is_folded: random() < 0.35,
      is_all_in: random() < 0.2,
      is_sitting_out: random() < 0.05,
    };
    if (dead > 0 || random() < 0.2) player.deadInvested = dead;
    if (individual > 0 || random() < 0.1) player.individualAnteInvested = individual;
    if (random() < 0.04) (player as { totalInvested?: number }).totalInvested = undefined;
    players.push(player);
  }
  if (random() < 0.1) for (const p of players) p.is_folded = true;
  if (random() < 0.05)
    for (const p of players) {
      p.totalInvested = p.deadInvested ?? 0;
      p.bet = 0;
    }
  return players;
}

const serialize = (pots: Pot[]): string =>
  JSON.stringify(
    pots.map((pot) => ({
      // The bit pattern catches a difference in the last place and -0.
      amount: Buffer.from(new Float64Array([pot.amount]).buffer).toString('hex'),
      eligiblePlayers: pot.eligiblePlayers,
    }))
  );

describe('calculatePots is exactly the previous partition', () => {
  it('matches the verbatim previous implementation on 60,000 seeded random tables', () => {
    const random = mulberry32(20261008);
    let sidePots = 0;
    let merges = 0;
    for (let n = 0; n < 60_000; n++) {
      const table = randomTable(random);
      const expected = referenceCalculatePots(structuredClone(table));
      const actual = calculatePots(structuredClone(table));
      if (serialize(actual) !== serialize(expected)) {
        expect({ n, table, actual }).toEqual({ n, table, actual: expected });
      }
      if (expected.length > 1) sidePots++;
      const levels = new Set(
        table
          .filter((p) => !p.is_folded)
          .map((p) => p.totalInvested ?? p.bet)
          .filter((v) => (v ?? 0) > 0)
      ).size;
      if (levels > expected.length) merges++;
    }
    // The generator really exercises side pots and the merge step.
    expect(sidePots).toBeGreaterThan(10_000);
    expect(merges).toBeGreaterThan(1_000);
  });

  it('matches on the documented orphaned-level and dead-money-only examples', () => {
    const seat = (
      i: number,
      totalInvested: number,
      extra: Partial<SeatPlayer> = {}
    ): SeatPlayer => ({
      seat: i,
      user_id: `u${i}`,
      username: `p${i}`,
      stack: 100,
      bet: 0,
      totalInvested,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      ...extra,
    });
    const cases: SeatPlayer[][] = [
      [
        seat(1, 300, { is_all_in: true }),
        seat(2, 811.33, { is_all_in: true }),
        seat(4, 1281.48, { is_folded: true }),
        seat(5, 1281.48, { is_folded: true }),
      ],
      [seat(1, 100), seat(2, 100), seat(3, 5, { deadInvested: 5, is_all_in: true })],
      [
        seat(1, 5, { deadInvested: 5, individualAnteInvested: 5 }),
        seat(2, 2.5, { deadInvested: 2.5, individualAnteInvested: 2.5, is_all_in: true }),
        seat(3, 5, { deadInvested: 5, individualAnteInvested: 5, is_folded: true }),
      ],
      [seat(1, 0), seat(2, 0, { is_folded: true })],
    ];
    for (const table of cases)
      expect(serialize(calculatePots(structuredClone(table)))).toBe(
        serialize(referenceCalculatePots(structuredClone(table)))
      );
  });
});
