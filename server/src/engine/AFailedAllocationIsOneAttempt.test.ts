import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { F06HandPermit } from '../services/F06HandPermit.js';

/* A FAILED ALLOCATION IS ONE ATTEMPT (2026-09-26).

   Production, 2026-09-26 03:45-03:48 UTC, release 92d59cfb: one tournament
   hand-number pre-allocation (`fn_f06_allocate_hand_number`) hit
   `canceling statement due to statement timeout` behind the tournament's
   settlement lane while a bust write held it. The engine kept that single
   failure as a standing error and re-threw it on every later deal attempt
   (`deal_error_attempt_N Error: f06_allocation_unproven`), even though the
   allocator answered again at once. Table 16de0024 sat 183 s until the zombie
   watchdog rebuilt it; about 15 tables hit the same wall after the restart.

   An allocation claims no hand. Custody begins at `fn_f06_begin_hand`, so a
   failed allocation costs at most a burned number. These tests drive the real
   loop order - prepareNextHand, the rest's settle, dealHand - and pin that a
   failure before BEGIN fails exactly the attempt it happened in, while a
   failure after BEGIN keeps holding the table exactly as before. */

vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw new Error('Unexpected database read in allocation fixture');
    }),
    rpc: vi.fn(() => {
      throw new Error('Unexpected database RPC in allocation fixture');
    }),
  },
  maintenanceSupabase: {},
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TABLE = id(2);
const CUSTODY = id(4);
const STATEMENT_TIMEOUT = {
  code: '57014',
  message: 'canceling statement due to statement timeout',
};

type Reply = { data: unknown; error: unknown };

function tournamentTable(opts: { allocations: Reply[]; projections?: Reply[]; begins?: Reply[] }) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const engine = new ServerTableEngine(TABLE) as any;
  const players = [1, 2, 3].map((n) => ({
    user_id: id(10 + n),
    occupancy_id: id(20 + n),
    seat_number: n,
    stack: 1000,
  }));
  engine.tableInfo = { id: TABLE, tournament_id: id(3), game_type: 'NLH', max_players: 6 };
  engine.seatedPlayers = players;
  engine.readNextHandInputs = vi.fn(async () => players);

  const rpc = vi.fn(async (name: string, _input: unknown): Promise<Reply> => {
    const queue =
      name === 'fn_f06_allocate_hand_number'
        ? opts.allocations
        : name === 'fn_f06_hand_number_state'
          ? (opts.projections ?? [])
          : name === 'fn_f06_begin_hand'
            ? (opts.begins ?? [])
            : [];
    const reply = queue.shift();
    if (!reply) throw new Error(`unscripted ${name}`);
    return reply;
  });

  // The Manager's allocator and admission closures, reduced to what they
  // decide: any RPC error or malformed reply is `..._unproven`.
  engine.installF06Allocator(
    CUSTODY,
    async () => {
      const { data, error } = await rpc('fn_f06_allocate_hand_number', {});
      const a = data as { hand_number?: string } | null;
      if (error || !a || typeof a.hand_number !== 'string')
        throw new Error('f06_allocation_unproven');
      return Number(a.hand_number);
    },
    () => true,
    '1'
  );
  const permits: F06HandPermit[] = [];
  engine.installF06HandAdmission(async (handNumber: string) => {
    if (opts.projections) {
      const refreshed = await rpc('fn_f06_hand_number_state', {});
      if (refreshed.error || !refreshed.data) throw new Error('f06_fresh_hand_projection_unproven');
    }
    const binding = {
      tournament_id: id(3),
      lease_generation: id(5),
      table_id: TABLE,
      lifecycle: '1',
      permit_id: id(100 + permits.length),
      hand_number: handNumber,
      custody_id: CUSTODY,
    };
    const permit = new F06HandPermit(
      binding,
      async (name, input) => {
        const reserved = { ok: true, ...binding, generation: id(5), state: 'reserved' };
        if (!opts.begins) return { data: reserved, error: null };
        const reply = await rpc(name, input);
        return reply.error || !reply.data ? reply : { data: reserved, error: null };
      },
      () => true
    );
    permits.push(permit);
    return permit;
  });
  engine.running = true;

  // The hand is created right after this seam; record the number it was
  // given and let the hand resolve so the permit does not linger.
  const dealt: number[] = [];
  engine.discardPreparedHandForPause = vi.fn(() => {
    dealt.push(engine.handCount);
    if (!opts.begins) engine.f06CurrentPermit = null;
    return true;
  });

  // One pass of the dealing loop's own order: roster + pre-allocation, the
  // rest's settle, then the deal.
  const attempt = async () => {
    await engine.prepareNextHand();
    await engine.settlePreparedHandNumber();
    await engine.dealHand(players);
  };
  return { engine, attempt, dealt, rpc, permits };
}

const allocated = (n: number): Reply => ({ data: { hand_number: String(n) }, error: null });
const failed: Reply = { data: null, error: STATEMENT_TIMEOUT };

describe('a failed hand-number allocation is one attempt, not a standing error', () => {
  it('the attempt after a statement timeout allocates a fresh number and deals', async () => {
    const { engine, attempt, dealt, rpc } = tournamentTable({
      allocations: [failed, allocated(1000002), allocated(1000003)],
    });

    await expect(attempt()).rejects.toThrow('f06_allocation_unproven');
    expect(dealt).toEqual([]);

    await attempt();
    expect(dealt).toEqual([1000002]);

    await attempt();
    expect(dealt).toEqual([1000002, 1000003]);
    expect(rpc.mock.calls.filter(([n]) => n === 'fn_f06_allocate_hand_number')).toHaveLength(3);
    expect(engine.preparedF06AllocationError).toBeNull();
    expect(engine.f06CurrentPermit).toBeNull();
  });

  it('a failure that is never dealt is replaced by the next preparation, not replayed', async () => {
    // A pause between the rest and the deal skips dealHand. The next pass
    // prepares again; its success must not be vetoed by the older failure.
    const { attempt, engine, dealt } = tournamentTable({
      allocations: [failed, allocated(1000002)],
    });
    await engine.prepareNextHand();
    await engine.settlePreparedHandNumber();
    await attempt();
    expect(dealt).toEqual([1000002]);
  });

  it('a fresh-projection failure before any permit exists is also one attempt', async () => {
    const { engine, attempt, dealt, rpc } = tournamentTable({
      allocations: [allocated(1000002), allocated(1000003)],
      projections: [failed, { data: { ok: true }, error: null }],
    });

    await expect(attempt()).rejects.toThrow('f06_fresh_hand_projection_unproven');
    expect(engine.f06CurrentPermit).toBeNull();
    expect(dealt).toEqual([]);

    await attempt();
    expect(dealt).toEqual([1000003]);
    expect(rpc.mock.calls.filter(([n]) => n === 'fn_f06_begin_hand')).toHaveLength(0);
  });

  it('a failure after BEGIN keeps holding the table on the original permit', async () => {
    const { engine, attempt, dealt, rpc, permits } = tournamentTable({
      allocations: [allocated(1000002), allocated(1000003), allocated(1000004)],
      begins: [failed],
    });

    await expect(attempt()).rejects.toThrow('f06_permit_unproven');
    const original = engine.f06CurrentPermit;
    expect(original).toBe(permits[0]);
    expect(original.recoveryState()).toBe('unknown');

    await expect(attempt()).rejects.toThrow('f06_prior_hand_unresolved');
    await expect(attempt()).rejects.toThrow('f06_prior_hand_unresolved');
    expect(engine.f06CurrentPermit).toBe(original);
    expect(permits).toHaveLength(1);
    expect(rpc.mock.calls.filter(([n]) => n === 'fn_f06_begin_hand')).toHaveLength(1);
    expect(dealt).toEqual([]);
  });
});
