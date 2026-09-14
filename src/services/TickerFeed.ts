/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE ROUND TRIP FOR THE WHOLE RAIL (2026-09-14)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The ticker used to run FIVE queries every thirty seconds, for every seated
 * player: their registrations (200 rows), upcoming events (25), overlay
 * candidates (25), an operational sweep of `tournaments` (80) and new tables
 * (10). The bar then showed ONE line.
 *
 * The sweep was the expensive part and the broken part. Measured for a real
 * three-club member on 2026-09-14 it MATCHED 1,322 rows and took the eighty
 * most recently `updated_at` - a column with no trigger maintaining it - and
 * from that slice the browser filtered out the handful that could speak:
 *
 *     registration closing   2   (of 1,028 running events)
 *     guarantee starting     3
 *     result to report      72
 *
 * Three sources sharing one budget of eighty, chosen by a proxy for recency
 * that is not reliably recency. It is the same defect as #4601, where a major
 * was crowded off the rail by turbos, except silent: a bar with nothing on it
 * looks exactly like a bar with nothing to say.
 *
 * `fn_get_ticker_feed` does the filtering where the rows are. One call, a row
 * budget PER SOURCE, the club scope derived from `auth.uid()` inside the
 * function rather than shipped up from the browser, and `is_registered`
 * resolved server-side - which is what removes the 200-row read entirely.
 *
 * WHAT DELIBERATELY DID NOT MOVE. Copy, `lateRegEndMs()` and
 * `rankOverlayAnnouncements()` all stay in TypeScript. Composing sentences in
 * plpgsql would fork tickerMessages.ts into a second implementation the Title
 * Case and em-dash checks cannot see, and lateRegEndMs parses the blind
 * structure and sums level durations - logic corrected twice in August, which
 * should exist once, in the language that has the tests. The function ships a
 * provable superset for those and the client does the arithmetic it already
 * does.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

/** Which sources the operator has switched on. Anything absent is off. */
export interface TickerFeedSources {
  starting_soon?: boolean;
  overlays?: boolean;
  registration_closing?: boolean;
  guarantees?: boolean;
  winner_results?: boolean;
  table_openings?: boolean;
}

export interface TickerFeedUpcomingRow {
  id: string;
  name: string | null;
  start_time: string | null;
  club_id: string | null;
  buy_in_amount: number | null;
  buy_in_fee: number | null;
  current_players: number | null;
  is_registered: boolean;
  foreign_club_name: string | null;
}

export interface TickerFeedRegClosingRow {
  id: string;
  name: string | null;
  status: string | null;
  start_time: string | null;
  started_at: string | null;
  late_reg_levels: number | null;
  late_reg_mins: number | null;
  current_level: number | null;
  blind_structure: string | null;
  level_started_at: string | null;
}

export interface TickerFeedGuaranteeRow {
  id: string;
  name: string | null;
  guaranteed_prize: number | null;
  current_players: number | null;
  start_time: string | null;
}

export interface TickerFeedResultRow {
  id: string;
  name: string | null;
  prize_pool: number | null;
  ended_at: string | null;
}

export interface TickerFeedTableRow {
  id: string;
  name: string | null;
  game_variant: string | null;
  created_at: string | null;
}

export interface TickerFeed {
  clubs: number;
  upcoming: TickerFeedUpcomingRow[];
  /** Passed straight to rankOverlayAnnouncements, which owns the judgement. */
  overlays: unknown[];
  reg_closing: TickerFeedRegClosingRow[];
  guarantees: TickerFeedGuaranteeRow[];
  results: TickerFeedResultRow[];
  table_openings: TickerFeedTableRow[];
}

const EMPTY: TickerFeed = {
  clubs: 0,
  upcoming: [],
  overlays: [],
  reg_closing: [],
  guarantees: [],
  results: [],
  table_openings: [],
};

/** An array or nothing. A malformed feed must not throw inside a poll tick. */
function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Read the whole rail in one call.
 *
 * @returns the feed, or `null` when the read FAILED - which is different from
 *          an empty feed and the caller must treat it differently. An empty
 *          feed clears the bar; a failure keeps the last confirmed
 *          announcements until their own deadlines expire them.
 */
export async function fetchTickerFeed(
  sources: TickerFeedSources,
  horizonMs: number,
  railClubId: string | null
): Promise<TickerFeed | null> {
  try {
    const { data, error } = await supabase.rpc('fn_get_ticker_feed', {
      p_sources: sources,
      p_horizon_ms: Math.round(horizonMs),
      p_rail_club_id: railClubId,
    });
    if (error) {
      reportError(error, 'TickerFeed.fetch');
      return null;
    }
    const feed = data as Record<string, unknown> | null;
    if (!feed || typeof feed !== 'object') return null;

    /* `ok: false` is the function declining, not failing - an unauthenticated
       caller. There is nothing to say and nothing to preserve, so it is an
       EMPTY feed rather than a failure. */
    if (feed.ok !== true) return EMPTY;

    return {
      clubs: Number(feed.clubs) || 0,
      upcoming: rows<TickerFeedUpcomingRow>(feed.upcoming),
      overlays: rows<unknown>(feed.overlays),
      reg_closing: rows<TickerFeedRegClosingRow>(feed.reg_closing),
      guarantees: rows<TickerFeedGuaranteeRow>(feed.guarantees),
      results: rows<TickerFeedResultRow>(feed.results),
      table_openings: rows<TickerFeedTableRow>(feed.table_openings),
    };
  } catch (e) {
    reportError(e, 'TickerFeed.fetch');
    return null;
  }
}

/** Test seam: the shape a successful but empty read returns. */
export const EMPTY_TICKER_FEED: Readonly<TickerFeed> = EMPTY;
