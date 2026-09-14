/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NATIVE PUSH — APNs and FCM device tokens for the Club Arena app
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Store readiness, phase 4b. Inside the Capacitor webview there is no Web
 * Push: no push service, no root service worker, no VAPID. The OS hands the
 * app a DEVICE TOKEN instead (APNs on iOS, FCM on Android; Firebase relays
 * both), and the Hub's outbox delivers to it over FCM HTTP v1
 * (Smarter-Poker-World-Hub src/lib/push/fcm.js, PR #1568).
 *
 * The token rides the SAME row shape and the SAME endpoint a browser
 * subscription uses: POST /api/push/subscribe with `transport: 'fcm'`, the
 * token as `endpoint`, no keys. One device, one row, one dispatcher - the
 * player's preferences, mute_all and the per-type gates apply unchanged.
 *
 * This module is reached only from src/lib/pushClient.ts (behind
 * isNativePlatform()) and from src/lib/nativeShell.ts, so none of it is in
 * the web bundle.
 *
 * Tap routing: every payload carries `data.url` (fcm.js guarantees it). A url
 * under /hub/club-arena/ routes inside the app through the deep-link handler;
 * any other Hub page opens in the in-app browser, the same way every other
 * Hub link does on native (src/lib/openExternal.ts).
 */

import { nativePlatform } from '../appBase';
import { pushAuthHeaders, pushDeviceId } from '../pushClient';
import { openPushUrl } from './openPushUrl';
export { openPushUrl } from './openPushUrl';

/* Same shape as Capacitor's PluginListenerHandle; declared here so the only
   Capacitor imports in this file are dynamic (the web-bundle law). */
interface ListenerHandle {
  remove: () => Promise<void>;
}

const TOKEN_KEY = 'ca.push.token';
const REGISTER_TIMEOUT_MS = 20_000;

let wired = false;
let latestToken: string | null = null;
const tokenWaiters = new Set<(t: string) => void>();
const registrationErrors = new Set<(e: Error) => void>();

async function plugin() {
  const { PushNotifications } = await import('@capacitor/push-notifications');
  return PushNotifications;
}

async function prefs() {
  const { Preferences } = await import('@capacitor/preferences');
  return Preferences;
}

async function rememberToken(token: string | null): Promise<void> {
  const Preferences = await prefs();
  if (token) await Preferences.set({ key: TOKEN_KEY, value: token });
  else await Preferences.remove({ key: TOKEN_KEY });
}

export async function storedToken(): Promise<string | null> {
  try {
    const Preferences = await prefs();
    const { value } = await Preferences.get({ key: TOKEN_KEY });
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Attach the plugin listeners once per launch. Called from the native shell
 * at boot so a tap on a notification that COLD-STARTED the app is still
 * routed: Capacitor replays `pushNotificationActionPerformed` to the first
 * listener attached.
 */
export async function initNativePush(): Promise<ListenerHandle[]> {
  if (wired) return [];
  wired = true;
  const PushNotifications = await plugin();
  const handles: ListenerHandle[] = [];

  handles.push(
    await PushNotifications.addListener('registration', ({ value }) => {
      latestToken = value;
      for (const w of tokenWaiters) w(value);
      tokenWaiters.clear();
    })
  );
  handles.push(
    await PushNotifications.addListener('registrationError', ({ error }) => {
      const err = new Error(String(error || 'Push registration failed'));
      for (const w of registrationErrors) w(err);
      registrationErrors.clear();
    })
  );
  handles.push(
    await PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const data = (notification?.data || {}) as Record<string, unknown>;
      void openPushUrl(typeof data.url === 'string' ? data.url : undefined);
    })
  );
  return handles;
}

/** Ask the OS for a token. Resolves with the token or rejects on error/timeout. */
async function registerForToken(): Promise<string> {
  await initNativePush();
  const PushNotifications = await plugin();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      tokenWaiters.delete(onToken);
      registrationErrors.delete(onError);
      reject(new Error('The device did not return a push token in time.'));
    }, REGISTER_TIMEOUT_MS);
    const onToken = (t: string) => {
      clearTimeout(timer);
      registrationErrors.delete(onError);
      resolve(t);
    };
    const onError = (e: Error) => {
      clearTimeout(timer);
      tokenWaiters.delete(onToken);
      reject(e);
    };
    tokenWaiters.add(onToken);
    registrationErrors.add(onError);
    void PushNotifications.register().catch(onError);
  });
}

export interface NativePushResult {
  ok: boolean;
  error?: string;
  permission?: 'granted' | 'denied' | 'default';
}

/** Permission prompt, token, then the Hub row. Call from a tap handler. */
export async function enableNativePush(): Promise<NativePushResult> {
  const PushNotifications = await plugin();
  let status = (await PushNotifications.checkPermissions()).receive;
  if (status === 'prompt' || status === 'prompt-with-rationale') {
    status = (await PushNotifications.requestPermissions()).receive;
  }
  if (status !== 'granted') {
    return {
      ok: false,
      permission: 'denied',
      error:
        'Notifications are turned off for Club Arena. Turn them on in your phone settings and try again.',
    };
  }

  let token: string;
  try {
    token = await registerForToken();
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'Could not register this device.' };
  }

  const previous = await storedToken();
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: pushAuthHeaders(),
    body: JSON.stringify({
      transport: 'fcm',
      platform: nativePlatform(),
      endpoint: token,
      userAgent: navigator.userAgent,
      deviceLabel: nativePlatform() === 'ios' ? 'iPhone' : 'Android',
      deviceId: pushDeviceId() || undefined,
      replacesEndpoint: previous && previous !== token ? previous : undefined,
    }),
  });
  if (res.status === 401) {
    return { ok: false, error: 'You need to be signed in to enable notifications.' };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body?.error || `Could not save subscription (${res.status})` };
  }
  await rememberToken(token);
  return { ok: true, permission: 'granted' };
}

/** Retire the Hub row for this token and drop the local copy. */
export async function disableNativePush(): Promise<NativePushResult> {
  const token = latestToken || (await storedToken());
  if (token) {
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: pushAuthHeaders(),
      body: JSON.stringify({ endpoint: token }),
    }).catch(() => null);
  }
  await rememberToken(null);
  latestToken = null;
  try {
    const PushNotifications = await plugin();
    await PushNotifications.unregister();
  } catch {
    /* the OS may refuse; the row is already retired */
  }
  return { ok: true };
}

/** Is this device enrolled (a token was saved to the Hub from this install)? */
export async function hasNativeSubscription(): Promise<boolean> {
  return Boolean(await storedToken());
}

/**
 * The permission state in Web Notification terms, so the settings page can
 * reuse its existing copy for 'denied'.
 */
export async function nativeNotificationPermission(): Promise<'granted' | 'denied' | 'default'> {
  try {
    const PushNotifications = await plugin();
    const { receive } = await PushNotifications.checkPermissions();
    if (receive === 'granted') return 'granted';
    if (receive === 'denied') return 'denied';
    return 'default';
  } catch {
    return 'default';
  }
}
