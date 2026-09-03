import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
  },
}));

import { persistInterfaceTheme } from '../../src/lib/persistInterfaceTheme';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('persistInterfaceTheme', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: 'light', error: null });
  });

  it('uses the atomic server function so unrelated profile settings cannot be overwritten', async () => {
    await expect(persistInterfaceTheme('user-1', 'light')).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith('fn_set_interface_theme', { p_theme: 'light' });
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
    expect(mocks.rpc.mock.calls.map(([, value]) => value)).toEqual([
      { p_theme: 'light' },
      { p_theme: 'dark' },
    ]);
  });

  it('fails explicitly when there is no signed-in account', async () => {
    const result = await persistInterfaceTheme('', 'light');
    expect(result.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
