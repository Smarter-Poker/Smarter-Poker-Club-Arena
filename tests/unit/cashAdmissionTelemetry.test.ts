import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc, capture } = vi.hoisted(() => ({ rpc: vi.fn(), capture: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../../src/lib/analytics', () => ({ capture }));
import { joinCashGame } from '../../src/services/cashGameLobby';
beforeEach(() => {
  rpc.mockReset();
  capture.mockReset();
});
describe('admission measurement preserves authoritative outcomes', () => {
  it('records successful admission without another request', async () => {
    const data = { ok: true, action: 'seat', table_id: 'assigned-table' };
    rpc.mockResolvedValue({ data, error: null });
    await expect(joinCashGame('game')).resolves.toEqual(data);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('fn_cash_game_join', { p_game_id: 'game' });
    expect(capture).toHaveBeenCalledWith(
      'cash_game_admission_completed',
      expect.objectContaining({ outcome: 'seat', table_id: 'assigned-table' })
    );
  });
  it('keeps an unknown outcome and never retries it', async () => {
    const error = new Error('transport timeout with private diagnostic');
    rpc.mockResolvedValue({ data: null, error });
    await expect(joinCashGame('game')).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      'cash_game_admission_failed',
      expect.objectContaining({ error_code: 'UNCONFIRMED' })
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private diagnostic');
  });
  it('an analytics failure cannot change a successful admission', async () => {
    capture.mockImplementation(() => {
      throw new Error('analytics unavailable');
    });
    const data = { ok: true, action: 'waitlisted', position: 2 };
    rpc.mockResolvedValue({ data, error: null });
    await expect(joinCashGame('game')).resolves.toEqual(data);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
