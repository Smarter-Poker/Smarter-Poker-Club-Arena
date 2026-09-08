import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), reportError: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: { rpc: mock.rpc, from: mock.from } }));
vi.mock('../errorReporter.js', () => ({ reportError: mock.reportError }));
vi.mock('./pendingWrites.js', () => ({
  drainPendingWrites: vi.fn().mockResolvedValue(undefined),
  enqueuePendingWrite: vi.fn(),
}));
import { loadSeatedPlayers, syncStacks } from './tables.js';

const player = {
  user_id: 'user',
  stack: 100,
  stack_before: 100,
  time_bank_remaining: 40,
  time_bank_uses_remaining: 2,
  persisted_time_bank: { remainingSeconds: 40, usesRemaining: 2 },
};
function arrangeWrite(result: unknown = { error: null }) {
  const write = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockResolvedValue(result),
  };
  mock.from.mockReturnValue(write);
  return write;
}
beforeEach(() => {
  vi.resetAllMocks();
  mock.rpc.mockResolvedValue({ data: { success: true }, error: null });
});

describe('time bank settlement requests', () => {
  it('settles stacks but sends no bank request when the fresh roster already matches', async () => {
    await syncStacks('table', [player], 1);
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(mock.rpc.mock.calls[0][0]).toBe('fn_ca_settle_hand_stacks_absolute');
    expect(mock.from).not.toHaveBeenCalled();
  });

  it('persists consumption down to zero with the existing active-seat and WAL guards', async () => {
    const write = arrangeWrite();
    await syncStacks(
      'table',
      [{ ...player, time_bank_remaining: 0, time_bank_uses_remaining: 0 }],
      1
    );
    expect(write.update).toHaveBeenCalledWith({
      time_bank_remaining: 0,
      time_bank_uses_remaining: 0,
    });
    expect(write.eq).toHaveBeenCalledWith('table_id', 'table');
    expect(write.eq).toHaveBeenCalledWith('user_id', 'user');
    expect(write.is).toHaveBeenCalledWith('left_at', null);
    expect(write.or.mock.calls[0][0]).toContain('time_bank_remaining.is.null');
  });

  it('persists replenishment without rewriting the unchanged column', async () => {
    const write = arrangeWrite();
    await syncStacks('table', [{ ...player, time_bank_remaining: 60 }], 1);
    expect(write.update).toHaveBeenCalledWith({ time_bank_remaining: 60 });
    expect(write.or.mock.calls[0][0]).not.toContain('time_bank_uses_remaining');
  });

  it.each([undefined, { remainingSeconds: null, usesRemaining: null }])(
    'does not treat an unknown baseline as a persisted zero (%j)',
    async (persisted_time_bank) => {
      const write = arrangeWrite();
      await syncStacks(
        'table',
        [{ ...player, persisted_time_bank, time_bank_remaining: 0, time_bank_uses_remaining: 0 }],
        1
      );
      expect(write.update).toHaveBeenCalledWith({
        time_bank_remaining: 0,
        time_bank_uses_remaining: 0,
      });
    }
  );

  it('reports a resolved database failure and retries from the unchanged roster on the next hand', async () => {
    const failure = { message: 'write unavailable' };
    const write = arrangeWrite({ error: failure });
    const consumed = { ...player, time_bank_remaining: 20, time_bank_uses_remaining: 1 };
    await syncStacks('table', [consumed], 1);
    expect(mock.reportError).toHaveBeenCalledWith(failure, 'DB.persist_time_banks_failed');
    write.or.mockResolvedValue({ error: null });
    await syncStacks('table', [consumed], 2);
    expect(write.update).toHaveBeenCalledTimes(2);
    expect(consumed.persisted_time_bank).toEqual({ remainingSeconds: 40, usesRemaining: 2 });
  });

  it('keeps real bank writes inside the settlement barrier', async () => {
    const write = arrangeWrite();
    let finish!: (value: { error: null }) => void;
    write.or.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    let settled = false;
    const work = syncStacks('table', [{ ...player, time_bank_remaining: 20 }], 1).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(write.or).toHaveBeenCalled());
    expect(settled).toBe(false);
    finish({ error: null });
    await work;
    expect(settled).toBe(true);
  });

  it('carries raw database values through the roster without turning null into a known zero', async () => {
    const read = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        error: null,
        data: [
          {
            user_id: 'user',
            stack: 100,
            seat_number: 1,
            time_bank_remaining: null,
            time_bank_uses_remaining: 0,
            profile: { id: 'user', username: 'player' },
          },
        ],
      }),
    };
    mock.from.mockReturnValue(read);
    const [seat] = await loadSeatedPlayers('table');
    expect(seat.persisted_time_bank).toEqual({ remainingSeconds: null, usesRemaining: 0 });
    expect(seat.time_bank_remaining).toBe(0);
  });
});
