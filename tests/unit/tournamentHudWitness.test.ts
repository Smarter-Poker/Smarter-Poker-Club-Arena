import { describe, expect, it, vi } from 'vitest';
import {
  eligibleHudClock,
  receivedHudLevel,
  sharedNaturalLevel,
  waitForSharedNaturalLevel,
} from '../e2e/support/tournamentHudWitness';

const id = '11111111-1111-4111-8111-111111111111';
const now = Date.parse('2026-09-27T03:40:30Z');
const row = {
  id,
  status: 'RUNNING',
  current_players: 12,
  started_at: '2026-09-27T03:30:00Z',
  current_level: 2,
  level_started_at: '2026-09-27T03:40:00Z',
  on_break: false,
  blind_structure: [
    { durationMinutes: 2 },
    { durationMinutes: 2 },
    { durationMinutes: 2 },
    { durationMinutes: 2 },
  ],
};

describe('a natural HUD witness must fit the real clock and keep independent wire facts', () => {
  it('qualifies the actual remaining boundary while reserving another full interval and mount time', () => {
    expect(eligibleHudClock(row, now, 210_000)).toEqual({
      tournamentId: id,
      levelIndex: 2,
      intervalMs: 120_000,
      remainingMs: 90_000,
      observedAt: now,
    });
    expect(eligibleHudClock(row, now, 179_999)).toBeNull();
  });
  it('rejects healthy long levels instead of scheduling a predictable timeout', () => {
    expect(
      eligibleHudClock({ ...row, blind_structure: [{ durationMinutes: 15 }] }, now, 300_000)
    ).toBeNull();
    expect(
      eligibleHudClock({ ...row, blind_structure: [{ duration: 180 }] }, now, 250_000)?.intervalMs
    ).toBe(180_000);
    expect(
      eligibleHudClock(
        { ...row, blind_structure: JSON.stringify([{ duration_minutes: 1 }]) },
        now,
        200_000
      )?.intervalMs
    ).toBe(60_000);
  });
  it.each([
    { status: 'COMPLETED' },
    { current_players: 2 },
    { current_players: null },
    { on_break: true },
    { accelerated_mtt: true },
    { current_level: null },
    { level_started_at: '2026-09-27T03:35:00Z' },
    { level_started_at: '2026-09-27T03:45:00Z' },
    { blind_structure: 'invalid' },
    { blind_structure: [{}] },
    { blind_structure: [{ isBreak: true, durationMinutes: 2 }] },
    {
      current_level: 0,
      blind_structure: [{ durationMinutes: 2 }, { isBreak: true, durationMinutes: 2 }],
    },
    {
      addon_period_started_at: '2026-09-27T03:40:00Z',
      addon_period_ends_at: '2026-09-27T03:45:00Z',
    },
  ])('refuses unavailable or unstable timing: %j', (override) => {
    expect(eligibleHudClock({ ...row, ...override }, now, 300_000)).toBeNull();
  });
  const body = { event: 'tournament_event', payload: { type: 'level_up', payload: { level: 3 } } };
  it('reads both supported Realtime envelopes without changing the zero-based level', () => {
    for (const frame of [
      { topic: `realtime:t-break-${id}`, event: 'broadcast', payload: body },
      [null, null, `realtime:t-break-${id}`, 'broadcast', body],
    ])
      expect(receivedHudLevel(JSON.stringify(frame), now)).toEqual({
        tournamentId: id,
        levelIndex: 3,
        at: now,
      });
  });
  it('does not turn auth, unrelated broadcasts or absent levels into witness evidence', () => {
    for (const frame of [
      'invalid',
      {
        topic: `realtime:t-break-${id}`,
        event: 'phx_join',
        payload: { access_token: 'must-not-survive' },
      },
      { topic: 'realtime:other', event: 'broadcast', payload: body },
      {
        topic: `realtime:t-break-${id}`,
        event: 'broadcast',
        payload: { ...body, payload: { type: 'level_up', payload: { level: null } } },
      },
    ])
      expect(receivedHudLevel(JSON.stringify(frame), now)).toBeNull();
  });
  it('requires both contexts to receive the same later level for the same tournament after baseline', () => {
    const next = { tournamentId: id, levelIndex: 3, at: now + 1 };
    expect(sharedNaturalLevel([next], [next], id, 2, now)).toEqual(next);
    expect(sharedNaturalLevel([next], [], id, 2, now)).toBeUndefined();
    expect(
      sharedNaturalLevel([next], [{ ...next, tournamentId: 'other' }], id, 2, now)
    ).toBeUndefined();
    expect(sharedNaturalLevel([next], [{ ...next, levelIndex: 4 }], id, 2, now)).toBeUndefined();
    expect(sharedNaturalLevel([next], [{ ...next, at: now }], id, 2, now)).toBeUndefined();
    expect(sharedNaturalLevel([next], [next], id, 3, now)).toBeUndefined();
  });
  it('retires observation immediately after another assertion fails, without leaking a later-case timer', async () => {
    vi.useFakeTimers();
    try {
      const owner = new AbortController();
      const pending = waitForSharedNaturalLevel(() => undefined, 300_000, owner.signal);
      const result = expect(pending).rejects.toThrow('retired');
      owner.abort();
      await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
