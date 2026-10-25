/**
 * A HORSE WHOSE LIGHTNING POOL SESSION ENDED LEAVES ITS ANCHOR SEAT (2026-10-24).
 *
 * CLAUDE.md 10.5: a horse is a player and the engine is its input device.
 * The disconnect reaper closes a pool session and never stands the anchor
 * seat up, so a returning person can find their chair (VIEW GAME) and decide.
 * A horse never comes back with a browser. Measured on "FLH 0.25/0.50
 * Lightning Games", 2026-10-24: two horses' sessions closed
 * 'disconnect_expired' at 15:52:50 UTC while both kept funded anchor seats
 * (38.74 and 51.77), and eight hours later nothing had re-entered or cashed
 * out either one.
 *
 * Pinned here:
 *   - the parked pass runs the hook after the busted-horse recovery and
 *     before the halt acknowledgement;
 *   - the horse leaves through the person's own Leave door (`leaveTable`,
 *     scoped to its occupancy), never a hand-stamped row or a forced exit;
 *   - only on a SECOND observation of the same ended occupancy, at least the
 *     confirm window later;
 *   - nothing is done when the pool cannot be read, during the freeze, for a
 *     horse sitting out, already leaving or at zero (the bust recovery owns
 *     that seat), or for a seat whose session is still open;
 *   - the read answers only sessions THIS occupancy entered from THIS seat,
 *     only for a Cluster that is Lightning now, and never a player who plays
 *     on from another seat.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ended: vi.fn(),
  frozen: vi.fn(() => false),
}));
vi.mock('../services/supabase/lightningAnchor.js', async (original) => ({
  ...(await original<typeof import('../services/supabase/lightningAnchor.js')>()),
  lightningSeatsWhosePoolSessionEnded: (...args: unknown[]) => mocks.ended(...args),
}));
vi.mock('../maintenance/freezeState.js', async (original) => ({
  ...(await original<typeof import('../maintenance/freezeState.js')>()),
  isMaintenanceFrozen: () => mocks.frozen(),
}));

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { ServerTableEngineDealing } = await import('./ServerTableEngineDealing.js');
const { deadlineScheduler } = await import('./DeadlineScheduler.js');

const table = '70000000-0000-4000-8000-0000000000b1';
const cluster = '5be919f7-d306-4349-a514-22b88b18f98e';
const horseId = '0f14f372-0c43-47ff-9257-1324a7e94488';
const seatId = 'd0b4cbf1-94b1-47a9-b04b-c8ef7d2cec5a';
const occupancy = '70000000-0000-4000-8000-0000000000b3';
const SRC = (f: string) => readFileSync(join(process.cwd(), 'src', 'engine', f), 'utf8');
const CHECK = ServerTableEngineDealing.POOL_ENDED_CHECK_MS;

let clock = 1_800_000_000_000;
beforeEach(() => {
  clock = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  deadlineScheduler.cancelAll(table);
  vi.restoreAllMocks();
  mocks.ended.mockReset();
  mocks.frozen.mockImplementation(() => false);
});

function parkedAnchor(overrides: Record<string, unknown> = {}) {
  const e = new ServerTableEngine(table) as any;
  e.tableInfo = { club_id: 'club', big_blind: 0.5, cluster_id: cluster };
  e.seatedPlayers = [
    {
      user_id: horseId,
      seat_id: seatId,
      seat_joined_at: '2026-10-24T14:36:24.652981+00:00',
      occupancy_id: occupancy,
      username: 'horse',
      stack: 38.74,
      seat_number: 3,
      is_horse: true,
      ...overrides,
    },
  ];
  e.isTournamentTable = () => false;
  e.lifecycleCanMutate = () => true;
  e.leaveTable = vi.fn(async () => ({ success: true, immediate: true }));
  return e;
}

describe('a horse whose Lightning pool session ended leaves its anchor seat', () => {
  it('the parked pass runs the hook, and the override uses the Leave door', () => {
    const base = SRC('ServerTableEngineBase.ts');
    const pass = base.slice(
      base.indexOf('protected async passWhileDealingHalted('),
      base.indexOf('protected async completeQueuedLeavesWhileHalted(')
    );
    const busted = pass.indexOf('await this.recoverBustedHorsesWhileHalted();');
    const ended = pass.indexOf('await this.standUpHorsesWhosePoolSessionEnded();');
    const ack = pass.indexOf('await this.observeDealingHalt();');
    expect(busted).toBeGreaterThan(-1);
    expect(ended).toBeGreaterThan(busted);
    expect(ack).toBeGreaterThan(ended);

    const dealing = SRC('ServerTableEngineDealing.ts');
    const override = dealing.slice(
      dealing.indexOf('protected override async standUpHorsesWhosePoolSessionEnded(')
    );
    expect(override.length).toBeGreaterThan(0);
    expect(override).toMatch(/await this\.leaveTable\(horse\.user_id, \{/);
    expect(override).toMatch(/lightningSeatsWhosePoolSessionEnded\(/);
    expect(override).toMatch(/isMaintenanceFrozen\(\)/);
    // A person's door: no forced exit, no hand-stamped seat row, no direct cash-out.
    expect(override).not.toMatch(/forced:\s*true/);
    expect(override).not.toMatch(/markSeatAsLeft\(|atomicCashout\(|releaseBustedSeat\(/);
  });

  it('the stranded horse leaves through leaveTable on the second observation', async () => {
    const e = parkedAnchor();
    mocks.ended.mockResolvedValue(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpHorsesWhosePoolSessionEnded();
    expect(mocks.ended).toHaveBeenCalledWith(cluster, [
      { seatId, userId: horseId, joinedAt: '2026-10-24T14:36:24.652981+00:00' },
    ]);
    expect(e.leaveTable).not.toHaveBeenCalled(); // first sight only

    clock += CHECK - 1;
    await e.standUpHorsesWhosePoolSessionEnded();
    expect(mocks.ended).toHaveBeenCalledTimes(1); // asked at most once per window

    clock += 1;
    await e.standUpHorsesWhosePoolSessionEnded();
    expect(e.leaveTable).toHaveBeenCalledTimes(1);
    expect(e.leaveTable).toHaveBeenCalledWith(horseId, {
      occupancyId: occupancy,
      seatNumber: 3,
    });
  });

  it('a session that re-opened between the two looks is left alone', async () => {
    const e = parkedAnchor();
    mocks.ended.mockResolvedValueOnce(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpHorsesWhosePoolSessionEnded();
    clock += CHECK;
    mocks.ended.mockResolvedValueOnce(new Map());
    await e.standUpHorsesWhosePoolSessionEnded();
    clock += CHECK;
    mocks.ended.mockResolvedValueOnce(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpHorsesWhosePoolSessionEnded();
    // The clock restarted at the third look: still only one sighting.
    expect(e.leaveTable).not.toHaveBeenCalled();
  });

  it('an unreadable pool stands nobody up', async () => {
    const e = parkedAnchor();
    mocks.ended.mockRejectedValue(new Error('lightning_pool_session read failed'));
    await e.standUpHorsesWhosePoolSessionEnded();
    clock += CHECK;
    await e.standUpHorsesWhosePoolSessionEnded();
    expect(e.leaveTable).not.toHaveBeenCalled();
  });

  it('the freeze stands nobody up', async () => {
    const e = parkedAnchor();
    mocks.frozen.mockImplementation(() => true);
    mocks.ended.mockResolvedValue(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpHorsesWhosePoolSessionEnded();
    clock += CHECK;
    await e.standUpHorsesWhosePoolSessionEnded();
    expect(mocks.ended).not.toHaveBeenCalled();
    expect(e.leaveTable).not.toHaveBeenCalled();
  });

  it.each([
    ['sitting out (a break the horse took)', { is_sitting_out: true }],
    ['already leaving', { leave_pending: true }],
    ['busted (the bust recovery owns it)', { stack: 0 }],
  ])('a horse %s is not asked', async (_label, overrides) => {
    const e = parkedAnchor(overrides);
    mocks.ended.mockResolvedValue(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpHorsesWhosePoolSessionEnded();
    clock += CHECK;
    await e.standUpHorsesWhosePoolSessionEnded();
    expect(mocks.ended).not.toHaveBeenCalled();
    expect(e.leaveTable).not.toHaveBeenCalled();
  });

  it('a stay clock that refuses keeps the horse seated and it asks again', async () => {
    const e = parkedAnchor();
    e.leaveTable = vi.fn(async () => ({
      success: false,
      immediate: false,
      code: 'LEAVE_LOCKED',
      stay_remaining_ms: 60_000,
    }));
    mocks.ended.mockResolvedValue(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpHorsesWhosePoolSessionEnded();
    clock += CHECK;
    await e.standUpHorsesWhosePoolSessionEnded();
    clock += CHECK;
    await e.standUpHorsesWhosePoolSessionEnded();
    expect(e.leaveTable).toHaveBeenCalledTimes(2);
  });
});

describe('the read: which seats lost their pool session', () => {
  async function readWith(rows: {
    game: Record<string, unknown> | null;
    open: Array<Record<string, unknown>>;
    closed: Array<Record<string, unknown>>;
    fail?: 'open' | 'closed';
  }) {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock('../services/supabase/client.js', () => ({
      supabase: {
        from: (name: string) => {
          const filters: Array<[string, unknown]> = [];
          const chain: any = {
            select: () => chain,
            eq: (k: string, v: unknown) => (filters.push([k, v]), chain),
            in: (k: string, v: unknown) => (filters.push([k, v]), chain),
            is: (k: string, v: unknown) => (filters.push(['is:' + k, v]), chain),
            not: (k: string) => (filters.push(['not:' + k, null]), chain),
            maybeSingle: async () => ({ data: rows.game, error: null }),
            then: (resolve: (v: unknown) => unknown) => {
              const closedRead = filters.some(([k]) => k === 'not:exited_at');
              calls.push(closedRead ? 'closed' : 'open');
              const failing = rows.fail === (closedRead ? 'closed' : 'open');
              return Promise.resolve(
                failing
                  ? { data: null, error: { message: 'boom' } }
                  : { data: closedRead ? rows.closed : rows.open, error: null }
              ).then(resolve);
            },
          };
          calls.push(name);
          return chain;
        },
      },
    }));
    const mod = await vi.importActual<typeof import('../services/supabase/lightningAnchor.js')>(
      '../services/supabase/lightningAnchor.js'
    );
    return { read: mod.lightningSeatsWhosePoolSessionEnded, calls };
  }
  const occ = { seatId, userId: horseId, joinedAt: '2026-10-24T14:36:24.652981+00:00' };
  const lightning = { cluster_mode: 'lightning', lightning_enabled: true };
  const closedHere = {
    player_id: horseId,
    anchor_seat_id: seatId,
    entered_at: '2026-10-24T14:36:24.824804+00:00',
    exit_reason: 'disconnect_expired',
  };

  afterEach(() => {
    vi.doUnmock('../services/supabase/client.js');
    vi.resetModules();
  });

  it('answers the stranded seat with its exit reason', async () => {
    const { read } = await readWith({ game: lightning, open: [], closed: [closedHere] });
    expect(await read(cluster, [occ])).toEqual(new Map([[seatId, 'disconnect_expired']]));
  });

  it('a player with an open session anywhere in the Cluster is not stranded', async () => {
    const { read } = await readWith({
      game: lightning,
      open: [{ player_id: horseId }],
      closed: [closedHere],
    });
    expect((await read(cluster, [occ])).size).toBe(0);
  });

  it('a session a previous occupancy entered from the same seat row does not count', async () => {
    const { read } = await readWith({
      game: lightning,
      open: [],
      closed: [{ ...closedHere, entered_at: '2026-10-24T11:00:00+00:00' }],
    });
    expect((await read(cluster, [occ])).size).toBe(0);
  });

  it.each([
    ['must_move', { cluster_mode: 'must_move', lightning_enabled: true }],
    ['frozen', { cluster_mode: 'frozen', lightning_enabled: true }],
    ['lightning switched off', { cluster_mode: 'lightning', lightning_enabled: false }],
  ])('a Cluster that is %s answers nothing', async (_label, game) => {
    const { read, calls } = await readWith({ game, open: [], closed: [closedHere] });
    expect((await read(cluster, [occ])).size).toBe(0);
    expect(calls).toEqual(['cash_games']);
  });

  it('a failed pool read throws rather than answering empty', async () => {
    const a = await readWith({ game: lightning, open: [], closed: [closedHere], fail: 'open' });
    await expect(a.read(cluster, [occ])).rejects.toThrow(/lightning_pool_session read failed/);
    const b = await readWith({ game: lightning, open: [], closed: [closedHere], fail: 'closed' });
    await expect(b.read(cluster, [occ])).rejects.toThrow(/lightning_pool_session read failed/);
  });
});
