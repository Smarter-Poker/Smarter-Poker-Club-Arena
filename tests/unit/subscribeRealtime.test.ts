import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ready: vi.fn(), realtime: { timeout: 10_000 } }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { realtime: mocks.realtime } }));
vi.mock('../../src/lib/realtimeAdmission', () => ({ realtimeAdmission: { ready: mocks.ready } }));
import { subscribeRealtime } from '../../src/lib/subscribeRealtime';

beforeEach(() => vi.clearAllMocks());

it('calibrates only the admitted channel before subscribing', async () => {
  let release!: () => void;
  mocks.ready.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const channel = { timeout: 10_000, subscribe: vi.fn() };
  channel.subscribe.mockImplementation(() => expect(channel.timeout).toBe(60_000));
  const callback = vi.fn();
  const controller = new AbortController();
  const pending = subscribeRealtime(channel as any, callback, controller.signal);
  expect(mocks.ready).toHaveBeenCalledWith(mocks.realtime, controller.signal);
  expect(channel.subscribe).not.toHaveBeenCalled();
  expect(channel.timeout).toBe(10_000);
  release();
  await pending;
  expect(channel.subscribe).toHaveBeenCalledOnce();
  channel.subscribe.mock.calls[0][0]('SUBSCRIBED');
  expect(callback).toHaveBeenCalledExactlyOnceWith('SUBSCRIBED', undefined);
  expect(channel.timeout).toBe(60_000);
});

it.each(['CHANNEL_ERROR', 'TIMED_OUT'])(
  'retires %s once while its existing consumer owns recovery',
  async (status) => {
    mocks.ready.mockResolvedValue(undefined);
    const channel = {
      timeout: 10_000,
      subscribe: vi.fn(),
      unsubscribe: vi.fn().mockResolvedValue('ok'),
    };
    const callback = vi.fn();
    await subscribeRealtime(channel as any, callback, new AbortController().signal);
    const receive = channel.subscribe.mock.calls[0][0];
    const error = new Error('Synthetic join failure');
    receive(status, error);
    receive('CLOSED');
    receive(status, error);
    expect(channel.unsubscribe).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(callback).toHaveBeenCalledExactlyOnceWith(status, error);
  }
);

it('cannot join or report failure after its owning effect cancels it', async () => {
  let release!: () => void;
  mocks.ready.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const channel = { timeout: 10_000, subscribe: vi.fn() },
    callback = vi.fn(),
    controller = new AbortController();
  const pending = subscribeRealtime(channel as any, callback, controller.signal);
  controller.abort();
  release();
  await pending;
  expect(channel.subscribe).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
  expect(channel.timeout).toBe(10_000);
});

it('surfaces admission failure through the existing channel error consumer', async () => {
  const error = new Error('Connection unavailable');
  mocks.ready.mockRejectedValue(error);
  const channel = { timeout: 10_000, subscribe: vi.fn() },
    callback = vi.fn();
  await subscribeRealtime(channel as any, callback, new AbortController().signal);
  expect(channel.subscribe).not.toHaveBeenCalled();
  expect(callback).toHaveBeenCalledExactlyOnceWith('CHANNEL_ERROR', error);
  expect(channel.timeout).toBe(10_000);
});
