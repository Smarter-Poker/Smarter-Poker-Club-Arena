import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { supabase } from '../services/supabase.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const member = () => ({
  user_id: id(4),
  source_seat_id: id(5),
  source_seat_number: 1,
  occupancy_id: id(6),
  request_id: id(7),
  destination_table_id: id(8),
  destination_seat_number: 2,
  original_destination_table_id: id(8),
  original_destination_seat_number: 2,
  active_request_id: id(7),
  winner_request_id: null,
  winning_receipt: null,
  attempt_revision: 1,
});
const state = (begun = true): any => ({
  ok: true,
  reason: null,
  break_id: id(2),
  tournament_id: id(1),
  source_table_id: id(3),
  lifecycle: '1',
  state: begun ? 'begun' : 'park_requested',
  revision: '1',
  custody_id: null,
  custody_generation: null,
  terminal_handoff_required: false,
  members: begun ? [member()] : [],
});
const input = () => {
  const m = member();
  return [
    {
      user_id: m.user_id,
      source_seat_id: m.source_seat_id,
      source_seat_number: m.source_seat_number,
      occupancy_id: m.occupancy_id,
      request_id: m.request_id,
      destination_table_id: m.destination_table_id,
      destination_seat_number: m.destination_seat_number,
    },
  ];
};
function manager() {
  const m: any = new TournamentManager(id(1), {} as any, id(9), performance.now() + 60000);
  m.running = true;
  m.eliminationSweepDeadlineAt = 0;
  return m;
}
const capacity = { data: null, error: { code: '55000', message: 'F06_CAPACITY_UNAVAILABLE' } };
const ok = (data: any) => ({ data, error: null });
afterEach(() => vi.restoreAllMocks());
describe('0064 actual Manager and transport proposal resolution', () => {
  it('rejected replacement can select another legal chair with fresh proposal and same predecessor', async () => {
    const m = manager();
    const calls: any[] = [];
    let durable = state();
    vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
      if (name === 'fn_f06_reconcile_break') return ok(durable);
      calls.push(p);
      if (calls.length === 1) return capacity;
      durable = {
        ...durable,
        members: [
          {
            ...member(),
            active_request_id: p.p_new_request_id,
            destination_seat_number: p.p_destination_seat_number,
            attempt_revision: 2,
          },
        ],
      };
      return ok(durable);
    }) as any);
    const first = await m.amendTournamentBreakMember(state(), id(4), id(8), 3);
    const next = await m.amendTournamentBreakMember(first, id(4), id(8), 4);
    expect(calls.map((p) => p.p_destination_seat_number)).toEqual([3, 4]);
    expect(calls[1].p_amendment_id).not.toBe(calls[0].p_amendment_id);
    expect(calls[1].p_expected_request_id).toBe(id(7));
    expect(next.members[0].active_request_id).toBe(calls[1].p_new_request_id);
  });
  it('initial capacity race refreshes placement while retaining every source and request identity', async () => {
    const m = manager();
    const calls: any[] = [];
    vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
      if (name === 'fn_f06_reconcile_break') return ok(state(false));
      calls.push(p);
      if (calls.length === 1) return capacity;
      return ok({
        ...state(),
        members: [
          {
            ...member(),
            ...p.p_members[0],
            original_destination_seat_number: p.p_members[0].destination_seat_number,
          },
        ],
      });
    }) as any);
    expect((await m.beginTournamentBreak(id(2), id(3), input())).state).toBe('park_requested');
    const replacement = input().map((m) => ({ ...m, destination_seat_number: 4 }));
    await m.beginTournamentBreak(id(2), id(3), replacement);
    expect(calls[1].p_members).toEqual(replacement);
    expect(calls[1].p_members[0].request_id).toBe(calls[0].p_members[0].request_id);
    expect(m.pendingTournamentBreakBegins.size).toBe(0);
    expect(m.resolvedTournamentBreakProposals.size).toBe(0);
  });
  it.each(['begin', 'amend'])(
    'earlier lost %s commit is recovered by exact replay despite now unavailable chair',
    async (kind) => {
      const m = manager();
      let committed: any;
      const calls: any[] = [];
      vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
        calls.push(p);
        if (!committed) {
          committed =
            kind === 'begin'
              ? state()
              : {
                  ...state(),
                  members: [
                    {
                      ...member(),
                      active_request_id: p.p_new_request_id,
                      destination_seat_number: 3,
                      attempt_revision: 2,
                    },
                  ],
                };
          return { data: null, error: { message: 'reply lost' } };
        }
        // Models authoritative replay-before-capacity ordering, not an invented refusal.
        return ok(committed);
      }) as any);
      const run = () =>
        kind === 'begin'
          ? m.beginTournamentBreak(id(2), id(3), input())
          : m.amendTournamentBreakMember(state(), id(4), id(8), 4);
      await expect(run()).rejects.toThrow('outcome unproven');
      expect(await run()).toEqual(committed);
      expect(calls[1]).toEqual(calls[0]);
    }
  );
  it.each([
    { code: '55000', message: 'different refusal' },
    { code: '40001', message: 'F06_CAPACITY_UNAVAILABLE' },
    { message: 'F06_CAPACITY_UNAVAILABLE' },
    { code: '22023', message: 'F06_CHANGED_MANIFEST' },
  ])('retains exact proposal for unqualified error %j', async (error) => {
    const m = manager();
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error } as never);
    await expect(m.amendTournamentBreakMember(state(), id(4), id(8), 3)).rejects.toThrow(
      'outcome unproven'
    );
    await expect(m.amendTournamentBreakMember(state(), id(4), id(8), 4)).rejects.toThrow(
      'outcome unproven'
    );
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
    expect(m.pendingTournamentBreakAmendments.size).toBe(1);
  });
  it('retains proposal when capacity reconciliation fails', async () => {
    const m = manager();
    vi.spyOn(supabase, 'rpc')
      .mockResolvedValueOnce(capacity as never)
      .mockResolvedValueOnce({ data: null, error: { message: 'lost read' } } as never);
    await expect(m.amendTournamentBreakMember(state(), id(4), id(8), 3)).rejects.toThrow(
      'lost read'
    );
    expect(m.pendingTournamentBreakAmendments.size).toBe(1);
  });
  it('adopts a delayed begin winner observed after capacity refusal', async () => {
    const m = manager();
    vi.spyOn(supabase, 'rpc')
      .mockResolvedValueOnce(capacity as never)
      .mockResolvedValueOnce(ok(state()) as never);
    expect((await m.beginTournamentBreak(id(2), id(3), input())).state).toBe('begun');
    expect(m.pendingTournamentBreakBegins.size).toBe(0);
  });
  it('refuses changed occupancy in authoritative reconciliation and retains exact proposal', async () => {
    const m = manager();
    vi.spyOn(supabase, 'rpc')
      .mockResolvedValueOnce(capacity as never)
      .mockResolvedValueOnce(
        ok({ ...state(), members: [{ ...member(), occupancy_id: id(99) }] }) as never
      );
    await expect(m.amendTournamentBreakMember(state(), id(4), id(8), 3)).rejects.toThrow(
      'membership mismatch'
    );
    expect(m.pendingTournamentBreakAmendments.size).toBe(1);
  });
  it('physical parked-source replanning preserves initial IDs after a capacity race', async () => {
    const m = manager();
    const engine = { parkForTournamentMove: vi.fn(async () => true) };
    m.tableEngines.set(id(3), engine);
    m.gameServer.ownsTournamentTableEngine = () => true;
    m.eligibleBreakDestinations = vi.fn(async () => [
      { tableId: id(8), playerCount: 0, maxSeats: 10, players: [] },
    ]);
    let chair = 3;
    m.tableBalancer.breakTable = vi.fn(() => [
      { playerId: id(4), toTableId: id(8), toSeat: chair },
    ]);
    const query: any = {
      select: () => query,
      eq: () => query,
      is: async () => ({
        data: [
          {
            id: id(5),
            user_id: id(4),
            seat_number: 1,
            stack: 100,
            occupancy_id: id(6),
          },
        ],
        error: null,
      }),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(query);
    const calls: any[] = [];
    vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
      if (name === 'fn_f06_reconcile_break') return ok(state(false));
      calls.push(p);
      if (calls.length === 1) return capacity;
      return ok({
        ...state(),
        members: [
          {
            ...member(),
            ...p.p_members[0],
            active_request_id: p.p_members[0].request_id,
            original_destination_seat_number: chair,
          },
        ],
      });
    }) as any);
    await m.prepareParkedTournamentBreak(state(false));
    chair = 4;
    const result = await m.prepareParkedTournamentBreak(state(false));
    expect(result.members[0].destination_seat_number).toBe(4);
    expect(calls[1].p_members[0].request_id).toBe(calls[0].p_members[0].request_id);
    expect(engine.parkForTournamentMove).toHaveBeenCalledTimes(2);
  });
  it('adopts competing amendment successor after correlated refusal without claiming proposed successor won', async () => {
    const m = manager();
    const next = {
      ...state(),
      members: [
        { ...member(), active_request_id: id(40), attempt_revision: 3, destination_seat_number: 5 },
      ],
    };
    vi.spyOn(supabase, 'rpc')
      .mockResolvedValueOnce(capacity as never)
      .mockResolvedValueOnce(ok(next) as never);
    const result = await m.amendTournamentBreakMember(state(), id(4), id(8), 3);
    expect(result.members[0].active_request_id).toBe(id(40));
    expect(m.pendingTournamentBreakAmendments.size).toBe(0);
    expect(m.resolvedTournamentBreakProposals.get(id(2))).toHaveLength(1);
  });
  it('actual repair and balancer advance from a raced occupied replacement to the next free chair', async () => {
    const m = manager();
    let occupied = 2;
    const proposals: any[] = [];
    m.eligibleBreakDestinations = async () => [
      {
        tableId: id(8),
        playerCount: occupied,
        maxSeats: 10,
        players: Array.from({ length: occupied }, (_, i) => ({
          userId: id(50 + i),
          seat: i + 1,
          stack: 100,
        })),
      },
    ];
    vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
      if (name === 'fn_f06_reconcile_break') return ok(state());
      proposals.push(p);
      if (proposals.length === 1) {
        occupied = 3;
        return capacity;
      }
      return ok({
        ...state(),
        members: [
          {
            ...member(),
            active_request_id: p.p_new_request_id,
            destination_seat_number: p.p_destination_seat_number,
            attempt_revision: 2,
          },
        ],
      });
    }) as any);
    const first = await m.repairTournamentBreakDestinations(state());
    const next = await m.repairTournamentBreakDestinations(first);
    expect(proposals.map((p) => p.p_destination_seat_number)).toEqual([3, 4]);
    expect(next.members[0].destination_seat_number).toBe(4);
  });
});
