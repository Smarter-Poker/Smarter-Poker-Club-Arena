import { expect, it } from 'vitest';
import { HeldRouteLifecycle } from '../e2e/support/heldRouteLifecycle';

it('drains all held callbacks before removing the exact handler', async () => {
  const gate = new HeldRouteLifecycle();
  const calls: string[] = [];
  let finishFirst!: () => void;
  const first = gate.handler({
    continue: async () => {
      calls.push('first');
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    },
  });
  await gate.seen;
  const cleanup = gate.finish(async () => {
    calls.push('remove');
  });
  await Promise.resolve();
  expect(calls).toEqual(['first']);
  const second = gate.handler({
    continue: async () => {
      calls.push('second');
    },
  });
  finishFirst();
  await Promise.all([first, second, cleanup]);
  expect(calls).toEqual(['first', 'second', 'remove']);
});

it('removes the handler and reports a failed continuation without losing the failure', async () => {
  const gate = new HeldRouteLifecycle();
  const error = new Error('route refused');
  const callback = gate.handler({
    continue: async () => {
      throw error;
    },
  });
  const outcome = callback.catch((failure) => failure);
  let removed = false;
  await expect(
    gate.finish(async () => {
      removed = true;
    })
  ).rejects.toBe(error);
  expect(removed).toBe(true);
  expect(await outcome).toBe(error);
});

it('can remove an unused handler after navigation fails before any request', async () => {
  const gate = new HeldRouteLifecycle();
  let removed = false;
  await gate.finish(async () => {
    removed = true;
  });
  expect(removed).toBe(true);
});
