import { describe, expect, it, vi } from 'vitest';
import { AuthorizedPrivateSend } from './AuthorizedPrivateSend.js';
import { WEBSOCKET_HARD_BACKPRESSURE_BYTES } from './webSocketBackpressure.js';
const flush = () => new Promise((resolve) => setImmediate(resolve));
function owner() {
  return {
    current: vi.fn(() => true),
    authorize: vi.fn(async () => true),
    send: vi.fn((_data: string, complete: (error?: Error) => void) => complete()),
    buffered: vi.fn(() => 0),
    retire: vi.fn(),
    error: vi.fn(),
  };
}
describe('original socket private queue', () => {
  it('orders frames and acknowledges only actual accepted sends', async () => {
    const authority = owner(),
      queue = new AuthorizedPrivateSend(authority);
    const delivered = vi.fn();
    queue.enqueue('one', delivered);
    queue.enqueue('two', delivered);
    expect(authority.send).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    await flush();
    expect(authority.send.mock.calls.map(([data]) => data)).toEqual(['one', 'two']);
    expect(authority.authorize).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveBeenCalledTimes(2);
  });
  it('does not acknowledge an asynchronous socket callback failure and permits explicit retry', async () => {
    const authority = owner(),
      delivered = vi.fn();
    let complete!: (error?: Error) => void;
    authority.send.mockImplementation((_data: string, callback?: (error?: Error) => void) => {
      complete = callback!;
    });
    const queue = new AuthorizedPrivateSend(authority);
    queue.enqueue('one', delivered);
    await flush();
    expect(delivered).not.toHaveBeenCalled();
    complete(new Error('asynchronous socket failure'));
    await flush();
    expect(authority.error).toHaveBeenCalledOnce();
    expect(delivered).not.toHaveBeenCalled();
    queue.enqueue('one', delivered);
    await flush();
    expect(delivered).not.toHaveBeenCalled();
    complete();
    await flush();
    expect(delivered).toHaveBeenCalledOnce();
  });
  it('keeps a callback-pending frame inside the bounds and never acknowledges retired sends', async () => {
    const authority = owner(),
      delivered = vi.fn();
    let complete!: (error?: Error) => void;
    authority.send.mockImplementation((_data, callback) => {
      complete = callback;
    });
    authority.retire.mockImplementation(() => authority.current.mockReturnValue(false));
    const queue = new AuthorizedPrivateSend(authority);
    queue.enqueue('x'.repeat(WEBSOCKET_HARD_BACKPRESSURE_BYTES), delivered);
    await flush();
    expect(authority.send).toHaveBeenCalledOnce();
    expect(delivered).not.toHaveBeenCalled();
    queue.enqueue('x', delivered);
    expect(authority.retire).toHaveBeenCalledOnce();
    complete();
    await flush();
    expect(delivered).not.toHaveBeenCalled();
    expect(authority.send).toHaveBeenCalledOnce();
  });
  it('retains owner recovery when authority is unavailable and permits later explicit retry', async () => {
    const authority = owner(),
      queue = new AuthorizedPrivateSend(authority),
      delivered = vi.fn();
    authority.authorize.mockResolvedValueOnce(false);
    queue.enqueue('one', delivered);
    await flush();
    expect(authority.send).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(authority.retire).not.toHaveBeenCalled();
    queue.enqueue('one', delivered);
    await flush();
    expect(delivered).toHaveBeenCalledOnce();
  });
  it.each(['connection', 'subscription'])(
    'refuses late grant after original %s retires',
    async (mode) => {
      const authority = owner(),
        queue = new AuthorizedPrivateSend(authority),
        delivered = vi.fn();
      let finish!: (allowed: boolean) => void;
      let subscription = true;
      authority.authorize.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      queue.enqueue('cards', delivered, () => subscription);
      if (mode === 'connection') authority.current.mockReturnValue(false);
      else subscription = false;
      finish(true);
      await flush();
      expect(authority.send).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
    }
  );
  it('keeps send failure unacknowledged and permits an explicit owner retry', async () => {
    const authority = owner(),
      queue = new AuthorizedPrivateSend(authority),
      delivered = vi.fn();
    authority.send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });
    queue.enqueue('one', delivered);
    await flush();
    expect(delivered).not.toHaveBeenCalled();
    expect(authority.error).toHaveBeenCalledOnce();
    queue.enqueue('one', delivered);
    await flush();
    expect(delivered).toHaveBeenCalledOnce();
  });
  it('bounds queued bytes including the in-flight grant and retires only its original socket', async () => {
    const authority = owner(),
      queue = new AuthorizedPrivateSend(authority),
      delivered = vi.fn();
    let finish!: (allowed: boolean) => void;
    authority.authorize.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    authority.retire.mockImplementation(() => authority.current.mockReturnValue(false));
    queue.enqueue('x'.repeat(WEBSOCKET_HARD_BACKPRESSURE_BYTES), delivered);
    queue.enqueue('x', delivered);
    expect(authority.retire).toHaveBeenCalledOnce();
    finish(true);
    await flush();
    expect(authority.send).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
  });
  it('bounds tiny-frame count while a grant is pending', async () => {
    const authority = owner(),
      queue = new AuthorizedPrivateSend(authority);
    let finish!: (allowed: boolean) => void;
    authority.authorize.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    authority.retire.mockImplementation(() => authority.current.mockReturnValue(false));
    for (let i = 0; i < 257; i++) queue.enqueue('x');
    expect(authority.retire).toHaveBeenCalledOnce();
    finish(true);
    await flush();
    expect(authority.send).not.toHaveBeenCalled();
  });
});
