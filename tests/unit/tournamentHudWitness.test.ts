import { describe, expect, it, vi } from 'vitest';
import {
  eligibleHudClock,
  createHudClockReader,
  hudEventObservationMs,
  mttCaseTimeoutMs,
  OperationalPollFailure,
  receivedHudLevel,
  selectableHudClock,
  sharedNaturalLevel,
  waitForSharedNaturalLevel,
  HUD_RESERVE_MS,
  MTT_HUD_LEVEL_CAP_MS,
} from '../e2e/support/tournamentHudWitness';

const id = '11111111-1111-4111-8111-111111111111';
const now = Date.parse('2026-09-27T03:40:30Z');
const row = {
  id,
  format_contract: 'mtt-v1',
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
  it('reserves the next boundary plus the original sixty seconds after recovery', () => {
    // 150_000 comfortably covers the 120_000ms level, so it is eligible
    // regardless of which of the two roles (a generous level cap, or - in the
    // old design - a remaining case budget) it is read as.
    expect(eligibleHudClock(row, now, 150_000)).toEqual({
      tournamentId: id,
      levelIndex: 2,
      intervalMs: 120_000,
      remainingMs: 90_000,
      nextIntervalMs: 120_000,
      requiredObservationMs: 150_000,
      observedAt: now,
    });
  });
  it('eligibility no longer depends on how much of the case is left, only on the level itself', () => {
    // The actual failed production witness: an eligible six-minute level with
    // only 277_398ms of a fixed 390_000ms case left. The old design compared
    // requiredObservationMs against that shrinking budget and refused it by
    // luck. The level itself is well inside any sane cap, so it is eligible
    // regardless of how little of the case happens to remain by this point -
    // the case's deadline is sized to it afterward (see mttCaseTimeoutMs).
    const recoveredAt = Date.parse('2026-09-27T16:20:39.769Z');
    const sixMinute = {
      ...row,
      current_level: 29,
      level_started_at: '2026-09-27T16:19:09.769Z',
      blind_structure: [{ durationMinutes: 6 }],
    };
    const clock = eligibleHudClock(sixMinute, recoveredAt);
    expect(clock?.intervalMs).toBe(360_000);
    expect(clock?.requiredObservationMs).toBe(330_000);
    // A budget of 277_398ms - the actual recorded shortfall - used to refuse
    // this exact clock. It is no longer a parameter this function takes.
    expect(eligibleHudClock(sixMinute, recoveredAt)).not.toBeNull();
  });
  it('refuses a level longer than the certifiable cap, right at its boundary', () => {
    const atCap = { ...row, blind_structure: [{ durationMinutes: MTT_HUD_LEVEL_CAP_MS / 60_000 }] };
    const overCap = {
      ...row,
      blind_structure: [{ durationMinutes: MTT_HUD_LEVEL_CAP_MS / 60_000 + 1 }],
    };
    expect(eligibleHudClock(atCap, now)?.intervalMs).toBe(MTT_HUD_LEVEL_CAP_MS);
    expect(eligibleHudClock(overCap, now)).toBeNull();
    // The cap is a caller-supplied ceiling, not only the default.
    expect(eligibleHudClock(row, now, 119_999)).toBeNull();
    expect(eligibleHudClock(row, now, 120_000)?.intervalMs).toBe(120_000);
    for (const cap of [0, -1, NaN, Infinity]) expect(eligibleHudClock(row, now, cap)).toBeNull();
  });
  it('still refuses malformed and boundary-exhausted clocks under a generous cap', () => {
    expect(
      eligibleHudClock({ ...row, blind_structure: [{ duration: 180 }] }, now)?.intervalMs
    ).toBe(180_000);
    expect(
      eligibleHudClock({ ...row, blind_structure: JSON.stringify([{ duration_minutes: 1 }]) }, now)
        ?.intervalMs
    ).toBe(60_000);
    // Exactly at the 20s no-time-left floor, and just past it.
    expect(eligibleHudClock(row, now + 70_000)).toBeNull();
    expect(eligibleHudClock(row, now + 69_999)?.remainingMs).toBe(20_001);
  });
  it('requires a real next level that remains visible through its render assertion', () => {
    const variable = {
      ...row,
      current_level: 0,
      blind_structure: [{ durationMinutes: 1 }, { durationMinutes: 5 }],
    };
    expect(eligibleHudClock(variable, now)?.nextIntervalMs).toBe(300_000);
    for (const next of [{}, { duration: 32 }, { isBreak: true, durationMinutes: 2 }])
      expect(
        eligibleHudClock({ ...variable, blind_structure: [{ durationMinutes: 1 }, next] }, now)
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
        now
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
  describe('the case timeout is sized from the real clock, never guessed', () => {
    it('adds exactly the reserve the clock needs on top of time already spent', () => {
      const clock = eligibleHudClock(row, now, 150_000)!;
      expect(clock.requiredObservationMs).toBe(150_000);
      // A currentTimeoutMs below what's needed never wins the max.
      expect(mttCaseTimeoutMs(132_602, clock, 200_000)).toBe(132_602 + 150_000);
    });
    it('never shrinks the case below the timeout already in force', () => {
      const clock = eligibleHudClock(row, now, 150_000)!;
      // 132_602 + 150_000 = 282_602, well under the existing 390_000 floor.
      expect(mttCaseTimeoutMs(132_602, clock, 390_000)).toBe(390_000);
    });
    it('reproduces the actual 2026-09-28 production refusal and fixes it deterministically', () => {
      // Runs 36381276194 and 36389080031, tournament 2dbd67a7...: RUNNING,
      // 164 players, current_level 10 (zero-based, lasts 7 minutes),
      // level_started_at 07:02:47.500Z. The case started at 07:03:25.900Z
      // with test timeout 390_000ms, so its one fixed deadline was
      // 07:09:55.900Z. The attached qualification recorded budgetMs
      // 277_398ms remaining at the read - the one exact figure the
      // coordinator's evidence gives - which places the read at
      // 07:05:18.502Z.
      const tournamentId = '2dbd67a7-0000-4000-8000-000000000000';
      const caseStartedAt = Date.parse('2026-09-28T07:03:25.900Z');
      const oldDeadline = caseStartedAt + 390_000;
      const recordedBudgetMs = 277_398;
      const readAt = oldDeadline - recordedBudgetMs;
      expect(new Date(readAt).toISOString()).toBe('2026-09-28T07:05:18.502Z');
      const row10 = {
        id: tournamentId,
        format_contract: 'mtt-v1',
        status: 'RUNNING',
        current_players: 164,
        started_at: '2026-09-28T05:00:00Z',
        current_level: 10,
        level_started_at: '2026-09-28T07:02:47.500Z',
        on_break: false,
        blind_structure: Array.from({ length: 12 }, () => ({ durationMinutes: 7 })),
      };
      // On main, eligibleHudClock's third argument is the remaining case
      // budget and this call is refused: intervalMs=420_000,
      // remainingMs=268_998, requiredObservationMs=328_998 is 51_600ms more
      // than the 277_398ms actually left - the exact shortfall behind
      // "no eligible natural HUD clock inside the remaining case budget".
      // On this fix, the third argument is a level-length cap the six- and
      // seven-minute production schedule sits nowhere near, so the same
      // clock is eligible and the case grows to fit it instead of losing the
      // coin flip.
      const clock = eligibleHudClock(row10, readAt);
      expect(clock).not.toBeNull();
      expect(clock?.intervalMs).toBe(420_000);
      expect(clock?.remainingMs).toBe(268_998);
      expect(clock?.requiredObservationMs).toBe(328_998);
      expect(clock!.requiredObservationMs - recordedBudgetMs).toBe(51_600); // would have refused, old design
      const elapsedMs = clock!.observedAt - caseStartedAt;
      expect(elapsedMs).toBe(112_602);
      const extended = mttCaseTimeoutMs(elapsedMs, clock!, 390_000);
      // Independent of exactly when the clock is read: elapsed + required
      // always resolves to (level end) - (case start) + the 60s reserve.
      expect(extended).toBe(441_600);
      // The extension stays comfortably under the certifiable cap the
      // enclosing job's timeout is sized against.
      expect(extended).toBeLessThan(390_000 + MTT_HUD_LEVEL_CAP_MS + HUD_RESERVE_MS);
    });
  });
  it('charges actual SDK authentication and row reads to the observed clock only', async () => {
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
      const clocks = await reader.clocks(['table-one'], 200_000);
      expect(reader.qualifications[0].levelCapMs).toBe(200_000);
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
  it('records an unreadable table separately from a readable but ineligible tournament', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const email = 'ca-customization-cert-postdeploy-refusal@example.invalid';
    const missingTable = '22222222-2222-4222-8222-222222222222';
    const ineligibleTable = '33333333-3333-4333-8333-333333333333';
    vi.stubEnv('SP_EMAIL', email);
    vi.stubEnv('SP_PASS', 'local-fixture-only');
    vi.stubEnv('SUPABASE_URL', 'https://hud-refusal.example.invalid');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-fixture-public-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        let body: unknown;
        if (url.pathname === '/auth/v1/token') {
          body = {
            access_token: 'local-fixture-access-token',
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'local-fixture-refresh-token',
            user: { id, email },
          };
        } else if (url.pathname === '/rest/v1/tables') {
          body = [{ id: ineligibleTable, tournament_id: id }];
        } else if (url.pathname === '/rest/v1/tournaments') {
          body = [
            {
              ...row,
              addon_period_started_at: '2026-09-27T03:35:00Z',
              addon_period_ends_at: '2026-09-27T03:45:00Z',
            },
          ];
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
      expect(
        await reader.clocks(
          [missingTable, ineligibleTable],
          MTT_HUD_LEVEL_CAP_MS,
          selectableHudClock
        )
      ).toEqual(new Map());
      expect(reader.qualificationBatches.at(-1)).toEqual({
        requestedTableCount: 2,
        readableTableCount: 1,
        requestedTournamentCount: 1,
        readableTournamentCount: 1,
        eligibleTournamentCount: 0,
        eligibleTableCount: 0,
        rejectionCategories: {
          unreadable_table: 1,
          addon_period_open: 1,
        },
      });
      expect(reader.refusalEvidence().latestQualifications).toEqual([
        {
          tableId: missingTable,
          tournamentId: null,
          clock: null,
          levelCapMs: MTT_HUD_LEVEL_CAP_MS,
          category: 'unreadable_table',
        },
        {
          tableId: ineligibleTable,
          tournamentId: id,
          clock: null,
          levelCapMs: MTT_HUD_LEVEL_CAP_MS,
          category: 'addon_period_open',
        },
      ]);
    } finally {
      await reader?.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
  it('pages the joined table read, pins every MTT filter, and excludes competing SNGs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const email = 'ca-customization-cert-postdeploy-pagination@example.invalid';
    const fixtureClub = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
    const fixtureUnion = 'fade0000-0000-0000-0000-000000000001';
    const eligibleTournament = '66666666-6666-4666-8666-666666666666';
    const eligibleTable = '77777777-7777-4777-8777-777777777777';
    let tableReads = 0;
    vi.stubEnv('SP_EMAIL', email);
    vi.stubEnv('SP_PASS', 'local-fixture-only');
    vi.stubEnv('SUPABASE_URL', 'https://hud-pagination.example.invalid');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-fixture-public-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        let body: unknown;
        if (url.pathname === '/auth/v1/token') {
          body = {
            access_token: 'local-fixture-access-token',
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'local-fixture-refresh-token',
            user: { id, email },
          };
        } else if (url.pathname === '/rest/v1/tables') {
          tableReads += 1;
          expect(url.searchParams.get('select')).toContain(
            'tournament:tournaments!tables_tournament_id_fkey!inner('
          );
          expect(url.searchParams.get('status')).toBe('eq.running');
          expect(url.searchParams.get('tournament.status')).toBe('eq.RUNNING');
          expect(url.searchParams.get('tournament.format_contract')).toBe('in.(mtt-v1,mtt-v2)');
          expect(url.searchParams.get('tournament.or')).toBe(
            `(club_id.in.(${fixtureClub},${fixtureUnion}),union_id.in.(${fixtureClub},${fixtureUnion}))`
          );
          expect(url.searchParams.get('order')).toBe('id.asc');
          expect(url.searchParams.get('limit')).toBe('1000');
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          expect(init?.signal?.aborted).toBe(false);
          expect(url.searchParams.has('offset')).toBe(false);
          expect(url.searchParams.get('id')).toBe(
            tableReads === 1 ? null : 'gt.20000000-0000-4000-8000-000000000999'
          );
          body =
            tableReads === 1
              ? Array.from({ length: 1000 }, (_, index) => {
                  const tournamentId = `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`;
                  return {
                    id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
                    tournament_id: tournamentId,
                    status: 'running',
                    current_players: 9,
                    tournament: {
                      ...row,
                      id: tournamentId,
                      format_contract: 'sng-v1',
                      club_id: fixtureClub,
                    },
                  };
                })
              : tableReads === 2
                ? [
                    {
                      id: eligibleTable,
                      tournament_id: eligibleTournament,
                      status: 'running',
                      current_players: 4,
                      tournament: {
                        ...row,
                        id: eligibleTournament,
                        format_contract: 'mtt-v1',
                        club_id: fixtureClub,
                      },
                    },
                  ]
                : [];
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
      expect(
        await reader.discoverSelectableTableIds(
          [fixtureClub, fixtureUnion],
          MTT_HUD_LEVEL_CAP_MS,
          32,
          now + 30_000
        )
      ).toEqual([eligibleTable]);
      expect(tableReads).toBe(2);
      expect(reader.discoveries.at(-1)).toEqual({
        fixtureClubIds: [fixtureClub, fixtureUnion],
        readableTournamentCount: 1001,
        eligibleTournamentCount: 1,
        requestedTournamentCount: 1001,
        readableTableCount: 1001,
        selectedTableCount: 1,
        rejectionCategories: { not_mtt_format: 1000, eligible: 1 },
      });
    } finally {
      await reader?.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
  it('bounds a large unreadable candidate set to four joined requests and the fixed deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const email = 'ca-customization-cert-postdeploy-bounded@example.invalid';
    const fixtureClub = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
    const fixtureUnion = 'fade0000-0000-0000-0000-000000000001';
    let tableReads = 0;
    vi.stubEnv('SP_EMAIL', email);
    vi.stubEnv('SP_PASS', 'local-fixture-only');
    vi.stubEnv('SUPABASE_URL', 'https://hud-bounded.example.invalid');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-fixture-public-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        let body: unknown;
        if (url.pathname === '/auth/v1/token') {
          body = {
            access_token: 'local-fixture-access-token',
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'local-fixture-refresh-token',
            user: { id, email },
          };
        } else if (url.pathname === '/rest/v1/tables') {
          const page = tableReads;
          tableReads += 1;
          expect(url.searchParams.has('offset')).toBe(false);
          expect(url.searchParams.get('order')).toBe('id.asc');
          expect(url.searchParams.get('limit')).toBe('1000');
          expect(url.searchParams.get('id')).toBe(
            page === 0 ? null : `gt.table-${String(page * 1000 - 1).padStart(8, '0')}`
          );
          body = Array.from({ length: 1000 }, (_, index) => {
            const ordinal = page * 1000 + index;
            const tournamentId = `tournament-${ordinal}`;
            return {
              id: `table-${String(ordinal).padStart(8, '0')}`,
              tournament_id: tournamentId,
              status: 'paused',
              current_players: 4,
              tournament: { ...row, id: tournamentId, club_id: fixtureClub },
            };
          });
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
      await expect(
        reader.discoverSelectableTableIds(
          [fixtureClub, fixtureUnion],
          MTT_HUD_LEVEL_CAP_MS,
          32,
          now + 30_000
        )
      ).rejects.toThrow('bounded read limit');
      expect(tableReads).toBe(4);
      expect(reader.discoveries.at(-1)).toMatchObject({
        readableTournamentCount: 4000,
        eligibleTournamentCount: 4000,
        readableTableCount: 4000,
        selectedTableCount: 0,
        rejectionCategories: { eligible: 4000, table_scan_truncated: 1 },
      });
    } finally {
      await reader?.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
  it('rethrows a forced discovery or exact-health failure and clears it after a clean read', async () => {
    const tracker = new OperationalPollFailure();
    const failure = new Error('forced exact-health failure');
    await expect(
      tracker.attempt(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(() => tracker.rethrowIfPresent()).toThrow(failure);
    await expect(tracker.attempt(async () => 0)).resolves.toBe(0);
    expect(() => tracker.rethrowIfPresent()).not.toThrow();
  });
  it('classifies an abandoned in-flight health read as operational, never as an absent subject', async () => {
    const tracker = new OperationalPollFailure();
    let resolve!: (value: number) => void;
    const pending = tracker.attempt(
      () =>
        new Promise<number>((done) => {
          resolve = done;
        })
    );
    expect(() => tracker.rethrowIfPresent()).toThrow(
      'authenticated health read was still in flight'
    );
    resolve(1);
    await expect(pending).resolves.toBe(1);
    expect(() => tracker.rethrowIfPresent()).not.toThrow();
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
    expect(eligibleHudClock({ ...row, ...override }, now)).toBeNull();
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
