/**
 * A PLAYER'S OWN SIT OUT IS NOT UNDONE BY A HORSE CONTROLLER (2026-10-22).
 *
 * Found live by Lightning pilot witness run 39771149895 (engine bae91fc9,
 * mode financial_top_up_sitout). Pilot horse account 009 pressed Sit Out in
 * its own authenticated client at the Lightning anchor table:
 *
 *   11:32:00.441Z  [ServerTableEngine:94734f85] Disconnect: PLAYER_SAT_OUT player=0097309f
 *   11:33:11.440Z  [ServerTableEngine:94734f85] Disconnect: PLAYER_SAT_BACK player=0097309f
 *   11:33:11.440Z  [SessionRotator] sat 2 horse(s) back in from a sit-out no break
 *                  on record explains (a restart forgot it)
 *   11:33:12.274Z  next Lightning hand formed with 009 on pool slot fb40505e
 *
 * HorseSessionRotator saw a sitting-out horse with no break in its memory,
 * took it for a break a restart had forgotten, and sat it back in. The
 * matcher then (correctly, for a seat that is no longer sitting out) dealt it
 * a new Lightning hand roughly every forty seconds, and the witness timed out
 * waiting for the pool to go quiet. The matcher itself refuses a sitting-out
 * anchor (fn_lightning_anchor_is_live_eligible); the pause was simply gone.
 *
 * These drive the real engine sitOut, the real DisconnectEngine, and the real
 * rotator pass over a fake PostgREST floor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from './supabase.js';
import { HorseSessionRotator, type RotatorEngine } from './HorseSessionRotator.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { DisconnectEngine } from '../engine/DisconnectEngine.js';
import { PreciseActionTimer } from '../engine/PreciseActionTimer.js';
import { DeadlineScheduler } from '../engine/DeadlineScheduler.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { JAQK_CLUB_ID } from './StableHand.js';

const NOW = Date.parse('2026-10-22T11:33:11Z');
const CLUSTER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ANCHOR = '94734f85-ca61-48c1-9c76-89eb91bb2c5a';
const OTHER = '10000000-0000-4000-8000-00000000000b';
const HORSES = Array.from(
  { length: 12 },
  (_, i) => `h0000000-0000-4000-8000-${String(i).padStart(12, '0')}`
);
const PILOT = HORSES[0];

function disconnectEngine(): DisconnectEngine {
  let now = NOW;
  const sched = new DeadlineScheduler({
    tickMs: 100,
    now: () => now,
    setInterval: () => 1 as any,
    clearInterval: () => {},
  });
  return new DisconnectEngine(new PreciseActionTimer(undefined, sched, () => now));
}

/** The anchor table's engine: the real sitOut over a real DisconnectEngine. */
function anchorEngine() {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  Object.assign(engine, {
    tableId: ANCHOR,
    tableInfo: { cluster_id: CLUSTER, game_type: 'cash' },
    seatedPlayers: HORSES.slice(0, 6).map((user_id) => ({ user_id, occupancy_id: `o-${user_id}` })),
    dealtInUserIds: new Set(HORSES.slice(0, 6)),
    dealingHaltLock: true,
    handController: null,
    returnedFromSitOutAtMs: new Map(),
    pendingSitOut: new Set(),
    leaveHeldByClock: new Map(),
    returningFromSitout: new Set(),
    disconnectEngine: disconnectEngine(),
    chipContinuity: { evaluate: vi.fn(async () => []) },
    broadcastCurrentState: vi.fn(),
    isContinuityActive: vi.fn(() => false),
  });
  return engine;
}

/* A fake PostgREST: enough of the builder for one rotator pass. */
type Rows = Record<string, any>[];
function fakeDb(tables: Record<string, Rows>) {
  const build = (name: string) => {
    let rows = [...(tables[name] ?? [])];
    let from = 0;
    let to = Infinity;
    let lim = Infinity;
    const b: any = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b);
    b.in = (c: string, v: unknown[]) => ((rows = rows.filter((r) => v.includes(r[c]))), b);
    b.is = (c: string, v: unknown) => ((rows = rows.filter((r) => (r[c] ?? null) === v)), b);
    b.gt = (c: string, v: any) => ((rows = rows.filter((r) => String(r[c]) > String(v))), b);
    b.lte = () => b;
    b.not = () => b;
    b.order = () => b;
    b.limit = (n: number) => ((lim = n), b);
    b.range = (a: number, z: number) => ((from = a), (to = z), b);
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
      Promise.resolve({
        data: rows.slice(from, Math.min(rows.length, to + 1)).slice(0, lim),
        error: null,
      }).then(ok, bad);
    return b;
  };
  vi.spyOn(supabase, 'from').mockImplementation(((name: string) => build(name)) as never);
  vi.spyOn(supabase, 'rpc').mockImplementation((() =>
    Promise.resolve({ data: null, error: { message: 'no rpc in fixture' } })) as never);
}

const tableRow = (id: string) => ({
  id,
  big_blind: 0.02,
  tournament_id: null,
  status: 'running',
  settings: {},
  cluster_id: CLUSTER,
  role: 'main',
  main_index: 1,
  lifecycle: 'live',
  created_at: new Date(NOW - 3600_000).toISOString(),
  max_players: 6,
  min_buy_in: 1,
  max_buy_in: 4,
});

/** The floor as the database shows it: `sittingOut` seats read is_sitting_out. */
function floor(sittingOut: Set<string>) {
  const tables = [tableRow(ANCHOR), tableRow(OTHER)];
  const seats: Rows = [];
  tables.forEach((t, ti) => {
    for (let s = 0; s < 6; s++) {
      const user_id = HORSES[ti * 6 + s];
      seats.push({
        id: `s-${ti}-${s}`,
        table_id: t.id,
        user_id,
        seat_number: s + 1,
        stack: 2,
        joined_at: new Date(NOW - (60 + s) * 60_000).toISOString(),
        club_id: JAQK_CLUB_ID,
        leave_pending: false,
        is_sitting_out: sittingOut.has(user_id),
        left_at: null,
        tables: t,
      });
    }
  });
  return {
    table_seats: seats,
    profiles: HORSES.map((id) => ({ id, is_horse: true })),
    club_members: [],
    chip_ledger: [],
    table_waitlist: [],
    cash_game_waitlist: [],
    cash_games: [],
    cash_seat_moves: [],
    hand_history: [],
    tournament_players: [],
    tables: tables.map((t) => ({ ...t, is_deleted: false })),
  };
}

/** What GameServer.getTableEngine hands the rotator for each table. */
function engines(anchor: any) {
  const asRotator = (e: any): RotatorEngine => ({
    leaveTable: () => ({ success: false }),
    sitOut: (u, b) => e.sitOut(u, b),
    isClientSitOut: (u) => e.isClientSitOut(u),
  });
  const other: RotatorEngine = { leaveTable: () => ({ success: false }), sitOut: vi.fn() };
  return (tableId: string) => (tableId === ANCHOR ? asRotator(anchor) : other);
}

async function rotateOnce(rot: any) {
  rot.isRunning = true;
  rot.lifecycleGeneration = 1;
  await rot.rotate(1);
}

describe("the rotator never sits back in a Sit Out the account's own client asked for", () => {
  beforeEach(() => {
    setMaintenanceFrozen(false);
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    for (const m of ['log', 'warn', 'error'] as const)
      vi.spyOn(console, m).mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0.999999); // no discretionary departures or breaks
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('the observed sequence: client Sit Out mid-hand, applied at the hand end, then a rotator pass', async () => {
    const anchor = anchorEngine();
    // 11:31:59 a Lightning hand is running on the halted anchor; Sit Out is deferred.
    anchor.handController = {};
    expect(anchor.sitOut(PILOT, true, { requestedByClient: true }).success).toBe(true);
    expect(anchor.pendingSitOut.has(PILOT)).toBe(true);
    expect(anchor.isClientSitOut(PILOT)).toBe(true);
    // 11:32:00 the hand ends and the deferred sit-out lands, as settlement 5.9 does.
    anchor.handController = null;
    for (const u of anchor.pendingSitOut) anchor.disconnectEngine.sitOut(ANCHOR, u, 'voluntary');
    anchor.pendingSitOut.clear();
    expect(anchor.disconnectEngine.isSittingOut(ANCHOR, PILOT)).toBe(true);

    // 11:33:11 the rotator reads the persisted pause and has no break on record.
    fakeDb(floor(new Set([PILOT])));
    const rot = new HorseSessionRotator(engines(anchor)) as any;
    await rotateOnce(rot);

    expect(anchor.disconnectEngine.isSittingOut(ANCHOR, PILOT)).toBe(true);
    expect(anchor.returningFromSitout.has(PILOT)).toBe(false);
    // Not marked handled: once the client says I'm Back it is an ordinary seat.
    expect(rot.sitBackRestoredKeys.size).toBe(0);
  });

  it("only the client's own I'm Back ends it, and after that ordinary rules apply again", async () => {
    const anchor = anchorEngine();
    anchor.sitOut(PILOT, true, { requestedByClient: true });
    expect(anchor.sitOut(PILOT, false, { requestedByClient: true }).success).toBe(true);
    expect(anchor.isClientSitOut(PILOT)).toBe(false);
    expect(anchor.disconnectEngine.isSittingOut(ANCHOR, PILOT)).toBe(false);

    // Later the strike ladder sits the horse out (no client): a sit-out no
    // break explains is sat back in, once, exactly as before.
    anchor.disconnectEngine.sitOut(ANCHOR, PILOT, 'forced');
    fakeDb(floor(new Set([PILOT])));
    const rot = new HorseSessionRotator(engines(anchor)) as any;
    await rotateOnce(rot);
    expect(anchor.disconnectEngine.isSittingOut(ANCHOR, PILOT)).toBe(false);
  });

  it('ordinary horse behaviour is unchanged: a forgotten break is still sat back in', async () => {
    const anchor = anchorEngine();
    // A break the rotator itself started (no client) before a restart forgot it.
    anchor.sitOut(PILOT, true);
    expect(anchor.isClientSitOut(PILOT)).toBe(false);
    fakeDb(floor(new Set([PILOT])));
    const rot = new HorseSessionRotator(engines(anchor)) as any;
    await rotateOnce(rot);
    expect(anchor.disconnectEngine.isSittingOut(ANCHOR, PILOT)).toBe(false);
  });

  it("a break that ends while the client has sat out leaves the client's pause standing", async () => {
    const anchor = anchorEngine();
    fakeDb(floor(new Set([PILOT])));
    const rot = new HorseSessionRotator(engines(anchor)) as any;
    // The rotator's own break began first ...
    anchor.sitOut(PILOT, true);
    rot.breaks.set(`${ANCHOR}:${PILOT}`, { tableId: ANCHOR, userId: PILOT, sitBackAt: NOW - 1 });
    // ... then the account's client pressed Sit Out.
    anchor.sitOut(PILOT, true, { requestedByClient: true });
    await rotateOnce(rot);
    expect(rot.breaks.size).toBe(0);
    expect(anchor.disconnectEngine.isSittingOut(ANCHOR, PILOT)).toBe(true);
  });

  it("an engine whose answer throws is treated as the player's pause standing", async () => {
    const sitOut = vi.fn(() => ({ success: true }));
    const engine: RotatorEngine = {
      leaveTable: () => ({ success: false }),
      sitOut,
      isClientSitOut: () => {
        throw new Error('unknown');
      },
    };
    fakeDb(floor(new Set([PILOT])));
    await rotateOnce(new HorseSessionRotator(() => engine) as any);
    expect(sitOut).not.toHaveBeenCalledWith(PILOT, false);
  });
});

describe("the client's pause survives a restart as the client's", () => {
  it('the presence park carries it and the restore puts it back', () => {
    const before = disconnectEngine();
    before.registerPlayer(ANCHOR, PILOT);
    before.markClientSitOut(ANCHOR, PILOT);
    before.sitOut(ANCHOR, PILOT, 'voluntary');
    const parked = JSON.parse(JSON.stringify(before.getFsmStatesForTable(ANCHOR)));
    expect(parked[PILOT]).toMatchObject({ state: 'SAT_OUT', sitOutByClient: true });

    const after = disconnectEngine();
    expect(after.restoreFsmStates(ANCHOR, parked)).toBe(1);
    expect(after.isSittingOut(ANCHOR, PILOT)).toBe(true);
    expect(after.isClientSitOut(ANCHOR, PILOT)).toBe(true);

    after.sitBack(ANCHOR, PILOT);
    expect(after.isClientSitOut(ANCHOR, PILOT)).toBe(false);
  });

  it('an older park without the field restores as before: not a client pause', () => {
    const after = disconnectEngine();
    after.restoreFsmStates(ANCHOR, {
      [PILOT]: { state: 'SAT_OUT', sinceMs: NOW, graceDeadlineMs: null },
    });
    expect(after.isSittingOut(ANCHOR, PILOT)).toBe(true);
    expect(after.isClientSitOut(ANCHOR, PILOT)).toBe(false);
  });
});
