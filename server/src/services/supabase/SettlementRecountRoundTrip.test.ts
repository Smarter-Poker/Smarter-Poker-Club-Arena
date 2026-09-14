import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: { from: mock.from } }));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
import { updateTableStatus } from './tables.js';

function arrange(error: unknown = null) {
  const query = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    or: vi.fn().mockResolvedValue({ error }),
  };
  mock.from.mockReturnValue(query);
  return query;
}

beforeEach(() => vi.resetAllMocks());

describe('settlement table-summary compare-and-set', () => {
  it('writes the authoritative count through the changed-value filter', async () => {
    const query = arrange();

    await updateTableStatus('table', 6, 'running');

    expect(mock.from).toHaveBeenCalledWith('tables');
    expect(query.update).toHaveBeenCalledWith({ current_players: 6, status: 'running' });
    expect(query.eq).toHaveBeenCalledWith('id', 'table');
    expect(query.or).toHaveBeenCalledWith(
      'current_players.neq.6,current_players.is.null,status.neq."running",status.is.null'
    );
  });

  it('cannot reopen a table already closed by terminal settlement', async () => {
    const query = arrange();

    await updateTableStatus('table', 2, 'running');

    expect(query.neq).toHaveBeenCalledWith('status', 'closed');
    expect(query.neq.mock.invocationCallOrder[0]).toBeLessThan(
      query.or.mock.invocationCallOrder[0]
    );
  });

  it('fails loudly when the conditional update cannot be evaluated', async () => {
    arrange({ message: 'database unavailable' });

    await expect(updateTableStatus('table', 1, 'waiting')).rejects.toThrow(
      'table table status recount failed: database unavailable'
    );
  });
});
