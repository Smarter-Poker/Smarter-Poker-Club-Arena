import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  obligations: vi.fn(),
  leaves: vi.fn(),
  recount: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  logHandHistory: mocks.commit,
  processHandPostCommitObligations: mocks.obligations,
  processLeavePending: mocks.leaves,
  reconcileTableSeatCount: mocks.recount,
}));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (error: unknown) => String(error),
}));
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase/client.js';

const id = '00000000-0000-0000-0000-000000000006';
const handId = '00000000-0000-0000-0000-000000100006';
const joinedAt = '2026-09-10T01:00:00.000Z';
function engineAndPlayers(verified = true) {
  const engine = new ServerTableEngine(id) as any;
  engine.tableInfo = {
    id,
    club_id: 'arena',
    tournament_id: null,
    game_variant: 'nlh',
    arena: { id: 'arena', kind: 'diamond_arena', asset: 'diamonds' },
    small_blind: 1,
    big_blind: 2,
    max_players: 6,
    min_buy_in: 20,
    max_buy_in: 200,
  };
  const players = [
    {
      user_id: 'a',
      seat_id: 'seat-a',
      seat_joined_at: joinedAt,
      occupancy_id: 'occupancy-a',
      seat_number: 1,
      stack: 90,
      is_horse: false,
    },
    {
      user_id: 'b',
      seat_id: 'seat-b',
      seat_joined_at: joinedAt,
      occupancy_id: 'occupancy-b',
      seat_number: 2,
      stack: 110,
      is_horse: false,
    },
  ];
  engine.seatedPlayers = players;
  engine.handCount = 1000006;
  engine.currentHandVariant = 'nlh';
  engine.currentHandPotSize = 20;
  engine.currentHandRake = 0;
  engine.currentHandBBJFee = 0;
  engine.currentHandInsuranceNet = 0;
  engine.currentHandContributions = new Map([
    ['a', 10],
    ['b', 10],
  ]);
  engine.currentHandDealtStacks = new Map([
    ['a', 100],
    ['b', 100],
  ]);
  engine.currentHandSeatGenerations = new Map(
    players.map((p) => [
      p.user_id,
      {
        seat_id: p.seat_id,
        seat_joined_at: p.seat_joined_at,
      },
    ])
  );
  engine.currentHandWinners = [{ userId: 'b', amount: 20 }];
  engine.currentHandStartedAt = Date.now() - 1000;
  engine.lifecycleCanMutate = () => true;
  engine.hasCurrentEngineLeaseAuthority = () => true;
  engine.getEngineLeaseAuthority = () => ({ verified, generation: 'generation', scope: 'cash' });
  engine.finishTerminalBoundaryPersistence = vi.fn();
  engine.announceEnvelopeResolvedAddOns = vi.fn().mockResolvedValue(undefined);
  engine.executePendingSeatMoves = vi.fn().mockResolvedValue(undefined);
  engine.wakeClusterGame = vi.fn();
  engine.killForRestart = vi.fn();
  engine.hub = { emitEvent: vi.fn(), sendToUser: vi.fn() };
  return { engine, players };
}
beforeEach(() => {
  mocks.commit.mockReset().mockResolvedValue({ handId, settlementCommitted: true });
  mocks.obligations.mockReset().mockResolvedValue({ ok: true, pending_addons: 0 });
  mocks.leaves.mockReset().mockResolvedValue([{ userId: 'a', occupancyId: 'occupancy-a' }]);
  mocks.recount.mockReset().mockResolvedValue(1);
  vi.spyOn(supabase, 'rpc').mockImplementation(mocks.rpc);
  vi.spyOn(supabase, 'from').mockImplementation((() => {
    const chain: any = {
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn().mockResolvedValue({
        data: [
          { user_id: 'a', stack: 90 },
          { user_id: 'b', stack: 110 },
        ],
        error: null,
      }),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    return chain;
  }) as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  mocks.rpc.mockReset();
});

describe('the actual shared settlement pipeline accepts Diamond hands', () => {
  it('sends the exact lease, time banks and empty chip obligations then processes pending leave', async () => {
    const { engine, players } = engineAndPlayers();
    const unregister = vi.spyOn(engine.disconnectEngine, 'unregisterPlayer');
    await engine.postHandTasks(players, 1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    const request = mocks.commit.mock.calls[0][0];
    expect(request.dailyMissionEvents).toEqual([]);
    expect(request.atomicCommit).toMatchObject({
      rake: 0,
      bbj: 0,
      inflow: 0,
      leaseGeneration: 'generation',
      stacks: [
        { user_id: 'a', seat_id: 'seat-a', seat_joined_at: joinedAt, stack_before: 100, stack: 90 },
        {
          user_id: 'b',
          seat_id: 'seat-b',
          seat_joined_at: joinedAt,
          stack_before: 100,
          stack: 110,
        },
      ],
      acceptedPostCommitFacts: {
        contributions: { a: 10, b: 10 },
        returned_uncalled: {},
        insurance: [],
      },
      postCommitObligations: {
        version: 1,
        rake: null,
        bbj_contribution: null,
        promo_playthrough: [],
        insurance: [],
        pending_addons: null,
      },
    });
    expect(request.atomicCommit.postCommitObligations.time_banks).toHaveLength(2);
    expect(mocks.obligations).toHaveBeenCalledWith(handId);
    expect(mocks.leaves).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledWith(id, 'a');
    expect(engine.killForRestart).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('does not commit or cash out when a Diamond generation lacks verified authority', async () => {
    const { engine, players } = engineAndPlayers(false);
    await expect(engine.postHandTasks(players, 1)).rejects.toThrow(
      'authoritative hand commit was not proved'
    );
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.obligations).not.toHaveBeenCalled();
    expect(mocks.leaves).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
