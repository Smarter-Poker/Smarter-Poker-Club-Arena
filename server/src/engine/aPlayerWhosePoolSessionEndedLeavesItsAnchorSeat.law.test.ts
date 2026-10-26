/**
 * A PLAYER WHOSE LIGHTNING POOL SESSION ENDED LEAVES THEIR ANCHOR SEAT (2026-10-24).
 *
 * CLAUDE.md 10.5: a horse is a player, so this is ONE rule for every player.
 * The disconnect reaper closes a pool session and never stands the anchor
 * seat up. Measured on "FLH 0.25/0.50 Lightning Games", 2026-10-24: two
 * horses' sessions closed 'disconnect_expired' at 15:52:50 UTC while both kept
 * funded anchor seats (38.74 and 51.77), and eight hours later nothing had
 * re-entered or cashed out either one. PR #7973 stood the horses up; a PERSON
 * in the same place kept the seat and chips for as long as the Cluster stayed
 * Lightning, because the rule carried an is_horse condition. Dan (2026-10-24)
 * approved the same treatment for everyone: the person's own Leave/cash-out
 * into their club wallet, with its receipt, by the same two-looks rule.
 *
 * Pinned here:
 *   - the parked pass runs the hook after the busted-horse recovery and
 *     before the halt acknowledgement;
 *   - the player leaves through the ordinary Leave door (`leaveTable`,
 *     scoped to the occupancy), never a hand-stamped row or a forced exit;
 *   - the rule has no horse condition: a person and a horse are stood up by
 *     the same code on the same evidence;
 *   - only on a SECOND observation of the same ended occupancy, at least the
 *     confirm window later;
 *   - nothing is done when the pool cannot be read, during the freeze, for a
 *     player sitting out, already leaving, in a live hand or at zero (the bust
 *     recovery owns that seat), or for a seat whose session is still open;
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

const personId = '1a2b3c4d-0000-4000-8000-0000000000c1';

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

describe('a player whose Lightning pool session ended leaves their anchor seat', () => {
  it('the parked pass runs the hook, and the override uses the Leave door', () => {
    const base = SRC('ServerTableEngineBase.ts');
    const pass = base.slice(
      base.indexOf('protected async passWhileDealingHalted('),
      base.indexOf('protected async completeQueuedLeavesWhileHalted(')
    );
    const busted = pass.indexOf('await this.recoverBustedHorsesWhileHalted();');
    const ended = pass.indexOf('await this.standUpPlayersWhosePoolSessionEnded();');
    const ack = pass.indexOf('await this.observeDealingHalt();');
    expect(busted).toBeGreaterThan(-1);
    expect(ended).toBeGreaterThan(busted);
    expect(ack).toBeGreaterThan(ended);

    const dealing = SRC('ServerTableEngineDealing.ts');
    const override = dealing.slice(
      dealing.indexOf('protected override async standUpPlayersWhosePoolSessionEnded(')
    );
    expect(override.length).toBeGreaterThan(0);
    const body = override.slice(0, override.indexOf('\n  }\n') + 4);
    expect(body).toMatch(/await this\.leaveTable\(player\.user_id, \{/);
    // One rule for every player (10.5): no horse condition anywhere in it.
    expect(body).not.toMatch(/is_?[Hh]orse/);
    expect(override).toMatch(/lightningSeatsWhosePoolSessionEnded\(/);
    expect(override).toMatch(/isMaintenanceFrozen\(\)/);
    // A person's door: no forced exit, no hand-stamped seat row, no direct cash-out.
    expect(override).not.toMatch(/forced:\s*true/);
    expect(override).not.toMatch(/markSeatAsLeft\(|atomicCashout\(|releaseBustedSeat\(/);
  });

  it('a stranded horse leaves through leaveTable on the second observation', async () => {
    const e = parkedAnchor();
    mocks.ended.mockResolvedValue(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpPlayersWhosePoolSessionEnded();
    expect(mocks.ended).toHaveBeenCalledWith(cluster, [
      { seatId, userId: horseId, joinedAt: '2026-10-24T14:36:24.652981+00:00' },
    ]);
    expect(e.leaveTable).not.toHaveBeenCalled(); // first sight only

    clock += CHECK - 1;
    await e.standUpPlayersWhosePoolSessionEnded();
    expect(mocks.ended).toHaveBeenCalledTimes(1); // asked at most once per window

    clock += 1;
    await e.standUpPlayersWhosePoolSessionEnded();
    expect(e.leaveTable).toHaveBeenCalledTimes(1);
    expect(e.leaveTable).toHaveBeenCalledWith(horseId, {
      occupancyId: occupancy,
      seatNumber: 3,
    });
  });

  it('a stranded PERSON leaves by exactly the same rule, on exactly the same evidence', async () => {
    const e = parkedAnchor({ user_id: personId, is_horse: false, username: 'person' });
    mocks.ended.mockResolvedValue(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpPlayersWhosePoolSessionEnded();
    expect(mocks.ended).toHaveBeenCalledWith(cluster, [
      { seatId, userId: personId, joinedAt: '2026-10-24T14:36:24.652981+00:00' },
    ]);
    expect(e.leaveTable).not.toHaveBeenCalled(); // first sight only
    clock += CHECK;
    await e.standUpPlayersWhosePoolSessionEnded();
    expect(e.leaveTable).toHaveBeenCalledTimes(1);
    // Their own ordinary Leave: occupancy-scoped, never forced.
    expect(e.leaveTable).toHaveBeenCalledWith(personId, {
      occupancyId: occupancy,
      seatNumber: 3,
    });
  });

  it('a player in a live hand is not asked, and one dealt in between the looks stays', async () => {
    const e = parkedAnchor({ user_id: personId, is_horse: false });
    e.handController = { getState: () => ({ players: [{ user_id: personId }] }) };
    mocks.ended.mockResolvedValue(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpPlayersWhosePoolSessionEnded();
    expect(mocks.ended).not.toHaveBeenCalled();

    const f = parkedAnchor({ user_id: personId, is_horse: false });
    await f.standUpPlayersWhosePoolSessionEnded();
    clock += CHECK;
    let reads = 0;
    f.handController = {
      getState: () => (reads++ > 0 ? { players: [{ user_id: personId }] } : { players: [] }),
    };
    await f.standUpPlayersWhosePoolSessionEnded();
    expect(f.leaveTable).not.toHaveBeenCalled();
  });

  it('a session that re-opened between the two looks is left alone', async () => {
    const e = parkedAnchor();
    mocks.ended.mockResolvedValueOnce(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpPlayersWhosePoolSessionEnded();
    clock += CHECK;
    mocks.ended.mockResolvedValueOnce(new Map());
    await e.standUpPlayersWhosePoolSessionEnded();
    clock += CHECK;
    mocks.ended.mockResolvedValueOnce(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpPlayersWhosePoolSessionEnded();
    // The clock restarted at the third look: still only one sighting.
    expect(e.leaveTable).not.toHaveBeenCalled();
  });

  it('an unreadable pool stands nobody up', async () => {
    const e = parkedAnchor();
    mocks.ended.mockRejectedValue(new Error('lightning_pool_session read failed'));
    await e.standUpPlayersWhosePoolSessionEnded();
    clock += CHECK;
    await e.standUpPlayersWhosePoolSessionEnded();
    expect(e.leaveTable).not.toHaveBeenCalled();
  });

  it('the freeze stands nobody up', async () => {
    const e = parkedAnchor();
    mocks.frozen.mockImplementation(() => true);
    mocks.ended.mockResolvedValue(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpPlayersWhosePoolSessionEnded();
    clock += CHECK;
    await e.standUpPlayersWhosePoolSessionEnded();
    expect(mocks.ended).not.toHaveBeenCalled();
    expect(e.leaveTable).not.toHaveBeenCalled();
  });

  it.each([
    ['sitting out (a break the player took)', { is_sitting_out: true }],
    ['already leaving', { leave_pending: true }],
    ['busted (the bust recovery owns it)', { stack: 0 }],
    ['sitting out, a person', { is_sitting_out: true, is_horse: false, user_id: personId }],
    ['already leaving, a person', { leave_pending: true, is_horse: false, user_id: personId }],
  ])('a player %s is not asked', async (_label, overrides) => {
    const e = parkedAnchor(overrides);
    mocks.ended.mockResolvedValue(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpPlayersWhosePoolSessionEnded();
    clock += CHECK;
    await e.standUpPlayersWhosePoolSessionEnded();
    expect(mocks.ended).not.toHaveBeenCalled();
    expect(e.leaveTable).not.toHaveBeenCalled();
  });

  it('a stay clock that refuses keeps the player seated and it asks again', async () => {
    const e = parkedAnchor();
    e.leaveTable = vi.fn(async () => ({
      success: false,
      immediate: false,
      code: 'LEAVE_LOCKED',
      stay_remaining_ms: 60_000,
    }));
    mocks.ended.mockResolvedValue(new Map([[seatId, 'disconnect_expired']]));
    await e.standUpPlayersWhosePoolSessionEnded();
    clock += CHECK;
    await e.standUpPlayersWhosePoolSessionEnded();
    clock += CHECK;
    await e.standUpPlayersWhosePoolSessionEnded();
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
