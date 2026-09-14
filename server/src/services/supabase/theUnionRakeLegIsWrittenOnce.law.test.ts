import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, reportError } = vi.hoisted(() => ({ rpc: vi.fn(), reportError: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: { rpc } }));
vi.mock('../errorReporter.js', () => ({ reportError }));
import { logRakeCollection } from './rake.js';

describe('rake uses one authoritative transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ error: null });
  });

  it('passes the complete hand identity and separate jackpot amount once', async () => {
    await logRakeCollection('table', 'club', 12, 5, 100, 0.25, 'hand');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('atomic_distribute_rake', {
      p_table_id: 'table',
      p_club_id: 'club',
      p_hand_id: 'hand',
      p_hand_number: 12,
      p_rake: 5,
      p_bbj: 0.25,
      p_pot: 100,
    });
  });

  it('retains table and number identity when hand history is not written yet', async () => {
    await logRakeCollection('table', 'club', 12, 5, 100);
    expect(rpc).toHaveBeenCalledWith(
      'atomic_distribute_rake',
      expect.objectContaining({ p_table_id: 'table', p_hand_number: 12, p_hand_id: null, p_bbj: 0 })
    );
  });

  it('reports and propagates a failed transaction so it can be retried', async () => {
    const failure = { code: '55P03', message: 'lock timeout' };
    rpc.mockResolvedValue({ error: failure });
    await expect(logRakeCollection('table', 'club', 12, 5, 100)).rejects.toBe(failure);
    expect(reportError).toHaveBeenCalledWith(
      failure,
      'logRakeCollection.atomic_distribution_failed'
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not collect zero or negative rake', async () => {
    await logRakeCollection('table', 'club', 12, 0, 100);
    await logRakeCollection('table', 'club', 12, -1, 100);
    expect(rpc).not.toHaveBeenCalled();
  });
});
