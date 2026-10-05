import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc },
}));

import {
  ACCOUNT_SETTINGS_WRITE_TIMEOUT_MS,
  persistAccountSettings,
} from '../../src/lib/persistAccountSettings';

describe('persistAccountSettings', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: { theme: 'auto' }, error: null });
  });

  it('binds the preference merge and effective mode to the authenticated account', async () => {
    const patch = { soundVolume: 42, theme: 'auto' };
    await expect(persistAccountSettings('user-1', patch, 'light')).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith('fn_patch_account_settings', {
      p_expected_user_id: 'user-1',
      p_mutation_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      p_settings_patch: patch,
      p_interface_theme: 'light',
    });
  });

  it('does not retry an account-fence rejection', async () => {
    const error = { code: '42501', message: 'authenticated account changed' };
    mocks.rpc.mockResolvedValue({ data: null, error });

    await expect(persistAccountSettings('user-a', {}, 'dark')).resolves.toEqual({
      ok: false,
      error,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('bounds an ambiguous request and retries once with the same mutation id', async () => {
    vi.useFakeTimers();
    mocks.rpc.mockImplementation(() => new Promise(() => {}));

    const result = persistAccountSettings('user-1', { soundEnabled: true }, 'dark');
    await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_WRITE_TIMEOUT_MS);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0][1].p_mutation_id).toBe(mocks.rpc.mock.calls[1][1].p_mutation_id);
    await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_WRITE_TIMEOUT_MS);

    await expect(result).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ name: 'AccountSettingsWriteTimeoutError' }),
    });
  });

  it('refuses a missing account before calling the database', async () => {
    await expect(persistAccountSettings('', {}, 'dark')).resolves.toEqual({
      ok: false,
      error: expect.any(Error),
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('normalizes a synchronous adapter failure without poisoning the account queue', async () => {
    const failure = new TypeError('transport unavailable');
    mocks.rpc
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValueOnce({ data: { theme: 'dark' }, error: null });

    await expect(persistAccountSettings('user-sync', {}, 'light')).resolves.toEqual({
      ok: false,
      error: failure,
    });
    await expect(persistAccountSettings('user-sync', {}, 'dark')).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });
});
