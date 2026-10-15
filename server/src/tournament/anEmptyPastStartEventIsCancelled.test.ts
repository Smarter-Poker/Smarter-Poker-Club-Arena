/**
 * AN EVENT NOBODY ENTERED IS CANCELLED, NOT WAITED ON FOR EVER (2026-10-15).
 *
 * TournamentNeverStarted paged every hour on three "Daily 25 Chip Freezeout"
 * events of a one-member pilot club with no horse in it: zero entrants, 7 to
 * 55 hours past start, REGISTERING for ever, one more spawned every day. The
 * past-start lane topped them up with horses that did not exist and tried
 * again, with no end. See tournament/emptyPastStartEvent.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMPTY_PAST_START_CANCEL_AFTER_MS,
  EMPTY_PAST_START_CANCEL_RETRY_MS,
  shouldCancelEmptyPastStartEvent,
  type EmptyPastStartEvent,
} from './emptyPastStartEvent.js';

const START = Date.parse('2026-10-14T19:00:00Z');
const empty: EmptyPastStartEvent = {
  seatFirst: false,
  poolFinalized: false,
  rosterCount: 0,
  currentPlayers: 0,
  startTimeMs: START,
  nowMs: START + 7 * 60 * 60 * 1000,
  emptyTopUps: 1,
};

describe('an empty past-start event', () => {
  it('is cancelled once nobody entered, it is 30 minutes past start and the top-up came back empty', () => {
    expect(shouldCancelEmptyPastStartEvent(empty)).toBe(true);
    expect(
      shouldCancelEmptyPastStartEvent({
        ...empty,
        nowMs: START + EMPTY_PAST_START_CANCEL_AFTER_MS,
      })
    ).toBe(true);
  });

  it('is never cancelled with an entrant on its roster or its counter', () => {
    expect(shouldCancelEmptyPastStartEvent({ ...empty, rosterCount: 1 })).toBe(false);
    expect(shouldCancelEmptyPastStartEvent({ ...empty, currentPlayers: 1 })).toBe(false);
  });

  it('is never cancelled when its roster could not be read', () => {
    expect(shouldCancelEmptyPastStartEvent({ ...empty, rosterCount: undefined })).toBe(false);
  });

  it('waits for the top-up first, so a club whose horses can fill it plays it', () => {
    expect(shouldCancelEmptyPastStartEvent({ ...empty, emptyTopUps: 0 })).toBe(false);
  });

  it('waits thirty minutes past start', () => {
    expect(
      shouldCancelEmptyPastStartEvent({
        ...empty,
        nowMs: START + EMPTY_PAST_START_CANCEL_AFTER_MS - 1,
      })
    ).toBe(false);
    expect(shouldCancelEmptyPastStartEvent({ ...empty, nowMs: START - 60_000 })).toBe(false);
  });

  it('never touches a seat-first game or a finalized pool', () => {
    expect(shouldCancelEmptyPastStartEvent({ ...empty, seatFirst: true })).toBe(false);
    expect(shouldCancelEmptyPastStartEvent({ ...empty, poolFinalized: true })).toBe(false);
  });

  it('refuses an unreadable clock', () => {
    expect(shouldCancelEmptyPastStartEvent({ ...empty, startTimeMs: Number.NaN })).toBe(false);
  });

  it('asks again no more than every thirty minutes', () => {
    expect(EMPTY_PAST_START_CANCEL_RETRY_MS).toBe(30 * 60 * 1000);
  });
});

describe('the discovery loop wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/GameServer.ts'), 'utf8');
  const start = source.indexOf('AN EVENT NOBODY ENTERED IS CANCELLED (2026-10-15)');
  const branch = source.slice(start, source.indexOf('/* At most every 45 s', start));

  it('asks the predicate with the complete roster read and the top-up backoff', () => {
    expect(start).toBeGreaterThan(-1);
    expect(branch).toContain('shouldCancelEmptyPastStartEvent({');
    expect(branch).toContain('rosterCount: rosterByTournament.get(tournament.id)');
    expect(branch).toContain('emptyTopUps: emptyClock?.misses ?? 0');
  });

  it('cancels only through the database cancellation authority', () => {
    expect(branch).toContain("supabase.rpc('atomic_cancel_tournament'");
    expect(branch).not.toMatch(/\.update\(\{\s*status:/);
    expect(branch).toContain("'GameServer.empty_past_start_event_cancel_refused'");
  });

  it('keeps its retry clock on the past-start clock entry, pruned with the event', () => {
    expect(branch).toContain('const askedAt = emptyClock?.cancelAskedAt ?? 0;');
    expect(branch).toContain('cancelAskedAt: now,');
    expect(source).toContain('private pastStartTopUpClock: Map<string, PastStartTopUpClock>');
    expect(source).toContain('  cancelAskedAt?: number;');
  });

  it('sits inside the past-start top-up branch, ahead of the top-up', () => {
    const topUp = source.indexOf('if (needsPastStartTopUp) {');
    expect(topUp).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(topUp);
    expect(source.indexOf('this.tournamentRecurring.topUpWithHorses(', start)).toBeGreaterThan(
      start
    );
  });
});
