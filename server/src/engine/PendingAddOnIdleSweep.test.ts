/**
 * Dan 2026-08-19, bug list item 17: "when hero busts and adds chips they're
 * never dealt in - stuck on 'Seat Reserved, You'll Be Dealt In Next Hand'."
 *
 * An add-on requested while a hand is running is DEBITED immediately but only
 * QUEUED onto `table_pending_addons`. It reaches the seat via
 * `processPendingAddOns`, which used to be called from exactly one place:
 * settlement step 8e, at the end of a hand.
 *
 * That is a deadlock for the player who needs it most. Bust, and `stack > 0`
 * filters you out of the deal. If the table then drops below two funded seats
 * the dealing loop parks in its idle branch - no hand starts, so no settlement
 * runs, so the queued chips are never applied, so you never get a stack. The
 * seat reads "Seat Reserved, you'll be dealt in next hand" forever while the
 * money sits debited in the ledger. The same hole opens when a hand hits
 * HAND_SAFETY_TIMEOUT, which nulls the controller and resolves WITHOUT
 * settling.
 *
 * The fix sweeps on every idle tick, before the active-player filter. These
 * tests prove the sweep happens without any hand completing, and that it
 * resolves a ledger row for a player who is NOT in the hand.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const loadSeatedPlayers = vi.fn();
const loadTable = vi.fn();

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    loadSeatedPlayers: (...a: unknown[]) => loadSeatedPlayers(...a),
    loadTable: (...a: unknown[]) => loadTable(...a),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { supabase } = await import('../services/supabase.js');

const TABLE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

afterEach(() => {
  vi.restoreAllMocks();
  loadSeatedPlayers.mockReset();
});

/** A table parked in the idle branch: one seated player, busted to 0. */
function idleEngine() {
  const engine = new ServerTableEngine(TABLE) as any;
  // dealingLoop is entered directly in this harness; model the exact
  // process-owned generation that production start() establishes first.
  engine.isCurrentEngine = () => true;
  const busted = {
    user_id: 'hero',
    seat_number: 1,
    stack: 0,
    is_horse: false,
  };
  loadSeatedPlayers.mockResolvedValue([busted]);
  engine.seatedPlayers = [busted];
  engine.tableInfo = { id: TABLE, tournament_id: null };
  engine.postHandTasksPromise = null;
  engine.refreshBlinds = vi.fn().mockResolvedValue(undefined);
  engine.refreshRakeConfig = vi.fn().mockResolvedValue(undefined);
  engine.recoverBustedSeatedHorses = vi.fn().mockResolvedValue(undefined);
  engine.isTournamentTable = () => false;
  // A real (tiny) yield, not an instantly-resolved promise: the idle branch
  // awaits sleep(), and a synchronously-resolving stub starves the event loop
  // so the test's own bail timer could never fire.
  engine.sleep = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, 5)));
  engine.hub = { emitEvent: vi.fn() };
  engine.disconnectEngine = {
    isSittingOut: () => false,
    registerPlayer: vi.fn(),
    checkStaleHeartbeats: vi.fn(),
    onAutoAction: vi.fn(),
    // Added 2026-08-21 with the sit-out eviction rule. dealingLoop now calls
    // this near the top of every tick, BEFORE the add-on sweep, so a stub
    // without it throws and the loop never reaches the behaviour under test -
    // which is what this file exists to protect. Returns no evictions.
    tickSitOutsAndCollectEvictions: () => [] as string[],
    // Added 2026-08-23 with the away-blind cap, for the same reason as the
    // line above and with the same consequence if it is missing: dealingLoop
    // calls this on every tick BEFORE the add-on sweep, so a stub without it
    // throws and this file silently stops testing the thing it exists for.
    // Returns no evictions.
    collectAwayBlindEvictions: () => [] as string[],
    collectAbandonedSeatEvictions: () => [] as string[],
    // dealHand calls this for whoever is in the blind seats. Stubbed as a
    // no-op: presence is not what these tests are about.
    noteBlindChargedWhileAway: vi.fn(),
    unregisterPlayer: vi.fn(),
  };
  engine.timeBankEngine = { removePlayer: vi.fn() };
  engine.straddleEngine = { removePlayer: vi.fn() };
  engine.preActionEngine = { removePlayer: vi.fn() };
  engine.waitingForBB = new Set<string>();
  engine.tableFSM = { state: 'waiting', transition: vi.fn() };
  return { engine, busted };
}

describe('pending add-ons are swept on an idle tick', () => {
  it('sweeps with NO hand completing, on a table below two funded seats', async () => {
    const { engine } = idleEngine();

    let swept = 0;
    engine.processPendingAddOns = vi.fn().mockImplementation(async () => {
      swept++;
      engine.running = false; // one iteration is enough
    });

    engine.running = true;
    // Bound the loop so that WITHOUT the fix this fails on the assertion
    // rather than hanging: nothing else in the idle branch would ever stop it.
    const bail = setTimeout(() => {
      engine.running = false;
    }, 5_000);
    await engine.dealingLoop();
    clearTimeout(bail);

    // The whole point: no hand ran, no settlement ran, and the sweep still did.
    expect(swept).toBeGreaterThan(0);
    expect(engine.handController).toBeFalsy();
  }, 15000);

  it('sweeps BEFORE the active-player filter, so new chips play this hand', async () => {
    const { engine, busted } = idleEngine();
    const order: string[] = [];

    engine.processPendingAddOns = vi.fn().mockImplementation(async () => {
      order.push('sweep');
      busted.stack = 200; // the queued add-on lands
    });
    engine.dealHand = vi.fn().mockImplementation(async (activePlayers: unknown[]) => {
      order.push(`deal:${(activePlayers as Array<{ stack: number }>).length}`);
      engine.running = false;
    });
    // Two funded seats are needed to deal; give the table a second player.
    const other = { user_id: 'villain', seat_number: 2, stack: 500, is_horse: false };
    loadSeatedPlayers.mockResolvedValue([busted, other]);

    engine.running = true;
    const bail = setTimeout(() => {
      engine.running = false;
    }, 5_000);
    await engine.dealingLoop();
    clearTimeout(bail);

    expect(order[0]).toBe('sweep');
    // The rebought player is in THIS hand, not the next one.
    expect(order[1]).toBe('deal:2');
  }, 15000);
});

describe('completed idle dealing sweeps are live work', () => {
  it('keeps a short-handed engine alive across completed sweeps without dealing', async () => {
    const { engine } = idleEngine();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    engine.processPendingAddOns = vi.fn(async () => {});
    engine.executePendingSeatMoves = vi.fn(async () => {});
    engine.stopIfClusterTableClosed = vi.fn(async () => {});
    engine.allocateGlobalHandNumber = vi.fn(async () => 8_000_000);
    const ages: number[] = [];
    engine.sleep = async () => {
      ages.push(engine.msSinceProgress());
      now += 181_000;
      if (ages.length === 2) engine.running = false;
    };
    engine.running = true;
    await engine.dealingLoop();
    expect(ages).toEqual([0, 0]);
    expect(engine.executePendingSeatMoves).toHaveBeenCalledTimes(2);
    expect(engine.handController).toBeFalsy();
  });

  it('does not stamp progress while idle seat-move work is unresolved', async () => {
    const { engine } = idleEngine();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    engine.processPendingAddOns = vi.fn(async () => {});
    engine.allocateGlobalHandNumber = vi.fn(async () => 8_000_000);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.executePendingSeatMoves = vi.fn(() => pending);
    const progress = vi.spyOn(engine, 'markProgress');
    engine.running = true;
    const loop = engine.dealingLoop();
    try {
      await vi.waitFor(() => expect(engine.executePendingSeatMoves).toHaveBeenCalled());
      now += 181_000;
      expect(engine.msSinceProgress()).toBeGreaterThan(180_000);
      expect(progress).not.toHaveBeenCalled();
    } finally {
      engine.running = false;
      release();
      await loop;
    }
  });
});

describe('processPendingAddOns resolves a busted player who is not in the hand', () => {
  it('resolves the ledger row even when the user is absent from `players`', async () => {
    const engine = new ServerTableEngine(TABLE) as any;
    engine.running = true;
    engine.isCurrentEngine = () => true;
    engine.tableInfo = { id: TABLE, tournament_id: null };
    engine.getMaxBuyIn = () => 1000;
    engine.broadcastCurrentState = vi.fn();
    engine.pendingAddOnSweepNeeded = true;

    const resolved: string[] = [];
    vi.spyOn(supabase, 'from').mockReturnValue({
      select: () => ({
        eq: () => ({
          is: () =>
            Promise.resolve({
              data: [{ id: 'row-1', user_id: 'hero', amount: 200 }],
              error: null,
            }),
        }),
      }),
    } as never);
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

    // `players` deliberately does NOT contain hero - they were not dealt in.
    await engine.processPendingAddOns([{ user_id: 'villain', stack: 500 }]);

    expect(resolved).toEqual(['row-1']);
    // The ledger row is settled, so the sweep does not have to run again.
    expect(engine.pendingAddOnSweepNeeded).toBe(false);
  });

  it('is a cheap no-op when nothing is pending', async () => {
    const engine = new ServerTableEngine(TABLE) as any;
    engine.pendingAddOnSweepNeeded = false;
    engine.pendingAddOns = new Map();
    const from = vi.spyOn(supabase, 'from');
    await engine.processPendingAddOns([]);
    expect(from).not.toHaveBeenCalled();
  });
});
