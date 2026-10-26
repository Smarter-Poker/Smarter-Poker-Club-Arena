import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  rpc: vi.fn(),
  abort: vi.fn(),
  response: { data: null, error: null } as any,
}));
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: fixture.rpc } }));
import {
  readHorseOwnPublicHistory,
  HORSE_OWN_PUBLIC_HISTORY_DEFINITION_MD5,
} from './HorseOwnPublicHistory.js';
import type { HorseObserverReadContext } from '../engine/HorseObserverReadContext.js';
const context: HorseObserverReadContext = {
  version: 1,
  observerId: '11111111-1111-4111-8111-111111111111',
  variant: 'nlh',
  format: 'cash',
  dealtCount: 2,
};
beforeEach(() => {
  fixture.rpc.mockReset();
  fixture.abort.mockReset();
  fixture.rpc.mockReturnValue({ abortSignal: fixture.abort });
  fixture.abort.mockImplementation(async () => fixture.response);
  fixture.response = {
    data: {
      definitionMd5: HORSE_OWN_PUBLIC_HISTORY_DEFINITION_MD5,
      window: { context, hands: [] },
    },
    error: null,
  };
});
it('uses only the pinned individual public reader and original context, with a finite read deadline', async () => {
  expect(await readHorseOwnPublicHistory(context)).toEqual(fixture.response.data.window);
  expect(fixture.rpc).toHaveBeenCalledWith('fn_horse_own_public_history_read', {
    p_observer: context.observerId,
    p_variant: 'nlh',
    p_format: 'cash',
    p_dealt_count: 2,
    p_before: expect.any(String),
  });
  expect(fixture.abort.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
});
it.each(['definition', 'other_observer', 'format', 'extra', 'error', 'throw', 'empty'] as const)(
  'refuses %s rather than importing pooled or unknown history',
  async (fault) => {
    if (fault === 'definition') fixture.response.data.definitionMd5 = '0'.repeat(32);
    if (fault === 'other_observer')
      fixture.response.data.window.context = {
        ...context,
        observerId: '22222222-2222-4222-8222-222222222222',
      };
    if (fault === 'format') fixture.response.data.window.context = { ...context, format: 'mtt' };
    if (fault === 'extra') fixture.response.data.foreign = 'unknown';
    if (fault === 'error') fixture.response.error = { message: 'unavailable' };
    if (fault === 'throw') fixture.abort.mockRejectedValueOnce(Error('unavailable'));
    if (fault === 'empty') fixture.response.data = null;
    expect(await readHorseOwnPublicHistory(context)).toBeNull();
  }
);
it('never asks the provider for an invalid individual context', async () => {
  expect(await readHorseOwnPublicHistory({ ...context, observerId: 'unknown' })).toBeNull();
  expect(fixture.rpc).not.toHaveBeenCalled();
});
