import type { CardBox } from './protectedCardPlacement';

export function wagerBoxesOverlap(a: CardBox, b: CardBox): boolean {
  return (
    a.left < b.left + b.width + 2 &&
    a.left + a.width > b.left - 2 &&
    a.top < b.top + b.height + 2 &&
    a.top + a.height > b.top - 2
  );
}

/** Finite minimum-remaining-options assignment; a greedy first slot may be
 * another player's only clear rail slot. Candidates already exclude chrome.
 */
export function assignProtectedWagers(
  options: ReadonlyArray<ReadonlyArray<CardBox>>
): CardBox[] | null {
  const result: Array<CardBox | undefined> = options.map(() => undefined);
  let budget = 2000;
  const visit = (remaining: number): boolean => {
    if (!remaining) return true;
    if (--budget < 0) return false;
    let index = -1;
    let available: ReadonlyArray<CardBox> = [];
    for (let i = 0; i < options.length; i++) {
      if (result[i]) continue;
      const candidates = options[i].filter((candidate) =>
        result.every((placed) => !placed || !wagerBoxesOverlap(candidate, placed))
      );
      if (!candidates.length) return false;
      if (index < 0 || candidates.length < available.length) {
        index = i;
        available = candidates;
      }
    }
    for (const candidate of available) {
      result[index] = candidate;
      if (visit(remaining - 1)) return true;
    }
    result[index] = undefined;
    return false;
  };
  return visit(options.length) ? (result as CardBox[]) : null;
}

/** Fallback when no joint assignment exists: most-constrained wager first,
 * each taking its best candidate clear of the wagers already placed. When none
 * is clear of them, its best candidate still clears every player, the board
 * and the pot, which beats staying printed over its own player. A wager with
 * no candidate at all is left where it is (undefined). */
export function greedyProtectedWagers(
  options: ReadonlyArray<ReadonlyArray<CardBox>>
): Array<CardBox | undefined> {
  const result: Array<CardBox | undefined> = options.map(() => undefined);
  const order = options.map((_, i) => i).sort((a, b) => options[a].length - options[b].length);
  for (const index of order) {
    result[index] =
      options[index].find((candidate) =>
        result.every((placed) => !placed || !wagerBoxesOverlap(candidate, placed))
      ) ?? options[index][0];
  }
  return result;
}
