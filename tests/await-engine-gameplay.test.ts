import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  awaitEngineGameplay,
  BREAK_START_MINUTE,
  CERTIFICATE_LEAD_MS,
  gameplayHasResumed,
  GAMEPLAY_WAIT_MS,
  LAST_HAND_LEAD_MINUTES,
  msUntilNextAnnouncement,
} from '../scripts/ci/await-engine-gameplay.mjs';
import { HUD_RESERVE_MS, MTT_HUD_LEVEL_CAP_MS } from './e2e/support/tournamentHudWitness';

const SHA = 'a'.repeat(40);
const health = (maintenance: object, releaseSha = SHA) =>
  JSON.stringify({ releaseSha, running: true, liveness: 'ok', maintenance });
const idle = { active: false, phase: 'idle', resumeWaves: null };
const frozen = { active: true, phase: 'counting_down' };
const reply = (raw: string) => new Response(raw, { status: 200 });
const resumed = { verdict: 'resumed', sha: SHA };
const NEWER = 'b'.repeat(40);

describe('the existing certification waits only for its engine maintenance boundary', () => {
  it('admits a resumed exact engine immediately without sleeping', async () => {
    const pause = vi.fn();
    expect(
      await awaitEngineGameplay(SHA, { fetchImpl: async () => reply(health(idle)), pause })
    ).toEqual(resumed);
    expect(pause).not.toHaveBeenCalled();
  });

  it('does not open fixtures until the countdown and all resume waves finish', async () => {
    let elapsed = 0;
    const states = [
      frozen,
      { active: true, phase: 'finalizing' },
      { ...idle, resumeWaves: { total: 8, done: 3 } },
      { ...idle, resumeWaves: { total: 8, done: 8 } },
    ];
    const report = vi.fn();
    const fetchImpl = vi.fn(async (_url, options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.headers['Cache-Control']).toBe('no-store');
      return reply(health(states.shift()!));
    });
    const result = await awaitEngineGameplay(SHA, {
      fetchImpl,
      now: () => elapsed,
      pause: async (ms: number) => {
        elapsed += ms;
      },
      report,
    });
    expect(result).toEqual(resumed);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(elapsed).toBe(15_000);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed engine that is not a later protected-main release', async () => {
    let calls = 0;
    const isForwardRelease = vi.fn(() => false);
    await expect(
      awaitEngineGameplay(SHA, {
        fetchImpl: async () => reply(health(frozen, ++calls === 1 ? SHA : NEWER)),
        pause: async () => {},
        report: () => {},
        isForwardRelease,
      })
    ).rejects.toThrow('has not reached required');
    expect(calls).toBe(2);
    expect(isForwardRelease).toHaveBeenCalledWith(SHA, NEWER);
  });

  it('stands down, never certifying the replacement, when the break cut over a later release', async () => {
    let calls = 0;
    expect(
      await awaitEngineGameplay(SHA, {
        fetchImpl: async () =>
          reply(health(++calls === 1 ? frozen : idle, calls === 1 ? SHA : NEWER)),
        pause: async () => {},
        report: () => {},
        isForwardRelease: () => true,
      })
    ).toEqual({ verdict: 'superseded', sha: NEWER });
  });

  it('waits out the restart inside the break: gateway 5xx, refused sockets and warming liveness', async () => {
    // Runs 37094718899 and 37097809882 died on the first 502 at :55.
    let elapsed = 0;
    const report = vi.fn();
    const fetchImpl = vi.fn(async () => {
      if (elapsed < 60_000) return reply(health({ active: true, phase: 'counting_down' }));
      if (elapsed < 120_000) return new Response('', { status: 502 });
      if (elapsed < 150_000) throw new TypeError('fetch failed');
      if (elapsed < 170_000) return new Response('', { status: 503 });
      if (elapsed < 190_000)
        return reply(
          JSON.stringify({
            releaseSha: SHA,
            running: true,
            liveness: 'warming',
            maintenance: frozen,
          })
        );
      if (elapsed < 240_000) return reply(health({ active: true, phase: 'finalizing' }));
      return reply(health(idle));
    });
    expect(
      await awaitEngineGameplay(SHA, {
        fetchImpl,
        now: () => elapsed,
        pause: async (ms: number) => {
          elapsed += ms;
        },
        report,
      })
    ).toEqual(resumed);
    expect(elapsed).toBe(240_000);
    // One line per distinct reason, not one per poll.
    expect(report.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('still fails inside the fixed budget when the engine never comes back', async () => {
    let elapsed = 0;
    await expect(
      awaitEngineGameplay(SHA, {
        fetchImpl: async () => new Response('', { status: 502 }),
        now: () => elapsed,
        pause: async (ms: number) => {
          elapsed += ms;
        },
        report: () => {},
      })
    ).rejects.toThrow(/twelve-minute.*HTTP 502/);
    expect(elapsed).toBe(GAMEPLAY_WAIT_MS);
  });

  it('fails after a fixed budget if maintenance never ends', async () => {
    let elapsed = 0;
    const fetchImpl = vi.fn(async () => reply(health(frozen)));
    await expect(
      awaitEngineGameplay(SHA, {
        fetchImpl,
        now: () => elapsed,
        pause: async (ms: number) => {
          elapsed += ms;
        },
        report: () => {},
      })
    ).rejects.toThrow('twelve-minute');
    expect(elapsed).toBe(GAMEPLAY_WAIT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(GAMEPLAY_WAIT_MS / 5000);
  });

  it('covers the last-hand lead plus the observed v3 tail and resume spread', async () => {
    let elapsed = 0;
    const fetchImpl = vi.fn(async () => {
      const state =
        elapsed < 120_000
          ? { active: true, phase: 'last_hand' }
          : elapsed < 420_000
            ? frozen
            : elapsed < 543_650
              ? { active: true, phase: 'finalizing' }
              : { ...idle, resumeWaves: { total: 8, done: elapsed < 554_150 ? 7 : 8 } };
      return reply(health(state));
    });
    expect(
      await awaitEngineGameplay(SHA, {
        fetchImpl,
        now: () => elapsed,
        pause: async (ms: number) => {
          elapsed += ms;
        },
        report: () => {},
      })
    ).toEqual(resumed);
    expect(elapsed).toBe(555_000);
  });

  it('does not accept a response that arrives after its deadline', async () => {
    let elapsed = 0;
    await expect(
      awaitEngineGameplay(SHA, {
        now: () => elapsed,
        fetchImpl: async () => {
          elapsed = GAMEPLAY_WAIT_MS;
          return reply(health(idle));
        },
      })
    ).rejects.toThrow('twelve-minute');
  });

  it('covers the September 27 recorded v3 release and all eight resume waves', async () => {
    // Run 36292616717 started at 03:53:01.395Z and exhausted the former 600s
    // budget 62.457s before this unchanged engine finished its actual waves.
    const startedAt = Date.parse('2026-09-27T03:53:01.395Z');
    const freezeAt = Date.parse('2026-09-27T03:55:00.190Z');
    const releaseAt = Date.parse('2026-09-27T04:03:52.999Z');
    const wavesFinishedAt = Date.parse('2026-09-27T04:04:03.902Z');
    let elapsed = 0;
    const fetchImpl = vi.fn(async () => {
      const at = startedAt + elapsed;
      const maintenance =
        at < freezeAt
          ? { active: true, phase: 'last_hand' }
          : at < releaseAt
            ? frozen
            : { ...idle, resumeWaves: { total: 8, done: at < wavesFinishedAt ? 7 : 8 } };
      return reply(health(maintenance));
    });
    expect(
      await awaitEngineGameplay(SHA, {
        fetchImpl,
        now: () => elapsed,
        pause: async (ms: number) => {
          elapsed += ms;
        },
        report: () => {},
      })
    ).toEqual(resumed);
    expect(elapsed).toBe(665_000);
    expect(elapsed).toBeGreaterThan(600_000);
    expect(GAMEPLAY_WAIT_MS - elapsed).toBeGreaterThan(15_000 + 5_000);
  });

  it('leaves time for every real-hand case and fixture cleanup in the enclosing job', () => {
    const workflow = readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8');
    const liveJob = workflow.slice(workflow.indexOf('\n  live-table-e2e:'));
    const jobMs = Number(liveJob.match(/timeout-minutes: (\d+)/)?.[1]) * 60_000;
    const suite = readFileSync('tests/e2e/production-live-table-realtime.spec.ts', 'utf8');
    const caseMs = Number(suite.match(/test\.setTimeout\(([\d_]+)\)/)?.[1]?.replaceAll('_', ''));
    const handMs = Number(
      suite.match(/const CAUSAL_HAND_TIMEOUT_MS = ([\d_]+);/)?.[1]?.replaceAll('_', '')
    );
    const formats = suite.match(/const TOURNAMENT_FORMATS = \[([^\]]+)\]/)?.[1];
    const tournamentCount = formats?.match(/'[^']+'/g)?.length ?? 0;
    expect(tournamentCount).toBeGreaterThan(0);
    expect(formats).toContain("'mtt'");
    // Every tournament case starts at 300s + 90s. Spin and SNG never grow
    // past it. The MTT alone may grow further, AFTER recovery, to whatever
    // its own real clock needs (mttCaseTimeoutMs) - never a fixed guess, and
    // never past the certifiable level cap plus the unchanged 60s reserve.
    expect(suite).toContain('testInfo.setTimeout(testInfo.timeout + CAUSAL_HAND_TIMEOUT_MS)');
    expect(caseMs + handMs).toBe(390_000);
    expect(suite).toContain('mttCaseTimeoutMs(');
    expect(suite).toContain('testInfo.setTimeout(mttTimeoutMs)');
    // Worst case the MTT case ever reaches: everything already spent on the
    // shared 390s case budget, plus a level right at the certifiable cap,
    // plus its unchanged 60s reserve. mttCaseTimeoutMs can only grow a case's
    // timeout, never shrink it below that shared 390s floor.
    const mttWorstCaseMs = caseMs + handMs + MTT_HUD_LEVEL_CAP_MS + HUD_RESERVE_MS;
    // The cash case now starts at the same 300s + 90s as every tournament case
    // (cash hands are long: p90 87s, p99 149s over 20,488 hands, 2026-09-29).
    expect(suite).toMatch(
      /test\('an already-running table stays live[\s\S]*?testInfo\.setTimeout\(testInfo\.timeout \+ CAUSAL_HAND_TIMEOUT_MS\)/
    );
    expect(
      jobMs -
        GAMEPLAY_WAIT_MS -
        (tournamentCount - 1) * (caseMs + handMs) -
        mttWorstCaseMs -
        (caseMs + handMs)
    ).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it.each([
    undefined,
    {},
    { active: 'false', phase: 'idle' },
    { active: true, phase: 'unknown' },
    { active: false, phase: 'counting_down' },
    { ...idle, resumeWaves: { total: 8, done: 9 } },
    { ...idle, resumeWaves: { total: 8, done: '8' } },
  ])('refuses missing or contradictory maintenance evidence %#', (maintenance) => {
    expect(() => gameplayHasResumed(health(maintenance as object), SHA)).toThrow();
  });

  it('does not retry an answer it cannot read or a non-gateway HTTP refusal', async () => {
    for (const fetcher of [
      async () => new Response('', { status: 500 }),
      async () => new Response('', { status: 404 }),
      async () => reply('{'),
      async () => reply(JSON.stringify({ running: true, liveness: 'ok', maintenance: idle })),
    ]) {
      const fetchImpl = vi.fn(fetcher);
      await expect(awaitEngineGameplay(SHA, { fetchImpl })).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the live-table certificate does not start into the next scheduled break', () => {
  const at = (iso: string) => Date.parse(iso);

  it('measures the time to the next :53 announcement', () => {
    expect(msUntilNextAnnouncement(at('2026-10-04T22:47:00Z'))).toBe(6 * 60_000);
    expect(msUntilNextAnnouncement(at('2026-10-04T22:53:00Z'))).toBe(60 * 60_000);
    expect(msUntilNextAnnouncement(at('2026-10-04T23:01:00Z'))).toBe(52 * 60_000);
  });

  it('reads the announcement minute from the engine that schedules it', () => {
    const engine = readFileSync('server/src/maintenance/MaintenanceBreak.ts', 'utf8');
    expect(engine).toContain(`static readonly BREAK_START_MINUTE = ${BREAK_START_MINUTE};`);
    expect(engine).toContain(
      `static readonly LAST_HAND_LEAD_MS = ${LAST_HAND_LEAD_MINUTES} * 60 * 1000;`
    );
  });

  it('waits out the break when the certificate would straddle the announcement', async () => {
    const pause = vi.fn();
    const report = vi.fn();
    expect(
      await awaitEngineGameplay(SHA, {
        fetchImpl: async () => reply(health(idle)),
        pause,
        report,
        wallClock: () => at('2026-10-04T22:47:00Z'),
      })
    ).toEqual(resumed);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledWith(6 * 60_000 + 30_000);
    expect(report.mock.calls[0][0]).toMatch(/starts after that break/);
  });

  it('starts at once with enough of the hour left', async () => {
    const pause = vi.fn();
    expect(
      await awaitEngineGameplay(SHA, {
        fetchImpl: async () => reply(health(idle)),
        pause,
        wallClock: () => at('2026-10-04T23:01:00Z'),
      })
    ).toEqual(resumed);
    expect(pause).not.toHaveBeenCalled();
    expect(CERTIFICATE_LEAD_MS).toBe(15 * 60_000);
  });
});
