import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
  },
}));

import {
  INTERFACE_THEME_WRITE_TIMEOUT_MS,
  persistInterfaceTheme,
} from '../../src/lib/persistInterfaceTheme';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('persistInterfaceTheme', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: 'light', error: null });
  });

  it('uses the atomic server function so unrelated profile settings cannot be overwritten', async () => {
    await expect(persistInterfaceTheme('user-1', 'light')).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith('fn_set_interface_theme', {
      p_expected_user_id: 'user-1',
      p_mutation_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      p_theme: 'light',
    });
  });

  it('persists rapid mode changes in tap order', async () => {
    const firstWrite = deferred<{ data: string; error: null }>();
    mocks.rpc
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce({ data: 'dark', error: null });

    const light = persistInterfaceTheme('user-1', 'light');
    const dark = persistInterfaceTheme('user-1', 'dark');

    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    firstWrite.resolve({ data: 'light', error: null });

    await expect(Promise.all([light, dark])).resolves.toEqual([{ ok: true }, { ok: true }]);
    const calls = mocks.rpc.mock.calls.map(([, value]) => value);
    expect(calls).toEqual([
      {
        p_expected_user_id: 'user-1',
        p_mutation_id: expect.any(String),
        p_theme: 'light',
      },
      {
        p_expected_user_id: 'user-1',
        p_mutation_id: expect.any(String),
        p_theme: 'dark',
      },
    ]);
    expect(calls[0].p_mutation_id).not.toBe(calls[1].p_mutation_id);
  });

  it('bounds a wedged request, retries once with the same mutation id, and releases the caller', async () => {
    vi.useFakeTimers();
    mocks.rpc.mockImplementation(() => new Promise(() => {}));

    const result = persistInterfaceTheme('timeout-user', 'light');
    await vi.advanceTimersByTimeAsync(INTERFACE_THEME_WRITE_TIMEOUT_MS);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0][1].p_mutation_id).toBe(mocks.rpc.mock.calls[1][1].p_mutation_id);
    await vi.advanceTimersByTimeAsync(INTERFACE_THEME_WRITE_TIMEOUT_MS);

    await expect(result).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ name: 'InterfaceThemeWriteTimeoutError' }),
    });
  });

  it('normalizes a synchronous client failure and does not poison later writes', async () => {
    const thrown = new TypeError('transport unavailable');
    mocks.rpc
      .mockImplementationOnce(() => {
        throw thrown;
      })
      .mockImplementationOnce(() => {
        throw thrown;
      })
      .mockResolvedValueOnce({ data: 'dark', error: null });

    await expect(persistInterfaceTheme('sync-failure-user', 'light')).resolves.toEqual({
      ok: false,
      error: thrown,
    });
    await expect(persistInterfaceTheme('sync-failure-user', 'dark')).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it('binds a queued A write to A so a later B session is rejected server-side', async () => {
    const firstWrite = deferred<{ data: string; error: null }>();
    let activeAuthUser = 'user-a';
    mocks.rpc
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce((_functionName, args: { p_expected_user_id: string }) =>
        Promise.resolve(
          args.p_expected_user_id === activeAuthUser
            ? { data: 'dark', error: null }
            : {
                data: null,
                error: { code: '42501', message: 'authenticated owner changed' },
              }
        )
      );

    const startedForA = persistInterfaceTheme('user-a', 'light');
    const queuedForA = persistInterfaceTheme('user-a', 'dark');
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));

    activeAuthUser = 'user-b';
    firstWrite.resolve({ data: 'light', error: null });

    await expect(startedForA).resolves.toEqual({ ok: true });
    await expect(queuedForA).resolves.toEqual({
      ok: false,
      error: { code: '42501', message: 'authenticated owner changed' },
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly when there is no signed-in account', async () => {
    const result = await persistInterfaceTheme('', 'light');
    expect(result.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
