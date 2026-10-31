import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { useTopUpAccounting, readTopUpAccounting } from '../../src/hooks/useTopUpAccounting';
import { supabase } from '../../src/lib/supabase';
import type { DiamondCashSessionRecap } from '../../src/services/diamondCashSessionRecap';
const facts = { totalBuyIn: 150, totalRebuys: 1 } as DiamondCashSessionRecap;
function setup() {
  const read = vi.fn(async () => facts);
  const onFunding = vi.fn();
  const props = {
    tableId: 'table',
    asset: 'diamonds' as const,
    tableEvent: null as Record<string, unknown> | null,
    userId: 'user',
    seat: 1,
    enabled: true,
    connected: true,
    revision: 0,
    event: null as Record<string, unknown> | null,
    read,
    onFunding,
  };
  const h = renderHook((p) => useTopUpAccounting(p), { initialProps: props });
  return { ...h, props, read, onFunding };
}
const completion = {
  kind: 'diamond_top_up_completed',
  table_id: 'table',
  user_id: 'user',
  request_id: 'original',
};
describe('recorded Diamond top-up accounting', () => {
  it('loads at entry and restores absolute totals on completion, not an inferred stack delta', async () => {
    const h = setup();
    await waitFor(() => expect(h.onFunding).toHaveBeenCalledTimes(1));
    h.rerender({ ...h.props, event: completion });
    await waitFor(() => expect(h.onFunding).toHaveBeenCalledTimes(2));
    expect(h.onFunding.mock.calls[1][0]).toBe(facts);
    h.rerender({ ...h.props, event: { ...completion } });
    await act(async () => {});
    expect(h.read).toHaveBeenCalledTimes(2);
  });
  it('does not read again on unrelated private frames, but reads after a reconnect or acknowledged direct purchase', async () => {
    const h = setup();
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    h.rerender({ ...h.props, event: { kind: 'hole_cards' } });
    await act(async () => {});
    expect(h.read).toHaveBeenCalledTimes(1);
    h.rerender({ ...h.props, connected: false });
    h.rerender({ ...h.props, connected: true });
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    h.rerender({ ...h.props, revision: 1 });
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(3));
  });
  it('refuses another player or table completion', async () => {
    const h = setup();
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    h.rerender({ ...h.props, event: { ...completion, user_id: 'other' } });
    h.rerender({ ...h.props, event: { ...completion, table_id: 'other' } });
    await act(async () => {});
    expect(h.read).toHaveBeenCalledTimes(1);
  });
  it('fences a late recap after seat/account scope changes or opt-out', async () => {
    let finish!: (value: DiamondCashSessionRecap) => void;
    const read = vi.fn(
      () =>
        new Promise<DiamondCashSessionRecap>((r) => {
          finish = r;
        })
    );
    const onFunding = vi.fn();
    const props = {
      tableId: 'table',
      asset: 'diamonds' as const,
      tableEvent: null as Record<string, unknown> | null,
      userId: 'user',
      seat: 1,
      enabled: true,
      connected: true,
      revision: 0,
      event: null,
      read,
      onFunding,
    };
    const h = renderHook((p) => useTopUpAccounting(p), { initialProps: props });
    h.rerender({ ...props, enabled: false });
    await act(async () => finish(facts));
    expect(onFunding).not.toHaveBeenCalled();
    h.unmount();
  });
  it('does not overwrite real totals with a failed read', async () => {
    const h = setup();
    await waitFor(() => expect(h.onFunding).toHaveBeenCalledTimes(1));
    h.read.mockRejectedValueOnce(new Error('unavailable'));
    h.rerender({ ...h.props, revision: 1 });
    await act(async () => {});
    expect(h.onFunding).toHaveBeenCalledTimes(1);
  });
});

describe('chip canonical funding', () => {
  it('reads the caller-bound baseline and refuses missing or malformed evidence', async () => {
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: '150.25', error: null } as never);
    expect(await readTopUpAccounting('table', 'user', 'chips')).toEqual({ totalBuyIn: 150.25 });
    expect(supabase.rpc).toHaveBeenCalledWith('fn_my_cash_session_baseline', {
      p_table_id: 'table',
    });
    for (const data of [null, '', 'bad', -1]) {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({ data, error: null } as never);
      await expect(readTopUpAccounting('table', 'user', 'chips')).rejects.toThrow();
    }
  });
  it('reads on its own queued landing and ignores another seat', async () => {
    const h = setup();
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    h.rerender({ ...h.props, tableEvent: { type: 'add_on_applied', table_id: 'table', seat: 2 } });
    await act(async () => {});
    expect(h.read).toHaveBeenCalledTimes(1);
    h.rerender({ ...h.props, tableEvent: { type: 'add_on_applied', table_id: 'table', seat: 1 } });
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  });
  it('a slower older read cannot overwrite the newer committed baseline', async () => {
    const h = setup();
    await waitFor(() => expect(h.onFunding).toHaveBeenCalledTimes(1));
    let finish!: (value: DiamondCashSessionRecap) => void;
    h.read.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        })
    );
    h.rerender({ ...h.props, revision: 1 });
    h.rerender({ ...h.props, revision: 2 });
    await waitFor(() => expect(h.onFunding).toHaveBeenCalledTimes(2));
    await act(async () => finish({ ...facts, totalBuyIn: 100 }));
    expect(h.onFunding).toHaveBeenCalledTimes(2);
  });
});
