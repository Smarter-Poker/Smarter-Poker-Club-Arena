/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HOW LONG BEFORE A TOURNAMENT IS "ABOUT TO START" (2026-09-13)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-20: "When a scheduled MTT is about to start... 5 minutes left."
 *
 * Five minutes, for everything. A 2-chip turbo and a 500-chip Sunday major got
 * the same warning, which is not how any room calls a tournament: the bigger
 * the event, the earlier the last call, because the decision it asks a player
 * to make is bigger and the seat is worth more to fill.
 *
 * THE PRINCIPLE IS ALREADY IN THIS CODEBASE. `utils/tournamentScheduleWindow`
 * shows a 200+ buy-in on the lobby board for six days and everything else for
 * seventy-two hours - the same idea at a different scale. This is that idea
 * applied to the last call. The ladder is NOT shared with that helper on
 * purpose: a lobby window is measured in days and a last call in minutes, and
 * one constant serving both would be a coincidence rather than a rule.
 *
 * FIVE MINUTES IS STILL THE FLOOR, so the behaviour Dan asked for is what the
 * cheapest event still gets, and nothing that used to be announced stops being
 * announced. Only the top of the ladder is new.
 *
 * WHAT THIS COSTS. A longer horizon means the query returns more rows and the
 * bar has more to say, so a club running many large events will see a busier
 * rail. That is the intended trade - a 500-chip event is worth the pixels - but
 * it is a real change in how much the strip talks, which is why the ladder is
 * three lines in one file rather than a constant buried in a query.
 *
 * Pure: buy-in in, milliseconds out. No clock, no DOM, no Supabase.
 */

/** The last call every event gets, and what Dan originally asked for. */
export const BASE_LEAD_MS = 5 * 60_000;

/**
 * The ladder, cheapest first. `min` is the TOTAL buy-in - what the player
 * actually pays - not the prize-side portion.
 */
export const LEAD_LADDER: ReadonlyArray<{ minTotalBuyIn: number; leadMs: number }> = [
  { minTotalBuyIn: 100, leadMs: 15 * 60_000 },
  { minTotalBuyIn: 25, leadMs: 10 * 60_000 },
  { minTotalBuyIn: 0, leadMs: BASE_LEAD_MS },
];

/** The longest lead any event can claim. The query horizon uses this. */
export const MAX_LEAD_MS = LEAD_LADDER.reduce(
  (longest, rung) => Math.max(longest, rung.leadMs),
  BASE_LEAD_MS
);

/**
 * How far ahead THIS event counts as about to start.
 *
 * @param totalBuyIn what the player pays, prize side plus fee
 */
export function leadMsFor(totalBuyIn: number): number {
  const total = Number(totalBuyIn);
  if (!Number.isFinite(total) || total <= 0) return BASE_LEAD_MS;
  for (const rung of LEAD_LADDER) {
    if (total >= rung.minTotalBuyIn) return rung.leadMs;
  }
  return BASE_LEAD_MS;
}

/**
 * Is this event inside its own last call?
 *
 * The thirty seconds of grace after the gun is the window the rail has always
 * kept: an event that has just started is still worth naming for a moment,
 * because a player reading "0:00" is a player who can still be walked to a
 * seat that is filling.
 */
export function isInsideLastCall(startsAtMs: number, totalBuyIn: number, now: number): boolean {
  const until = startsAtMs - now;
  return until <= leadMsFor(totalBuyIn) && until > -30_000;
}

/**
 * How many upcoming rows the feed must ask for.
 *
 * THE BUG THIS FIXES, shipped in #4575 and found auditing it. The horizon
 * widened from five minutes to fifteen so one read could serve every rung of
 * the ladder, and the query still asked for five rows ordered by start time.
 * Postgres therefore returned the five SOONEST events inside fifteen minutes,
 * and the per-stake filter then threw away every one of them that was not yet
 * inside its own last call.
 *
 *     five 2-chip turbos at +6, +7, +8, +9, +10 minutes
 *     one 200-chip major  at +12 minutes
 *
 * The turbos take all five slots, all five fail `isInsideLastCall` because a
 * cheap event is a five-minute call, and the major - which IS inside its
 * fifteen-minute call and is the single most valuable seat the rail could be
 * filling - was never fetched. The bar says nothing.
 *
 * Widening the horizon without widening the take is the whole defect: the
 * filter moved to the client and the LIMIT did not follow it. Twenty-five is
 * the same size the overlay query already asks for, it is bounded, and the
 * lane caps at eight on screen regardless.
 *
 * ── WHERE THE LIMIT IS APPLIED NOW (2026-09-14) ────────────────────────────
 *
 * The read moved into `fn_get_ticker_feed`, so the LIMIT lives in the
 * migration and this constant no longer reaches it. That is exactly the shape
 * that produced the bug above - a number in one place and the filter that
 * depends on it in another - so `tickerServerFeed.test.ts` reads the
 * migration and fails if the two disagree. The reasoning stays here because
 * this is where the reasoning is about; the SQL just has to match it.
 */
export const UPCOMING_ROW_LIMIT = 25;
