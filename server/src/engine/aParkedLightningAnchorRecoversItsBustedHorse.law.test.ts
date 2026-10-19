/**
 * A PARKED LIGHTNING ANCHOR STILL RECOVERS ITS BUSTED HORSE (2026-10-19).
 *
 * CLAUDE.md 10.5: a horse is a player, and the engine is its input device. A
 * Cluster's halt parks every anchor table for as long as the Cluster is
 * Lightning, and the parked pass never ran the horse bust recovery every
 * ordinary cash table runs. Measured on the private Action pilot: 33 of 37
 * open pool sessions were horses sitting on a zero anchor stack, none
 * rebought, none released, the oldest stuck for hours, leaving 4 playable.
 *
 * Pinned here:
 *   - the parked pass runs the hook, between the leave sweep and the halt
 *     acknowledgement, and the dealing override runs the SHARED recovery
 *     (same stop-loss, amount, treasury door and exit door);
 *   - a parked anchor keys each bust by the Lightning hand that busted it,
 *     never by its own frozen handCount, so a second bust is a second funding
 *     operation and not a replay of the first one's receipt;
 *   - an unreadable bust identity funds nothing and releases nothing;
 *   - no Lightning bust in the open session falls back to the table's own key;
 *   - stop-loss still releases through the one busted-seat door.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  funding: vi.fn(),
  identity: vi.fn(),
  stopLoss: vi.fn(() => false),
}));
vi.mock('../services/supabase.js', async (original) => ({
  ...(await original<typeof import('../services/supabase.js')>()),
  autoRebuyHorse: (...args: unknown[]) => mocks.funding(...args),
}));
vi.mock('../services/HorseRebuyPolicy.js', () => ({
  horseRebuyAmount: vi.fn(async () => 5),
  atRebuyStopLoss: (...args: unknown[]) => mocks.stopLoss(...(args as [])),
  rebuyStopLossReached: vi.fn(() => false),
}));
vi.mock('../lightning/LightningBustIdentity.js', () => ({
  lightningBustIdentity: (...args: unknown[]) => mocks.identity(...args),
}));

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { deadlineScheduler } = await import('./DeadlineScheduler.js');

const table = '70000000-0000-4000-8000-0000000000a1';
const cluster = '56d5d6f0-23e9-41b0-b407-852aa1026c2a';
const horseId = '70000000-0000-4000-8000-0000000000a2';
const SRC = (f: string) => readFileSync(join(process.cwd(), 'src', 'engine', f), 'utf8');

afterEach(() => {
  deadlineScheduler.cancelAll(table);
  vi.clearAllMocks();
  mocks.stopLoss.mockImplementation(() => false);
});

function parkedAnchor() {
  const e = new ServerTableEngine(table) as any;
  e.tableInfo = { club_id: 'club', big_blind: 0.04, cluster_id: cluster };
  e.handCount = 12; // a parked anchor deals nothing: this never moves
  e.seatedPlayers = [
    {
      user_id: horseId,
      occupancy_id: 'occ-1',
      username: 'horse',
      stack: 0,
      seat_number: 3,
      is_horse: true,
    },
  ];
  e.isTournamentTable = () => false;
  e.releaseBustedSeat = vi.fn(async () => true);
  e.wakeClusterGame = vi.fn();
  return e;
}

describe('a parked Lightning anchor recovers its busted horse', () => {
  it('the parked pass runs the hook, and the override runs the shared recovery', () => {
    const base = SRC('ServerTableEngineBase.ts');
    const pass = base.slice(
      base.indexOf('protected async passWhileDealingHalted('),
      base.indexOf('protected async completeQueuedLeavesWhileHalted(')
    );
    const leaves = pass.indexOf('await this.completeQueuedLeavesWhileHalted();');
    const horses = pass.indexOf('await this.recoverBustedHorsesWhileHalted();');
    const ack = pass.indexOf('await this.observeDealingHalt();');
    expect(leaves).toBeGreaterThan(-1);
    expect(horses).toBeGreaterThan(leaves);
    expect(ack).toBeGreaterThan(horses);

    const dealing = SRC('ServerTableEngineDealing.ts');
    const override = dealing.slice(
      dealing.indexOf('protected override async recoverBustedHorsesWhileHalted('),
      dealing.indexOf('protected async recoverBustedSeatedHorses(')
    );
    expect(override).toMatch(/this\.recoverBustedSeatedHorses\(\{/);
    expect(override).toMatch(/lightningBustIdentity\(clusterId, horse\.user_id\)/);
    expect(override).toMatch(/withStepBudget\(/);
    // The input device decides; it never decides by who is a horse here.
    expect(override).not.toMatch(/is_horse/);
  });

  it('keys the rebuy by the Lightning bust hand, never the frozen handCount', async () => {
    const e = parkedAnchor();
    mocks.identity.mockResolvedValue({ status: 'lightning', handNumber: 38875017 });
    mocks.funding.mockResolvedValue({ status: 'funded', stack: 5 });
    await e.recoverBustedHorsesWhileHalted();
    expect(mocks.identity).toHaveBeenCalledWith(cluster, horseId);
    expect(mocks.funding).toHaveBeenCalledWith(table, horseId, 5, 'club', 38875017);
    expect(e.seatedPlayers[0].stack).toBe(5);
    expect(e.horseRebuys.get(horseId)).toBe(1);
    expect(e.releaseBustedSeat).not.toHaveBeenCalled();
    expect(e.wakeClusterGame).toHaveBeenCalledWith('horse_bust_recovered');
  });

  it('a second bust on the same parked anchor is a second funding operation', async () => {
    const e = parkedAnchor();
    mocks.funding.mockResolvedValue({ status: 'funded', stack: 5 });
    mocks.identity.mockResolvedValueOnce({ status: 'lightning', handNumber: 38875017 });
    await e.recoverBustedHorsesWhileHalted();
    e.seatedPlayers[0].stack = 0; // busted again in a later Lightning hand
    e.bustRecoveryLastAttempt.clear(); // past the 30s throttle
    mocks.identity.mockResolvedValueOnce({ status: 'lightning', handNumber: 38890211 });
    await e.recoverBustedHorsesWhileHalted();
    const keys = mocks.funding.mock.calls.map((c) => c[4]);
    expect(keys).toEqual([38875017, 38890211]);
    expect(e.handCount).toBe(12);
    expect(e.horseRebuys.get(horseId)).toBe(2);
  });

  it('an unreadable bust identity funds nothing and releases nothing', async () => {
    const e = parkedAnchor();
    mocks.identity.mockResolvedValue({ status: 'unknown' });
    await e.recoverBustedHorsesWhileHalted();
    expect(mocks.funding).not.toHaveBeenCalled();
    expect(e.releaseBustedSeat).not.toHaveBeenCalled();
    expect(e.seatedPlayers[0].stack).toBe(0);
    expect(e.wakeClusterGame).not.toHaveBeenCalled();
  });

  it('no Lightning bust in the open session falls back to the table key', async () => {
    const e = parkedAnchor();
    mocks.identity.mockResolvedValue({ status: 'none' });
    mocks.funding.mockResolvedValue({ status: 'funded', stack: 5 });
    await e.recoverBustedHorsesWhileHalted();
    expect(mocks.funding).toHaveBeenCalledWith(table, horseId, 5, 'club', 12);
  });

  it('at stop-loss the horse leaves through the one busted-seat door', async () => {
    const e = parkedAnchor();
    mocks.stopLoss.mockImplementation(() => true);
    await e.recoverBustedHorsesWhileHalted();
    expect(mocks.funding).not.toHaveBeenCalled();
    expect(e.releaseBustedSeat).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: horseId }),
      'busted_stop_loss'
    );
    expect(e.wakeClusterGame).toHaveBeenCalledWith('horse_bust_recovered');
  });

  it('a treasury that cannot pay stands the horse up, like every cash table', async () => {
    const e = parkedAnchor();
    mocks.identity.mockResolvedValue({ status: 'lightning', handNumber: 38875017 });
    mocks.funding.mockResolvedValue({ status: 'declined' });
    await e.recoverBustedHorsesWhileHalted();
    expect(e.releaseBustedSeat).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: horseId }),
      'busted_unfunded'
    );
  });

  it('an ordinary dealing table keeps its own hand key', async () => {
    const e = parkedAnchor();
    mocks.funding.mockResolvedValue({ status: 'funded', stack: 5 });
    await e.recoverBustedSeatedHorses();
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.funding).toHaveBeenCalledWith(table, horseId, 5, 'club', 12);
  });
});
