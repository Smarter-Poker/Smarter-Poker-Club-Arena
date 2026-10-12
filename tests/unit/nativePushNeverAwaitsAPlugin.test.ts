/**
 * The device-push module never resolves a promise with a Capacitor plugin.
 *
 * Found on the Android emulator, 2026-09-29: a Capacitor plugin object is a
 * Proxy that turns EVERY property into a native call, `then` included. push.ts
 * returned the plugin from an async helper, the promise adopted it as a
 * thenable, the runtime called PushNotifications.then(), and Android answered
 * '"PushNotifications.then()" is not implemented on android'. So the push
 * listeners were never attached at launch, Enable spun on "Enabling..."
 * forever, and no token was stored. The existing tests mocked the plugins as
 * plain objects, which have no `then`, so they could not see it.
 *
 * These mocks behave like the real thing: any property is a method, and
 * `then` throws exactly what Android threw.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

function capacitorLike(name: string, methods: Record<string, (...a: unknown[]) => unknown>) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop in methods) return methods[prop];
        return () => {
          throw new Error(`"${name}.${String(prop)}()" is not implemented on android`);
        };
      },
    }
  );
}

const calls = vi.hoisted(() => ({ listeners: [] as string[], store: new Map<string, string>() }));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: capacitorLike('PushNotifications', {
    addListener: async (event: unknown) => {
      calls.listeners.push(String(event));
      return { remove: async () => undefined };
    },
    checkPermissions: async () => ({ receive: 'granted' }),
    requestPermissions: async () => ({ receive: 'granted' }),
    register: async () => undefined,
    unregister: async () => undefined,
  }),
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: capacitorLike('Preferences', {
    get: async ({ key }: { key: string }) => ({ value: calls.store.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      calls.store.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      calls.store.delete(key);
    },
  }),
}));

import {
  initNativePush,
  nativeNotificationPermission,
  storedToken,
  hasNativeSubscription,
} from '../../src/lib/native/push';

describe('device push with plugins that behave like Capacitor', () => {
  beforeEach(() => {
    calls.listeners.length = 0;
    calls.store.clear();
  });

  it('attaches the three listeners at launch instead of rejecting', async () => {
    await expect(initNativePush()).resolves.toBeDefined();
    expect(calls.listeners).toEqual([
      'registration',
      'registrationError',
      'pushNotificationActionPerformed',
    ]);
  });

  it('reads the permission and the stored token without calling then() on a plugin', async () => {
    await expect(nativeNotificationPermission()).resolves.toBe('granted');
    calls.store.set('ca.push.token', 'tok-1');
    await expect(storedToken()).resolves.toBe('tok-1');
    await expect(hasNativeSubscription()).resolves.toBe(true);
  });
});
