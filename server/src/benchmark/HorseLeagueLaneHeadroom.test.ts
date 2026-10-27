/**
 * THE LEAGUE NEVER TAKES A CORE FROM A HORSE THAT IS WAITING (2026-10-16).
 * A league matchup starts only while the live decision lane is calm, and both
 * league windows sit in the floor's quietest hours. See HorseLeague.ts.
 */
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const { fromMock, rpcMock } = vi.hoisted(() => ({ fromMock: vi.fn(), rpcMock: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ supabase: { from: fromMock, rpc: rpcMock } }));

import {
  LEAGUE_LANE_MAX_QUEUED_AGE_MS,
  decisionLaneHasHeadroom,
  msLeftInRunWindow,
  runLeague,
} from './HorseLeague.js';
import type { HorseLeagueCompute } from './HorseLeagueComputeWorkerClient.js';

describe('decisionLaneHasHeadroom', () => {
  it('is calm only while the oldest queued decision is at most a second old', () => {
    expect(decisionLaneHasHeadroom({ phase: 'ready', oldestQueuedDecisionAgeMs: null })).toBe(true);
    expect(decisionLaneHasHeadroom({ phase: 'ready', oldestQueuedDecisionAgeMs: 0 })).toBe(true);
    expect(
      decisionLaneHasHeadroom({
        phase: 'ready',
        oldestQueuedDecisionAgeMs: LEAGUE_LANE_MAX_QUEUED_AGE_MS,
      })
    ).toBe(true);
    expect(
      decisionLaneHasHeadroom({
        phase: 'ready',
        oldestQueuedDecisionAgeMs: LEAGUE_LANE_MAX_QUEUED_AGE_MS + 1,
      })
    ).toBe(false);
    expect(decisionLaneHasHeadroom({ phase: 'ready', oldestQueuedDecisionAgeMs: 5_966 })).toBe(
      false
    );
  });

  it('never calls a starting, failing or stopping lane calm; a process without one has nothing to protect', () => {
    for (const phase of ['starting', 'failed', 'stopping'] as const)
      expect(decisionLaneHasHeadroom({ phase, oldestQueuedDecisionAgeMs: 0 })).toBe(false);
    expect(decisionLaneHasHeadroom({ phase: 'stopped', oldestQueuedDecisionAgeMs: null })).toBe(
      true
    );
  });
});

describe('the headroom gate reads decision jobs only', () => {
  it('a mirrored-hand or observation backlog is not a horse waiting; a queued decision is', () => {
    // Every completed hand is mirrored to every shard (mindMirror.ts): the
    // lane's oldest job can be seconds old while no decision waits at all.
    // client.test.ts proves the client reports exactly these two ages.
    expect(
      decisionLaneHasHeadroom({
        phase: 'ready',
        oldestQueuedAgeMs: 6_000,
        oldestQueuedDecisionAgeMs: null,
      } as never)
    ).toBe(true);
    expect(
      decisionLaneHasHeadroom({
        phase: 'ready',
        oldestQueuedAgeMs: 6_000,
        oldestQueuedDecisionAgeMs: 200,
      } as never)
    ).toBe(true);
    expect(
      decisionLaneHasHeadroom({
        phase: 'ready',
        oldestQueuedAgeMs: 6_000,
        oldestQueuedDecisionAgeMs: LEAGUE_LANE_MAX_QUEUED_AGE_MS + 1,
      } as never)
    ).toBe(false);
  });
});

describe('the league windows sit in the quietest hours (13:00 and 16:00 UTC)', () => {
  it('clips the 13:00 window at 16:00 and the 16:00 window at 19:00', () => {
    expect(msLeftInRunWindow(new Date('2026-10-17T13:30:00Z'))).toBe(150 * 60_000);
    expect(msLeftInRunWindow(new Date('2026-10-17T15:59:00Z'))).toBe(60_000);
    expect(msLeftInRunWindow(new Date('2026-10-17T16:00:00Z'))).toBe(180 * 60_000);
    expect(msLeftInRunWindow(new Date('2026-10-17T18:30:00Z'))).toBe(30 * 60_000);
    // Outside both windows the AM window's end is the bound, as before.
    expect(msLeftInRunWindow(new Date('2026-10-17T04:30:00Z'))).toBe(
      Date.parse('2026-10-17T16:00:00Z') - Date.parse('2026-10-17T04:30:00Z')
    );
  });
});

describe('runLeague stands down while the lane is busy', () => {
  const upserts: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    fromMock.mockReset();
    rpcMock.mockReset();
    upserts.length = 0;
    rpcMock.mockResolvedValue({ error: null });
    fromMock.mockImplementation(() => {
      const query = {
        order: vi.fn(() => query),
        limit: vi.fn(async () => ({ data: [], error: null })),
      };
      return {
        select: vi.fn(() => query),
        upsert: vi.fn(async (row: Record<string, unknown>) => {
          upserts.push(row);
          return { error: null };
        }),
      };
    });
  });

  function compute(): HorseLeagueCompute {
    return {
      ready: vi.fn(async () => ({
        charts: 0,
        postflop: 0,
        postflopV31: 0,
        postflopV31Dataset: null,
      })),
      scoreSolverAgreement: vi.fn(async () => ({
        spots: 0,
        agreement: 0,
        pureMisses: 0,
        reference: null,
        eligibleSpots: 0,
        reconciledSpots: 0,
        actionRegretBb: null,
        regretEligibleSpots: 0,
        decisionChecksum: null,
        decisions: [],
      })),
      scoreGtoV31Agreement: vi.fn(async () => ({ reference: null }) as never),
      runMatchup: vi.fn(async (m: { name: string }) => ({
        matchup: m.name,
        hands: 2,
        bb100: 0,
        stderr: 1,
        durationMs: 1,
        illegalActions: 0,
        truncatedStreets: 0,
        divergentPairs: 1,
      })) as never,
      shutdown: vi.fn(async () => undefined),
    } as unknown as HorseLeagueCompute;
  }

  it.each([
    { inert: true, bb100: 0, stderr: 0, divergentPairs: 0 },
    // Zero variance is also inert even when the paired edge is nonzero.
    { inert: true, bb100: 2, stderr: 0, divergentPairs: 1 },
    // Rounded storage zeros must not override the worker's actual verdict.
    { inert: false, bb100: 0.001, stderr: 0.001, divergentPairs: 1 },
  ])('persists the worker measurement verdict with its raw result: %j', async (verdict) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T13:30:00Z'));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const c = compute();
    const original = vi.mocked(c.runMatchup).getMockImplementation()!;
    vi.mocked(c.runMatchup).mockImplementation(async (...args) => ({
      ...(await original(...args)),
      ...verdict,
    }));
    let calm = 2; // boot and one worker result, then stop without another simulation
    const results = await runLeague(
      '2026-10-17',
      () => true,
      () => c,
      () => calm-- > 0
    );
    expect(results).toHaveLength(1);
    expect(upserts).toHaveLength(1);
    const row = upserts[0];
    expect(row).toMatchObject({
      matchup: results[0].matchup,
      hands: 2,
      bb100: Math.round(verdict.bb100 * 100) / 100,
      stderr: Math.round(verdict.stderr * 100) / 100,
      illegal_actions: 0,
      status: verdict.inert ? 'inert' : 'measured',
    });
    if (verdict.inert) {
      expect(row.refusal_reason).toEqual(expect.stringContaining('not a measurement'));
      expect(row.refusal_reason).toEqual(expect.stringContaining(String(verdict.divergentPairs)));
    } else {
      // Explicit null clears an earlier inert reason on an upsert of this key.
      expect(row.refusal_reason).toBeNull();
    }
  });

  it('runs no matchup while a decision waits', async () => {
    const c = compute();
    await runLeague(
      '2026-10-17',
      () => true,
      () => c,
      () => false
    );
    expect(c.ready).not.toHaveBeenCalled();
    expect(c.runMatchup).not.toHaveBeenCalled();
  });

  it('stops the card the moment the lane gets busy, keeping what it measured', async () => {
    // Inside the 13:00 window, so the run's own budget is not what stops it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T13:30:00Z'));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const c = compute();
    let calm = 3; // the boot check, then two matchups
    const results = await runLeague(
      '2026-10-17',
      () => true,
      () => c,
      () => calm-- > 0
    );
    expect(c.runMatchup).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
  });
});
