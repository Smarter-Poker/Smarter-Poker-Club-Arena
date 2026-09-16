import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: transport }));
import {
  cancelSeatChange,
  requestSeatChange,
  seatChangeRefusalText,
} from '../../src/services/cashGameLobby';

beforeEach(() => vi.resetAllMocks());

describe('seat changes require an authoritative receipt', () => {
  const moving = { ok: true, action: 'moving', request_id: 'request', to_table_id: 'main2' };

  it.each([
    null,
    {},
    { ...moving, ok: false },
    { ...moving, ok: 'true' },
    { ...moving, action: 'unknown' },
    { ...moving, action: 'cancelled' },
    { ...moving, action: 'none' },
    { ...moving, request_id: null },
    { ...moving, to_table_id: ' ' },
    { ...moving, action: 'swapping', to_table_id: null },
    { ...moving, action: 'listed', position: 0 },
    { ...moving, action: 'listed', position: '2' },
  ])('rejects an unconfirmed or unusable request receipt %#', async (data) => {
    transport.rpc.mockResolvedValue({ data, error: null });
    await expect(requestSeatChange('game', null)).rejects.toThrow();
    expect(transport.rpc).toHaveBeenCalledExactlyOnceWith('fn_cash_seat_change_request', {
      p_game_id: 'game',
      p_to_table_id: null,
    });
  });

  it.each([
    moving,
    { ...moving, action: 'swapping' },
    { ...moving, action: 'moved' },
    { ...moving, action: 'listed', to_table_id: null, position: 2 },
    { ...moving, action: 'listed', position: 1 },
  ])('preserves the confirmed destination or queue %#', async (data) => {
    transport.rpc.mockResolvedValue({ data, error: null });
    await expect(requestSeatChange('game', 'main2')).resolves.toBe(data);
  });

  it.each([
    null,
    {},
    { ok: false, cancelled: 1 },
    { ok: 'true', cancelled: 1 },
    { ok: true, cancelled: -1 },
    { ok: true, cancelled: '1' },
    { ok: true, cancelled: 0.5 },
    { ok: true, cancelled: Number.MAX_SAFE_INTEGER + 1 },
  ])('does not report an unconfirmed cancellation %#', async (data) => {
    transport.rpc.mockResolvedValue({ data, error: null });
    await expect(cancelSeatChange('game')).rejects.toThrow();
    expect(transport.rpc).toHaveBeenCalledExactlyOnceWith('fn_cash_seat_change_cancel', {
      p_game_id: 'game',
    });
  });

  it.each([0, 1])('preserves a confirmed cancellation count of %i', async (cancelled) => {
    const data = { ok: true, cancelled };
    transport.rpc.mockResolvedValue({ data, error: null });
    await expect(cancelSeatChange('game')).resolves.toBe(data);
  });

  it('retains named refusals and transport errors for the existing player copy', async () => {
    const error = { message: 'SEAT_CHANGE_USED: already used' };
    transport.rpc.mockResolvedValue({ data: null, error });
    await expect(requestSeatChange('game', null)).rejects.toBe(error);
    await expect(cancelSeatChange('game')).rejects.toBe(error);
    transport.rpc.mockResolvedValue({
      data: { ok: false, reason: 'SEAT_CHANGE_USED' },
      error: null,
    });
    const refused = await requestSeatChange('game', null).catch((reason) => reason);
    expect(seatChangeRefusalText(refused)).toBe('You Have Used Your Seat Change For This Game.');
  });
});
