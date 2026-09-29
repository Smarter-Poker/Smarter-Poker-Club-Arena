/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND ARENA'S FOUR FIGURES (2026-09-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10, line 3 of the Diamond programme: "Show real member/online/seated/
 * table counts with meaningful zero/error states."
 *
 * `fn_diamond_arena_counts()` (migration 20260929214500) answers four
 * figures. Each is a number, or NULL when the server could not tell, and the
 * server names the reason. This file turns that answer into the three-valued
 * `CountFigure` of `countFigure.ts` without ever inventing a zero:
 *
 *   a number        the figure. A real 0 is printed as 0.
 *   null            NOT YET ASKED. The Players page prints "...".
 *   COUNT_UNKNOWN   asked, and the server (or the network) could not tell.
 *                   Printed "Unavailable", the lobby's one word for unknown.
 *
 * The lobby rail prints "0" while it loads, because Dan's rule for the rail is
 * "THEY SHOULD HAVE 0'S UNTIL THE CARD LOADS". That rule is the rail's. The
 * Players page is a directory, like the chip roster it replaces for the arena,
 * and the chip roster prints "..." while it loads; so does this page, so that
 * loading, a real zero and unknown are three different things on the screen.
 *
 * ONLINE is usually unknown today, and that is the truth rather than a fault
 * here: nothing in Club Arena writes `profiles.is_online`/`last_seen` (World
 * Hub's messenger and social page do), so the server gives a number only when
 * the presence feed can see the person asking (see the migration header).
 */
import { COUNT_UNKNOWN, COUNT_UNKNOWN_TEXT, type CountFigure } from './countFigure';

/** The four figures, in the order the Players page shows them. */
export const DIAMOND_ARENA_FIGURES = Object.freeze([
  'members',
  'online',
  'seated',
  'tables',
] as const);

export type DiamondArenaFigure = (typeof DIAMOND_ARENA_FIGURES)[number];
export type DiamondArenaCounts = Record<DiamondArenaFigure, CountFigure>;

/** Nothing asked yet. */
export const DIAMOND_ARENA_COUNTS_PENDING: Readonly<DiamondArenaCounts> = Object.freeze({
  members: null,
  online: null,
  seated: null,
  tables: null,
});

/** Asked, and nothing could be told (the read itself failed). */
export const DIAMOND_ARENA_COUNTS_UNKNOWN: Readonly<DiamondArenaCounts> = Object.freeze({
  members: COUNT_UNKNOWN,
  online: COUNT_UNKNOWN,
  seated: COUNT_UNKNOWN,
  tables: COUNT_UNKNOWN,
});

/** What the Players page prints while a figure has not been asked yet. */
export const DIAMOND_FIGURE_LOADING_TEXT = '...';

/** A count is a whole number of people or tables, never negative. */
function readFigure(value: unknown): CountFigure {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(number) && number >= 0 ? number : COUNT_UNKNOWN;
}

/**
 * Read `fn_diamond_arena_counts()`'s answer.
 *
 * A NULL figure is the server saying it could not tell. A missing, malformed
 * or negative figure is treated the same way: whatever the page cannot read,
 * it says it cannot read. Nothing here becomes a zero.
 */
export function parseDiamondArenaCounts(data: unknown): DiamondArenaCounts {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ...DIAMOND_ARENA_COUNTS_UNKNOWN };
  }
  const row = data as Record<string, unknown>;
  return {
    members: readFigure(row.members),
    online: readFigure(row.online),
    seated: readFigure(row.seated),
    tables: readFigure(row.tables),
  };
}

/** True when any figure is the explicit "could not tell". */
export function anyDiamondFigureUnknown(counts: DiamondArenaCounts): boolean {
  return DIAMOND_ARENA_FIGURES.some((key) => counts[key] === COUNT_UNKNOWN);
}

/** What a Players page tile prints for a figure: "...", "Unavailable" or the number. */
export function diamondFigureText(figure: CountFigure | undefined): string {
  if (figure === COUNT_UNKNOWN) return COUNT_UNKNOWN_TEXT;
  if (figure == null) return DIAMOND_FIGURE_LOADING_TEXT;
  return figure.toLocaleString();
}

/** Where the Players page's read of the four figures stands. */
export type DiamondCountsPhase = 'loading' | 'ready' | 'failed';

/** The line under the figures, or null when every figure is a number. */
export function diamondCountsStatus(
  phase: DiamondCountsPhase,
  counts: DiamondArenaCounts
): string | null {
  if (phase === 'loading') return 'Counting The Arena.';
  if (phase === 'failed') return 'The Arena Totals Could Not Be Read. Refresh To Try Again.';
  return anyDiamondFigureUnknown(counts)
    ? 'Unavailable Means The Arena Could Not Tell, Not That The Figure Is Zero.'
    : null;
}
