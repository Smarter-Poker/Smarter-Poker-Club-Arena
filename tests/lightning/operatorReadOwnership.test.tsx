import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usePolledAnswer } from '../../src/lightning/useLightningOperator';
import type { OperatorAnswer } from '../../src/lightning/lightningOperatorApi';

const events = vi.hoisted(() => ({ changed: () => undefined as void }));
vi.mock('../../src/lightning/lightningOperatorEvents', () => ({
  watchLightningOperator: (_c: unknown, _s: unknown, changed: () => void) => {
    events.changed = changed;
    return () => undefined;
  },
}));

it('rejects an obsolete read when the same cluster is reopened', async () => {
  const pending: ((answer: OperatorAnswer<string>) => void)[] = [];
  const load = () => new Promise<OperatorAnswer<string>>((resolve) => pending.push(resolve));
  const { result, rerender } = renderHook(({ scope }) => usePolledAnswer(scope, load, 30_000), {
    initialProps: { scope: 'cluster-a' },
  });
  rerender({ scope: 'cluster-b' });
  rerender({ scope: 'cluster-a' });
  expect(pending).toHaveLength(3);
  await act(async () => pending[2]({ status: 'ok', data: 'current' }));
  await waitFor(() => expect(result.current.answer).toEqual({ status: 'ok', data: 'current' }));
  await act(async () => pending[0]({ status: 'ok', data: 'obsolete' }));
  expect(result.current.answer).toEqual({ status: 'ok', data: 'current' });
});

it('coalesces an event received during a read and never starts another after unmount', async () => {
  const pending: ((answer: OperatorAnswer<string>) => void)[] = [];
  const load = vi.fn(() => new Promise<OperatorAnswer<string>>((resolve) => pending.push(resolve)));
  const { unmount } = renderHook(() => usePolledAnswer('cluster:a', load, 30_000, 'club'));
  act(() => events.changed());
  await act(async () => pending[0]({ status: 'ok', data: 'first' }));
  expect(load).toHaveBeenCalledTimes(2);
  act(() => events.changed());
  unmount();
  await act(async () => pending[1]({ status: 'ok', data: 'last' }));
  expect(load).toHaveBeenCalledTimes(2);
});
