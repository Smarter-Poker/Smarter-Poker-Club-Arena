/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  tabSlots — which slot a table takes, and which tabs a rebuild may close
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two decisions that used to live inline in MultiTablePage, where the only way
 * to test either was to open four tables by hand. Both had shipped a bug that a
 * unit test would have caught in a second, so they live here now — pure, and
 * pinned by tests/unit/tabSlots.test.ts. Same reasoning as swipeTarget.ts.
 *
 * WHY BOTH ARE IN ONE FILE: they are the same question asked twice. "Is this
 * tab holding something the player would lose?" A tab with a live seat holds
 * chips and an engine socket; a lobby tab and an unseated observer hold
 * nothing. Slot reuse and pruning both turn on that, and keeping the predicate
 * in one place is what stops them drifting apart again — they had.
 */

/**
 * IS THIS ROW A TOURNAMENT? — one derivation, used by every tab factory.
 *
 * Dan 2026-08-30, second pass. The rebuild computed this inline, passed it to
 * `gameCode(...)`, and then dropped it instead of putting it on the tab. Four
 * readers depend on the tab carrying it, and `undefined` reads as "cash" at
 * every one: the sit-out toast (promises a 5-minute seat hold to a player who
 * is actually being blinded off), Sit Out All's cash-seat count, the profit
 * chip (which Dan requires to ignore tournaments entirely), and the tile raise
 * slider's step unit.
 *
 * A row is a tournament if it says so OR if it belongs to one. `tournament_id`
 * alone is enough: a table can carry it without `game_type` being set.
 */
export interface TableRowLike {
  game_type?: string | null;
  tournament_id?: string | null;
}
export const isTournamentRow = (row: TableRowLike | null | undefined): boolean =>
  row?.game_type === 'tournament' || !!row?.tournament_id;

/** The subset of a tab these decisions read. Structural, so the container's
 *  richer `TableInstance` satisfies it without an import cycle. */
export interface SlotTab {
  id: string;
  /** Optional on purpose: see `isLobbyLike`. Absent means "a table". */
  kind?: 'table' | 'lobby';
  /** True only for a seat the server has confirmed. */
  seated?: boolean;
}

/** Lobby tabs carry a prefixed synthetic id as well as the flag; either proves it. */
export const LOBBY_TAB_PREFIX = 'lobby:';
export const isLobbyLike = (t: SlotTab): boolean =>
  t.kind === 'lobby' || t.id.startsWith(LOBBY_TAB_PREFIX);

/**
 * A tab that can be replaced without costing the player anything: a lobby tab,
 * or a table they are only watching. A SEATED tab is never free.
 *
 * `seated !== true` rather than `!seated` so an explicit `false` and an
 * as-yet-unknown `undefined` read the same, which is what the observer tab
 * (deliberately undefined) relies on.
 */
export const isFreeSlot = (t: SlotTab): boolean => isLobbyLike(t) || t.seated !== true;

/**
 * WHICH SLOT A NEWLY OPENED TABLE TAKES.
 *
 * Dan 2026-08-30, verbatim: "WHEN I WENT INTO THE LOBBY TO CHANGE A TABLE, IT
 * DIDN'T CHANGE THE TABLE FOR THE LOBBY TABLE AND PAGE I WAS IN, IT CREATED A
 * NEW ACTION BAR AND ADDED IT IN THE FIRST SLOT LABELED MTT."
 *
 * The rule "watching a table never costs you a screen you are already using"
 * was written to protect SEATED screens. Applied to the screen the player
 * launched the gesture FROM, it produced the opposite of what they asked for:
 * they said "change this table" and got the new one parked in another slot
 * while the one in front of them did not move.
 *
 * Order, and why:
 *   'focus'   already open — watching a table twice is not a thing, and a
 *             duplicate would burn one of the four slots.
 *   'active'  the tab they are ON is free — take it, in place, same index.
 *             This is the case that was missing.
 *   'lobby'   some OTHER parked lobby tab is free — take that rather than grow.
 *   'append'  room left.
 *   'full'    say so out loud; silence is how "the button is broken" is born.
 *
 * Returns the slot index for every action but 'full', which returns -1.
 */
export type ObserveSlotAction = 'focus' | 'active' | 'lobby' | 'append' | 'full';

export interface ObserveSlot {
  action: ObserveSlotAction;
  index: number;
}

export function pickObserveSlot(
  tabs: readonly SlotTab[],
  activeIndex: number,
  tableId: string,
  maxTables: number
): ObserveSlot {
  const existing = tabs.findIndex((t) => t.id === tableId);
  if (existing !== -1) return { action: 'focus', index: existing };

  const active = tabs[activeIndex];
  if (active && isFreeSlot(active)) return { action: 'active', index: activeIndex };

  const lobbyIdx = tabs.findIndex(isLobbyLike);
  if (lobbyIdx !== -1) return { action: 'lobby', index: lobbyIdx };

  if (tabs.length < maxTables) return { action: 'append', index: tabs.length };
  return { action: 'full', index: -1 };
}

/**
 * WHICH TABS A SERVER-TRUTH REBUILD MAY CLOSE.
 *
 * Dan 2026-08-28 bug 1: a tab claiming a seat the server has since closed sits
 * frozen on a hand that will never finish — the "Connection Lost, Trying To Get
 * You Back" screen over an empty felt.
 *
 * The first version of this asked `kind === 'table' && seated === true`, and
 * the rebuild's OWN tabs were built without a `kind`. So every tab restored
 * after a page reload — which is every tab, in the case that matters — was
 * exempt from the prune that exists to close it, and the fix was inert exactly
 * where it was needed. Asking `!isLobbyLike` instead cannot rot that way: it
 * needs no field to be remembered by whoever writes the next tab factory.
 *
 * Never prunes a lobby tab (not a table) or an observer (holds no seat by
 * definition) — both are things the player deliberately opened.
 */
export function pruneStaleSeatedTabs<T extends SlotTab>(
  tabs: readonly T[],
  liveSeatIds: ReadonlySet<string>
): T[] {
  return tabs.filter((t) => !(!isLobbyLike(t) && t.seated === true && !liveSeatIds.has(t.id)));
}
