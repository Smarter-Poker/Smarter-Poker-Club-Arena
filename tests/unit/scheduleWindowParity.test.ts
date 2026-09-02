/**
 * The client and the server must publish the SAME window.
 *
 * `src/utils/tournamentScheduleWindow.ts` decides what the lobby LISTS.
 * `server/src/services/ScheduledTournamentService.ts` decides what the spawner
 * CREATES. They hold the same two numbers in two files because `server/`
 * compiles standalone — the same arrangement RakeConfig has, and the same
 * failure mode: if the spawner's look-ahead is shorter than the lobby's window,
 * the lobby asks for events that do not exist and the board just looks thin,
 * with nothing anywhere going red. That is exactly the state this shipped to
 * fix (spawner 24h, board wanted 48h).
 *
 * If this test fails, change BOTH files, not this one.
 */

import { describe, it, expect, vi } from 'vitest';

/* The server service reaches for env vars at load time through its own
   supabase module. Same stub ScheduledTournamentService.test.ts uses, for the
   same reason: this file is about two constants, not about a database. */
vi.mock('../../server/src/services/supabase.js', () => ({
  supabase: {
    from: () => ({}),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    channel: vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue(undefined),
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    }),
  },
}));

import {
  LOBBY_WINDOW_MS,
  LOBBY_FEATURE_WINDOW_MS,
  FEATURE_BUYIN_THRESHOLD,
  LOBBY_WINDOW_HOURS,
  LOBBY_FEATURE_WINDOW_DAYS,
  scheduleWindowMsFor,
  isWithinLobbyWindow,
  lobbyQueryHorizonIso,
} from '../../src/utils/tournamentScheduleWindow';
import {
  TIMED_WINDOW_AHEAD_MS,
  FEATURE_WINDOW_AHEAD_MS,
  FEATURE_BUYIN_THRESHOLD as SERVER_FEATURE_BUYIN_THRESHOLD,
  spawnAheadMsFor,
} from '../../server/src/services/ScheduledTournamentService';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('the published window is one rule', () => {
  it('is 72 hours, and 6 days from a 200 buy-in upward', () => {
    // Dan 2026-08-26, second pass: "USE 72H/6 DAY FOR $200 BUY IN OR MORE".
    // 72 is not a new number - it is what TournamentLobbyPage already used, so
    // this is the club board and the tournament board finally agreeing.
    expect(LOBBY_WINDOW_HOURS).toBe(72);
    expect(LOBBY_FEATURE_WINDOW_DAYS).toBe(6);
    expect(LOBBY_WINDOW_MS).toBe(72 * HOUR);
    expect(LOBBY_FEATURE_WINDOW_MS).toBe(6 * DAY);
    expect(FEATURE_BUYIN_THRESHOLD).toBe(200);
  });

  it('the server spawner uses the identical numbers', () => {
    expect(TIMED_WINDOW_AHEAD_MS).toBe(LOBBY_WINDOW_MS);
    expect(FEATURE_WINDOW_AHEAD_MS).toBe(LOBBY_FEATURE_WINDOW_MS);
    expect(SERVER_FEATURE_BUYIN_THRESHOLD).toBe(FEATURE_BUYIN_THRESHOLD);
  });

  it('THE SPAWNER NEVER PUBLISHES LESS THAN THE LOBBY LISTS', () => {
    // The invariant that actually matters. A lobby cannot list a row that was
    // never created, so the look-ahead must be at least the display window for
    // every price point.
    for (const buyIn of [0, 1, 25, 199, 200, 201, 500, 10_000]) {
      expect(spawnAheadMsFor({ buyIn })).toBeGreaterThanOrEqual(scheduleWindowMsFor(buyIn));
    }
  });
});

describe('spawnAheadMinutes RAISES the floor and never lowers it', () => {
  /**
   * THE BUG THAT ALMOST SHIPPED GREEN. Every one of the 60 active schedules on
   * this platform carries `spawnAheadMinutes: 1440`, written when 24 hours was
   * the house window. The first version of spawnAheadMsFor let an explicit
   * override win outright -- so moving TIMED_WINDOW_AHEAD_MS to 48 hours would
   * have changed the board for exactly zero schedules, while every test, every
   * typecheck and every CI gate went green.
   *
   * Verified against production on 2026-08-26:
   *   ahead_minutes=1440, schedules=60, max_buyin=109
   */
  it('the real production value (1440) cannot hold the board at 24 hours', () => {
    expect(spawnAheadMsFor({ buyIn: 10, spawnAheadMinutes: 1440 })).toBe(LOBBY_WINDOW_MS);
    expect(spawnAheadMsFor({ buyIn: 10, spawnAheadMinutes: 1440 })).toBeGreaterThan(24 * HOUR);
  });

  it('an override LARGER than the floor still wins (the Major opens a week early)', () => {
    expect(spawnAheadMsFor({ buyIn: 10, spawnAheadMinutes: 10080 })).toBe(10080 * 60_000);
  });

  it('no override, at any price, can publish less than the house window', () => {
    for (const mins of [30, 60, 720, 1440, 2879, 4319]) {
      for (const buyIn of [0, 50, 500]) {
        expect(spawnAheadMsFor({ buyIn, spawnAheadMinutes: mins })).toBeGreaterThanOrEqual(
          scheduleWindowMsFor(buyIn)
        );
      }
    }
  });

  it('an out-of-range override is ignored, not clamped', () => {
    expect(spawnAheadMsFor({ buyIn: 10, spawnAheadMinutes: 1 })).toBe(LOBBY_WINDOW_MS);
    expect(spawnAheadMsFor({ buyIn: 10, spawnAheadMinutes: 99999 })).toBe(LOBBY_WINDOW_MS);
    expect(spawnAheadMsFor({ buyIn: 10, spawnAheadMinutes: 'soon' })).toBe(LOBBY_WINDOW_MS);
  });

  it('a big event keeps its 6 days even under a 24 hour override', () => {
    expect(spawnAheadMsFor({ buyIn: 500, spawnAheadMinutes: 1440 })).toBe(LOBBY_FEATURE_WINDOW_MS);
  });
});

describe('scheduleWindowMsFor', () => {
  it('INCLUDES 200, because the Sunday Deep Stack is priced at exactly 200', () => {
    /* This assertion used to say the opposite. The first pass read "more then
       200" literally and implemented `> 200`, which put a flat 200 event on
       the SHORT window -- and the flagship added in the same batch costs
       exactly 200, so the rule would have excluded the one event it was
       written for. "OR MORE" settles it. */
    expect(scheduleWindowMsFor(200)).toBe(LOBBY_FEATURE_WINDOW_MS);
    expect(scheduleWindowMsFor(199)).toBe(LOBBY_WINDOW_MS);
    expect(scheduleWindowMsFor(201)).toBe(LOBBY_FEATURE_WINDOW_MS);
    expect(scheduleWindowMsFor(0)).toBe(LOBBY_WINDOW_MS);
  });
});

describe('isWithinLobbyWindow', () => {
  const now = Date.parse('2026-08-26T12:00:00Z');
  const at = (ms: number) => new Date(now + ms).toISOString();

  it('lists a cheap event inside 72 hours and drops it beyond', () => {
    const cheap = { buy_in_amount: 9, buy_in_fee: 1 }; // total 10
    expect(isWithinLobbyWindow({ ...cheap, start_time: at(71 * HOUR) }, now)).toBe(true);
    expect(isWithinLobbyWindow({ ...cheap, start_time: at(73 * HOUR) }, now)).toBe(false);
  });

  it('THE SUNDAY DEEP STACK: a flat 200 gets the long window, not the short one', () => {
    // 180 prize + 20 fee is the real split buyInFor(200) produces, and it is
    // the exact shape that a `> 200` rule would have demoted.
    const deepStack = { buy_in_amount: 180, buy_in_fee: 20 };
    expect(isWithinLobbyWindow({ ...deepStack, start_time: at(5 * DAY) }, now)).toBe(true);
    expect(isWithinLobbyWindow({ ...deepStack, start_time: at(7 * DAY) }, now)).toBe(false);
    // Its cheapest satellite is a 72-hour event.
    const sat = { buy_in_amount: 5, buy_in_fee: 0 };
    expect(isWithinLobbyWindow({ ...sat, start_time: at(71 * HOUR) }, now)).toBe(true);
    expect(isWithinLobbyWindow({ ...sat, start_time: at(73 * HOUR) }, now)).toBe(false);
  });

  it('lists a big event for 6 days', () => {
    // Total, not the prize half: 190 + 20 is a 210 event and gets the long
    // window even though neither column alone is over the threshold.
    const big = { buy_in_amount: 190, buy_in_fee: 20 };
    expect(isWithinLobbyWindow({ ...big, start_time: at(5 * DAY) }, now)).toBe(true);
    expect(isWithinLobbyWindow({ ...big, start_time: at(7 * DAY) }, now)).toBe(false);
  });

  it('always lists something already under way', () => {
    // A RUNNING or late-registering event has a start time in the past. Dan
    // 2026-08-24: it stays on the board at the bottom of the MTT tab.
    expect(isWithinLobbyWindow({ buy_in_amount: 5, start_time: at(-6 * HOUR) }, now)).toBe(true);
  });

  it('fails OPEN on an unreadable start time rather than hiding the event', () => {
    expect(isWithinLobbyWindow({ start_time: null }, now)).toBe(true);
    expect(isWithinLobbyWindow({ start_time: 'not a date' }, now)).toBe(true);
  });
});

describe('lobbyQueryHorizonIso', () => {
  it('is the LONGEST window, so the query never clips what the filter would keep', () => {
    const now = Date.parse('2026-08-26T12:00:00Z');
    expect(Date.parse(lobbyQueryHorizonIso(now)) - now).toBe(LOBBY_FEATURE_WINDOW_MS);
  });
});
