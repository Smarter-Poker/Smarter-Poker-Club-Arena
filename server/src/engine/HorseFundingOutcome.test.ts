import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ funding: vi.fn(), leave: vi.fn() }));
vi.mock('../services/supabase.js', async (original) => ({
  ...(await original<typeof import('../services/supabase.js')>()),
  autoRebuyHorse: (...args: unknown[]) => mocks.funding(...args),
  markSeatAsLeft: (...args: unknown[]) => mocks.leave(...args),
}));
vi.mock('../services/HorseRebuyPolicy.js', () => ({
  horseRebuyAmount: vi.fn(async () => 5),
  atRebuyStopLoss: vi.fn(() => false),
}));
const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { deadlineScheduler } = await import('./DeadlineScheduler.js');
const table = '70000000-0000-4000-8000-000000000002';
const user = '70000000-0000-4000-8000-000000000003';
afterEach(() => {
  deadlineScheduler.cancelAll(table);
  vi.clearAllMocks();
});
describe('idle rebuy consumes the funding verdict without destroying an uncertain seat', () => {
  function engine() {
    const e = new ServerTableEngine(table) as any;
    e.tableInfo = { club_id: 'club', big_blind: 1 };
    e.handCount = 91;
    e.seatedPlayers = [
      { user_id: user, username: 'player', stack: 0, seat_number: 1, is_horse: true },
    ];
    return e;
  }
  it('keeps the seat and registrations on an unknown payment outcome', async () => {
    const e = engine();
    const unregister = vi.spyOn(e.disconnectEngine, 'unregisterPlayer');
    mocks.funding.mockResolvedValue({ status: 'unknown' });
    await e.recoverBustedSeatedHorses();
    expect(mocks.leave).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(e.seatedPlayers[0].stack).toBe(0);
    expect(e.horseRebuys.has(user)).toBe(false);
  });
  it('uses the confirmed database stack and shares the hand operation identity', async () => {
    const e = engine();
    mocks.funding.mockResolvedValue({ status: 'funded', stack: 7 });
    await e.recoverBustedSeatedHorses();
    expect(mocks.funding).toHaveBeenCalledWith(table, user, 5, 'club', 91);
    expect(e.seatedPlayers[0].stack).toBe(7);
    expect(e.horseRebuys.get(user)).toBe(1);
    expect(mocks.leave).not.toHaveBeenCalled();
  });
});
