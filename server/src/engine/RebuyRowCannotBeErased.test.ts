/**
 * CHIP STANDARD C3 (docs/CHIP-ACCOUNTING-STANDARD.md 2.3, 2026-09-02):
 * a bust rebuy that cannot be erased.
 *
 * `atomic_table_rebuy` no longer does `table_seats.stack += n`. It debits the
 * wallet and writes a `table_pending_addons` row (kind 'rebuy') in the same
 * transaction, exactly like a mid-hand add-on, and only the engine's
 * `resolve_pending_addon` sweep puts the chips on the felt. That closes the
 * hole where `syncStacks` (an ABSOLUTE write from engine memory) overwrote a
 * relative DB credit that landed between loadSeatedPlayers and the next sync,
 * leaving the wallet debited and the felt empty.
 *
 * It also moves the rebuy OUT of the engine's sight: the browser calls the RPC
 * directly, so nothing in memory (`pendingAddOns`, the sweep flag) knows a row
 * exists. These tests pin the three places the engine now asks the ledger:
 *
 *   1. the 5-second bust pause counts an unresolved row as "the player
 *      answered" and requests a sweep;
 *   2. the busted-seat stand-up keeps a seat that has a row;
 *   3. a sweep request that lands while a sweep is mid-read survives it
 *      (generation counter), so the row is delivered before the next deal and
 *      the first hand after the rebuy starts with the chips in memory - which
 *      is what syncStacks then persists.
 *
 * And the negative: a bust with NO row still stands the player up after the
 * grace, and the pause runs its full course.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const loadSeatedPlayers = vi.fn();
const atomicCashout = vi.fn();
const markSeatAsLeft = vi.fn();

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    loadSeatedPlayers: (...a: unknown[]) => loadSeatedPlayers(...a),
    atomicCashout: (...a: unknown[]) => atomicCashout(...a),
    markSeatAsLeft: (...a: unknown[]) => markSeatAsLeft(...a),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { ServerTableEngineDealing } = await import('./ServerTableEngineDealing.js');
const { supabase } = await import('../services/supabase.js');

const occupancyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

afterEach(() => {
  vi.restoreAllMocks();
  loadSeatedPlayers.mockReset();
  atomicCashout.mockReset();
  markSeatAsLeft.mockReset();
});

/**
 * A `supabase.from` stub that answers per table. Every builder method returns
 * the same thenable so any chain (select.eq.in.is / select.eq.is) resolves to
 * the table's rows. `delayMs` lets a test hold one table's read in flight.
 */
function fromStub(rows: Record<string, unknown[]>, delayMs: Record<string, number> = {}) {
  return (table: string) => {
    const answer = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ data: rows[table] ?? [], error: null }), delayMs[table] ?? 0)
      );
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'update', 'lte', 'order', 'limit']) {
      builder[m] = () => builder;
    }
    builder.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      answer().then(ok, bad);
    return builder;
  };
}

function bareEngine() {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.tableInfo = { id: TABLE, tournament_id: null, club_id: 'club-1' };
  engine.isTournamentTable = () => false;
  engine.getMaxBuyIn = () => 1000;
  engine.broadcastCurrentState = vi.fn();
  engine.hub = { emitEvent: vi.fn() };
  engine.disconnectEngine = { unregisterPlayer: vi.fn() };
  engine.timeBankEngine = { removePlayer: vi.fn() };
  engine.straddleEngine = { removePlayer: vi.fn() };
  engine.preActionEngine = { removePlayer: vi.fn() };
  return engine;
}

describe('the rebuy pause sees a ledger row as an answer', () => {
  it('returns as soon as an unresolved table_pending_addons row exists, and requests a sweep', async () => {
    const engine = bareEngine();
    engine.pendingAddOnSweepNeeded = false;
    vi.spyOn(supabase, 'from').mockImplementation(
      fromStub({
        table_seats: [{ user_id: 'hero', stack: 0 }], // the RPC no longer raises the stack
        table_pending_addons: [{ user_id: 'hero' }],
      }) as never
    );

    const t0 = Date.now();
    await engine.waitForRebuyDecisions(['hero'], 4000);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1500);
    expect(engine.pendingAddOnSweepNeeded).toBe(true);
  });

  it('waits the full window when there is no row and no stack (negative control)', async () => {
    const engine = bareEngine();
    engine.pendingAddOnSweepNeeded = false;
    vi.spyOn(supabase, 'from').mockImplementation(
      fromStub({ table_seats: [{ user_id: 'hero', stack: 0 }], table_pending_addons: [] }) as never
    );

    const t0 = Date.now();
    await engine.waitForRebuyDecisions(['hero'], 600);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(engine.pendingAddOnSweepNeeded).toBe(false);
  });
});

describe('the busted-seat stand-up keeps a seat with money in flight', () => {
  function bustedEngine() {
    const engine = bareEngine();
    const hero = {
      user_id: 'hero',
      username: 'hero',
      seat_number: 1,
      stack: 0,
      is_horse: false,
      occupancy_id: occupancyId,
    };
    engine.seatedPlayers = [hero];
    engine.pendingAddOns = new Map();
    // Seen at zero long ago: the grace has expired.
    engine.bustedSince = new Map([
      ['hero', Date.now() - ServerTableEngineDealing.BUSTED_GRACE_MS - 1],
    ]);
    return { engine, hero };
  }

  it('does NOT cash the seat out while a rebuy row is unresolved, and requests a sweep', async () => {
    const { engine } = bustedEngine();
    engine.pendingAddOnSweepNeeded = false;
    vi.spyOn(supabase, 'from').mockImplementation(
      fromStub({ table_pending_addons: [{ user_id: 'hero' }] }) as never
    );

    await engine.standUpBustedCashPlayers();

    expect(atomicCashout).not.toHaveBeenCalled();
    expect(markSeatAsLeft).not.toHaveBeenCalled();
    expect(engine.pendingAddOnSweepNeeded).toBe(true);
  });

  it('stands the player up after the grace when there is no row (negative control)', async () => {
    const { engine } = bustedEngine();
    vi.spyOn(supabase, 'from').mockImplementation(fromStub({ table_pending_addons: [] }) as never);
    atomicCashout.mockResolvedValue(undefined);

    await engine.standUpBustedCashPlayers();

    expect(atomicCashout).toHaveBeenCalledWith('hero', TABLE, 1, { occupancyId });
  });

  it('stands nobody up on an unreadable ledger (fail open toward the seat)', async () => {
    const { engine } = bustedEngine();
    vi.spyOn(supabase, 'from').mockImplementation((() => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'is']) builder[m] = () => builder;
      builder.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { message: 'boom' } }).then(ok);
      return builder;
    }) as never);

    await engine.standUpBustedCashPlayers();

    expect(atomicCashout).not.toHaveBeenCalled();
  });
});

describe('a sweep request cannot be erased by a sweep already in flight', () => {
  it('keeps the flag when requestPendingAddOnSweep lands during an empty read', async () => {
    const engine = bareEngine();
    engine.pendingAddOnSweepNeeded = true;
    engine.pendingAddOns = new Map();
    // The sweep's read takes 60ms and answers "nothing pending" from a
    // snapshot taken BEFORE the rebuy row committed.
    vi.spyOn(supabase, 'from').mockImplementation(
      fromStub({ table_pending_addons: [] }, { table_pending_addons: 60 }) as never
    );

    const sweep = engine.processPendingAddOns([]);
    await new Promise((r) => setTimeout(r, 10));
    engine.requestPendingAddOnSweep(); // the pause found the new row
    await sweep;

    // Before the generation counter this was false: the row would have waited
    // for the next engine start while the seat was stood up.
    expect(engine.pendingAddOnSweepNeeded).toBe(true);
  });

  it('clears the flag when nobody asked during the read (steady-state cost stays zero)', async () => {
    const engine = bareEngine();
    engine.pendingAddOnSweepNeeded = true;
    engine.pendingAddOns = new Map();
    vi.spyOn(supabase, 'from').mockImplementation(fromStub({ table_pending_addons: [] }) as never);
    await engine.processPendingAddOns([]);
    expect(engine.pendingAddOnSweepNeeded).toBe(false);
  });
});

describe('the rebuy is on the felt for the first hand after it', () => {
  it('delivers the row into the next deal, in memory, before syncStacks could persist a zero', async () => {
    const engine = bareEngine();
    const hero = {
      user_id: 'hero',
      username: 'hero',
      seat_number: 1,
      stack: 0,
      is_horse: false,
      occupancy_id: occupancyId,
    };
    const villain = {
      user_id: 'villain',
      username: 'v',
      seat_number: 2,
      stack: 500,
      is_horse: false,
    };
    engine.seatedPlayers = [hero, villain];
    engine.pendingAddOns = new Map();
    engine.pendingAddOnSweepNeeded = false;
    engine.pendingAddOnSweepGen = 0;

    vi.spyOn(supabase, 'from').mockImplementation(
      fromStub({
        table_seats: [{ user_id: 'hero', stack: 0 }],
        table_pending_addons: [{ id: 'row-rebuy', user_id: 'hero', amount: 200, kind: 'rebuy' }],
      }) as never
    );
    const resolved: string[] = [];
    vi.spyOn(supabase, 'rpc').mockImplementation(((fn: string, args: Record<string, unknown>) => {
      if (fn === 'resolve_pending_addon') {
        resolved.push(String(args.p_pending_id));
        return Promise.resolve({
          data: [{ applied: 200, refunded: 0, was_resolved: true }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    }) as never);

    // 1. End of hand N: the bust pause. The row is what ends it.
    await engine.waitForRebuyDecisions(['hero'], 4000);
    expect(engine.pendingAddOnSweepNeeded).toBe(true);

    // 2. Top of the loop for hand N+1: the idle-tick sweep (it runs before the
    //    active-player filter - see PendingAddOnIdleSweep.test.ts).
    await engine.processPendingAddOns(engine.seatedPlayers);

    expect(resolved).toEqual(['row-rebuy']);
    // The chips are in ENGINE MEMORY, so the next absolute syncStacks writes
    // 200 rather than the 0 it would have written before the sweep.
    expect(hero.stack).toBe(200);
    // ...and the seat is funded for the deal.
    const active = engine.seatedPlayers.filter((p: { stack: number }) => p.stack > 0);
    expect(active.map((p: { user_id: string }) => p.user_id)).toEqual(['hero', 'villain']);
  });
});
