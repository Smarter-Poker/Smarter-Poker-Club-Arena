import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: mocks }));
vi.mock('../errorReporter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../errorReporter.js')>()),
  reportError: vi.fn(),
}));
import { processHandPostCommitObligations } from './handProjection.js';

function prepare(earlier = [{ hand_id: 'older-1' }, { hand_id: 'older-2' }]) {
  const query: any = {};
  for (const method of ['select', 'eq', 'lt', 'not', 'is', 'order']) {
    query[method] = vi.fn().mockReturnValue(query);
  }
  query.maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: { table_id: 'table-a', hand_number: 103 }, error: null });
  query.limit = vi.fn().mockResolvedValue({ data: earlier, error: null });
  mocks.from.mockReturnValue(query);
  mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  mocks.rpc.mockResolvedValueOnce({
    data: { ok: false, reason: 'predecessor_pending' },
    error: null,
  });
  return query;
}
const ids = () => mocks.rpc.mock.calls.map((call) => call[1].p_hand_id);
beforeEach(() => vi.resetAllMocks());

describe('live settlement advances its own causal predecessors', () => {
  it('keeps the normal hand at one RPC and no extra reads', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, hand_id: 'current' }, error: null });
    expect(await processHandPostCommitObligations('current')).toEqual({
      ok: true,
      hand_id: 'current',
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(ids()).toEqual(['current']);
  });
  it('finishes only earlier envelopes from the same table, then proves the requested hand', async () => {
    const query = prepare();
    expect((await processHandPostCommitObligations('current')).ok).toBe(true);
    expect(query.eq).toHaveBeenCalledWith('table_id', 'table-a');
    expect(query.lt).toHaveBeenCalledWith('hand_number', 103);
    expect(query.not).toHaveBeenCalledWith('post_commit_payload', 'is', null);
    expect(query.is).toHaveBeenCalledWith('post_commit_completed_at', null);
    expect(query.order).toHaveBeenCalledWith('hand_number', { ascending: true });
    expect(query.limit).toHaveBeenCalledWith(16);
    expect(ids()).toEqual(['current', 'older-1', 'older-2', 'current']);
    expect(
      mocks.rpc.mock.calls.every((call) => call[0] === 'fn_ca_process_hand_post_commit_obligations')
    ).toBe(true);
  });
  it('does not advance past a refused older obligation', async () => {
    prepare();
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, reason: 'predecessor_pending' },
      error: null,
    });
    expect(await processHandPostCommitObligations('current')).toEqual({
      ok: false,
      reason: 'predecessor_pending',
    });
    expect(ids()).toEqual(['current', 'older-1']);
  });
  it('does not interpret a transport failure as permission to continue', async () => {
    prepare();
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error('timeout') });
    await expect(processHandPostCommitObligations('current')).rejects.toThrow('timeout');
    expect(ids()).toEqual(['current', 'older-1']);
  });
  it('accepts concurrent completion and still requests its own receipt', async () => {
    prepare([]);
    expect((await processHandPostCommitObligations('current')).ok).toBe(true);
    expect(ids()).toEqual(['current', 'current']);
  });
  it('does not treat another hand success as completion of the current hand', async () => {
    prepare([{ hand_id: 'older-1' }]);
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true, hand_id: 'older-1' }, error: null });
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, reason: 'predecessor_pending' },
      error: null,
    });
    expect((await processHandPostCommitObligations('current')).ok).toBe(false);
    expect(ids()).toEqual(['current', 'older-1', 'current']);
  });
  it('propagates predecessor read failure without executing more mutations', async () => {
    const query = prepare();
    query.limit.mockResolvedValue({ data: null, error: new Error('read failed') });
    await expect(processHandPostCommitObligations('current')).rejects.toThrow('read failed');
    expect(ids()).toEqual(['current']);
  });
  it('does not attempt predecessor recovery for other semantic refusals', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: 'not_found' }, error: null });
    expect((await processHandPostCommitObligations('current')).reason).toBe('not_found');
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
