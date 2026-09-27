import { describe, expect, it, vi } from 'vitest';
import {
  eligibleHudClock,
  createHudClockReader,
  hudEventObservationMs,
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
  it('fits the actual six-minute level after gameplay and the outage have finished', () => {
    // Actual failed production witness: 360s levels were impossible under a
    // pre-outage two-boundary guarantee. After recovery one future boundary
    // with the SAME 60s reserve fits the unchanged 390s case.
    const recoveredAt = Date.parse('2026-09-27T16:20:39.769Z');
    const sixMinute = {
      ...row,
      current_level: 29,
      level_started_at: '2026-09-27T16:19:09.769Z',
      blind_structure: [{ durationMinutes: 6 }],
    };
    expect(eligibleHudClock(sixMinute, recoveredAt, 330_000)?.requiredObservationMs).toBe(330_000);
    expect(eligibleHudClock(sixMinute, recoveredAt, 329_999)).toBeNull();
  });
  it('reserves the next boundary plus the original sixty seconds after recovery', () => {
    expect(eligibleHudClock(row, now, 150_000)).toEqual({
      tournamentId: id,
      levelIndex: 2,
      intervalMs: 120_000,
      remainingMs: 90_000,
      nextIntervalMs: 120_000,
      requiredObservationMs: 150_000,
      observedAt: now,
    });
    expect(eligibleHudClock(row, now, 149_999)).toBeNull();
  });
  it('still refuses long, unknown and exhausted remaining clocks', () => {
    expect(
      eligibleHudClock({ ...row, blind_structure: [{ durationMinutes: 15 }] }, now, 300_000)
    ).toBeNull();
    expect(
      eligibleHudClock({ ...row, blind_structure: [{ duration: 180 }] }, now, 390_000)?.intervalMs
    ).toBe(180_000);
    expect(
      eligibleHudClock(
        { ...row, blind_structure: JSON.stringify([{ duration_minutes: 1 }]) },
        now,
        200_000
      )?.intervalMs
    ).toBe(60_000);
    for (const budget of [0, -1, NaN, Infinity])
      expect(eligibleHudClock(row, now, budget)).toBeNull();
    expect(eligibleHudClock(row, now + 70_000, 90_000)).toBeNull();
    expect(eligibleHudClock(row, now + 69_999, 80_001)?.remainingMs).toBe(20_001);
  });
  it('does not budget an unnecessary second boundary after the outage is complete', () => {
    const fiveMinute = { ...row, blind_structure: [{ durationMinutes: 5 }] };
    expect(eligibleHudClock(fiveMinute, now, 330_000)?.requiredObservationMs).toBe(330_000);
    expect(eligibleHudClock(fiveMinute, now, 329_999)).toBeNull();
  });
  it('requires a real next level that remains visible through its render assertion', () => {
    const variable = {
      ...row,
      current_level: 0,
      blind_structure: [{ durationMinutes: 1 }, { durationMinutes: 5 }],
    };
    expect(eligibleHudClock(variable, now, 90_000)?.nextIntervalMs).toBe(300_000);
    expect(eligibleHudClock(variable, now, 89_999)).toBeNull();
    for (const next of [{}, { duration: 32 }, { isBreak: true, durationMinutes: 2 }])
      expect(
        eligibleHudClock(
          { ...variable, blind_structure: [{ durationMinutes: 1 }, next] },
          now,
          390_000
        )
      ).toBeNull();
    expect(
      eligibleHudClock(
        {
          ...variable,
          blind_structure: [
            { durationMinutes: 1 },
            { durationMinutes: 2 },
            { isBreak: true, durationMinutes: 2 },
          ],
        },
        now,
        90_000
      )?.levelIndex
    ).toBe(0);
  });
  it('subtracts time spent reading and signing out from the original event and case deadlines', () => {
    const clock = eligibleHudClock(row, now, 150_000)!;
    expect(hudEventObservationMs(clock, now + 150_000, now)).toBe(105_000);
    expect(hudEventObservationMs(clock, now + 150_000, now + 12_345)).toBe(92_655);
    expect(hudEventObservationMs(clock, now + 140_000, now + 12_345)).toBe(82_655);
    expect(() => hudEventObservationMs(clock, now + 150_000, now + 105_000)).toThrow(
      'reserved time'
    );
    expect(() => hudEventObservationMs(clock, now + 150_000, now + 150_000)).toThrow(
      'no time remaining'
    );
  });
  it('charges actual SDK authentication and row reads to the same absolute case deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const email = 'ca-customization-cert-postdeploy-local@example.invalid';
    vi.stubEnv('SP_EMAIL', email);
    vi.stubEnv('SP_PASS', 'local-fixture-only');
    vi.stubEnv('SUPABASE_URL', 'https://hud-fixture.example.invalid');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-fixture-public-key');
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        paths.push(url.pathname + url.search);
        let body: unknown;
        if (url.pathname === '/auth/v1/token') {
          vi.setSystemTime(Date.now() + 5_000);
          body = {
            access_token: 'local-fixture-access-token',
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'local-fixture-refresh-token',
            user: { id, email },
          };
        } else if (url.pathname === '/rest/v1/tables') {
          vi.setSystemTime(Date.now() + 1_000);
          body = [{ id: 'table-one', tournament_id: id }];
        } else if (url.pathname === '/rest/v1/tournaments') {
          vi.setSystemTime(Date.now() + 1_000);
          body = [row];
        } else if (url.pathname === '/auth/v1/logout') body = {};
        else throw new Error('Unexpected local SDK request: ' + url.pathname);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    let reader: Awaited<ReturnType<typeof createHudClockReader>> | undefined;
    try {
      reader = await createHudClockReader();
      const clocks = await reader.clocks(['table-one'], now + 150_000);
      expect(reader.qualifications[0].budgetMs).toBe(143_000);
      expect(clocks.get('table-one')?.remainingMs).toBe(83_000);
      expect(clocks.get('table-one')?.observedAt).toBe(now + 7_000);
      await reader.close();
      reader = undefined;
      expect(paths.some((path) => path.includes('/auth/v1/logout?scope=local'))).toBe(true);
    } finally {
      await reader?.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
  it('ignores a level received during the outage and requires a new shared event after recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const owner = new AbortController();
    try {
      const clock = eligibleHudClock(row, now, 150_000)!;
      const primary = [{ tournamentId: id, levelIndex: 3, at: now - 1 }];
      const peer = [{ tournamentId: id, levelIndex: 3, at: now - 1 }];
      let resolved = false;
      const pending = waitForSharedNaturalLevel(
        () => sharedNaturalLevel(primary, peer, id, clock.levelIndex, clock.observedAt),
        hudEventObservationMs(clock, now + 150_000),
        owner.signal
      ).then((level) => {
        resolved = true;
        return level;
      });
      await vi.advanceTimersByTimeAsync(90_000);
      expect(resolved).toBe(false);
      primary.push({ tournamentId: id, levelIndex: 3, at: Date.now() });
      await vi.advanceTimersByTimeAsync(50);
      expect(resolved).toBe(false);
      peer.push({ tournamentId: id, levelIndex: 3, at: Date.now() });
      await vi.advanceTimersByTimeAsync(50);
      expect((await pending).levelIndex).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      owner.abort();
      vi.useRealTimers();
    }
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
  it('refuses a late second receiver instead of spending the rendered-assertion reserve', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const owner = new AbortController();
    const clock = eligibleHudClock(row, now, 150_000)!;
    const primary = [{ tournamentId: id, levelIndex: 3, at: now + 90_000 }];
    const peer: typeof primary = [];
    try {
      const pending = waitForSharedNaturalLevel(
        () => sharedNaturalLevel(primary, peer, id, clock.levelIndex, clock.observedAt),
        hudEventObservationMs(clock, now + 150_000),
        owner.signal
      );
      const refused = expect(pending).rejects.toThrow('no shared natural level transition');
      await vi.advanceTimersByTimeAsync(105_000);
      peer.push({ tournamentId: id, levelIndex: 3, at: Date.now() });
      await refused;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      owner.abort();
      vi.useRealTimers();
    }
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
