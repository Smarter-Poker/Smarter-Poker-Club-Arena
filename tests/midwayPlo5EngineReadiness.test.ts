import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../src/utils/errorReporter', () => ({
  reportError: vi.fn(),
  captureClientError: vi.fn(),
  isClientErrorSinkEnabled: () => false,
}));
import { isCashGameHorseArrivalsReady } from '../src/services/GameServerAPI';

describe('the serving engine must actually support the arrival protocol', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    [{ status: 'ok', cashGameHorseArrivalsVersion: 1 }, true],
    [{ status: 'ok' }, false],
    [{ status: 'ok', cashGameHorseArrivalsVersion: '1' }, false],
    [{ status: 'degraded', cashGameHorseArrivalsVersion: 1 }, false],
    [null, false],
  ])(
    'uses the protocol receipt rather than a commit equality guess: %j',
    async (body, expected) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
      );
      await expect(isCashGameHorseArrivalsReady()).resolves.toBe(expected);
    }
  );
  it('refuses an unreadable engine', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Network Unavailable');
      })
    );
    await expect(isCashGameHorseArrivalsReady()).resolves.toBe(false);
  });
});
