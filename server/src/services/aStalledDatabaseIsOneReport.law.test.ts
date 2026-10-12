/**
 * LAW: A DATABASE STALL IS ONE REPORT, AND IT IS NOT ASKED AGAIN EVERY TWENTY
 * SECONDS (2026-10-12).
 *
 * The horse tournament context refreshes every live tournament on its own
 * twenty-second clock. In a Postgres stall each one timed out and filed its own
 * TournamentBrainContext.refresh (491 in the minute of 11:31 UTC on
 * 2026-10-12), and each timed-out read was replaced twenty seconds later by a
 * new one while the old one still ran in the database. A refresh that timed
 * out now waits 40 s, then 80 s, before the next; a published context returns
 * it to 20 s; a fast error keeps 20 s. Failures are reported once a minute and
 * the report carries what the previous minute suppressed.
 *
 * Registry: docs/laws.d/server-src-services-aStalledDatabaseIsOneReport.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('./errorReporter.js', () => ({ reportError: h.reportError }));

import {
  __clearTournamentBrainCache,
  noteTournamentContextRefreshFailure,
  refreshIntervalAfterTimeouts,
} from './TournamentBrainContext.js';

const SRC = readFileSync(join(__dirname, 'TournamentBrainContext.ts'), 'utf8');

beforeEach(() => {
  __clearTournamentBrainCache();
  h.reportError.mockClear();
});

describe('a timed-out refresh waits longer before it asks again', () => {
  it('20 s normally, 40 s after one timeout, 80 s from the second on', () => {
    expect(refreshIntervalAfterTimeouts(0)).toBe(20_000);
    expect(refreshIntervalAfterTimeouts(1)).toBe(40_000);
    expect(refreshIntervalAfterTimeouts(2)).toBe(80_000);
    expect(refreshIntervalAfterTimeouts(9)).toBe(80_000);
    expect(refreshIntervalAfterTimeouts(-1)).toBe(20_000);
    expect(refreshIntervalAfterTimeouts(Number.NaN)).toBe(20_000);
  });

  it('the background refresh is paced by that interval, and a success resets it', () => {
    expect(SRC).toMatch(
      /now - e\.lastAttemptAt > refreshIntervalAfterTimeouts\(e\.timeoutStreak \?\? 0\)/
    );
    expect(SRC).toMatch(/e\.lastFailureIssue = null;\s+e\.timeoutStreak = 0;/);
    expect(SRC).toMatch(
      /if \(ownsEntry\(\)\) e\.timeoutStreak = timedOut \? \(e\.timeoutStreak \?\? 0\) \+ 1 : 0;/
    );
  });
});

describe('a stall is reported once a minute', () => {
  it('reports the first failure of a minute and counts the rest into the next report', () => {
    const t0 = 1_800_000_000_000;
    const err = new Error('tournament context refresh timed out');
    noteTournamentContextRefreshFailure(err, 'a', t0);
    for (let i = 0; i < 40; i++)
      noteTournamentContextRefreshFailure(err, `t${i % 25}`, t0 + 1_000 + i);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenLastCalledWith(err, 'TournamentBrainContext.refresh', {
      tournamentId: 'a',
    });

    noteTournamentContextRefreshFailure(err, 'b', t0 + 60_000);
    expect(h.reportError).toHaveBeenCalledTimes(2);
    expect(h.reportError).toHaveBeenLastCalledWith(err, 'TournamentBrainContext.refresh', {
      tournamentId: 'b',
      previousWindowFailures: 40,
      previousWindowTournaments: 25,
    });
  });

  it('the refresh failure path goes through the minute window, never straight to reportError', () => {
    const start = SRC.indexOf(
      "const timedOut = error instanceof Error && error.message.includes('timed out');"
    );
    const end = SRC.indexOf('publishFailure(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(SRC.slice(start, end)).toContain(
      'noteTournamentContextRefreshFailure(error, tournamentId);'
    );
    expect(SRC).not.toMatch(/reportError\(error, 'TournamentBrainContext\.refresh'\);/);
  });
});
