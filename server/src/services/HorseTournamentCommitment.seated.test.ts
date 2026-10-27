import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[], frozen: false }));
vi.mock('./supabase.js', () => ({
  supabase: {
    from: vi.fn(() => {
      let seatFirst = false;
      const q: any = {};
      for (const method of ['select', 'in', 'order', 'limit', 'lte', 'gt']) q[method] = () => q;
      q.is = () => {
        seatFirst = true;
        return q;
      };
      q.then = (yes: any, no: any) =>
        Promise.resolve({ data: seatFirst ? [] : state.rows, error: null }).then(yes, no);
      return q;
    }),
  },
}));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => state.frozen }));
import { HorseSessionRotator } from './HorseSessionRotator.js';
const HORSE = 'horse';
const TOURNEY = 'event';
const TOURNEY_TABLE = 'event-table';
function scenario(cashCount: number, minutes = 10) {
  const now = Date.now();
  const leaveTable = vi.fn(async () => ({ success: true }));
  const getEngine = vi.fn(() => ({ leaveTable }) as any);
  const rotator = new HorseSessionRotator(getEngine);
  Object.assign(rotator, { isRunning: true, lifecycleGeneration: 1 });
  const cash = Array.from({ length: cashCount }, (_, i) => ({
    user_id: HORSE,
    table_id: `cash-${i}`,
    joined_at: new Date(now - (90 - i) * 60_000).toISOString(),
    tables: { status: 'running', tournament_id: null },
  }));
  const all = [
    ...cash,
    {
      user_id: HORSE,
      table_id: TOURNEY_TABLE,
      tables: { status: 'waiting', tournament_id: TOURNEY },
    },
  ];
  state.rows = [
    {
      id: 'registration',
      user_id: HORSE,
      tournament_id: TOURNEY,
      tournaments: {
        start_time: new Date(now + minutes * 60_000).toISOString(),
        status: 'REGISTERING',
      },
    },
  ];
  const run = () =>
    (rotator as any).leaveCashForTournaments(
      all,
      new Map(cash.map((s) => [s.table_id, [s]])),
      new Set([HORSE]),
      new Set(),
      1
    );
  return { run, leaveTable, getEngine };
}
beforeEach(() => {
  state.rows = [];
  state.frozen = false;
});
describe('a bought tournament chair retains its pre-start cash-session timing', () => {
  it('four cash seats plus an already seated imminent event leave one cash session', async () => {
    const s = scenario(4);
    expect(await s.run()).toBe(1);
    expect(s.leaveTable).toHaveBeenCalledTimes(1);
    expect(s.leaveTable).toHaveBeenCalledWith(HORSE);
    expect(s.getEngine).toHaveBeenCalledTimes(1);
    expect(s.getEngine).toHaveBeenCalledWith('cash-0');
  });
  it('does not count the bought event twice when three cash seats still fit', async () => {
    const s = scenario(3);
    expect(await s.run()).toBe(0);
    expect(s.leaveTable).not.toHaveBeenCalled();
  });
  it('does not change cash sessions for an event more than an hour away', async () => {
    const s = scenario(4, 61);
    expect(await s.run()).toBe(0);
    expect(s.leaveTable).not.toHaveBeenCalled();
  });
  it('preserves the maintenance freeze before asking the ordinary leave door', async () => {
    const s = scenario(4);
    state.frozen = true;
    expect(await s.run()).toBe(0);
    expect(s.leaveTable).not.toHaveBeenCalled();
  });
});
