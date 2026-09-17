import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: mock }));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
import { executePendingSeatMoves, pendingSeatMoves, type PendingSeatMove } from './seatMoves.js';
import { LeavePendingOperation } from '../../observability/LeavePendingDiagnostic.js';
import { reportError } from '../errorReporter.js';
const table = '11111111-1111-4111-8111-111111111111';
const destination = '22222222-2222-4222-8222-222222222222';
const sourceOccupancy = '33333333-3333-4333-8333-333333333333';
const destinationOccupancy = '44444444-4444-4444-8444-444444444444';
const player = '55555555-5555-4555-8555-555555555555';
const id = '66666666-6666-4666-8666-666666666666';
const candidate: PendingSeatMove = {
  move_id: id,
  player_id: player,
  source_occupancy_id: sourceOccupancy,
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
afterEach(() => vi.restoreAllMocks());
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
    { ...receipt, source_occupancy_id: player },
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
    /* PIN MOVED 2026-09-10 (must-move audit lane D, CLAUDE.md 5.8/10.6). What
       this asserts is unchanged and still asserted: a refused move is NO
       TRANSFER - nothing done, nothing held. The outcome now additionally
       REPORTS the refusal, because a player who was promised "Moving After
       This Hand" and then was not moved used to be told nothing at all.
       `original_occupancy_gone` is terminal, so it belongs in `refused`; the
       freeze, a retryable deadlock and a partner still to arrive never do. */
    expect(await run()).toEqual({
      done: [],
      held: [],
      refused: [
        {
          move_id: '66666666-6666-4666-8666-666666666666',
          player_id: '55555555-5555-4555-8555-555555555555',
          reason: 'original_occupancy_gone',
        },
      ],
    });
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
    mock.rpc.mockResolvedValue({
      data: [{ ...candidate, source_occupancy_id: null }],
      error: null,
    });
    await expect(pendingSeatMoves(table)).rejects.toThrow('original occupancy');
    mock.rpc.mockResolvedValue({ data: [candidate], error: null });
    expect(await pendingSeatMoves(table)).toEqual([candidate]);
  });
});

describe('move operation evidence preserves RPC and receipt behavior', () => {
  it('captures the returned error before the existing reporter prefixes its message', async () => {
    const diagnostic = new LeavePendingOperation();
    const error = Object.assign(new Error('original read error'), { code: '42501' });
    mock.rpc.mockResolvedValueOnce({ data: null, error });
    vi.mocked(reportError).mockImplementation((e) => {
      if (e instanceof Error) e.message = '[reporter] ' + e.message;
    });
    await expect(pendingSeatMoves(table, diagnostic)).rejects.toThrow(
      '[reporter] original read error'
    );
    expect(diagnostic.snapshot().error).toMatchObject({
      message: 'original read error',
      code: '42501',
    });
  });

  it('counts earlier recovered move errors and retains the final failing immutable move', async () => {
    const diagnostic = new LeavePendingOperation();
    const finalId = '77777777-7777-4777-8777-777777777777';
    const finalError = new Error('final unavailable');
    mock.rpc
      .mockRejectedValueOnce(new Error('first reply lost'))
      .mockResolvedValueOnce({ data: receipt, error: null })
      .mockRejectedValueOnce(finalError)
      .mockRejectedValueOnce(finalError);
    await expect(
      executePendingSeatMoves(
        table,
        { announcedOnly: false },
        [candidate, { ...candidate, move_id: finalId }],
        diagnostic
      )
    ).rejects.toBe(finalError);
    expect(mock.rpc.mock.calls).toEqual(
      [id, id, finalId, finalId].map((moveId) => [
        'fn_cash_seat_move_execute',
        { p_move_id: moveId },
      ])
    );
    expect(diagnostic.snapshot()).toMatchObject({
      move_id: finalId,
      prior_recovered_move_rpc_failures: 1,
      rpc_attempts: [
        { attempt: 1, status: 'rejected' },
        { attempt: 2, status: 'rejected' },
      ],
    });
  });

  it('does not mislabel a local refusal-log failure as an RPC or receipt failure', async () => {
    const diagnostic = new LeavePendingOperation();
    const failure = new Error('log write unavailable');
    mock.rpc.mockResolvedValue({
      data: { ok: false, reason: 'original_occupancy_gone' },
      error: null,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw failure;
    });
    await expect(
      executePendingSeatMoves(table, { announcedOnly: false }, [candidate], diagnostic)
    ).rejects.toBe(failure);
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(diagnostic.snapshot()).toMatchObject({
      phase: 'move_outcome_processing',
      rpc_attempts: [{ attempt: 1, status: 'fulfilled' }],
    });
  });
  it('distinguishes thrown transport, returned errors and reply validation', async () => {
    const transport = new LeavePendingOperation();
    const failure = Object.freeze(new Error('supabase_timeout'));
    mock.rpc.mockRejectedValueOnce(failure);
    await expect(pendingSeatMoves(table, transport)).rejects.toBe(failure);
    expect(transport.snapshot().phase).toBe('move_enumeration_rpc');

    const returned = new LeavePendingOperation();
    mock.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'read refused', code: '42501' },
    });
    await expect(pendingSeatMoves(table, returned)).rejects.toThrow('read refused');
    expect(returned.snapshot()).toMatchObject({
      failure_kind: 'returned_error',
      phase: 'move_enumeration_rpc',
      error: { code: '42501' },
    });

    const malformed = new LeavePendingOperation();
    mock.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(pendingSeatMoves(table, malformed)).rejects.toThrow('not confirmed');
    expect(malformed.snapshot().phase).toBe('move_enumeration_validation');
    expect(mock.rpc.mock.calls).toEqual(
      Array.from({ length: 3 }, () => ['fn_cash_seat_moves_pending', { p_table_id: table }])
    );
  });

  it('retains both attempts for the exact move without altering thrown identity', async () => {
    const diagnostic = new LeavePendingOperation();
    const final = Object.freeze(new Error('second unavailable response'));
    mock.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'first unavailable', code: '57014' } })
      .mockRejectedValueOnce(final);
    await expect(
      executePendingSeatMoves(table, { announcedOnly: false }, [candidate], diagnostic)
    ).rejects.toBe(final);
    expect(mock.rpc.mock.calls).toEqual([
      ['fn_cash_seat_move_execute', { p_move_id: id }],
      ['fn_cash_seat_move_execute', { p_move_id: id }],
    ]);
    expect(diagnostic.snapshot()).toMatchObject({
      move_id: id,
      phase: 'move_execution_rpc',
      rpc_attempts: [
        {
          attempt: 1,
          status: 'rejected',
          failure_kind: 'returned_error',
          error: { code: '57014' },
        },
        {
          attempt: 2,
          status: 'rejected',
          failure_kind: 'thrown',
          error: { message: final.message },
        },
      ],
    });
  });

  it('labels an unreadable successful reply as validation, without another RPC retry', async () => {
    const diagnostic = new LeavePendingOperation();
    mock.rpc.mockResolvedValue({ data: { ...receipt, source_occupancy_id: player }, error: null });
    await expect(
      executePendingSeatMoves(table, { announcedOnly: false }, [candidate], diagnostic)
    ).rejects.toThrow('original transfer');
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(diagnostic.snapshot()).toMatchObject({
      phase: 'move_receipt_validation',
      rpc_attempts: [{ attempt: 1, status: 'fulfilled' }],
    });
  });
});
