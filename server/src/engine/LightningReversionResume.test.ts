/**
 * LIGHTNING PHASE 7: A TABLE THE CLUSTER GIVES BACK DEALS AGAIN, WITH THE
 * STACKS LIGHTNING LEFT IT (2026-10-02).
 *
 * LIGHTNING -> MUST_MOVE ends with fn_cash_cluster_commit_must_move clearing
 * `tables.dealing_halted_at` on every member table. While the table stood
 * halted (reason 'lightning'), Lightning hands were settled against its
 * anchor seats, so the stacks in `table_seats` are not the stacks this engine
 * last dealt with. Driven through the REAL dealing loop over a mocked
 * database:
 *
 *   - a table halted with reason 'lightning' deals nothing and reads paused;
 *   - once the row is cleared it deals, with the FSM 'running';
 *   - the first hand is dealt with the stacks `table_seats` holds AFTER the
 *     lift, even when the roster read that ran beside the halt read was
 *     answered before the last settlement committed (the two reads are
 *     separate round trips, so the halt can be seen cleared by a roster that
 *     predates it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
}));
const rpc = vi.hoisted(() => vi.fn());

vi.mock('../services/supabase/client.js', () => {
  const from = (table: string) => ({
    select: (cols: string) => {
      // The row as it stands WHEN THE REQUEST IS SENT.
      const sent =
        table !== 'tables' || db.row === null
          ? null
          : cols.includes('cluster:')
            ? { ...db.row, cluster: { lightning_enabled: true } }
            : { ...db.row };
      return {
        eq: () => ({
          maybeSingle: async () => ({ data: sent, error: null }),
        }),
      };
    },
  });
  return { supabase: { from, rpc }, maintenanceSupabase: { from, rpc } };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const seats = vi.hoisted(() => ({
  stacks: [100, 100] as number[],
  /** Set by a test: the next roster read is answered, THEN settlement and the lift commit. */
  commitAfterNextRead: null as null | { stacks: number[]; row: Record<string, unknown> },
  readsAfterLift: 0,
  lifted: false,
}));
const loadSeatedPlayers = vi.hoisted(() => vi.fn());
const loadTable = vi.hoisted(() => vi.fn());
const processLeavePending = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    loadSeatedPlayers: (...a: unknown[]) => loadSeatedPlayers(...a),
    loadTable: (...a: unknown[]) => loadTable(...a),
    processLeavePending: (...a: unknown[]) => processLeavePending(...(a as [])),
    loadKillSettings: async () => null,
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');

const TABLE = 'eeeeeeee-1111-4222-8333-444444444444';
const HALTED = {
  rake_percent: 5,
  rake_cap_bb: 3,
  dealing_halted_at: '2026-10-02T12:00:00.000Z',
  dealing_halted_reason: 'lightning',
};
const LIVE = {
  rake_percent: 5,
  rake_cap_bb: 3,
  dealing_halted_at: null,
  dealing_halted_reason: null,
};

const player = (n: number, stack: number) => ({
  user_id: `11111111-1111-4111-8111-11111111111${n}`,
  occupancy_id: `22222222-2222-4222-8222-22222222222${n}`,
  seat_number: n,
  stack,
  username: `p${n}`,
  is_horse: false,
});

let clock = 2_000_000;

beforeEach(() => {
  clock = 2_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  db.row = { ...HALTED };
  seats.stacks = [100, 100];
  seats.commitAfterNextRead = null;
  seats.readsAfterLift = 0;
  seats.lifted = false;
  rpc.mockReset();
  rpc.mockImplementation(async (fn: string) =>
    fn === 'fn_ca_operator_floor_state'
      ? { data: { hold: null, close: null }, error: null }
      : fn === 'fn_cash_table_observe_dealing_halt'
        ? { data: new Date(clock).toISOString(), error: null }
        : { data: null, error: null }
  );
  loadSeatedPlayers.mockReset();
  loadSeatedPlayers.mockImplementation(async () => {
    // Answered from the database as it stands when the request is sent.
    const answer = seats.stacks.map((s, i) => player(i + 1, s));
    if (seats.lifted) seats.readsAfterLift++;
    const commit = seats.commitAfterNextRead;
    if (commit) {
      seats.commitAfterNextRead = null;
      seats.stacks = commit.stacks;
      db.row = { ...commit.row };
      seats.lifted = true;
    }
    return answer;
  });
  loadTable.mockReset();
  processLeavePending.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function dealingTable(script: (pass: number, e: any) => void) {
  const e = new ServerTableEngine(TABLE) as any;
  e.running = true;
  e.isCurrentEngine = () => true;
  e.tableInfo = {
    id: TABLE,
    club_id: 'club-1',
    game_type: 'cash',
    cluster_id: 'game-1',
    max_players: 6,
    small_blind: 1,
    big_blind: 2,
  };
  e.seatedPlayers = [player(1, 100), player(2, 100)];
  e.knownPlayerIds = new Set(e.seatedPlayers.map((p: { user_id: string }) => p.user_id));
  e.dealingLoopFirstIteration = false;
  e.tableFSM.transition('waiting');
  e.tableFSM.transition('seating');
  e.tableFSM.transition('running');
  e.allocateGlobalHandNumber = vi.fn(async () => 8_100_001);
  e.adoptMovedPresence = vi.fn(async () => true);
  e.restoreSitOutsFromSeats = vi.fn();
  e.restoreEntryHoldsFromSeats = vi.fn();
  e.persistEntryHold = vi.fn();
  e.evictExpiredSitOuts = vi.fn(async () => {});
  e.processPendingAddOns = vi.fn(async () => {});
  e.standUpBustedCashPlayers = vi.fn(async () => {});
  e.recoverBustedSeatedHorses = vi.fn(async () => {});
  e.usersWithPendingLedgerChips = vi.fn(async () => new Set<string>());
  e.executeIdleSeatMoves = vi.fn(async () => []);
  e.announcePendingSeatMoves = vi.fn(async () => true);
  e.awaitNextHandRest = vi.fn(async () => {});
  e.broadcastCurrentState = vi.fn(async () => {});
  e.hasOpenBountyReveal = () => false;
  const dealt: Array<{ fsm: string; stacks: number[]; halted: boolean }> = [];
  const reasons: Array<string | null> = [];
  let pass = 0;
  e.sleep = vi.fn(async () => {
    pass++;
    clock += 6_000; // one parked pass is longer than DEALING_HALT_TTL_MS
    reasons.push(e.dealingHaltReason);
    script(pass, e);
    if (pass > 20) e.running = false; // a test must never spin
  });
  e.dealHand = vi.fn(async () => {
    dealt.push({
      fsm: e.tableFSM.state,
      stacks: e.seatedPlayers.map((p: { stack: number }) => p.stack),
      halted: e.dealingHaltLock,
    });
    e.running = false;
  });
  return { e, dealt, reasons };
}

describe('a table released by LIGHTNING -> MUST_MOVE', () => {
  it("parks under reason 'lightning', then deals once the row is cleared, FSM running, settled stacks", async () => {
    const { e, dealt, reasons } = dealingTable((pass, eng) => {
      expect(eng.tableFSM.state).toBe('paused');
      // Lightning settled hands against the anchor seats while halted...
      if (pass === 2) seats.stacks = [137, 63];
      // ...and commit_must_move cleared the halt.
      if (pass === 3) db.row = { ...LIVE };
    });
    try {
      await e.dealingLoop();
      expect(reasons[0]).toBe('lightning');
      expect(dealt).toHaveLength(1);
      expect(dealt[0]).toEqual({ fsm: 'running', stacks: [137, 63], halted: false });
      expect(e.dealingHaltLock).toBe(false);
      expect(e.dealingHaltReason).toBe(null);
    } finally {
      e.running = false;
      e.preciseTimer?.dispose?.();
    }
  });

  it('re-reads the seats when the lift is seen beside a roster read that predates it', async () => {
    const { e, dealt } = dealingTable((pass) => {
      // The roster read on the next pass is answered with the pre-settlement
      // stacks; the last settlement and the lift commit before the halt read
      // that runs beside it is answered.
      if (pass === 2) {
        seats.commitAfterNextRead = { stacks: [151, 49], row: { ...LIVE } };
      }
    });
    try {
      await e.dealingLoop();
      expect(dealt).toHaveLength(1);
      expect(dealt[0].halted).toBe(false);
      expect(dealt[0].fsm).toBe('running');
      // Never the stale 100/100 the lift arrived beside.
      expect(dealt[0].stacks).toEqual([151, 49]);
      expect(seats.readsAfterLift).toBeGreaterThanOrEqual(1);
    } finally {
      e.running = false;
      e.preciseTimer?.dispose?.();
    }
  });

  it('a table that was never halted deals on its first read, with no extra roster read', async () => {
    db.row = { ...LIVE };
    const { e, dealt } = dealingTable(() => {});
    try {
      await e.dealingLoop();
      expect(dealt).toHaveLength(1);
      expect(dealt[0].stacks).toEqual([100, 100]);
      expect(loadSeatedPlayers).toHaveBeenCalledTimes(1);
    } finally {
      e.running = false;
      e.preciseTimer?.dispose?.();
    }
  });
});
