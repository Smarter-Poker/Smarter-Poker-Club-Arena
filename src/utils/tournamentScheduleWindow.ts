/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LOBBY SCHEDULE WINDOW — how far ahead a club lobby publishes its card
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26: "INSIDE THE CLUB LOBBIES, MTT'S ARE NOT DISPLAYING ALL EVENTS.
 * IT SHOULD BE DISPLAYING ALL EVENTS THAT ARE SCHEDULED OVER THE NEXT 48 HOURS.
 * ANY TOURNAMENT WITH A BUY IN OF MORE THEN 200 THAT IS ON THE SCHEDULE CAN BE
 * SHOWN 6 DAYS OUT."
 *
 * ONE RULE, THREE READERS. The window is enforced in three places that must
 * agree or the board contradicts itself:
 *
 *   1. `ScheduledTournamentService` (server) — decides how far ahead a
 *      `tournaments` row is CREATED from a `tournament_schedules` row. A row
 *      that does not exist cannot be listed, and this was the actual bug: the
 *      spawner published 24 hours ahead, so a 48-hour board was impossible no
 *      matter what the client asked for. It keeps its own copy of these numbers
 *      because `server/` compiles standalone; `tests/unit/scheduleWindowParity`
 *      pins the two together.
 *   2. The lobby QUERY — bounds what is fetched, so the 200-row cap can never
 *      clip a future event in favour of a spin that started ten minutes ago.
 *   3. The lobby FILTER (this module) — the precise 48h / 6-day split.
 *
 * ANYTHING ALREADY UNDER WAY ALWAYS PASSES. A running or late-registering
 * event has a start time in the PAST, so it satisfies the 48-hour test for
 * free — deliberately, because Dan's 2026-08-24 rule is that a running event
 * stays on the board at the bottom of the MTT tab until it finishes.
 */

/**
 * Events starting within this many hours of now are always on the board.
 *
 * 48 -> 72 (Dan 2026-08-26, second pass: "USE 72H/6 DAY FOR $200 BUY IN OR
 * MORE"). 72 was already the number the TOURNAMENT lobby used, so this is the
 * two surfaces agreeing rather than a new figure: a player who checks the
 * club board and the tournament board should not be told two different things
 * about how far ahead this room publishes.
 */
export const LOBBY_WINDOW_HOURS = 72;

/** Bigger events publish this many days ahead instead. */
export const LOBBY_FEATURE_WINDOW_DAYS = 6;

/**
 * Total buy-in (prize + fee, in chips) AT OR ABOVE which an event gets the
 * longer window.
 *
 * INCLUSIVE, and it did not start that way. The first pass read "more then
 * 200" and implemented `> 200`, so a flat 200 event — the exact price of the
 * Sunday Deep Stack this room now runs — fell on the short window. Dan's
 * second pass says "$200 BUY IN OR MORE", which settles it: 200 is a feature
 * event.
 */
export const FEATURE_BUYIN_THRESHOLD = 200;

export const LOBBY_WINDOW_MS = LOBBY_WINDOW_HOURS * 60 * 60 * 1000;
export const LOBBY_FEATURE_WINDOW_MS = LOBBY_FEATURE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The shape this module needs. Anything wider is accepted. */
export interface WindowedTournament {
  start_time?: string | number | Date | null;
  buy_in_amount?: number | string | null;
  buy_in_fee?: number | string | null;
}

/** The price a player actually pays: prize half plus fee. */
export function totalBuyIn(t: WindowedTournament): number {
  return (Number(t.buy_in_amount) || 0) + (Number(t.buy_in_fee) || 0);
}

/** How far ahead an event of this price is published. */
export function scheduleWindowMsFor(total: number): number {
  return total >= FEATURE_BUYIN_THRESHOLD ? LOBBY_FEATURE_WINDOW_MS : LOBBY_WINDOW_MS;
}

/**
 * Should this event be on the board right now?
 *
 * FAIL OPEN ON AN UNREADABLE START TIME. A row whose `start_time` will not
 * parse is a data fault, and hiding it turns a bad timestamp into a missing
 * tournament that nobody can register for. Listing it is visible and fixable;
 * dropping it is neither.
 */
export function isWithinLobbyWindow(t: WindowedTournament, now: number = Date.now()): boolean {
  const startsAt = t.start_time == null ? NaN : new Date(t.start_time as string).getTime();
  if (!Number.isFinite(startsAt)) return true;
  if (startsAt <= now) return true; // under way, or overdue and still open
  return startsAt - now <= scheduleWindowMsFor(totalBuyIn(t));
}

/**
 * The COARSE bound for a database query: nothing beyond the longest window can
 * ever be listed, so the query never pays to fetch it. The 48-hour half of the
 * rule is applied client-side by `isWithinLobbyWindow`, because it depends on
 * each row's own buy-in.
 */
export function lobbyQueryHorizonIso(now: number = Date.now()): string {
  return new Date(now + LOBBY_FEATURE_WINDOW_MS).toISOString();
}
