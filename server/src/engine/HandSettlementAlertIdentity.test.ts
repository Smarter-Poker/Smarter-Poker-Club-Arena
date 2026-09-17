/** Source-only qualification for received hand-refusal originals 19654/19655.
 * Drive the existing settlement path; this does not execute an atomic DB write.
 */
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
  raiseFinancialAlert: vi.fn().mockResolvedValue({ persisted: true, alertId: 'fixture' }),
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (error: unknown) => String(error),
}));
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase/client.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { reportError } from '../services/errorReporter.js';
const id = '34076355-b232-420e-93e8-2deab277f6bc';
const handId = '20000000-0000-4000-8000-000000000001';
const joinedAt = '2026-09-11T01:00:00.000Z';
const source = 'ServerTableEngine.authoritative_hand_semantic_refusal';
const historySource = 'postHandTasks.hand_history_failed';
const reported = (name: string) =>
  vi.mocked(raiseFinancialAlert).mock.calls.filter((c) => c[1] === name);
function cashTable() {
  const engine = new ServerTableEngine(id) as any;
  engine.tableInfo = {
    id,
    club_id: 'club',
    tournament_id: null,
    cluster_id: null,
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    max_players: 6,
    min_buy_in: 20,
    max_buy_in: 200,
    rake_percent: 0,
    bbj_percent: 0,
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
  engine.handCount = 9459694;
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
    players.map((p) => [p.user_id, { seat_id: p.seat_id, seat_joined_at: p.seat_joined_at }])
  );
  engine.currentHandWinners = [{ userId: 'b', amount: 20 }];
  engine.currentHandStartedAt = Date.now() - 1000;
  engine.lifecycleCanMutate = () => true;
  engine.hasCurrentEngineLeaseAuthority = () => true;
  engine.getEngineLeaseAuthority = () => ({
    verified: true,
    generation: 'generation',
    scope: 'cash',
  });
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
  mocks.leaves.mockReset().mockResolvedValue([]);
  mocks.recount.mockReset().mockResolvedValue(2);
  (raiseFinancialAlert as unknown as ReturnType<typeof vi.fn>).mockClear();
  vi.mocked(reportError).mockReset();
  vi.spyOn(supabase, 'rpc').mockImplementation(mocks.rpc);
  vi.spyOn(supabase, 'from').mockImplementation((() => {
    const chain: any = {
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn().mockResolvedValue({ data: [], error: null }),
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

describe('the original request identity survives both hand-failure reports', () => {
  it('binds both reports to the exact requested UUID without asserting rollback', async () => {
    const { engine, players } = cashTable();
    const original =
      'atomic hand commit refused (atomic_hand_rolled_back): pldbgapi2 statement call stack is broken';
    mocks.commit.mockImplementation(async () => {
      engine.handCount = 9459695;
      throw new Error(original);
    });
    vi.mocked(reportError).mockImplementation((error, context) => {
      if (error instanceof Error) error.message = `[${context}] ${error.message}`;
    });
    await expect(engine.postHandTasks(players, 1)).rejects.toThrow(
      `authoritative hand commit was not proved for ${id}#9459694`
    );
    expect(engine.killForRestart).toHaveBeenCalledWith('authoritative_hand_commit_not_proved');
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    const request = mocks.commit.mock.calls[0][0];
    expect(request.handNumber).toBe(9459694);
    expect(request.tableId).toBe(id);
    const first = reported(source);
    const second = reported(historySource);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const a = first[0][3]!.hand_request_identity_v1;
    expect(a).toEqual({
      version: 1,
      table_id: id,
      hand_number: 9459694,
      hand_id: request.handId,
      post_commit_required: true,
    });
    expect(request.handId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(a)).toBe(true);
    expect(second[0][3]!.hand_request_identity_v1).toBe(a);
    expect(a).not.toHaveProperty('success');
    expect(a).not.toHaveProperty('rolled_back');
    expect(a).not.toHaveProperty('commit_hash');
    expect(first[0][2]).toBe(
      `Table ${id} hand #9459694 was refused by the atomic settlement contract; this engine generation was terminated before every downstream money step`
    );
    expect(first[0][3]!.error).toContain(original);
    expect(second[0][3]!.error).toContain(original);
    expect(mocks.obligations).not.toHaveBeenCalled();
  });

  it('preserves the retry budget and original request UUID on a transient rollback', async () => {
    const { engine, players } = cashTable();
    engine.sleep = vi.fn().mockResolvedValue(undefined);
    mocks.commit
      .mockRejectedValueOnce(
        new Error('atomic hand commit refused (atomic_hand_rolled_back): F06_RETRY_CANONICAL_LANE')
      )
      .mockImplementationOnce(async (request) => ({
        handId: request.handId,
        settlementCommitted: true,
      }));
    await engine.postHandTasks(players, 1);
    expect(mocks.commit).toHaveBeenCalledTimes(2);
    expect(mocks.commit.mock.calls[0][0].handId).toBe(mocks.commit.mock.calls[1][0].handId);
    expect(reported(source)).toHaveLength(0);
    expect(reported(historySource)).toHaveLength(0);
  });

  it('does not certify missing protocol-2 obligations or attach the DTO to transport alerts', async () => {
    const { engine, players } = cashTable();
    engine.getEngineLeaseAuthority = () => null;
    mocks.commit.mockRejectedValue(
      new Error('authoritative hand commit failed after identical attempts')
    );
    await expect(engine.postHandTasks(players, 1)).rejects.toThrow(
      `authoritative hand commit was not proved for ${id}#9459694`
    );
    const history = reported(historySource);
    expect(history).toHaveLength(1);
    expect(history[0][3]!.hand_request_identity_v1).toMatchObject({ post_commit_required: false });
    const transport = reported('ServerTableEngine.authoritative_hand_unreachable');
    expect(transport).toHaveLength(1);
    expect(transport[0][3]).not.toHaveProperty('hand_request_identity_v1');
  });

  it('keeps unrelated post-hand alert contexts unchanged', async () => {
    const { engine, players } = cashTable();
    mocks.recount.mockRejectedValue(new Error('seat count refused'));
    await engine.postHandTasks(players, 1);
    const other = reported('postHandTasks.table_unlock_failed');
    expect(other).toHaveLength(1);
    expect(other[0][3]).not.toHaveProperty('hand_request_identity_v1');
  });

  it('gives two later attempts at different hand boundaries distinct original UUIDs', async () => {
    mocks.commit.mockRejectedValue(
      new Error('atomic hand commit refused (atomic_hand_rolled_back): debugger failure')
    );
    const first = cashTable();
    await expect(first.engine.postHandTasks(first.players, 1)).rejects.toThrow(
      `authoritative hand commit was not proved for ${id}#9459694`
    );
    const second = cashTable();
    second.engine.handCount = 9459695;
    await expect(second.engine.postHandTasks(second.players, 2)).rejects.toThrow(
      `authoritative hand commit was not proved for ${id}#9459695`
    );
    const alerts = reported(source);
    expect(alerts).toHaveLength(2);
    expect(alerts[0][3]!.hand_request_identity_v1).toMatchObject({ hand_number: 9459694 });
    expect(alerts[1][3]!.hand_request_identity_v1).toMatchObject({ hand_number: 9459695 });
    expect((alerts[0][3]!.hand_request_identity_v1 as any).hand_id).not.toBe(
      (alerts[1][3]!.hand_request_identity_v1 as any).hand_id
    );
  });
});
