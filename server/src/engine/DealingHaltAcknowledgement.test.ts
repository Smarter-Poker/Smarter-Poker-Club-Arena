/**
 * THE HALT, DRIVEN THROUGH THE REAL LOOPS (Lightning 2.0 Phase 5 remediation,
 * 2026-09-25).
 *
 * The law test (AHaltedTableFinishesItsHandAndDealsNoOther.law.test.ts) pins
 * the source shape. This file runs the REAL dealing loop and the REAL
 * start() wait loop over a mocked database, with two funded seats, and
 * asserts what a player would see:
 *
 *   - a halted row deals nothing;
 *   - the table acknowledges the halt (fn_cash_table_observe_dealing_halt)
 *     exactly once per `dealing_halted_at` value, and again for a new one;
 *   - the acknowledgement being unavailable (migration not live) is retried
 *     on the next pass and never deals or crashes;
 *   - clearing the row lets the same engine deal, with the FSM `running`;
 *   - a rebuilt engine whose row is halted applies the halt before any deal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  selects: [] as Array<{ table: string; cols: string }>,
  observeReply: null as null | (() => { data: unknown; error: unknown }),
  /** The Cluster's `lightning_enabled`, as the halt poll's embed reads it. */
  lightningEnabled: true,
  /** When set, a read of these columns answers only when the test says so. */
  hold: null as null | ((cols: string) => Promise<{ data: unknown; error: unknown }> | null),
}));
const rpc = vi.hoisted(() => vi.fn());

vi.mock('../services/supabase/client.js', () => {
  const from = (table: string) => ({
    select: (cols: string) => {
      db.selects.push({ table, cols });
      // The row as it stands WHEN THE REQUEST IS SENT, which is what a real
      // round trip answers with however late the answer arrives.
      const sent =
        table !== 'tables' || db.row === null
          ? null
          : cols.includes('cluster:')
            ? { ...db.row, cluster: { lightning_enabled: db.lightningEnabled } }
            : { ...db.row };
      const held = db.hold?.(cols) ?? null;
      return {
        eq: () => ({
          maybeSingle: async () => (held ? held : { data: sent, error: null }),
        }),
      };
    },
  });
  return { supabase: { from, rpc }, maintenanceSupabase: { from, rpc } };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

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

const TABLE = 'dddddddd-1111-4222-8333-444444444444';
const H1 = '2026-09-25T20:00:00.000Z';
const H2 = '2026-09-25T20:07:00.000Z';
const halted = (at: string) => ({
  rake_percent: 5,
  rake_cap_bb: 3,
  dealing_halted_at: at,
  dealing_halted_reason: 'lightning_pending_on',
});
const live = {
  rake_percent: 5,
  rake_cap_bb: 3,
  dealing_halted_at: null,
  dealing_halted_reason: null,
};

const players = [1, 2].map((n) => ({
  user_id: `11111111-1111-4111-8111-11111111111${n}`,
  occupancy_id: `22222222-2222-4222-8222-22222222222${n}`,
  seat_number: n,
  stack: 100,
  username: `p${n}`,
  is_horse: false,
}));

let clock = 1_000_000;
function observeCalls(): unknown[][] {
  return rpc.mock.calls.filter((c) => c[0] === 'fn_cash_table_observe_dealing_halt');
}

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  db.row = null;
  db.selects = [];
  db.observeReply = null;
  db.lightningEnabled = true;
  db.hold = null;
  rpc.mockReset();
  rpc.mockImplementation(async (fn: string) => {
    if (fn === 'fn_cash_table_observe_dealing_halt') {
      if (db.observeReply) return db.observeReply();
      return { data: new Date(clock).toISOString(), error: null };
    }
    return { data: null, error: null };
  });
  loadSeatedPlayers.mockReset();
  loadSeatedPlayers.mockImplementation(async () => players.map((p) => ({ ...p })));
  loadTable.mockReset();
  processLeavePending.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A cash Cluster table entering the real dealing loop between hands. Only the
 * leaves that would reach another subsystem are stubbed; the halt read, the
 * rule re-read, prepareNextHand, the gate and the acknowledgement are real.
 */
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
  e.seatedPlayers = players.map((p) => ({ ...p }));
  e.knownPlayerIds = new Set(players.map((p) => p.user_id));
  e.dealingLoopFirstIteration = false;
  // start() walks the table to 'running' before it hands over to this loop.
  e.tableFSM.transition('waiting');
  e.tableFSM.transition('seating');
  e.tableFSM.transition('running');
  expect(e.tableFSM.state).toBe('running');
  e.allocateGlobalHandNumber = vi.fn(async () => 8_000_001);
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
  const closedCheck = vi.spyOn(e, 'stopIfClusterTableClosed');
  let pass = 0;
  e.sleep = vi.fn(async () => {
    pass++;
    clock += 6_000; // one parked pass is longer than DEALING_HALT_TTL_MS
    script(pass, e);
  });
  e.dealHand = vi.fn(async () => {
    e.running = false;
  });
  return { e, closedCheck, passes: () => pass };
}

describe('a halted Cluster table, through the real dealing loop', () => {
  it('deals nothing, acknowledges once per halt value, and deals again when cleared', async () => {
    db.row = halted(H1);
    const fsmAtDeal: string[] = [];
    const { e, closedCheck } = dealingTable((pass) => {
      if (pass === 4) db.row = halted(H2); // the conversion aborted and began again
      if (pass === 7) db.row = { ...live }; // ...and this time it aborted for good
      if (pass > 20) e.running = false; // bail-out: a test must never spin
    });
    e.dealHand = vi.fn(async () => {
      fsmAtDeal.push(e.tableFSM.state);
      e.running = false;
    });
    e.consecutiveErrors = 7;

    try {
      await e.dealingLoop();

      // Two halt values, two acknowledgements - not one per pass.
      const observed = observeCalls();
      expect(observed).toHaveLength(2);
      expect(observed[0][1]).toEqual({ p_table_id: TABLE });
      // A parked pass is a success: the error streak cannot climb to the kill.
      // Then the halt lifts and the SAME engine deals, labelled running.
      expect(e.dealHand).toHaveBeenCalledTimes(1);
      expect(fsmAtDeal).toEqual(['running']);
      expect(e.consecutiveErrors).toBe(0);
      expect(e.dealingHaltLock).toBe(false);
      expect(e.dealingHaltObservedFor, 'a cleared halt owes no acknowledgement').toBe(null);
      // The empty-closed-table check is reached from the halt branch.
      expect(closedCheck).toHaveBeenCalled();
      // The halt was read with the narrow two-column select, not only the rule read.
      expect(db.selects).toContainEqual({
        table: 'tables',
        cols: 'dealing_halted_at, dealing_halted_reason, cluster:cash_games!cluster_id(lightning_enabled)',
      });
    } finally {
      e.running = false;
      e.preciseTimer?.dispose?.();
    }
  });

  it('while halted the FSM reads paused and not one hand is dealt', async () => {
    db.row = halted(H1);
    const states: string[] = [];
    const { e } = dealingTable((pass, eng) => {
      states.push(eng.tableFSM.state);
      if (pass >= 5) eng.running = false;
    });
    try {
      await e.dealingLoop();
      expect(e.dealHand).not.toHaveBeenCalled();
      expect(new Set(states)).toEqual(new Set(['paused']));
      expect(observeCalls()).toHaveLength(1);
    } finally {
      e.running = false;
      e.preciseTimer?.dispose?.();
    }
  });

  it('an acknowledgement the database cannot take yet is retried, never fatal, never a deal', async () => {
    db.row = halted(H1);
    let unavailable = true;
    db.observeReply = () =>
      unavailable
        ? {
            data: null,
            error: {
              code: 'PGRST202',
              message: 'Could not find the function public.fn_cash_table_observe_dealing_halt',
            },
          }
        : { data: new Date(clock).toISOString(), error: null };
    const { e } = dealingTable((pass, eng) => {
      if (pass === 3) unavailable = false; // the migration lands
      if (pass >= 6) eng.running = false;
    });
    try {
      await e.dealingLoop();
      expect(e.dealHand).not.toHaveBeenCalled();
      // Refused on passes 1-3, accepted on pass 4, then never asked again.
      expect(observeCalls()).toHaveLength(4);
      expect(e.dealingHaltObservedFor).toBe(H1);
      expect(e.consecutiveErrors).toBe(0);
    } finally {
      e.running = false;
      e.preciseTimer?.dispose?.();
    }
  });

  it('a halt written while a busy table is dealing is honoured before its next deal', async () => {
    // The table is live and deals; between its hands the Cluster halts it.
    db.row = { ...live };
    const { e } = dealingTable((pass, eng) => {
      if (pass >= 4) eng.running = false;
    });
    let hands = 0;
    e.dealHand = vi.fn(async () => {
      hands++;
      clock += 6_000; // the hand took longer than the halt TTL
      db.row = halted(H1);
    });
    try {
      await e.dealingLoop();
      expect(hands, 'exactly the hand in the air, and no other').toBe(1);
      expect(e.dealingHaltLock).toBe(true);
      expect(observeCalls()).toHaveLength(1);
    } finally {
      e.running = false;
      e.preciseTimer?.dispose?.();
    }
  });
});

describe('reads that answer out of order (verifier P1, 2026-09-26)', () => {
  it('a late rule-read answer sent before the halt can never release an acknowledged halt', async () => {
    // The table is live and its Cluster is Lightning-enabled.
    db.row = { ...live };
    const { e } = dealingTable(() => {});
    // 1. The rule re-read goes out while the row is still live; its answer
    //    is slow (the step budget gives up on it, the request carries on).
    let answerLate!: () => void;
    db.hold = (cols) =>
      cols.startsWith('rake_percent')
        ? new Promise((resolve) => {
            answerLate = () => resolve({ data: { ...live }, error: null });
          })
        : null;
    const lateRuleRead = e.refreshRakeConfig(true);
    db.hold = null;

    // 2. The Cluster halts the table; the halt poll reads it, and the parked
    //    table acknowledges.
    db.row = halted(H1);
    clock += 6_000;
    await e.refreshDealingHalt();
    expect(e.dealingHaltLock).toBe(true);
    await e.observeDealingHalt();
    expect(observeCalls()).toHaveLength(1);
    expect(e.dealingHaltObservedFor).toBe(H1);

    // 3. The stale answer finally lands. It was read before the halt existed.
    answerLate();
    await lateRuleRead;
    expect(e.dealingHaltLock, 'a stale read must not lift an acknowledged halt').toBe(true);
    expect(e.dealingHaltObservedFor).toBe(H1);
    expect(e.isNextHandPaused()).toBe(true);

    // 4. A read sent AFTER the acknowledgement that finds the row cleared is
    //    the only thing that lifts it.
    db.row = { ...live };
    clock += 6_000;
    await e.refreshDealingHalt();
    expect(e.dealingHaltLock).toBe(false);
    e.running = false;
    e.preciseTimer?.dispose?.();
  });

  it('an older answer landing after a newer one is ignored, whichever way it points', async () => {
    db.row = halted(H1);
    const { e } = dealingTable(() => {});
    const older = e.beginDealingHaltRead();
    const newer = e.beginDealingHaltRead();
    e.applyDealingHaltFromRow(halted(H1), newer);
    e.applyDealingHaltFromRow({ ...live }, older);
    expect(e.dealingHaltLock).toBe(true);
    e.running = false;
    e.preciseTimer?.dispose?.();
  });
});

describe('a rebuilt engine whose row is halted', () => {
  it('applies the halt in start() before any deal, acknowledges it, and deals once cleared', async () => {
    loadTable.mockResolvedValue({
      id: TABLE,
      club_id: 'club-1',
      small_blind: 1,
      big_blind: 2,
      max_players: 6,
      game_variant: 'nlh',
      game_type: 'cash',
      cluster_id: 'game-1',
      ...halted(H1),
    });
    db.row = halted(H1);
    const e = new ServerTableEngine(TABLE) as any;
    let pass = 0;
    e.sleep = async () => {
      pass++;
      clock += 6_000;
      if (pass === 3) db.row = { ...live };
      if (pass > 10) e.running = false;
    };
    e.seedHandCountFromHistory = async () => {};
    e.restoreButtonFromHistory = async () => {};
    e.checkCrashRecovery = async () => false;
    e.readParkedTimeBanks = async () => {};
    e.resolveOrphanedAddOns = async () => {};
    e.broadcastCurrentState = async () => {};
    e.scheduleHeartbeatCheck = () => {};
    e.restoreSitOutsFromSeats = () => {};
    e.restoreEntryHoldsFromSeats = () => {};
    e.adoptMovedPresence = async () => true;
    e.evictExpiredSitOuts = vi.fn(async () => {});
    e.executeIdleSeatMoves = vi.fn(async () => []);
    e.processPendingAddOns = vi.fn(async () => {});
    const dealtWhileHalted: boolean[] = [];
    e.dealingLoop = vi.fn(async () => {
      dealtWhileHalted.push(e.dealingHaltLock);
    });
    try {
      await e.start();
      expect(observeCalls(), 'the rebuilt table acknowledges the halt it came up in').toHaveLength(
        1
      );
      expect(e.dealingLoop).toHaveBeenCalledTimes(1);
      expect(dealtWhileHalted, 'it reached the dealer only after the row cleared').toEqual([false]);
      expect(e.tableFSM.state).toBe('running');
      expect(e.evictExpiredSitOuts).toHaveBeenCalled(); // only after the lift
    } finally {
      e.running = false;
      await e.stop().catch(() => undefined);
      e.preciseTimer?.dispose?.();
    }
  });
});
