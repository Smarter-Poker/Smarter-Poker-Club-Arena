/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINDING A HAND — one predicate, every surface
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PHASE 5 of the Previous Hand build plan (2026-09-06). The archive had four
 * chips (All / Won / Lost / Big Pots) and the table's panel had none, so the
 * only way to find a hand you remembered was to scroll. This is the search
 * both of them run.
 *
 * It is a PURE predicate over a normalised subject, for the same reason the
 * reconstruction is one function: two surfaces that each decide what "went to
 * showdown" means will eventually disagree, and the player will be the one who
 * finds out. Every term below is defined ONCE, off `ReplayModel`:
 *
 *   showdown   the model has showdown rows - cards were turned over
 *   all-in     a row with the `all_in` verb belongs to the viewer
 *   won/lost   the viewer's own NET for the hand, not the pot
 *   big pot    the pot is at least 100 big blinds, which is what the archive's
 *              existing "Big Pots" chip has always meant
 *
 * The free-text term matches the hand NUMBER, any player's NAME (so "find the
 * hand against KingFish" works), and the viewer's own note and tags. Names are
 * matched case-insensitively on a substring, because a player types what they
 * remember rather than what is on the badge.
 *
 * `handSearchSubject` is the only place a record shape is read, so the panel's
 * camelCase view model and the service's snake_case row both arrive here as
 * the same thing.
 */

import type { ReplayModel } from '../utils/handReplay';

export interface HandSearchSubject {
  /** The hand's own number, as text - it is matched as a string. */
  handNumber: string;
  /** When it was played, in ms, for the date range. */
  playedAt: number;
  /** The stored variant key (`nlh`, `plo8`, `pineapple`), not a label. */
  variant: string | null;
  /** The viewer's own net for the hand: what it paid them or cost them. */
  heroNet: number;
  potTotal: number;
  bigBlind: number;
  /** Cards were turned over. */
  wentToShowdown: boolean;
  /** The viewer was all-in at some point in this hand. */
  heroAllIn: boolean;
  /** Every player's name, the viewer's included. */
  names: string[];
  /** The viewer's own note on this hand, when they wrote one. */
  note?: string | null;
  /** The viewer's own tags on this hand. */
  tags?: string[] | null;
}

export type HandOutcome = 'all' | 'won' | 'lost';

export interface HandQuery {
  /** Free text: hand number, a player's name, a tag, or words from a note. */
  text?: string;
  outcome?: HandOutcome;
  /** Only hands that reached a showdown. */
  showdown?: boolean;
  /** Only hands the viewer was all-in in. */
  allIn?: boolean;
  /** Only pots of at least 100 big blinds. */
  bigPots?: boolean;
  /** Only hands the viewer noted or tagged. */
  noted?: boolean;
  /** A stored variant key. Compared canonically, so "PLO" finds `plo4`. */
  variant?: string;
  /** Inclusive `YYYY-MM-DD` bounds, read in the viewer's own timezone. */
  from?: string;
  to?: string;
}

/** A pot this big is what the archive's "Big Pots" chip has always meant. */
export const BIG_POT_BIG_BLINDS = 100;

/**
 * Build the subject from the ONE model plus the few facts that are not in it
 * (who the viewer is, and their own note).
 */
export function handSearchSubject(
  model: ReplayModel,
  opts: {
    heroUserId: string | null | undefined;
    handNumber: number | string | null | undefined;
    playedAtMs: number;
    note?: string | null;
    tags?: string[] | null;
  }
): HandSearchSubject {
  const hero = opts.heroUserId
    ? model.players.find((p) => p.userId === opts.heroUserId)
    : undefined;
  const rows = model.streets.flatMap((s) => s.rows);
  return {
    handNumber: String(opts.handNumber ?? model.handNumber ?? ''),
    playedAt: opts.playedAtMs,
    variant: model.gameVariant,
    heroNet: hero?.net ?? 0,
    potTotal: model.potTotal,
    bigBlind: model.bigBlind,
    /* Cards turned over. NOT "the hand reached the river": a river call that
       nobody showed for is not a showdown, and a flop all-in that ran out is. */
    wentToShowdown: model.showdown.length > 0,
    heroAllIn:
      !!opts.heroUserId && rows.some((r) => r.verb === 'all_in' && r.userId === opts.heroUserId),
    names: model.players.map((p) => p.username).filter(Boolean),
    note: opts.note ?? null,
    tags: opts.tags ?? null,
  };
}

/**
 * Variants compared the way a player types them.
 *
 * "plo" must find `plo4`, and "omaha" must find both. Exactly the rule
 * `handHistoryDrilldown` already uses for the stats drill-down, kept the same
 * so one page cannot disagree with the other about what PLO is.
 */
function canonicalVariant(value: string): string {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact === 'holdem' || compact === 'texasholdem' || compact === 'nlh') return 'nlh';
  if (compact === 'omaha' || compact === 'plo' || compact === 'plo4') return 'plo4';
  return compact;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Start of `YYYY-MM-DD` in the reader's own timezone, in ms. */
function dayStart(iso: string): number | null {
  if (!DATE_ONLY.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** End of `YYYY-MM-DD`, inclusive: the last millisecond of that day. */
function dayEnd(iso: string): number | null {
  const start = dayStart(iso);
  return start === null ? null : start + 86_400_000 - 1;
}

/**
 * Does this hand match every term of the query?
 *
 * Terms are ANDed - each one narrows. An empty query matches everything, which
 * is what an untouched search box should do.
 */
export function handMatchesQuery(subject: HandSearchSubject, query: HandQuery): boolean {
  if (query.outcome === 'won' && !(subject.heroNet > 0)) return false;
  if (query.outcome === 'lost' && !(subject.heroNet < 0)) return false;

  if (query.showdown && !subject.wentToShowdown) return false;
  if (query.allIn && !subject.heroAllIn) return false;

  if (query.bigPots) {
    /* A pot cannot be measured in big blinds without a big blind. Rather than
       divide by zero and let every hand through, a hand with no blind on
       record is simply not a big pot. */
    const bb = subject.bigBlind;
    if (!(bb > 0) || subject.potTotal < BIG_POT_BIG_BLINDS * bb) return false;
  }

  if (query.noted) {
    const hasNote = !!(subject.note && subject.note.trim());
    const hasTags = !!(subject.tags && subject.tags.length);
    if (!hasNote && !hasTags) return false;
  }

  if (query.variant) {
    const want = canonicalVariant(query.variant);
    const has = canonicalVariant(subject.variant || '');
    if (want && has !== want) return false;
  }

  if (query.from) {
    const start = dayStart(query.from);
    if (start !== null && subject.playedAt < start) return false;
  }
  if (query.to) {
    const end = dayEnd(query.to);
    if (end !== null && subject.playedAt > end) return false;
  }

  const text = (query.text || '').trim().toLowerCase();
  if (text) {
    /* A leading '#' is how a player writes a hand number, and it must not stop
       the number matching. */
    const bare = text.replace(/^#/, '');
    const inNumber = subject.handNumber.toLowerCase().includes(bare);
    const inNames = subject.names.some((n) => n.toLowerCase().includes(text));
    const inNote = !!subject.note && subject.note.toLowerCase().includes(text);
    const inTags = !!subject.tags && subject.tags.some((t) => t.toLowerCase().includes(text));
    if (!inNumber && !inNames && !inNote && !inTags) return false;
  }

  return true;
}

/** True when the query would narrow anything - used to show a "clear" affordance. */
export function handQueryIsActive(query: HandQuery): boolean {
  return !!(
    (query.text && query.text.trim()) ||
    (query.outcome && query.outcome !== 'all') ||
    query.showdown ||
    query.allIn ||
    query.bigPots ||
    query.noted ||
    query.variant ||
    query.from ||
    query.to
  );
}

/** Filter a list whose subjects are already built. */
export function filterBySubjects<T>(
  items: T[],
  subjectOf: (item: T) => HandSearchSubject,
  query: HandQuery
): T[] {
  if (!handQueryIsActive(query)) return items;
  return items.filter((item) => handMatchesQuery(subjectOf(item), query));
}
