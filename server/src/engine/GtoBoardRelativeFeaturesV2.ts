import { boardRelativeFeaturesV1 } from './GtoBoardRelativeFeaturesV1.js';

/** Immutable board-relative contract, selected only by a sealed V2 dataset. */
export const BOARD_RELATIVE_FEATURE_VERSION_V2 = 'holdem-board-relative-v2' as const;
const rank = (card: string): number => '23456789TJQKA'.indexOf(card[0]) + 2;
const compare = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1);
  }
  return 0;
};

function five(cards: string[]): number[] {
  const ranks = cards.map(rank);
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  const groups = unique
    .map((value) => [ranks.filter((r) => r === value).length, value])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const flush = cards.every((card) => card[1] === cards[0][1]);
  const straight =
    unique.length === 5
      ? unique[0] - unique[4] === 4
        ? unique[0]
        : unique.join(',') === '14,5,4,3,2'
          ? 5
          : 0
      : 0;
  if (straight && flush) return [8, straight];
  if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, groups[0][1], groups[1][1]];
  if (flush) return [5, ...unique];
  if (straight) return [4, straight];
  if (groups[0][0] === 3) return [3, ...groups.map((group) => group[1])];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...groups.map((group) => group[1])];
  if (groups[0][0] === 2) return [1, ...groups.map((group) => group[1])];
  return [0, ...unique];
}

export function boardRelativeFeaturesV2(hole: readonly string[], board: readonly string[]) {
  const base = boardRelativeFeaturesV1(hole, board); // owns strict deck validation
  const all = [...hole, ...board];
  let best: number[] = [],
    minHole = 2,
    maxHole = 0;
  for (let a = 0; a < all.length - 4; a++)
    for (let b = a + 1; b < all.length - 3; b++)
      for (let c = b + 1; c < all.length - 2; c++)
        for (let d = c + 1; d < all.length - 1; d++)
          for (let e = d + 1; e < all.length; e++) {
            const indices = [a, b, c, d, e];
            const score = five(indices.map((index) => all[index]));
            const order = compare(score, best),
              contribution = indices.filter((index) => index < 2).length;
            if (order > 0) {
              best = score;
              minHole = maxHole = contribution;
            } else if (order === 0) {
              minHole = Math.min(minHole, contribution);
              maxHole = Math.max(maxHole, contribution);
            }
          }
  const boardRanks = [...new Set(board.map(rank))].sort((a, b) => b - a);
  const holeRanks = hole.map(rank);
  // Board ordinal retains pair/straight strength relative to THIS board. An
  // actual hole rank retains kicker/blocker strength without storing the board.
  const madeTiebreakRoles = best
    .slice(1)
    .map((value) => [
      holeRanks.filter((r) => r === value).length,
      boardRanks.indexOf(value),
      holeRanks.includes(value) ? 14 - value : -1,
    ]);
  let adjacentEdges = 0,
    oneGapEdges = 0,
    fourOfFiveWindows = 0;
  for (let i = 0; i < boardRanks.length; i++)
    for (let j = i + 1; j < boardRanks.length; j++) {
      const gap = boardRanks[i] - boardRanks[j];
      if (gap === 1 || (boardRanks[i] === 14 && boardRanks[j] === 2)) adjacentEdges++;
      if (gap === 2 || (boardRanks[i] === 14 && boardRanks[j] === 3)) oneGapEdges++;
    }
  for (let top = 5; top <= 14; top++) {
    const window = top === 5 ? [14, 2, 3, 4, 5] : [top - 4, top - 3, top - 2, top - 1, top];
    if (window.filter((value) => boardRanks.includes(value)).length >= 4) fourOfFiveWindows++;
  }
  return {
    ...base,
    version: BOARD_RELATIVE_FEATURE_VERSION_V2,
    madeTiebreakRoles,
    bestHoleContribution: [minHole, maxHole],
    boardConnectivity: [adjacentEdges, oneGapEdges, fourOfFiveWindows],
  };
}

export function boardRelativeFeatureKeyV2(
  hole: readonly string[],
  board: readonly string[]
): string {
  const f = boardRelativeFeaturesV2(hole, board);
  // Versioned positional wire form: SQL jsonb object order is not JS insertion
  // order. An array preserves exact producer/consumer bytes independently.
  return JSON.stringify([
    f.version,
    f.street,
    f.madeCategory,
    f.boardMultiplicity,
    f.holeRelations,
    f.pocketPair,
    f.straightCompletionRanks,
    f.straightCompletionCards,
    f.suitRelations,
    f.flushCompletionCards,
    f.madeTiebreakRoles,
    f.bestHoleContribution,
    f.boardConnectivity,
  ]);
}

/** Validate the positional wire representation without accepting a different version. */
export function boardRelativeFeatureKeyV2Valid(value: unknown, street: 3 | 4 | 5): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let f: unknown;
  try {
    f = JSON.parse(value);
  } catch {
    return false;
  }
  if (
    !Array.isArray(f) ||
    f.length !== 13 ||
    JSON.stringify(f) !== value ||
    f[0] !== BOARD_RELATIVE_FEATURE_VERSION_V2 ||
    f[1] !== street
  )
    return false;
  const integer = (n: unknown, lo: number, hi: number): boolean =>
    Number.isSafeInteger(n) && (n as number) >= lo && (n as number) <= hi;
  const tuple = (a: unknown, length: number, lo: number, hi: number): boolean =>
    Array.isArray(a) && a.length === length && a.every((n) => integer(n, lo, hi));
  if (
    !integer(f[2], 0, 8) ||
    typeof f[5] !== 'boolean' ||
    !integer(f[6], 0, 13) ||
    !integer(f[7], 0, 52) ||
    f[7] !== 4 * f[6] ||
    ![0, 9].includes(f[9]) ||
    (street === 5 && (f[6] !== 0 || f[9] !== 0))
  )
    return false;
  if (
    !Array.isArray(f[3]) ||
    f[3].length < 1 ||
    f[3].length > street ||
    !f[3].every((n: unknown) => integer(n, 1, 4)) ||
    f[3].reduce((a: number, b: number) => a + b, 0) !== street
  )
    return false;
  if (
    !Array.isArray(f[4]) ||
    f[4].length !== 2 ||
    !f[4].every(
      (a: unknown) =>
        tuple(a, 3, 0, 12) &&
        (a as number[])[0] <= street &&
        (a as number[])[1] <= 3 &&
        (a as number[])[2] <= 1
    )
  )
    return false;
  if (
    !Array.isArray(f[8]) ||
    f[8].length !== 4 ||
    !f[8].every(
      (a: unknown) =>
        Array.isArray(a) &&
        a.length >= 2 &&
        a.length <= 4 &&
        a.every((n: unknown) => integer(n, 0, 12)) &&
        a[0] <= street &&
        a[1] <= 2 &&
        a.length === 2 + a[1]
    )
  )
    return false;
  if (
    f[8].reduce((sum: number, a: number[]) => sum + a[0], 0) !== street ||
    f[8].reduce((sum: number, a: number[]) => sum + a[1], 0) !== 2
  )
    return false;
  if (
    !Array.isArray(f[10]) ||
    f[10].length !== [5, 4, 3, 3, 1, 5, 2, 2, 1][f[2]] ||
    !f[10].every(
      (a: unknown) =>
        tuple(a, 3, -1, 12) &&
        integer((a as number[])[0], 0, 2) &&
        integer((a as number[])[1], -1, f[3].length - 1) &&
        ((a as number[])[0] === 0
          ? (a as number[])[2] === -1 && (a as number[])[1] !== -1
          : (a as number[])[2] >= 0)
    )
  )
    return false;
  if (f[5] && (JSON.stringify(f[4][0]) !== JSON.stringify(f[4][1]) || f[4][0][1] > 2)) return false;
  return (
    tuple(f[11], 2, 0, 2) &&
    f[11][0] >= Math.max(0, 5 - street) &&
    f[11][0] <= f[11][1] &&
    tuple(f[12], 3, 0, 10)
  );
}
