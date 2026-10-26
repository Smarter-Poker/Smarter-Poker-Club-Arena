import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock('../../src/lightning/lightningSessionApi', () => ({ stopLightningPlaying: mocks.stop }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { useLightningLeaveStop } from '../../src/lightning/useLightningLeaveStop';
const room = { poolSessionId: 'room', clusterId: 'cluster' } as any;
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('all leave doors share one stop in flight and retain the accepted result', async () => {
  let answer!: (v: any) => void;
  mocks.stop.mockReturnValue(
    new Promise((r) => {
      answer = r;
    })
  );
  const hook = renderHook(() => useLightningLeaveStop(room, 'hero'));
  let a!: Promise<boolean>, b!: Promise<boolean>;
  act(() => {
    a = hook.result.current();
    b = hook.result.current();
  });
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith('cluster');
  await act(async () => {
    answer({ ok: true });
    expect(await a).toBe(true);
    expect(await b).toBe(true);
  });
  expect(await hook.result.current()).toBe(true);
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it('refused and failed stops remain retryable, never authorize a leave', async () => {
  mocks.stop
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ ok: true });
  const hook = renderHook(() => useLightningLeaveStop(room, 'hero'));
  expect(await hook.result.current()).toBe(false);
  expect(await hook.result.current()).toBe(false);
  expect(await hook.result.current()).toBe(true);
});
it('a response for a previous room cannot leave the current room', async () => {
  let answer!: (v: any) => void;
  mocks.stop.mockReturnValue(
    new Promise((r) => {
      answer = r;
    })
  );
  const hook = renderHook(({ pool }) => useLightningLeaveStop(pool, 'hero'), {
    initialProps: { pool: room },
  });
  const pending = hook.result.current();
  hook.rerender({ pool: { ...room, poolSessionId: 'other' } });
  answer({ ok: true });
  expect(await pending).toBe(false);
});
it('an unmounted leave cannot navigate after the stop response', async () => {
  let answer!: (v: any) => void;
  mocks.stop.mockReturnValue(
    new Promise((r) => {
      answer = r;
    })
  );
  const hook = renderHook(() => useLightningLeaveStop(room, 'hero'));
  const pending = hook.result.current();
  hook.unmount();
  answer({ ok: true });
  expect(await pending).toBe(false);
});

it('spectators and guests can close a room without a stop RPC', async () => {
  const hook = renderHook(() => useLightningLeaveStop(room, 'guest'));
  expect(await hook.result.current()).toBe(true);
  expect(mocks.stop).not.toHaveBeenCalled();
});
