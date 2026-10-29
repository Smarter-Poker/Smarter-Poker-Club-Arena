import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  awaitPreferenceSave,
  beginTableSettingIntent,
  confirmTableSettingIntent,
  orderTableSettingWrite,
  readTableSettingIntent,
} from '../../src/lib/tableSettingIntents';
beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());
it('only the newest selection can retire its durable pending record', () => {
  const older = beginTableSettingIntent('a', 'volume', 20);
  const newer = beginTableSettingIntent('a', 'volume', 40);
  confirmTableSettingIntent('a', 'volume', older);
  expect(readTableSettingIntent('a', 'volume')).toEqual({ id: newer, value: 40 });
  expect(readTableSettingIntent('b', 'volume')).toBeNull();
  confirmTableSettingIntent('a', 'volume', newer);
  expect(readTableSettingIntent('a', 'volume')).toBeNull();
});
it('bounds a hung save and lets the next selection leave the original queue', async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  const request = Object.assign(new Promise<{ error: unknown }>(() => {}), {
    abortSignal: (signal: AbortSignal) => {
      signal.addEventListener('abort', abort);
      return new Promise<{ error: unknown }>(() => {});
    },
  });
  const first = orderTableSettingWrite('timeout-a', 'volume', () => awaitPreferenceSave(request));
  const write = vi.fn(async () => ({ error: null }));
  const next = orderTableSettingWrite('timeout-a', 'volume', write);
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(25_000);
  expect((await first).error).toBeInstanceOf(Error);
  expect(abort).toHaveBeenCalledOnce();
  expect(await next).toEqual({ error: null });
});
