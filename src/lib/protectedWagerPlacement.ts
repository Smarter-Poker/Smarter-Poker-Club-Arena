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
