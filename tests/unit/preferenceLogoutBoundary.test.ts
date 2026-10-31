import { afterEach, expect, it, vi } from 'vitest';
import {
  flushPreferencesBeforeLogout,
  registerPreferenceFlush,
  trackPreferenceWrite,
  beginTableSettingIntent,
  readTableSettingIntent,
} from '../../src/lib/tableSettingIntents';
afterEach(() => vi.useRealTimers());
it('awaits original request owners and in-flight lobby writes only for the account signing out', async () => {
  let finish!: () => void;
  let settled = false;
  let other = false;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const a = registerPreferenceFlush('logout-a', () => pending);
  const b = registerPreferenceFlush('logout-b', () => {
    other = true;
  });
  trackPreferenceWrite('logout-a', pending);
  const logout = flushPreferencesBeforeLogout('logout-a').then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(other).toBe(false);
  finish();
  await logout;
  expect(settled).toBe(true);
  expect(other).toBe(false);
  a();
  b();
});
it('bounds an interrupted logout save without clearing its durable pending intent', async () => {
  vi.useFakeTimers();
  localStorage.clear();
  const id = beginTableSettingIntent('logout-c', 'page:filter', 'mine');
  const stop = registerPreferenceFlush('logout-c', () => new Promise(() => {}));
  const logout = flushPreferencesBeforeLogout('logout-c');
  await vi.advanceTimersByTimeAsync(25_000);
  await logout;
  expect(readTableSettingIntent('logout-c', 'page:filter')).toEqual({ id, value: 'mine' });
  stop();
});
