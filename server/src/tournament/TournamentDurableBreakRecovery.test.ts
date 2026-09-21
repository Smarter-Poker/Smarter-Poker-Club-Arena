import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import * as movement from './tournamentSeatMoveRpc.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = id(1),
  source = id(2),
  lease = id(3),
  breakId = id(4);
function fixture() {
  const events: string[] = [];
  let durable: any = {
    ok: true,
    reason: null,
    break_id: breakId,
    tournament_id: event,
    source_table_id: source,
    lifecycle: '9007199254740993',
    state: 'begun',
    revision: '0',
    custody_id: null,
    custody_generation: null,
    terminal_handoff_required: false,
    members: [
      {
        user_id: id(5),
        source_seat_id: id(6),
        source_seat_number: 1,
        occupancy_id: id(7),
        request_id: id(8),
        active_request_id: null,
        winner_request_id: id(8),
        destination_table_id: id(9),
        destination_seat_number: 2,
      },
    ],
  };
  const engine: any = {
    stop: vi.fn(async () => {
      events.push('stop');
    }),
    hasReleasedProcessOwnership: () => true,
    releaseTournamentMovePause: vi.fn(),
    parkForTournamentMove: vi.fn(async () => true),
    executeTournamentMoveAtBoundary: vi.fn(async (_owner: string, work: () => Promise<unknown>) =>
      work()
    ),
  };
  const global = new Map([[source, engine]]);
  const custody = new TournamentRetirementCustody<any>();
  const server: any = {
    getTableEngine: vi.fn((table: string) => global.get(table)),
    ownsTournamentTableEngine: (table: string, expected: unknown) => global.get(table) === expected,
    unregisterTableEngine: vi.fn((table: string, expected: unknown) => {
      if (global.get(table) !== expected) return false;
      events.push('CAS');
      global.delete(table);
      return true;
    }),
    // Same thin adapter as Lease's GameServer; the actual custody implementation
    // is consumed from the owner overlay, not copied or simulated here.
    withRetirementCustody: (
      binding: any,
      local: Map<string, any>,
      current: () => boolean,
      work: any,
      prepare: any
    ) => custody.withCustody(binding, global, local, current, work, prepare),
  };
  const manager: any = new TournamentManager(event, server, lease, performance.now() + 60_000);
  manager.running = true;
  manager.eliminationSweepDeadlineAt = 0;
  manager.tableEngines.set(source, engine);
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  manager.retireManagedTableFromHandForHand = vi.fn(() => events.push('H4H'));
  manager.broadcast = vi.fn(async () => {});
  const api: any = {
    reconcile: vi.fn(async () => ({ ...durable })),
    discover: vi.fn(async () => ({
      ok: true,
      cursor_revision: '1',
      wrapped: true,
      operations: [{ ...durable }],
    })),
    claimCustody: vi.fn(async (_b: string, custodyId: string) => {
      events.push('claim');
      durable = { ...durable, custody_id: custodyId, custody_generation: lease, revision: '1' };
      return { ...durable };
    }),
    close: vi.fn(async () => {
      events.push('close');
      durable = { ...durable, state: 'close_confirmed' };
      return { ...durable };
    }),
    ackCleanup: vi.fn(async () => {
      events.push('ACK');
      durable = { ...durable, state: 'acknowledged' };
      return { ...durable };
    }),
  };
  manager.tableBreakRpc = () => api;
  return {
    manager,
    engine,
    server,
    global,
    custody,
    api,
    events,
    state: () => ({ ...durable }),
    setState: (value: any) => {
      durable = value;
    },
  };
}
afterEach(() => vi.restoreAllMocks());
describe('actual Manager durable close through actual Lease custody', () => {
  it('claims under reservation before stop, then close/CAS/H4H/ACK', async () => {
    const f = fixture();
    await f.manager.retireTournamentBreak(f.state());
    expect(f.events).toEqual(['claim', 'stop', 'close', 'CAS', 'H4H', 'ACK']);
    expect(f.global.size).toBe(0);
    expect(f.manager.tableEngines.size).toBe(0);
    expect(f.custody.admissionAllowed(source)).toBe(true);
    expect(f.api.ackCleanup.mock.calls[0][3]).toBe('retired');
  });
  it('keeps both registries and the reservation when close is unproven', async () => {
    const f = fixture();
    f.api.close.mockRejectedValueOnce(new Error('response unknown'));
    await expect(f.manager.retireTournamentBreak(f.state())).rejects.toThrow('unknown');
    expect(f.global.get(source)).toBe(f.engine);
    expect(f.manager.tableEngines.get(source)).toBe(f.engine);
    expect(f.server.unregisterTableEngine).not.toHaveBeenCalled();
    expect(f.custody.admissionAllowed(source)).toBe(false);
  });
  it('recovers committed close after lost response without calling close again', async () => {
    const f = fixture();
    f.api.close.mockImplementationOnce(async () => {
      f.setState({ ...f.state(), state: 'close_confirmed' });
      throw new Error('reply lost');
    });
    await expect(f.manager.retireTournamentBreak(f.state())).rejects.toThrow('lost');
    await f.manager.retireTournamentBreak(f.state());
    expect(f.api.close).toHaveBeenCalledTimes(1);
    expect(f.api.claimCustody.mock.calls[0][1]).toBe(f.api.claimCustody.mock.calls[1][1]);
    expect(f.custody.admissionAllowed(source)).toBe(true);
  });
  it('releases only the retained absent reservation after committed ACK response loss', async () => {
    const f = fixture();
    f.api.ackCleanup.mockImplementationOnce(async () => {
      f.setState({ ...f.state(), state: 'acknowledged' });
      throw new Error('ACK reply lost');
    });
    await expect(f.manager.retireTournamentBreak(f.state())).rejects.toThrow('ACK reply lost');
    expect(f.custody.admissionAllowed(source)).toBe(false);
    await f.manager.retireTournamentBreak(f.state());
    expect(f.engine.stop).toHaveBeenCalledTimes(1);
    expect(f.server.unregisterTableEngine).toHaveBeenCalledTimes(1);
    expect(f.api.ackCleanup).toHaveBeenCalledTimes(1);
    expect(f.custody.admissionAllowed(source)).toBe(true);
  });
  it('does not inspect or stop current custody for an unrelated historical ACK', async () => {
    const f = fixture();
    await f.manager.retireTournamentBreak({ ...f.state(), state: 'acknowledged' });
    expect(f.engine.stop).not.toHaveBeenCalled();
    expect(f.server.getTableEngine).not.toHaveBeenCalled();
    expect(f.api.claimCustody).not.toHaveBeenCalled();
  });
  it('discovers and retires before the scheduler can consult occupied-only balancing', async () => {
    const f = fixture();
    // Stop after recovery so unrelated board fixtures cannot supply completion.
    f.manager.redrivePendingTournamentSeatMoveOutcomes = vi.fn(async () => false);
    await f.manager.checkTableBalance();
    expect(f.api.discover).toHaveBeenCalledWith('0', 1);
    expect(f.api.close).toHaveBeenCalledTimes(1);
    expect(f.api.ackCleanup).toHaveBeenCalledTimes(1);
  });
  it('progresses through a new immutable attempt when the original destination is unavailable', async () => {
    const f = fixture();
    f.setState({
      ...f.state(),
      members: [{ ...f.state().members[0], winner_request_id: null, active_request_id: id(8) }],
    });
    f.manager.eligibleBreakDestinations = vi.fn(async () => [
      {
        tableId: id(10),
        maxSeats: 9,
        playerCount: 1,
        players: [{ userId: id(11), seat: 1, stack: 200 }],
      },
    ]);
    f.api.amend = vi.fn(async (input: any) => {
      f.events.push('amend');
      f.setState({
        ...f.state(),
        members: [
          {
            ...f.state().members[0],
            active_request_id: input.newRequestId,
            destination_table_id: input.destinationTableId,
            destination_seat_number: input.destinationSeatNumber,
          },
        ],
      });
      return f.state();
    });
    const move = vi
      .spyOn(movement, 'moveTournamentPlayerAtomically')
      .mockImplementation(async (input) => {
        f.events.push('move');
        f.setState({
          ...f.state(),
          members: [
            {
              ...f.state().members[0],
              active_request_id: null,
              winner_request_id: input.requestId,
            },
          ],
        });
        return {
          ...input,
          sourceSeatId: id(6),
          destinationSeatId: id(12),
          sourceSeatNumber: 1,
          stack: 100,
          movedAt: '2026-09-12T00:00:00Z',
          replayed: false,
        };
      });
    await f.manager.recoverTournamentBreak(f.state());
    expect(f.api.amend).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(1);
    expect(move.mock.calls[0][0].requestId).toBe(f.api.amend.mock.calls[0][0].newRequestId);
    expect(move.mock.calls[0][0].requestId).not.toBe(id(8));
    expect(move.mock.calls[0][0].destinationTableId).toBe(id(10));
    expect(f.events.indexOf('amend')).toBeLessThan(f.events.indexOf('move'));
    expect(f.api.ackCleanup).toHaveBeenCalledTimes(1);
    expect(f.engine.releaseTournamentMovePause).not.toHaveBeenCalled();
  });
  it('recovers a fully moved empty source with verified absence and no engine creation', async () => {
    const f = fixture();
    f.global.clear();
    f.manager.tableEngines.clear();
    await f.manager.recoverTournamentBreak(f.state());
    expect(f.engine.stop).not.toHaveBeenCalled();
    expect(f.server.unregisterTableEngine).not.toHaveBeenCalled();
    expect(f.api.close).toHaveBeenCalledTimes(1);
    expect(f.api.ackCleanup.mock.calls[0][3]).toBe('verified_absent');
    expect(f.custody.admissionAllowed(source)).toBe(true);
  });
  it.each(['lifecycle', 'source_table_id', 'custody_id'])(
    'retains exact empty source on mismatched close %s',
    async (field) => {
      const f = fixture();
      f.api.close.mockImplementationOnce(async () => ({
        ...f.state(),
        state: 'close_confirmed',
        [field]: 'wrong',
      }));
      await expect(f.manager.retireTournamentBreak(f.state())).rejects.toThrow('exact close');
      expect(f.global.get(source)).toBe(f.engine);
      expect(f.manager.tableEngines.get(source)).toBe(f.engine);
      expect(f.server.unregisterTableEngine).not.toHaveBeenCalled();
      expect(f.api.ackCleanup).not.toHaveBeenCalled();
      expect(f.custody.admissionAllowed(source)).toBe(false);
    }
  );
});
