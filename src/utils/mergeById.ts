/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A BACKGROUND REFRESH MUST NOT REBUILD THE LIST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02: "CLUBS SHOULD NOT BE 'RANDOMLY REFRESHING' ON THERE OWN, IT
 * FEELS LIKE A BUG OR GLITCH THAT SHOULDN'T HAPPEN ... ITS ALSO HAPPENING
 * INSIDE OF THE TABLE MANAGEMENT PAGE, FIX IT FOR EVERY PAGE AND SUB PAGE OF
 * THE CLUB ARENA."
 *
 * Two separate things make a page look like it refreshed itself:
 *
 *   1. It flips back into its loading state. That is fixed at each call site
 *      by only showing the spinner when there is nothing on screen yet.
 *   2. It hands React a brand new object for every row. Even when every value
 *      is identical, a new identity means the row's DOM is torn down and
 *      rebuilt: it flashes, an open menu closes, an input loses focus, and the
 *      scroll position jumps. This is the one that survives every other fix,
 *      because nothing about it looks wrong in the code that causes it.
 *
 * `mergeById` is the cure for (2). Rows that did not change keep the exact
 * object the list is already rendering, so React skips them entirely. The
 * array itself is only replaced when the membership or the order changed, so
 * an unchanged page re-renders nothing at all.
 *
 * Deliberately structural, not a deep-equality library: values that come back
 * from a query are plain JSON, and comparing their serialisations is both
 * exact for that shape and cheap enough to run on every refresh (a 200-row
 * management page costs well under a millisecond).
 */

/** Stable JSON: key order in a row must not decide whether it "changed". */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function rowsAreEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

/**
 * Merge freshly-read `next` rows over the `current` ones, keeping the identity
 * of every row whose content is unchanged.
 *
 * The result is `next`'s membership and `next`'s order - a refresh is still
 * authoritative about what exists and how it is sorted. Only the object
 * identities are borrowed back. When nothing at all changed, `current` is
 * returned unchanged so `setState` bails out and no render happens.
 */
export function mergeById<T>(
  current: readonly T[],
  next: readonly T[],
  key: (row: T) => string
): T[] {
  const previous = new Map<string, T>();
  for (const row of current) previous.set(key(row), row);

  let identical = current.length === next.length;
  const merged = next.map((row, index) => {
    const before = previous.get(key(row));
    if (before !== undefined && rowsAreEqual(before, row)) {
      if (current[index] !== before) identical = false;
      return before;
    }
    identical = false;
    return row;
  });

  return identical ? (current as T[]) : merged;
}

export default mergeById;
