/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE LEAVE DOOR, DRIVEN (chip continuity, Gate 1 deep audit, 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The law test pins the wiring by source. This file DRIVES `leaveTable` on a
 * real ServerTableEngine with the database behind a mock, because two of the
 * audit's findings were about what the engine ANSWERS, not what it contains:
 *
 *   - the between-hands answer used to be `success: true` before the database
 *     had ruled, so a refusal at the door reached a client that had already
 *     navigated away from a seat still holding its chips;
 *   - horses are players (CLAUDE.md 10.5): a horse asking to leave while ahead
 *     must be refused with the same label, by the same code, as a human.
 *
 * Every spec here has a human and a horse twin where the rule applies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cashout = vi.fn();
const cashoutVoluntary = vi.fn();
const evaluate = vi.fn(async () => []);

vi.mock('../services/supabase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/supabase.js')>();
  return {
    ...actual,
    atomicCashout: (...args: unknown[]) => cashout(...args),
    atomicCashoutVoluntary: (...args: unknown[]) => cashoutVoluntary(...args),
    markSeatAsLeft: vi.fn(async () => {
      throw new Error('markSeatAsLeft must never be a leave fallback');
    }),
  };
});
vi.mock('../services/supabase/cashSessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/supabase/cashSessions.js')>();
  return {
    ...actual,
    evaluateCashSessions: (...args: unknown[]) => evaluate(...(args as [])),
    atomicCashoutVoluntary: (...args: unknown[]) => cashoutVoluntary(...args),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { supabase } = await import('../services/supabase.js');
const { deadlineScheduler } = await import('./DeadlineScheduler.js');

const occupancyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TABLE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const HUMAN = 'aaaaaaaa-0000-0000-0000-000000000001';
const HORSE = 'aaaaaaaa-0000-0000-0000-000000000002';

const row = (user_id: string, over: Record<string, unknown> = {}) => ({
  user_id,
  baseline: 100,
  stack: 180,
  stay_remaining_ms: 372_000,
  stay_running: true,
  stay_last_tick_at: new Date().toISOString(),
  stay_clock_ms: 600_000,
  leave_locked: true,
  ...over,
});

function makeEngine() {
  const e = new ServerTableEngine(TABLE) as any;
  e.tableInfo = {
    id: TABLE,
    club_id: 'club',
    small_blind: 1,
    big_blind: 2,
    game_variant: 'nlh',
    max_players: 9,
    game_type: 'cash',
    min_buy_in: 80,
    max_buy_in: 400,
  };
  e.running = true;
  e.handController = null;
  e.seatedPlayers = [
    {
      user_id: HUMAN,
      username: 'human',
      stack: 180,
      seat_number: 1,
      is_horse: false,
      occupancy_id: occupancyId,
    },
    {
      user_id: HORSE,
      username: 'horse',
      stack: 180,
      seat_number: 2,
      is_horse: true,
      occupancy_id: occupancyId,
    },
  ];
  e.hub = { emitEvent: vi.fn(), publish: vi.fn() };
  e.broadcastCurrentState = vi.fn(async () => undefined);
  return e;
}

beforeEach(() => {
  cashout.mockReset();
  cashoutVoluntary.mockReset();
  evaluate.mockReset();
});
afterEach(() => {
  deadlineScheduler.cancelAll(TABLE);
});

describe('a locked player is refused synchronously, human and horse alike', () => {
  for (const [who, id] of [
    ['human', HUMAN],
    ['horse', HORSE],
  ] as const) {
    it(`${who}: the mirror says locked -> LEAVE_LOCKED with the label, no cash-out attempted`, async () => {
      const e = makeEngine();
      e.chipContinuity.rows.set(id, row(id));
      const res = await e.leaveTable(id);
      expect(res).toMatchObject({ success: false, code: 'LEAVE_LOCKED', immediate: false });
      expect(res.error).toMatch(/^Leave Available In \d+:\d\d$/);
      expect(cashoutVoluntary).not.toHaveBeenCalled();
      expect(cashout).not.toHaveBeenCalled();
      expect(e.hub.emitEvent).not.toHaveBeenCalledWith(
        TABLE,
        expect.objectContaining({ type: 'seat_left' })
      );
    });

    it(`${who}: the mirror is empty but the DATABASE refuses -> refusal returned, seat kept, nothing torn down`, async () => {
      const e = makeEngine();
      cashoutVoluntary.mockResolvedValue({
        ok: false,
        code: 'LEAVE_LOCKED',
        stayRemainingMs: 61_000,
      });
      const unregister = vi.spyOn(e.disconnectEngine, 'unregisterPlayer');
      const res = await e.leaveTable(id);
      expect(res).toMatchObject({
        success: false,
        code: 'LEAVE_LOCKED',
        stay_remaining_ms: 61_000,
      });
      expect(res.error).toBe('Leave Available In 1:01');
      expect(unregister).not.toHaveBeenCalled();
      expect(e.hub.emitEvent).not.toHaveBeenCalledWith(
        TABLE,
        expect.objectContaining({ type: 'seat_left' })
      );
      expect(e.hub.emitEvent).toHaveBeenCalledWith(
        TABLE,
        expect.objectContaining({ type: 'leave_blocked', user_id: id })
      );
    });

    it(`${who}: the database accepts -> success, seat_left AFTER the money, registrations torn down`, async () => {
      const e = makeEngine();
      const order: string[] = [];
      cashoutVoluntary.mockImplementation(async () => {
        order.push('cashout');
        return { ok: true, stack: 180 };
      });
      e.hub.emitEvent.mockImplementation((_t: string, ev: { type: string }) => order.push(ev.type));
      const unregister = vi.spyOn(e.disconnectEngine, 'unregisterPlayer');
      const res = await e.leaveTable(id);
      expect(res).toMatchObject({ success: true, immediate: true });
      expect(order).toEqual(['cashout', 'seat_left']);
      expect(unregister).toHaveBeenCalledWith(TABLE, id);
      expect(e.chipContinuity.row(id)).toBeUndefined();
    });
  }

  it('a transport failure keeps the seat and says so; nothing is torn down', async () => {
    const e = makeEngine();
    cashoutVoluntary.mockResolvedValue({ ok: false, code: 'FAILED', message: 'boom' });
    const unregister = vi.spyOn(e.disconnectEngine, 'unregisterPlayer');
    const res = await e.leaveTable(HUMAN);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Chips Are Still In Your Seat/);
    expect(unregister).not.toHaveBeenCalled();
  });
});

describe('a kick is a system exit', () => {
  it('skips the mirror check and cashes out with leaveMode forced', async () => {
    const e = makeEngine();
    e.chipContinuity.rows.set(HUMAN, row(HUMAN));
    cashout.mockResolvedValue(180);
    const res = await e.leaveTable(HUMAN, { forced: true });
    expect(res).toMatchObject({ success: true, immediate: true });
    expect(cashoutVoluntary).not.toHaveBeenCalled();
    expect(cashout).toHaveBeenCalledWith(
      HUMAN,
      TABLE,
      1,
      expect.objectContaining({ leaveMode: 'forced' })
    );
  });

  it('a mid-hand kick is remembered so settlement does not judge it by the clock', async () => {
    const e = makeEngine();
    e.handController = {
      getState: () => ({
        players: [{ user_id: HUMAN, seat: 1, is_folded: false, is_all_in: false }],
      }),
      performAction: () => true,
    };
    const res = await e.leaveTable(HUMAN, { forced: true });
    expect(res).toMatchObject({ success: true, immediate: false });
    expect(e.forcedLeaves.has(HUMAN)).toBe(true);
  });
});

describe('a leave refused at settlement is held by the clock, then released', () => {
  it('counts as active for the clock, and the heartbeat opens the door at zero', async () => {
    const e = makeEngine();
    e.onLeaveRefusedAtSettlement(HORSE, 500);
    expect(e.leaveHeldByClock.has(HORSE)).toBe(true);
    expect(e.isContinuityActive(HORSE)).toBe(true);
    // Clock still running: not released.
    e.chipContinuity.rows.set(HORSE, row(HORSE, { stay_remaining_ms: 5_000 }));
    cashoutVoluntary.mockResolvedValue({ ok: true, stack: 180 });
    await e.releaseLeavesHeldByClock();
    expect(cashoutVoluntary).not.toHaveBeenCalled();
    // Clock at zero: released through the guarded door, seat_left follows.
    e.chipContinuity.rows.set(HORSE, row(HORSE, { stay_remaining_ms: 0, stay_running: false }));
    await e.releaseLeavesHeldByClock();
    expect(cashoutVoluntary).toHaveBeenCalledWith(HORSE, TABLE, 2, occupancyId);
    expect(e.leaveHeldByClock.has(HORSE)).toBe(false);
    expect(e.hub.emitEvent).toHaveBeenCalledWith(
      TABLE,
      expect.objectContaining({ type: 'seat_left', user_id: HORSE })
    );
  });

  it('sitting back in withdraws the held leave', () => {
    const e = makeEngine();
    e.dealtInUserIds.add(HUMAN);
    e.onLeaveRefusedAtSettlement(HUMAN, 500);
    e.sitOut(HUMAN, false);
    expect(e.leaveHeldByClock.has(HUMAN)).toBe(false);
  });
});

describe('cashout follows a settlement barrier that is extended while waiting', () => {
  for (const forced of [false, true]) {
    it(
      forced
        ? 'forced cashout waits for the appended settlement'
        : 'voluntary cashout waits for the appended settlement',
      async () => {
        const e = makeEngine();
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const first = new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        const second = new Promise<void>((resolve) => {
          finishSecond = resolve;
        });
        e.postHandTasksPromise = first;
        cashoutVoluntary.mockResolvedValue({
          ok: false,
          code: 'LEAVE_LOCKED',
          stayRemainingMs: 1000,
        });
        cashout.mockImplementation(async (_user, _table, _seat, opts) => {
          opts.onFailed('test refusal preserves the seat');
        });
        const leaving = e.leaveTable(HUMAN, { forced });
        e.postHandTasksPromise = Promise.all([first, second]).then(() => undefined);
        finishFirst();
        for (let i = 0; i < 12; i++) await Promise.resolve();
        expect(cashoutVoluntary).not.toHaveBeenCalled();
        expect(cashout).not.toHaveBeenCalled();
        finishSecond();
        await leaving;
        expect(forced ? cashout : cashoutVoluntary).toHaveBeenCalledTimes(1);
      }
    );
  }
});

describe('a rejected settlement is not a cashout authorization', () => {
  for (const forced of [false, true]) {
    it(
      forced
        ? 'forced leave propagates settlement failure'
        : 'voluntary leave propagates settlement failure',
      async () => {
        const e = makeEngine();
        let rejectSettlement!: (error: Error) => void;
        e.postHandTasksPromise = new Promise<void>((_resolve, reject) => {
          rejectSettlement = reject;
        });
        const leaving = e.leaveTable(HUMAN, { forced });
        const rejected = expect(leaving).rejects.toThrow('settlement failed');
        rejectSettlement(new Error('settlement failed'));
        await rejected;
        expect(cashoutVoluntary).not.toHaveBeenCalled();
        expect(cashout).not.toHaveBeenCalled();
      }
    );
  }
});

describe('a folded player still has an unsettled hand contribution', () => {
  it.each([false, true])(
    'defers the cashout until the live hand persists its final stack: forced=%s',
    async (forced) => {
      const e = makeEngine();
      cashoutVoluntary.mockResolvedValue({ ok: true, stack: 180 });
      const chain: any = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockResolvedValue({ error: null }),
      };
      const from = vi.spyOn(supabase, 'from').mockReturnValue(chain);
      e.handController = {
        getState: () => ({
          players: [
            {
              user_id: HUMAN,
              seat: 1,
              is_folded: true,
              is_all_in: false,
              stack: 120,
              total_bet: 60,
            },
          ],
        }),
        performAction: vi.fn(),
      };
      try {
        const result = await e.leaveTable(HUMAN, { forced });
        expect(result).toMatchObject({ success: true, immediate: false });
        expect(cashoutVoluntary).not.toHaveBeenCalled();
        expect(cashout).not.toHaveBeenCalled();
        expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ leave_pending: true }));
        expect(e.handController.performAction).not.toHaveBeenCalled();
      } finally {
        from.mockRestore();
      }
    }
  );
});

describe('a player who was not dealt into the live hand', () => {
  it('can cash out without waiting for other players to finish', async () => {
    const e = makeEngine();
    cashoutVoluntary.mockResolvedValue({ ok: true, stack: 180 });
    e.handController = {
      getState: () => ({
        players: [{ user_id: HORSE, seat: 2, is_folded: false, is_all_in: false }],
      }),
    };
    const result = await e.leaveTable(HUMAN);
    expect(result).toMatchObject({ success: true, immediate: true });
    expect(cashoutVoluntary).toHaveBeenCalledOnce();
  });
});
