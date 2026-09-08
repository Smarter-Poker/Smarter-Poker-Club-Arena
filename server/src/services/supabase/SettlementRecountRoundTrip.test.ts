import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ from: vi.fn(), reportError: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: { from: mock.from } }));
vi.mock('../errorReporter.js', () => ({ reportError: mock.reportError }));
import { reconcileTableSeatCount } from './tables.js';

function arrange(data: unknown, error: unknown = null, updateError: unknown = null) {
  const read = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  const write = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockResolvedValue({ error: updateError }),
  };
  mock.from.mockReturnValueOnce(read).mockReturnValueOnce(write);
  return { read, write };
}
const seats = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ user_id: `user-${i}` }));
beforeEach(() => vi.resetAllMocks());

describe('settlement recount round trips', () => {
  it('uses one fresh joined read and no write for a stable table', async () => {
    const { read, write } = arrange({ current_players: 6, status: 'running', seats: seats(6) });
    expect(await reconcileTableSeatCount('table')).toBe(6);
    expect(mock.from).toHaveBeenCalledTimes(1);
    expect(read.select).toHaveBeenCalledWith(
      'current_players,status,seats:table_seats!table_seats_table_id_fkey(user_id)'
    );
    expect(read.eq).toHaveBeenCalledWith('id', 'table');
    expect(read.is).toHaveBeenCalledWith('seats.left_at', null);
    expect(write.update).not.toHaveBeenCalled();
  });

  it.each([
    [6, 'running', 1, 'waiting'],
    [1, 'waiting', 2, 'running'],
    [2, 'waiting', 2, 'running'],
    [null, null, 0, 'waiting'],
  ])(
    'repairs summary %s/%s from %s authoritative seats',
    async (stored, previous, count, status) => {
      const { write } = arrange({
        current_players: stored,
        status: previous,
        seats: seats(count as number),
      });
      expect(await reconcileTableSeatCount('table')).toBe(count);
      expect(write.update).toHaveBeenCalledWith({ current_players: count, status });
      expect(write.eq).toHaveBeenCalledWith('id', 'table');
      expect(write.or.mock.calls[0][0]).toContain(`current_players.neq.${count}`);
      expect(write.or.mock.calls[0][0]).toContain('status.is.null');
    }
  );

  it('accepts a genuinely empty active relation without a redundant update', async () => {
    arrange({ current_players: 0, status: 'waiting', seats: [] });
    expect(await reconcileTableSeatCount('table')).toBe(0);
    expect(mock.from).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { seats: null }, { seats: {} }])(
    'never turns missing relation %j into zero',
    async (data) => {
      const { write } = arrange(data);
      expect(await reconcileTableSeatCount('table')).toBeNull();
      expect(write.update).not.toHaveBeenCalled();
      expect(mock.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        'ServerTableEngine.table_unlock_count_unavailable'
      );
    }
  );

  it('does not trust data accompanying a failed read', async () => {
    const { write } = arrange(
      { current_players: 0, status: 'waiting', seats: [] },
      { message: 'unavailable' }
    );
    expect(await reconcileTableSeatCount('table')).toBeNull();
    expect(write.update).not.toHaveBeenCalled();
  });

  it('reports update failure while preserving the known count for the unlock event', async () => {
    arrange({ current_players: 0, status: 'waiting', seats: seats(6) }, null, {
      message: 'timeout',
    });
    expect(await reconcileTableSeatCount('table')).toBe(6);
    expect(mock.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'ServerTableEngine.table_unlock_update_failed'
    );
  });
});
