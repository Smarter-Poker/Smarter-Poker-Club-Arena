import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ from: vi.fn(), reportError: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: { from: mock.from } }));
vi.mock('../errorReporter.js', () => ({ reportError: mock.reportError }));
import { loadSeatedPlayers, persistTimeBanks } from './tables.js';

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
});

describe('time bank settlement requests', () => {
  it('sends no bank request when the fresh roster already matches', async () => {
    await persistTimeBanks('table', [player]);
    expect(mock.from).not.toHaveBeenCalled();
  });

  it('persists consumption down to zero with the existing active-seat and WAL guards', async () => {
    const write = arrangeWrite();
    await persistTimeBanks('table', [
      { ...player, time_bank_remaining: 0, time_bank_uses_remaining: 0 },
    ]);
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
    await persistTimeBanks('table', [{ ...player, time_bank_remaining: 60 }]);
    expect(write.update).toHaveBeenCalledWith({ time_bank_remaining: 60 });
    expect(write.or.mock.calls[0][0]).not.toContain('time_bank_uses_remaining');
  });

  it.each([undefined, { remainingSeconds: null, usesRemaining: null }])(
    'does not treat an unknown baseline as a persisted zero (%j)',
    async (persisted_time_bank) => {
      const write = arrangeWrite();
      await persistTimeBanks('table', [
        { ...player, persisted_time_bank, time_bank_remaining: 0, time_bank_uses_remaining: 0 },
      ]);
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
    await persistTimeBanks('table', [consumed]);
    expect(mock.reportError).toHaveBeenCalledWith(failure, 'DB.persist_time_banks_failed');
    write.or.mockResolvedValue({ error: null });
    await persistTimeBanks('table', [consumed]);
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
    const work = persistTimeBanks('table', [{ ...player, time_bank_remaining: 20 }]).then(() => {
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
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            joined_at: '2026-09-08T15:20:00.123456+00:00',
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
    expect(seat.seat_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(seat.seat_joined_at).toBe('2026-09-08T15:20:00.123456+00:00');
    expect(seat.persisted_time_bank).toEqual({ remainingSeconds: null, usesRemaining: 0 });
    expect(seat.time_bank_remaining).toBe(0);
  });
});
