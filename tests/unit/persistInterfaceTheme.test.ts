import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: mocks.read,
        })),
      })),
      update: vi.fn((value: unknown) => ({
        eq: vi.fn(() => mocks.write(value)),
      })),
    })),
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
    mocks.read.mockReset();
    mocks.write.mockReset();
    mocks.read.mockResolvedValue({ data: { settings: {} }, error: null });
    mocks.write.mockResolvedValue({ error: null });
  });

  it('merges the mode into the existing account settings', async () => {
    mocks.read.mockResolvedValue({
      data: { settings: { soundEnabled: false, cardBack: 'gold', theme: 'dark' } },
      error: null,
    });

    await expect(persistInterfaceTheme('user-1', 'light')).resolves.toEqual({ ok: true });

    expect(mocks.write).toHaveBeenCalledWith({
      settings: { soundEnabled: false, cardBack: 'gold', theme: 'light' },
    });
  });

  it('persists rapid mode changes in tap order', async () => {
    const firstWrite = deferred<{ error: null }>();
    mocks.read
      .mockResolvedValueOnce({ data: { settings: { theme: 'dark' } }, error: null })
      .mockResolvedValueOnce({ data: { settings: { theme: 'light' } }, error: null });
    mocks.write
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce({ error: null });

    const light = persistInterfaceTheme('user-1', 'light');
    const dark = persistInterfaceTheme('user-1', 'dark');

    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));
    expect(mocks.read).toHaveBeenCalledTimes(1);
    firstWrite.resolve({ error: null });

    await expect(Promise.all([light, dark])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(mocks.write.mock.calls.map(([value]) => value)).toEqual([
      { settings: { theme: 'light' } },
      { settings: { theme: 'dark' } },
    ]);
  });

  it('fails explicitly when there is no signed-in account', async () => {
    const result = await persistInterfaceTheme('', 'light');
    expect(result.ok).toBe(false);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
