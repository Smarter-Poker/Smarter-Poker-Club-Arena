import { beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: transport }));
import { readCashMoveArrivals } from './cashMovePresence.js';

const table = '11111111-1111-4111-8111-111111111111';
const source = '22222222-2222-4222-8222-222222222222';
const sourceStay = '33333333-3333-4333-8333-333333333333';
const destinationStay = '44444444-4444-4444-8444-444444444444';
const player = '55555555-5555-4555-8555-555555555555';
const move = '66666666-6666-4666-8666-666666666666';
const receipt = {
  move_id: move,
  player_id: player,
  from_table_id: source,
  to_table_id: table,
  source_occupancy_id: sourceStay,
  destination_occupancy_id: destinationStay,
};
beforeEach(() => vi.resetAllMocks());

describe('presence requires an exact completed arrival', () => {
  it('uses a read-only door and preserves the scoped result', async () => {
    transport.rpc.mockResolvedValue({ data: [receipt], error: null });
    expect(await readCashMoveArrivals(table, [destinationStay, destinationStay])).toEqual([
      receipt,
    ]);
    expect(transport.rpc).toHaveBeenCalledTimes(1);
    expect(transport.rpc).toHaveBeenCalledWith('fn_cash_seat_move_arrivals', {
      p_table_id: table,
      p_occupancy_ids: [destinationStay],
    });
  });

  it.each([
    null,
    {},
    [null],
    [{ ...receipt, move_id: '' }],
    [{ ...receipt, player_id: null }],
    [{ ...receipt, from_table_id: table }],
    [{ ...receipt, to_table_id: source }],
    [{ ...receipt, destination_occupancy_id: player }],
    [{ ...receipt, source_occupancy_id: destinationStay }],
    [receipt, receipt],
  ])('rejects unreadable or unrelated arrival proof %#', async (data) => {
    transport.rpc.mockResolvedValue({ data, error: null });
    await expect(readCashMoveArrivals(table, [destinationStay])).rejects.toThrow();
  });

  it('distinguishes a confirmed voluntary arrival from an unavailable read', async () => {
    transport.rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await readCashMoveArrivals(table, [destinationStay])).toEqual([]);
    const error = { message: 'unavailable' };
    transport.rpc.mockResolvedValueOnce({ data: null, error });
    await expect(readCashMoveArrivals(table, [destinationStay])).rejects.toBe(error);
  });

  it('does not read for an empty scope or send malformed occupancy IDs', async () => {
    expect(await readCashMoveArrivals(table, [])).toEqual([]);
    await expect(readCashMoveArrivals(table, [''])).rejects.toThrow();
    expect(transport.rpc).not.toHaveBeenCalled();
  });
});
