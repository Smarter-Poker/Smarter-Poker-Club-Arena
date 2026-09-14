/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE READ THAT USED TO BE FIVE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every thirty seconds, for every seated player, the ticker ran five queries and
 * then threw nearly all of the answer away, because the bar shows ONE line.
 *
 * The operational sweep was the expensive part and the broken part. Measured
 * against production for a real three-club member on 2026-09-14 it MATCHED
 * 1,322 rows and took the eighty most recently `updated_at` - a column with no
 * trigger maintaining it - and the browser then filtered that slice down to:
 *
 *     registration closing   2   (of 1,028 running events)
 *     guarantee starting     3
 *     result to report      72
 *
 * Three sources sharing one budget of eighty, ordered by a proxy for recency
 * that is not reliably recency. It is exactly the defect fixed in #4601, where a
 * major was crowded off the rail by five turbos, except silent: a bar with
 * nothing on it looks the same as a bar with nothing to say.
 *
 * This file covers the client half - the wrapper, and the container's contract
 * with it - and pins the parts of the SQL that a TypeScript change can silently
 * fall out of step with.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sliceBetween } from '../helpers/sourceWindow';
import { UPCOMING_ROW_LIMIT } from '../../src/components/tournament/tickerLeadWindow';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.report,
  reportWarning: vi.fn(),
}));

import { fetchTickerFeed } from '../../src/services/TickerFeed';

const MIGRATIONS = resolve(__dirname, '../../supabase/migrations');
const FEED_SQL = readFileSync(
  resolve(
    MIGRATIONS,
    readdirSync(MIGRATIONS).find((f) => f.endsWith('_the_rail_asks_the_server_once.sql'))!
  ),
  'utf8'
);

const ALL_ON = {
  starting_soon: true,
  overlays: true,
  registration_closing: true,
  guarantees: true,
  winner_results: true,
  table_openings: true,
};

function replied(feed: Record<string, unknown>) {
  mocks.rpc.mockResolvedValue({ data: feed, error: null });
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.report.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('one call carries the whole rail', () => {
  it('asks the feed function by name, with the switches and the horizon', async () => {
    replied({ ok: true, clubs: 2, upcoming: [] });
    await fetchTickerFeed(ALL_ON, 900_000, 'club-1');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.rpc.mock.calls[0];
    expect(fn).toBe('fn_get_ticker_feed');
    expect(args.p_sources).toEqual(ALL_ON);
    expect(args.p_horizon_ms).toBe(900_000);
    expect(args.p_rail_club_id).toBe('club-1');
  });

  it('rounds the horizon, because the parameter is an integer', async () => {
    replied({ ok: true, clubs: 1 });
    await fetchTickerFeed(ALL_ON, 900_000.7, null);
    expect(mocks.rpc.mock.calls[0][1].p_horizon_ms).toBe(900_001);
  });

  it('never ships a club-id list in either direction', async () => {
    /* THE SCOPE MOVED INSIDE THE FUNCTION. The browser used to send its own
       membership list into five filters, which is both a wire cost and a thing
       a caller could get wrong about itself. */
    replied({ ok: true, clubs: 3 });
    await fetchTickerFeed(ALL_ON, 900_000, null);
    expect(JSON.stringify(mocks.rpc.mock.calls[0][1])).not.toMatch(/club_ids|clubIds/);
    expect(FEED_SQL).toContain('auth.uid()');
  });
});

describe('a failure and an empty answer are different things', () => {
  it('returns null when the read FAILED, so the bar can keep what it had', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'connection interrupted' } });
    expect(await fetchTickerFeed(ALL_ON, 900_000, null)).toBeNull();
    expect(mocks.report).toHaveBeenCalled();
  });

  it('returns null when the call THREW, for the same reason', async () => {
    mocks.rpc.mockRejectedValue(new Error('offline'));
    expect(await fetchTickerFeed(ALL_ON, 900_000, null)).toBeNull();
    expect(mocks.report).toHaveBeenCalled();
  });

  it('returns an EMPTY feed when the function declines, which clears the bar', async () => {
    /* `ok: false` is an unauthenticated caller. There is nothing to say and
       nothing worth preserving, so this must not read as a failure. */
    replied({ ok: false, reason: 'not_authenticated' });
    const feed = await fetchTickerFeed(ALL_ON, 900_000, null);
    expect(feed).not.toBeNull();
    expect(feed?.upcoming).toEqual([]);
    expect(feed?.clubs).toBe(0);
  });

  it('survives a malformed body rather than throwing inside a poll tick', async () => {
    replied({ ok: true, clubs: 'lots', upcoming: 'not an array', overlays: null });
    const feed = await fetchTickerFeed(ALL_ON, 900_000, null);
    expect(feed?.clubs).toBe(0);
    expect(feed?.upcoming).toEqual([]);
    expect(feed?.overlays).toEqual([]);
  });

  it('treats a null body as a failure, not as an empty rail', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect(await fetchTickerFeed(ALL_ON, 900_000, null)).toBeNull();
  });
});

describe('the feed keeps each source in its own bucket', () => {
  it('hands every array through without reshaping it', async () => {
    replied({
      ok: true,
      clubs: 1,
      upcoming: [{ id: 'a' }],
      overlays: [{ id: 'b' }],
      reg_closing: [{ id: 'c' }],
      guarantees: [{ id: 'd' }],
      results: [{ id: 'e' }],
      table_openings: [{ id: 'f' }],
    });
    const feed = await fetchTickerFeed(ALL_ON, 900_000, null);
    expect(feed?.upcoming).toHaveLength(1);
    expect(feed?.overlays).toHaveLength(1);
    expect(feed?.reg_closing).toHaveLength(1);
    expect(feed?.guarantees).toHaveLength(1);
    expect(feed?.results).toHaveLength(1);
    expect(feed?.table_openings).toHaveLength(1);
  });
});

describe('the SQL and the TypeScript cannot drift apart', () => {
  it('gives the upcoming read the same budget the constant reasons about', () => {
    /* #4575 shipped a horizon of fifteen minutes with a take of five, and the
       per-stake filter then discarded every row it fetched. The constant and
       the LIMIT now live in different languages, which is the same shape that
       produced that bug - so they are pinned to each other here. */
    const block = sliceBetween(FEED_SQL, '-- ── STARTING SOON', "jsonb_build_object('overlays'");
    expect(block).toContain(`LIMIT ${UPCOMING_ROW_LIMIT}`);
  });

  it('keeps registration closing to rows that can actually speak', () => {
    /* The superset argument: lateRegEndMs takes the LATER of two candidates,
       so either the minutes one is itself inside the five-minute window, or
       the levels one exists at all. 1,028 rows became 2. */
    const block = sliceBetween(FEED_SQL, '-- ── REGISTRATION CLOSING', '-- ── GUARANTEES');
    expect(block).toContain("interval '5 minutes'");
    expect(block).toContain('COALESCE(t.current_level, 0) < t.late_reg_levels');
    expect(block).toContain('t.level_started_at IS NOT NULL');
  });

  it('keeps results to the ten minutes the client renders one for', () => {
    const block = sliceBetween(FEED_SQL, '-- ── RESULTS', '-- ── TABLE OPENINGS');
    expect(block).toContain("interval '10 minutes'");
    expect(block).toContain("t.status = 'COMPLETED'");
  });

  it('bounds the horizon a caller can ask for', () => {
    /* p_horizon_ms is a parameter, so it is an input. Without a clamp a caller
       could ask the bar to read a month ahead. */
    expect(FEED_SQL).toMatch(/LEAST\(GREATEST\(COALESCE\(p_horizon_ms, 0\), 0\), 3600000\)/);
  });

  it('cannot be executed by anonymous callers', () => {
    expect(FEED_SQL).toMatch(/REVOKE ALL ON FUNCTION public\.fn_get_ticker_feed[^\n]*anon/);
    expect(FEED_SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_get_ticker_feed[^\n]*authenticated/
    );
  });

  it('is one transaction, per the production DDL policy', () => {
    expect(FEED_SQL.match(/^BEGIN;/gm) ?? []).toHaveLength(1);
    expect(FEED_SQL.match(/^COMMIT;/gm) ?? []).toHaveLength(1);
  });

  it('verifies itself, so a broken feed rolls back instead of shipping', () => {
    expect(FEED_SQL).toContain('VERIFY FAILED');
    expect(FEED_SQL).toContain('a source that is switched off returned rows');
    expect(FEED_SQL).toContain('a source exceeded its row budget');
  });
});
