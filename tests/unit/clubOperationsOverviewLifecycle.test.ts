import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { subscribe: () => () => {} } }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => ({}) }));
import { useClubOperationsOverview } from '../../src/hooks/useClubOperationsOverview';

function pendingRead() {
  let resolve!: (value: { data: null; error: Error }) => void;
  const promise = new Promise<{ data: null; error: Error }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('club overview outcome belongs to its mounted reader', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.report.mockReset();
  });

  it('drops an aborted read after the owning route unmounts', async () => {
    const read = pendingRead();
    mocks.rpc.mockReturnValueOnce(read.promise);
    const hook = renderHook(() => useClubOperationsOverview('disposed-club'));
    expect(mocks.rpc).toHaveBeenCalledOnce();
    hook.unmount();
    await act(async () => {
      read.resolve({ data: null, error: new TypeError('Failed to fetch') });
    });
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('keeps current-reader transport failures visible', async () => {
    const read = pendingRead();
    mocks.rpc.mockReturnValueOnce(read.promise);
    const hook = renderHook(() => useClubOperationsOverview('active-club'));
    const failure = new TypeError('Failed to fetch');
    await act(async () => {
      read.resolve({ data: null, error: failure });
    });
    expect(mocks.report).toHaveBeenCalledWith(failure, 'ClubOperationsOverview.Load_failed');
    expect(hook.result.current.error).toBe('Live club readings are unavailable right now.');
    expect(hook.result.current.loading).toBe(false);
    hook.unmount();
  });

  it('does not report a former club failure after switching clubs', async () => {
    const former = pendingRead();
    const current = pendingRead();
    mocks.rpc.mockReturnValueOnce(former.promise).mockReturnValueOnce(current.promise);
    const hook = renderHook(({ club }) => useClubOperationsOverview(club), {
      initialProps: { club: 'former-club' },
    });
    hook.rerender({ club: 'current-club' });
    await act(async () => {
      former.resolve({ data: null, error: new TypeError('Failed to fetch') });
    });
    expect(mocks.report).not.toHaveBeenCalled();
    expect(hook.result.current.loading).toBe(true);
    hook.unmount();
    await act(async () => {
      current.resolve({ data: null, error: new TypeError('Failed to fetch') });
    });
    expect(mocks.report).not.toHaveBeenCalled();
  });
});
