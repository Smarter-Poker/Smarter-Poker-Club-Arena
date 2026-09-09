import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromMock, rpcMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock('../services/supabase.js', () => ({
  supabase: {
    from: fromMock,
    rpc: rpcMock,
  },
}));

import { runLeague } from './HorseLeague.js';
import type { HorseLeagueCompute } from './HorseLeagueComputeWorkerClient.js';

describe('Horse League certified V31 retry contract', () => {
  beforeEach(() => {
    fromMock.mockReset();
    rpcMock.mockReset();
    fromMock.mockImplementation((table: string) => {
      if (table !== 'horse_league_results') {
        throw new Error(`unexpected table ${table}`);
      }
      const query = {
        order: vi.fn(() => query),
        limit: vi.fn(async () => ({ data: [], error: null })),
      };
      return { select: vi.fn(() => query) };
    });
  });

  it('fails the run instead of latching completion when an active corpus cannot produce evidence', async () => {
    const shutdown = vi.fn(async () => undefined);
    const compute: HorseLeagueCompute = {
      ready: vi.fn(async () => ({
        charts: 0,
        postflop: 0,
        postflopV31: 1,
        postflopV31Dataset: {
          id: '11111111-1111-4111-8111-111111111111',
          checksum: 'a'.repeat(64),
        },
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
      scoreGtoV31Agreement: vi.fn(async () => {
        throw new Error('worker lost the certified corpus');
      }),
      runMatchup: vi.fn(async () => {
        throw new Error('matchup must not run after required evidence fails');
      }),
      shutdown,
    };

    await expect(
      runLeague(
        '2026-09-09',
        () => true,
        () => compute
      )
    ).rejects.toThrow(/worker lost the certified corpus/);
    expect(compute.runMatchup).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
