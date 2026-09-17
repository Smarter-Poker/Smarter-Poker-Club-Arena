import { beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: transport }));
import { joinCashGame, joinGameRefusalText } from '../../src/services/cashGameLobby';

describe('the game entry receipt is authoritative', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    null,
    {},
    { ok: false, action: 'seat', table_id: 'main' },
    { ok: true, action: 'unknown', table_id: 'main' },
    { ok: true, action: 'seat' },
    { ok: true, action: 'seated', table_id: '' },
    { ok: true, action: 'seat', table_id: 12 },
  ])('rejects an unconfirmed or unusable admission (%j)', async (data) => {
    transport.rpc.mockResolvedValue({ data, error: null });
    await expect(joinCashGame('game')).rejects.toThrow();
  });
  it.each([
    { ok: true, action: 'seat', table_id: 'feeder' },
    { ok: true, action: 'seated', table_id: 'main' },
    { ok: true, action: 'waitlisted', position: 3, waiting: 4 },
  ])('preserves the server-selected destination or queue place (%j)', async (data) => {
    transport.rpc.mockResolvedValue({ data, error: null });
    await expect(joinCashGame('game')).resolves.toEqual(data);
    expect(transport.rpc).toHaveBeenCalledExactlyOnceWith('fn_cash_game_join', {
      p_game_id: 'game',
    });
  });
  it('keeps transport and named business refusals available for the existing house copy', async () => {
    const error = { message: 'GAME_CLOSED: not taking players' };
    transport.rpc.mockResolvedValue({ data: null, error });
    await expect(joinCashGame('game')).rejects.toBe(error);
    transport.rpc.mockResolvedValue({ data: { ok: false, reason: 'GAME_CLOSED' }, error: null });
    const refusal = await joinCashGame('game').catch((e) => e);
    expect(joinGameRefusalText(refusal)).toBe('This Game Is Not Taking Players.');
  });
});
