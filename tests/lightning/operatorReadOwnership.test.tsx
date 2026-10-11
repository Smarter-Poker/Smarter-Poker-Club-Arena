import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { usePolledAnswer } from '../../src/lightning/useLightningOperator';
import type { OperatorAnswer } from '../../src/lightning/lightningOperatorApi';

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
