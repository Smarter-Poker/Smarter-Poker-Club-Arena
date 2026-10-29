/** Preserve strict endpoints: only mathematically zero/one print 0%/100%. */
export function formatAllInEquity(percent: number, exact = true): string | null {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  // Legacy samples cannot prove an endpoint; omit unavailable labels entirely.
  if (!exact && (percent === 0 || percent === 100)) return null;
  if (percent === 0 || percent === 100) return `${percent}%`;
  if (percent < 0.1) return '<0.1%';
  if (percent > 99.9) return '>99.9%';
  return `${Math.round(percent * 10) / 10}%`;
}

export interface AllInEquityEntry {
  userId: string;
  username: string;
  equity: number;
  equityRaw?: number;
  seat: number;
}

/** Reject a whole malformed field; dropping an opponent fabricates certainty. */
export function validAllInEquityEntries(value: unknown): value is AllInEquityEntry[] {
  if (!Array.isArray(value) || value.length < 2) return false;
  const ids = new Set<string>();
  return value.every((e) => {
    if (
      !e ||
      typeof e.userId !== 'string' ||
      !e.userId ||
      ids.has(e.userId) ||
      typeof e.equity !== 'number' ||
      formatAllInEquity(e.equity) === null ||
      (e.equityRaw !== undefined &&
        (typeof e.equityRaw !== 'number' || formatAllInEquity(e.equityRaw) === null))
    )
      return false;
    ids.add(e.userId);
    return true;
  });
}

const SUITS: Record<string, string> = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' };
/** Same key for wire card strings and client card objects. */
export function allInEquityBoardKey(boards: unknown[]): string {
  return boards
    .filter((b) => Array.isArray(b) && b.length > 0)
    .map((b) =>
      (b as unknown[])
        .map((c) => {
          if (typeof c === 'string') return c;
          const card = c as { rank?: string; suit?: string } | null;
          return card ? `${card.rank}${SUITS[card.suit ?? ''] ?? card.suit}` : '?';
        })
        .join(',')
    )
    .join('|');
}

/** A missing hand identity must not admit a retained result from a prior hand. */
export function allInEquityHandMatches(currentHand: number, eventHand: number): boolean {
  return Number.isSafeInteger(currentHand) && currentHand > 0 && eventHand === currentHand;
}
