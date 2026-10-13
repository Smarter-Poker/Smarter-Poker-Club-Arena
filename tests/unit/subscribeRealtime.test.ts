import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ready: vi.fn(), realtime: {} }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { realtime: mocks.realtime } }));
vi.mock('../../src/lib/realtimeAdmission', () => ({ realtimeAdmission: { ready: mocks.ready } }));
import { subscribeRealtime } from '../../src/lib/subscribeRealtime';

beforeEach(() => vi.clearAllMocks());

it('binds the actual subscription only after admission and preserves the SDK default timeout', async () => {
  let release!: () => void;
  mocks.ready.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const channel = { subscribe: vi.fn() };
  const callback = vi.fn();
  const controller = new AbortController();
  const pending = subscribeRealtime(channel as any, callback, controller.signal);
  expect(mocks.ready).toHaveBeenCalledWith(mocks.realtime, controller.signal);
  expect(channel.subscribe).not.toHaveBeenCalled();
  release();
  await pending;
  expect(channel.subscribe.mock.calls).toEqual([[callback]]);
});

it('cannot join or report failure after its owning effect cancels it', async () => {
  let release!: () => void;
  mocks.ready.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const channel = { subscribe: vi.fn() },
    callback = vi.fn(),
    controller = new AbortController();
  const pending = subscribeRealtime(channel as any, callback, controller.signal);
  controller.abort();
  release();
  await pending;
  expect(channel.subscribe).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
});

it('surfaces admission failure through the existing channel error consumer', async () => {
  const error = new Error('Connection unavailable');
  mocks.ready.mockRejectedValue(error);
  const channel = { subscribe: vi.fn() },
    callback = vi.fn();
  await subscribeRealtime(channel as any, callback, new AbortController().signal);
  expect(channel.subscribe).not.toHaveBeenCalled();
  expect(callback).toHaveBeenCalledExactlyOnceWith('CHANNEL_ERROR', error);
});
