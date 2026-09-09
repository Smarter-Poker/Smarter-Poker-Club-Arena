import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: mock }));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
import { executePendingSeatMoves, pendingSeatMoves, type PendingSeatMove } from './seatMoves.js';
const table = '11111111-1111-4111-8111-111111111111';
const destination = '22222222-2222-4222-8222-222222222222';
const sourceOccupancy = '33333333-3333-4333-8333-333333333333';
const destinationOccupancy = '44444444-4444-4444-8444-444444444444';
const player = '55555555-5555-4555-8555-555555555555';
const id = '66666666-6666-4666-8666-666666666666';
const candidate: PendingSeatMove = {
  move_id: id,
  player_id: player,
  to_table_id: destination,
  to_table_name: null,
  to_role: null,
  to_main_index: null,
  reason: 'must_move',
  announced_at: null,
  swap_move_id: null,
  ready_at: null,
};
const receipt = {
  ok: true,
  move_id: id,
  player_id: player,
  from_table_id: table,
  to_table_id: destination,
  source_seat_number: 2,
  to_seat_number: 4,
  source_occupancy_id: sourceOccupancy,
  destination_occupancy_id: destinationOccupancy,
  stack: 25,
  idempotency_key: 'seatmove:' + id,
};
const run = () => executePendingSeatMoves(table, { announcedOnly: false }, [candidate]);
beforeEach(() => vi.resetAllMocks());
describe('verified original seat move outcomes', () => {
  it('returns a proven original transfer', async () => {
    mock.rpc.mockResolvedValue({ data: receipt, error: null });
    expect((await run()).done[0]).toMatchObject({
      source_occupancy_id: sourceOccupancy,
      stack: 25,
    });
  });
  it.each([
    null,
    {},
    [],
    { ...receipt, ok: 'true' },
    { ...receipt, move_id: player },
    { ...receipt, player_id: id },
    { ...receipt, from_table_id: destination },
    { ...receipt, to_table_id: table },
    { ...receipt, source_occupancy_id: undefined },
    { ...receipt, destination_occupancy_id: sourceOccupancy },
    { ...receipt, stack: '25' },
    { ...receipt, stack: NaN },
    { ...receipt, stack: 25.001 },
    { ...receipt, idempotency_key: 'different' },
    { ...receipt, partner: { stack: 25 } },
  ])('rejects unconfirmed outcome %# before engine cleanup', async (data) => {
    mock.rpc.mockResolvedValue({ data, error: null });
    await expect(run()).rejects.toThrow();
  });
  it('retries only the same move after an unavailable response', async () => {
    mock.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'lost response' } })
      .mockResolvedValueOnce({ data: receipt, error: null });
    expect((await run()).done).toHaveLength(1);
    expect(mock.rpc.mock.calls).toEqual([
      ['fn_cash_seat_move_execute', { p_move_id: id }],
      ['fn_cash_seat_move_execute', { p_move_id: id }],
    ]);
  });
  it('rejects after bounded unresolved attempts', async () => {
    mock.rpc.mockRejectedValue(new Error('connection unavailable'));
    await expect(run()).rejects.toThrow('connection unavailable');
    expect(mock.rpc).toHaveBeenCalledTimes(2);
  });
  it('treats a refused move as no transfer', async () => {
    mock.rpc.mockResolvedValue({
      data: { ok: false, reason: 'original_occupancy_gone' },
      error: null,
    });
    expect(await run()).toEqual({ done: [], held: [] });
  });
  it('requires exact original scope for a swap hold', async () => {
    mock.rpc.mockResolvedValue({
      data: {
        ...receipt,
        ok: false,
        reason: 'waiting_partner',
        held: true,
        partner_id: destinationOccupancy,
      },
      error: null,
    });
    expect((await run()).held[0]).toMatchObject({ source_occupancy_id: sourceOccupancy });
    mock.rpc.mockResolvedValue({
      data: { ok: false, reason: 'waiting_partner', held: true },
      error: null,
    });
    await expect(run()).rejects.toThrow();
  });
  it('does not convert unavailable or malformed enumeration to an empty table', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { message: 'read failed' } });
    await expect(pendingSeatMoves(table)).rejects.toThrow('read failed');
    mock.rpc.mockResolvedValue({ data: null, error: null });
    await expect(pendingSeatMoves(table)).rejects.toThrow();
    mock.rpc.mockResolvedValue({ data: [], error: null });
    expect(await pendingSeatMoves(table)).toEqual([]);
  });
});
