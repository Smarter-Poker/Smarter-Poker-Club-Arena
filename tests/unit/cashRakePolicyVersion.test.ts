import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCashRakePolicyVersion } from '../../src/services/cashRakePolicyVersion';
afterEach(() => vi.unstubAllGlobals());
describe('cash rake display follows the serving engine contract', () => {
  it.each([
    [{ version: 'legacy' }, 0],
    [{ version: 'new', cashRakePolicyVersion: 1 }, 1],
    [{ version: 'future', cashRakePolicyVersion: 2 }, null],
    [{}, null],
  ])('reads %j as %s', async (body, expected) => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetch);
    expect(await readCashRakePolicyVersion()).toBe(expected);
    expect(fetch.mock.calls[0][1].cache).toBe('no-store');
  });
  it('keeps HTTP failure distinct from a reachable older engine', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await readCashRakePolicyVersion()).toBeNull();
  });
  it('keeps transport failure unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await readCashRakePolicyVersion()).toBeNull();
  });
});
