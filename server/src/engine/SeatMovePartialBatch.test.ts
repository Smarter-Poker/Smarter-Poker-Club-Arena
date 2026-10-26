import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: transport,
  maintenanceSupabase: transport,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import {
  executePendingSeatMoves,
  SeatMoveBatchError,
  type PendingSeatMove,
} from '../services/supabase/seatMoves.js';

const table = '11111111-1111-4111-8111-111111111111';
const destination = '22222222-2222-4222-8222-222222222222';
const sourceStay = '33333333-3333-4333-8333-333333333333';
const destinationStay = '44444444-4444-4444-8444-444444444444';
const player = '55555555-5555-4555-8555-555555555555';
const move = '66666666-6666-4666-8666-666666666666';
const secondMove = '77777777-7777-4777-8777-777777777777';
const secondPlayer = '88888888-8888-4888-8888-888888888888';
const pending: PendingSeatMove[] = [
  {
    move_id: move,
    player_id: player,
    source_occupancy_id: sourceStay,
    to_table_id: destination,
    to_table_name: null,
    to_role: null,
    to_main_index: null,
    reason: 'must_move',
    announced_at: null,
    swap_move_id: null,
    ready_at: null,
  },
  {
    move_id: secondMove,
    player_id: secondPlayer,
    source_occupancy_id: secondPlayer,
    to_table_id: destination,
    to_table_name: null,
    to_role: null,
    to_main_index: null,
    reason: 'must_move',
    announced_at: null,
    swap_move_id: null,
    ready_at: null,
  },
];
const receipt = {
  ok: true,
  move_id: move,
  player_id: player,
  from_table_id: table,
  to_table_id: destination,
  source_occupancy_id: sourceStay,
  destination_occupancy_id: destinationStay,
  source_seat_number: 1,
  to_seat_number: 2,
  stack: 25,
  idempotency_key: 'seatmove:' + move,
};
function partial(first: unknown, failure: 'unreadable' | 'transport' = 'unreadable') {
  transport.rpc.mockResolvedValueOnce({ data: first, error: null });
  if (failure === 'transport') transport.rpc.mockRejectedValue(new Error('reply lost'));
  else transport.rpc.mockResolvedValue({ data: null, error: null });
}
function sourceEngine() {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  engine.tableId = table;
  engine.tableInfo = { cluster_id: 'game' };
  engine.lifecycleCanMutate = vi.fn(() => true);
  engine.isTournamentTable = vi.fn(() => false);
  engine.seatedPlayers = [
    { user_id: player, occupancy_id: sourceStay, seat_number: 1 },
    { user_id: secondPlayer, occupancy_id: secondPlayer, seat_number: 2 },
  ];
  engine.announcedSeatMoves = new Set([move, secondMove]);
  engine.heldForSwap = new Set();
  engine.leaveHeldByClock = new Map();
  engine.depositPresenceForMove = vi.fn();
  engine.disconnectEngine = { unregisterPlayer: vi.fn() };
  engine.timeBankEngine = { removePlayer: vi.fn() };
  // forgetTimeBank (2026-09-25) drops the bank and its metadata together.
  engine.timeBankMeta = new Map([
    [player, { initialSeconds: 40, baseSeconds: 40, dbConsumedSeconds: 0 }],
  ]);
  engine.straddleEngine = { removePlayer: vi.fn() };
  engine.preActionEngine = { removePlayer: vi.fn() };
  engine.chipContinuity = { forget: vi.fn() };
  engine.hub = { emitEvent: vi.fn() };
  engine.broadcastCurrentState = vi.fn(async () => {});
  engine.wakeClusterGame = vi.fn();
  return engine;
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('a later unknown transfer cannot erase earlier confirmed outcomes', () => {
  it('does not start a move after its engine withdraws authority', async () => {
    const outcome = await executePendingSeatMoves(
      table,
      { announcedOnly: false, shouldContinue: () => false },
      pending
    );
    expect(outcome).toEqual({ done: [], held: [], refused: [] });
    expect(transport.rpc).not.toHaveBeenCalled();
  });

  it('retains the settled receipt but stops later moves after authority is withdrawn', async () => {
    let active = true;
    transport.rpc.mockImplementationOnce(async () => {
      active = false;
      return { data: receipt, error: null };
    });
    const outcome = await executePendingSeatMoves(
      table,
      { announcedOnly: false, shouldContinue: () => active },
      pending
    );
    expect(outcome.done).toHaveLength(1);
    expect(transport.rpc).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unresolved move after authority is withdrawn', async () => {
    let active = true;
    const failure = new Error('reply lost');
    transport.rpc.mockImplementationOnce(async () => {
      active = false;
      throw failure;
    });
    await expect(
      executePendingSeatMoves(
        table,
        { announcedOnly: false, shouldContinue: () => active },
        pending
      )
    ).rejects.toBe(failure);
    expect(transport.rpc).toHaveBeenCalledTimes(1);
  });
  it('does not execute a later candidate after an unresolved result', async () => {
    partial(receipt);
    const third = { ...pending[1], move_id: destinationStay };
    await expect(
      executePendingSeatMoves(table, { announcedOnly: false }, [...pending, third])
    ).rejects.toBeInstanceOf(SeatMoveBatchError);
    expect(transport.rpc.mock.calls.map(([, args]) => args.p_move_id)).toEqual([move, secondMove]);
  });
  it.each(['unreadable', 'transport'] as const)(
    'retains a proven transfer on a later %s failure',
    async (failure) => {
      partial(receipt, failure);
      const error = await executePendingSeatMoves(table, { announcedOnly: false }, pending).catch(
        (reason) => reason
      );
      expect(error).toBeInstanceOf(SeatMoveBatchError);
      expect(error.outcome.done).toHaveLength(1);
      expect(error.outcome.done[0]).toMatchObject({
        move_id: move,
        source_occupancy_id: sourceStay,
      });
      expect(error.outcome.held).toEqual([]);
      expect(transport.rpc.mock.calls.map(([, args]) => args.p_move_id)).toEqual(
        failure === 'transport' ? [move, secondMove, secondMove] : [move, secondMove]
      );
    }
  );

  it('reflects the committed transfer before preserving the later failure', async () => {
    partial(receipt);
    const engine = sourceEngine();
    await expect(
      engine.executePendingSeatMoves({ announcedOnly: false }, pending)
    ).rejects.toBeInstanceOf(SeatMoveBatchError);
    expect(engine.seatedPlayers.map((p: { user_id: string }) => p.user_id)).toEqual([secondPlayer]);
    expect(engine.disconnectEngine.unregisterPlayer).toHaveBeenCalledTimes(1);
    expect(engine.disconnectEngine.unregisterPlayer).toHaveBeenCalledWith(table, player);
    expect(engine.timeBankEngine.removePlayer).toHaveBeenCalledWith(table, player);
    expect(engine.timeBankMeta.has(player)).toBe(false);
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      table,
      expect.objectContaining({ type: 'seat_moved', user_id: player })
    );
    expect(engine.wakeClusterGame).toHaveBeenCalledWith('seat_move');
    expect(engine.announcedSeatMoves.has(secondMove)).toBe(true);
  });

  it('retains an earlier confirmed swap hold while the later result stays unknown', async () => {
    partial({
      ...receipt,
      ok: false,
      reason: 'waiting_partner',
      held: true,
      partner_id: secondPlayer,
    });
    const engine = sourceEngine();
    await expect(
      engine.executePendingSeatMoves({ announcedOnly: false }, pending)
    ).rejects.toBeInstanceOf(SeatMoveBatchError);
    expect(engine.heldForSwap.has(player)).toBe(true);
    expect(engine.seatedPlayers).toHaveLength(2);
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      table,
      expect.objectContaining({ type: 'seat_move_held', user_id: player })
    );
  });

  it('reports an earlier terminal refusal without classifying the later unknown result', async () => {
    partial({ ok: false, reason: 'destination_full' });
    const engine = sourceEngine();
    await expect(
      engine.executePendingSeatMoves({ announcedOnly: false }, pending)
    ).rejects.toBeInstanceOf(SeatMoveBatchError);
    expect(engine.hub.emitEvent).toHaveBeenCalledTimes(1);
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      table,
      expect.objectContaining({ type: 'seat_move_cancelled', user_id: player })
    );
    expect(engine.seatedPlayers).toHaveLength(2);
  });
});

describe('Main takes the open seat before another feeder deal', () => {
  function preparing() {
    const engine = sourceEngine();
    const swap = {
      ...pending[1],
      reason: 'seat_change' as const,
      swap_move_id: move,
      ready_at: '2026-10-24T03:00:00Z',
      announced_at: '2026-10-24T03:00:00Z',
    };
    engine.heldForSwap.add(secondPlayer);
    engine.readPendingSeatMoves = vi.fn().mockResolvedValue([pending[0], swap]);
    return engine;
  }
  it('lands an unannounced Main move at settlement without executing another unannounced reason', async () => {
    transport.rpc.mockResolvedValue({ data: receipt, error: null });
    const outcome = await executePendingSeatMoves(table, { announcedOnly: true }, [
      pending[0],
      { ...pending[1], reason: 'seat_change' },
      { ...pending[1], reason: 'balance' },
      { ...pending[1], reason: 'break' },
      { ...pending[1], swap_move_id: move },
    ]);
    expect(outcome.done.map((row) => row.player_id)).toEqual([player]);
    expect(transport.rpc).toHaveBeenCalledTimes(1);
    expect(transport.rpc).toHaveBeenCalledWith('fn_cash_seat_move_execute', {
      p_move_id: move,
    });
  });
  it("moves before the next deal and retains the other player's durable swap hold", async () => {
    const engine = preparing();
    const selected = [...engine.seatedPlayers];
    transport.rpc.mockResolvedValue({ data: receipt, error: null });
    expect(await engine.announcePendingSeatMoves()).toBe(true);
    expect(engine.seatedPlayers.map((row: any) => row.user_id)).toEqual([secondPlayer]);
    expect(engine.heldForSwap.has(secondPlayer)).toBe(true);
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      table,
      expect.objectContaining({ type: 'seat_moved', user_id: player })
    );
    engine.waitingForBB = new Set();
    engine.tournamentMovePauseOwners = new Set();
    engine.disconnectEngine.isSittingOut = () => false;
    engine.minPlayersToDeal = () => 2;
    engine.takePreparedHandNumber = vi.fn(() => {
      throw new Error('another feeder hand');
    });
    await engine.dealHand(selected);
    expect(engine.takePreparedHandNumber).not.toHaveBeenCalled();
  });
  it('keeps the seat boundary until the original pre-deal transfer actually resolves', async () => {
    const engine = preparing();
    let resolve!: (value: unknown) => void;
    const response = new Promise((r) => {
      resolve = r;
    });
    transport.rpc.mockImplementation((name) =>
      name === 'fn_cash_seat_move_execute' ? response : Promise.resolve({ data: 1, error: null })
    );
    const announcing = engine.announcePendingSeatMoves();
    await vi.waitFor(() =>
      expect(transport.rpc.mock.calls.some(([name]) => name === 'fn_cash_seat_move_execute')).toBe(
        true
      )
    );
    let acquired = false;
    const next = engine.acquireSeatBoundary().then((release: () => void) => {
      acquired = true;
      release();
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    resolve({ data: receipt, error: null });
    await announcing;
    await next;
    expect(acquired).toBe(true);
  });
  it('does not deal another feeder hand while the transfer is refused by the maintenance freeze', async () => {
    const engine = preparing();
    transport.rpc.mockResolvedValue({
      data: { ok: false, reason: 'platform_frozen' },
      error: null,
    });
    expect(await engine.announcePendingSeatMoves()).toBe(false);
    expect(engine.seatedPlayers.map((row: any) => row.user_id)).toContain(player);
    expect(engine.heldForSwap.has(secondPlayer)).toBe(true);
  });
  it('does not transfer a replacement occupancy selected after the plan', async () => {
    const engine = preparing();
    engine.readPendingSeatMoves.mockResolvedValue([pending[0]]);
    engine.seatedPlayers[0].occupancy_id = destinationStay;
    expect(await engine.announcePendingSeatMoves()).toBe(true);
    expect(transport.rpc).not.toHaveBeenCalled();
  });
});
