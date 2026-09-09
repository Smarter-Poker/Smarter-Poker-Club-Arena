/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  pushClient.ts — BROWSER ONLY. Web push enrollment for Club Arena.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 * ────────────────────────────────────────────────────────────────────────
 * OneSignal was removed on 2026-08-19 and replaced with self-hosted VAPID web
 * push. The World Hub got the whole client flow; Club Arena got nothing. The
 * subscribe prompt lives in the hub's `pages/_app.js`, which a Vite SPA served
 * at /hub/club-arena/ never loads, so no Club Arena player could ever enrol.
 *
 * The cost, measured 2026-08-27 before this file existed:
 *
 *     select count(distinct user_id) from push_subscriptions;   ->  2
 *     select count(*) from push_outbox
 *       where status = 'skipped' and failure_reason = 'no_subscription'
 *       and created_at > now() - interval '7 days';             ->  2432
 *
 * Of 552 people offered a seat, one could receive the push.
 *
 * WHY WE REGISTER /sw.js AND NOT public/sw-bus.js
 * ────────────────────────────────────────────────────────────────────────
 * Club Arena's own worker (public/sw-bus.js, scope /hub/club-arena) handles
 * fetch, message, notificationclick, install and activate — but it has NO
 * 'push' listener and no 'pushsubscriptionchange'. Subscribing against it
 * would produce an endpoint the server happily sends to and the browser
 * silently drops.
 *
 * The obvious fix — add a push handler to sw-bus.js — is the wrong one. Push
 * subscriptions belong to a REGISTRATION, and `push_subscriptions` upserts on
 * (user_id, endpoint). A device holding both the root registration (from the
 * hub) and the /hub/club-arena one would own two endpoints, both active, and
 * every notification would arrive twice.
 *
 * So Club Arena enrols on the SAME root-scope registration the hub uses.
 * /sw.js importScripts the hub's push worker (sp-push-v3), which already has
 * push, notificationclick, pushsubscriptionchange and the /api/push/receipt
 * ping, hardened in production. One device, one subscription, one banner,
 * whichever app the player turned it on in.
 *
 * We are same-origin with the hub (smarter.poker serves both), so /sw.js,
 * /api/push/* and the `smarter-poker-auth` session are all reachable from
 * here with no proxy and no auth handoff. Registering a script at /sw.js from
 * a page at /hub/club-arena/ yields scope '/' because scope is bounded by the
 * SCRIPT's path, not the page's. The two registrations then coexist: Club
 * Arena pages stay controlled by sw-bus.js, which has the longer matching
 * scope, so nothing about CA's offline behaviour changes.
 *
 * Note that register() is called only from enablePush(), i.e. only when a
 * player actually opts in. A player who never turns notifications on never
 * pays for the hub worker's precache.
 *
 * ────────────────────────────────────────────────────────────────────────
 * HARDENING — ported from World Hub src/lib/push-client.js. Every line below
 * exists because of a real failure. Do not "simplify" this file.
 * ────────────────────────────────────────────────────────────────────────
 *
 * 1. withTimeout() wraps EVERY await. iOS can wedge pushManager.subscribe()
 *    indefinitely with no error and no rejection. Without per-step timeouts
 *    the "Enabling..." spinner hangs forever and the user concludes push is
 *    broken.
 *
 * 2. Notification.requestPermission() is called FIRST, before any network
 *    fetch. iOS only honours the permission prompt while the originating user
 *    tap gesture is still alive. Fetching the VAPID key first can exhaust that
 *    gesture window on a slow connection, and the OS prompt then never appears
 *    at all — silently.
 *
 * 3. applicationServerKeyMatches() detects an existing subscription created
 *    with a different VAPID key and re-subscribes, instead of leaving one that
 *    will 403 on every send.
 *
 * 4. One automatic retry: if subscribe() fails, the stale subscription is
 *    force-dropped and the subscribe is attempted once more.
 *
 * 5. waitForActiveWorker() rather than navigator.serviceWorker.ready. `ready`
 *    resolves only when a worker is active AND CONTROLLING the page. A freshly
 *    installed PWA opened from the Home Screen is not controlled yet, so
 *    `ready` waits on an activate+claim round trip that pushManager does not
 *    need. On one bar of signal that read as "Service worker startup timed out"
 *    (Dan, 2026-08-25, on iPhone).
 */

import { installId } from './installId';
import { readLocalSession } from './authUtils';
import { isNativePlatform } from './appBase';

/* ═══════════════════════════════════════════════════════════════════════
   TIMEOUTS
   ═══════════════════════════════════════════════════════════════════════ */

const T = {
  permission: 90_000, // a human needs time to read the OS dialog
  vapid: 10_000,
  register: 10_000,
  /**
   * How long we will wait for a NEWLY REGISTERED root worker to activate.
   *
   * Raised from 30s on 2026-08-29, measured. `/sw.js` is next-pwa's generated
   * worker and its `install` precaches the whole manifest — 826 entries the day
   * this was measured — atomically. On a fast desktop connection that took ~55
   * SECONDS end to end. Under the old 30s ceiling the wait expired while the
   * worker was still legitimately installing, `reg.active` was still null, and
   * the player got "The notification service worker did not start" for a worker
   * that was in fact starting fine.
   *
   * That path is the COMMON one for a Club Arena player, not an edge case: the
   * hub registers this worker on its own pages, Club Arena is a Vite SPA that
   * never loads them, so for somebody who lives in Club Arena the tap on Enable
   * is what registers the root worker for the very first time — and it pays for
   * the entire precache before it can subscribe.
   *
   * 90s is not a spinner budget anybody would choose; it is how long the work
   * actually takes on a phone. The button reads "Enabling..." throughout, and
   * the alternative is a wrong error message on a device that would have
   * succeeded. If this is still not enough, the fix is to stop precaching 826
   * files, not to shorten the wait.
   */
  ready: 90_000,
  getSubscription: 8_000,
  subscribe: 20_000,
  save: 30_000,
} as const;

function withTimeout<T2>(promise: Promise<T2> | T2, ms: number, label: string): Promise<T2> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    ),
  ]);
}

/* ═══════════════════════════════════════════════════════════════════════
   CAPABILITY DETECTION
   ═══════════════════════════════════════════════════════════════════════ */

export function isWebPushSupported(): boolean {
  // Inside the native app there is no Web Push - no push service behind the
  // webview and no root service worker - but push IS supported: the OS hands
  // the app a device token and src/lib/native/push.ts enrols it over the same
  // /api/push/subscribe row (transport 'fcm'). Every caller of this function
  // is asking "can this device receive our notifications", so the answer in
  // the app is yes, and enablePush()/disablePush() below branch to the native
  // transport themselves.
  if (isNativePlatform()) return true;
  if (typeof window === 'undefined') return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export type PushPermission = NotificationPermission | 'unsupported';

/**
 * The native permission state, read from the plugin (async) and cached so the
 * synchronous callers below keep working unchanged. Primed by the native
 * shell at boot and refreshed after every enable/disable.
 */
let nativePermission: NotificationPermission = 'default';

export async function primeNativePushState(): Promise<void> {
  if (!isNativePlatform()) return;
  const { nativeNotificationPermission } = await import('./native/push');
  nativePermission = await nativeNotificationPermission();
}

export function notificationPermission(): PushPermission {
  if (isNativePlatform()) return nativePermission;
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * iOS only exposes the Push API inside an installed PWA (Add to Home Screen).
 * In a plain Safari tab isWebPushSupported() is false, and the honest answer
 * to the user is "install the app first", not "something went wrong".
 */
export function isIosStandalonePwa(): boolean {
  // The app store build IS the installed app; nothing to add to a Home Screen.
  if (isNativePlatform()) return true;
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true || window.matchMedia?.('(display-mode: standalone)')?.matches === true
  );
}

export function isIos(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ENCODING
   ═══════════════════════════════════════════════════════════════════════ */

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** True when an existing subscription was created with the VAPID key we now use. */
function applicationServerKeyMatches(
  subscription: PushSubscription | null,
  vapidKey: string
): boolean {
  try {
    const existing = subscription?.options?.applicationServerKey;
    if (!existing) return true; // cannot tell — assume fine rather than churn
    return bufferToBase64Url(existing as ArrayBuffer) === vapidKey;
  } catch {
    return true;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   DEVICE IDENTITY

   THE KEY IS DELIBERATELY THE HUB'S KEY. Club Arena is served from
   /hub/club-arena/ on the SAME ORIGIN as the hub, so both apps read and write
   one localStorage. Sharing `smarter-poker-push-device-id` is what makes this
   browser ONE device to the server no matter which of the two apps the player
   happened to enable notifications in. A Club-Arena-specific key would mint a
   second identity for the same phone and reintroduce, by a new route, exactly
   the duplicate this exists to stop. If you rename it, rename it in
   `Smarter-Poker-World-Hub/src/lib/push-client.js` in the same commit.

   WHY IT IS NEEDED AT ALL. `replacesEndpoint` only retires the old row while
   the CLIENT still remembers what it is replacing, and it does not after a
   service-worker reinstall, cleared site data, or a PWA re-add — the browser
   mints a fresh endpoint and the previous row is left is_active with nothing
   pointing at it. It is a perfectly valid endpoint, so the push service never
   410s it and no reaper removes it. The dispatcher fans out to every active
   row, so the same phone is sent the same notification once per stale row.

   Measured on production 2026-08-30, before this change: one account, 22 rows,
   4 of them active for 2 physical devices, and two Seat Open banners on one
   iPhone. Every row Club Arena had ever written carried device_id = NULL,
   because this field was never sent — and the partial unique index that is
   supposed to enforce one live row per device is
   `WHERE is_active AND device_id IS NOT NULL`, so it was structurally blind
   to precisely the rows this app creates.

   Returns null rather than throwing: private windows and locked-down browsers
   throw on localStorage access. A missing device id costs a duplicate banner.
   A thrown one would cost the entire subscription, which is far worse.
   ═══════════════════════════════════════════════════════════════════════ */
function deviceId(): string | null {
  // One id per install, shared with the daily bonus claim (src/lib/installId.ts).
  return installId();
}

function deviceLabel(): string {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Browser';
}

/* ═══════════════════════════════════════════════════════════════════════
   AUTH
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * smarter.poker API routes authenticate with a Bearer JWT read from the
 * `smarter-poker-auth` localStorage key — NOT with cookies. Every
 * authenticated fetch here must carry that header or it 401s. Club Arena and
 * the hub share that key (see src/lib/supabase.ts storageKey), which is what
 * makes calling the hub's API from this SPA work at all.
 */
function authHeaders(): Record<string, string> {
  const token = readLocalSession()?.accessToken || null;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   SERVICE WORKER
   ═══════════════════════════════════════════════════════════════════════ */

/** Resolve once THIS registration has an active worker. See hardening note 5. */
function waitForActiveWorker(
  reg: ServiceWorkerRegistration,
  ms: number
): Promise<ServiceWorkerRegistration> {
  if (reg?.active) return Promise.resolve(reg);
  const pending = reg?.installing || reg?.waiting;
  if (!pending) return Promise.resolve(reg);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pending.removeEventListener('statechange', onState);
      clearTimeout(timer);
      resolve(reg);
    };
    const onState = () => {
      // 'redundant' means this worker was replaced — reg.active is the one
      // that won, so stop waiting either way.
      if (pending.state === 'activated' || pending.state === 'redundant') finish();
    };
    const timer = setTimeout(finish, ms);
    pending.addEventListener('statechange', onState);
  });
}

/**
 * Get the ROOT-scope registration that owns push for this origin.
 *
 * Deliberately '/sw.js' and not Club Arena's own sw-bus.js — see the header
 * of this file. If the player has ever opened the hub, register() returns the
 * existing registration rather than making a second one.
 */
async function getPushRegistration(): Promise<ServiceWorkerRegistration> {
  let reg: ServiceWorkerRegistration | null = null;
  try {
    reg = await withTimeout(
      navigator.serviceWorker.register('/sw.js'),
      T.register,
      'Service worker registration'
    );
  } catch {
    // Already registered by the hub, or the call raced. Fall through.
  }

  if (!reg) {
    try {
      reg = (await navigator.serviceWorker.getRegistration('/')) || null;
    } catch {
      /* ignore */
    }
  }

  if (reg) {
    await waitForActiveWorker(reg, T.ready);
    // An active worker is all subscribe() needs. Control is irrelevant.
    if (reg.active && reg.pushManager) return reg;

    // Still installing when the wait ran out. This is NOT the same failure as
    // "the worker died", and telling somebody to reload while a precache is
    // half done throws that work away and starts it over. Say what is true.
    if (reg.installing) {
      throw new Error(
        'Notifications are still setting up on this device. Give it a moment and tap Enable again.'
      );
    }
  }

  // Nothing usable yet. `ready` resolves against whichever registration
  // controls this page — on a Club Arena route that is sw-bus.js, which
  // cannot display a push, so a subscription made against it would be a
  // silent dead end. Refusing here produces an error the user can act on.
  throw new Error('The notification service worker did not start. Reload and try again.');
}

/* ═══════════════════════════════════════════════════════════════════════
   PERSISTENCE
   ═══════════════════════════════════════════════════════════════════════ */

async function fetchVapidKey(): Promise<string> {
  const res = await withTimeout(fetch('/api/push/vapid-public-key'), T.vapid, 'VAPID key fetch');
  if (!res.ok) {
    if (res.status === 503) throw new Error('Push is not configured on this deployment yet.');
    throw new Error(`Could not load the push key (${res.status})`);
  }
  const json = (await res.json()) as { key?: string };
  if (!json?.key) throw new Error('Push key response was empty');
  return json.key;
}

async function persistSubscription(
  subscription: PushSubscription,
  replacedEndpoint: string | null
): Promise<true> {
  const json = subscription.toJSON();
  const res = await withTimeout(
    fetch('/api/push/subscribe', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: json.keys,
        userAgent: navigator.userAgent,
        deviceLabel: deviceLabel(),
        // The endpoint this one supersedes, so the server can retire it.
        // Without this the old row stays is_active=true forever: it inflates
        // the device count on /admin/push-health and every send burns a
        // request on it until the push service finally 404s.
        replacesEndpoint: replacedEndpoint || undefined,
        // Stable per browser profile, shared with the hub. The server retires
        // any other live row this device owns before upserting this one, which
        // is the only thing that works when the endpoint has rotated and
        // `replacesEndpoint` above is therefore unknown. See deviceId().
        deviceId: deviceId() || undefined,
      }),
    }),
    T.save,
    'Saving your subscription'
  );
  if (res.status === 401) throw new Error('You need to be signed in to enable notifications.');
  if (res.status === 409) {
    throw new Error('This device is registered to another account. Sign out there first.');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body?.error || `Could not save subscription (${res.status})`);
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
   OPT-OUT
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Explicit opt-out marker.
 *
 * Turning push off does NOT revoke the OS permission — Notification.permission
 * stays 'granted'. The repair loop only skips when permission is not granted,
 * so without this marker it would silently re-subscribe the device on the next
 * boot, undoing a deliberate choice. That is a consent bug, not a UX wrinkle.
 *
 * The key is SHARED with the World Hub (same origin, same localStorage) on
 * purpose: turning push off in one app must mean off in the other. There is
 * one device and one subscription behind both.
 */
const OPT_OUT_KEY = 'sp_push_opt_out';

export function isOptedOut(): boolean {
  try {
    return Boolean(localStorage.getItem(OPT_OUT_KEY));
  } catch {
    return false;
  }
}

function setOptOut(): void {
  try {
    localStorage.setItem(OPT_OUT_KEY, String(Date.now()));
  } catch {
    /* private mode */
  }
}

function clearOptOut(): void {
  try {
    localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    /* private mode */
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════════════════════════════════ */

export interface PushResult {
  ok: boolean;
  error?: string;
  permission?: PushPermission;
}

/**
 * Enable push on this device.
 *
 * MUST be called synchronously from a click handler. iOS only honours the
 * permission prompt while the originating tap gesture is alive, so callers
 * may not await anything before this.
 */
export async function enablePush(): Promise<PushResult> {
  if (isNativePlatform()) {
    const { enableNativePush } = await import('./native/push');
    const result = await enableNativePush();
    if (result.permission) nativePermission = result.permission;
    if (result.ok) clearOptOut();
    return result;
  }
  if (!isWebPushSupported()) {
    if (isIos() && !isIosStandalonePwa()) {
      return {
        ok: false,
        error:
          'On iPhone and iPad, add Smarter Poker to your Home Screen first. Tap Share, then Add To Home Screen, then open it from there.',
      };
    }
    return { ok: false, error: 'This browser does not support push notifications.' };
  }

  // ── STEP 1: permission FIRST, while the tap gesture is still alive ──────
  let permission: NotificationPermission = Notification.permission;
  if (permission === 'default') {
    try {
      permission = await withTimeout(
        Notification.requestPermission(),
        T.permission,
        'Permission prompt'
      );
    } catch (e) {
      return {
        ok: false,
        error: (e as Error)?.message || 'The permission prompt did not respond.',
      };
    }
  }
  if (permission !== 'granted') {
    return {
      ok: false,
      permission,
      error:
        permission === 'denied'
          ? 'Notifications are blocked for this site. Turn them back on in your browser settings and try again.'
          : 'Notification permission was not granted.',
    };
  }

  try {
    // ── STEP 2: key + worker ─────────────────────────────────────────────
    const vapidKey = await fetchVapidKey();
    const registration = await getPushRegistration();

    // ── STEP 3: reuse or replace an existing subscription ────────────────
    let subscription = await withTimeout(
      registration.pushManager.getSubscription(),
      T.getSubscription,
      'Reading the existing subscription'
    );

    let replacedEndpoint: string | null = null;

    if (subscription && !applicationServerKeyMatches(subscription, vapidKey)) {
      // Subscribed under a different VAPID key — every send would 403.
      replacedEndpoint = subscription.endpoint || null;
      try {
        await subscription.unsubscribe();
      } catch {
        /* ignore */
      }
      subscription = null;
    }

    if (!subscription) {
      const options: PushSubscriptionOptionsInit = {
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      };
      try {
        subscription = await withTimeout(
          registration.pushManager.subscribe(options),
          T.subscribe,
          'Subscribing this device'
        );
      } catch {
        // ── one automatic retry: drop whatever is stuck, try once more.
        try {
          const stale = await registration.pushManager.getSubscription();
          if (stale) {
            replacedEndpoint = replacedEndpoint || stale.endpoint || null;
            await stale.unsubscribe();
          }
        } catch {
          /* ignore */
        }
        subscription = await withTimeout(
          registration.pushManager.subscribe(options),
          T.subscribe,
          'Subscribing this device (retry)'
        );
      }
    }

    // ── STEP 4: persist ──────────────────────────────────────────────────
    // Never report the endpoint we just created as the one it replaced.
    await persistSubscription(
      subscription,
      replacedEndpoint && replacedEndpoint !== subscription.endpoint ? replacedEndpoint : null
    );
    clearOptOut();
    return { ok: true, permission: 'granted' };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'Could not enable notifications.' };
  }
}

/** Turn push off on this device: unsubscribe locally AND deactivate server-side. */
export async function disablePush(): Promise<PushResult> {
  // Record the choice even if the unsubscribe below fails — the user asked for
  // off, and the repair loop must honour that regardless.
  setOptOut();
  if (isNativePlatform()) {
    const { disableNativePush } = await import('./native/push');
    return disableNativePush();
  }
  if (!isWebPushSupported()) return { ok: true };
  try {
    const registration = await withTimeout(
      navigator.serviceWorker.getRegistration('/'),
      T.ready,
      'Service worker lookup'
    );
    const subscription = registration
      ? await withTimeout(
          registration.pushManager.getSubscription(),
          T.getSubscription,
          'Reading the existing subscription'
        )
      : null;

    if (subscription) {
      // Timeout the DELETE: it is awaited before the local unsubscribe, so a
      // stalled request used to block "off" entirely.
      await withTimeout(
        fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: authHeaders(),
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }),
        T.save,
        'Removing your subscription'
      ).catch(() => null);
      try {
        await subscription.unsubscribe();
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'Could not disable notifications.' };
  }
}

export interface TestPushResult {
  ok: boolean;
  /** How many of this account's devices the push service accepted. */
  sent: number;
  error?: string;
}

/**
 * Fire a test push at this account and report how many devices accepted it.
 *
 * WHY THIS IS WORTH A BUTTON. Every other signal about push health is a proxy.
 * `Notification.permission` says the OS dialog was accepted. A row in
 * push_subscriptions says a subscription was persisted. Neither tells anybody
 * whether a notification will actually arrive on the phone in their hand, and
 * the gap between those two things is precisely where this stack has failed
 * before: a rotated endpoint the server still believes in, a worker with no
 * push handler, a vendor switched off a week earlier. Without a test the next
 * confirmation is an unpredictable real event, which is no way to debug.
 *
 * The server deliberately bypasses the per-type preference gate for this, so a
 * category toggle cannot make a healthy subscription look broken. `mute_all`
 * and `push_enabled` still apply, because those are the player saying stop,
 * and the response explains which one fired.
 */
export async function sendTestPush(): Promise<TestPushResult> {
  try {
    const res = await withTimeout(
      fetch('/api/push/test', { method: 'POST', headers: authHeaders(), body: JSON.stringify({}) }),
      15_000,
      'Test push'
    );
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      sent?: number;
      error?: string;
      hint?: string;
      reason?: string;
    };
    if (res.status === 401) {
      return { ok: false, sent: 0, error: 'You need to be signed in to send a test.' };
    }
    if (res.status === 503) {
      return { ok: false, sent: 0, error: 'Push is not configured on this deployment yet.' };
    }
    if (!res.ok) {
      return { ok: false, sent: 0, error: json?.error || `Test failed (${res.status})` };
    }
    if (json.ok === true) return { ok: true, sent: json.sent || 0 };
    return {
      ok: false,
      sent: 0,
      // `hint` is the server's plain-English reading of `reason`. Prefer it,
      // and fall back to the raw reason rather than to nothing: an unexplained
      // failure here is the exact ambiguity the button exists to remove.
      error: json.hint || json.reason || 'The test push was not delivered.',
    };
  } catch (e) {
    return { ok: false, sent: 0, error: (e as Error)?.message || 'Test push failed.' };
  }
}

/**
 * Is this specific device currently subscribed?
 *
 * Reads the ROOT registration, which is the one that owns push. Asking
 * Notification.permission instead — as Club Arena's settings page did until
 * 2026-08-27 — answers a different question and answers it wrong: permission
 * is granted the moment the OS dialog is accepted, whether or not a
 * subscription was ever created or persisted.
 */
export async function hasLocalSubscription(): Promise<boolean> {
  if (isNativePlatform()) {
    const { hasNativeSubscription } = await import('./native/push');
    return hasNativeSubscription();
  }
  if (!isWebPushSupported()) return false;
  try {
    const registration = await withTimeout(
      navigator.serviceWorker.getRegistration('/'),
      T.ready,
      'Service worker lookup'
    );
    if (!registration) return false;
    const sub = await withTimeout(
      registration.pushManager.getSubscription(),
      T.getSubscription,
      'Reading subscription'
    );
    return Boolean(sub);
  } catch {
    return false;
  }
}

/* Shared with the native transport (src/lib/native/push.ts) so a device token
   row carries the same device identity and the same Bearer header a browser
   subscription does. */
export { deviceId as pushDeviceId, authHeaders as pushAuthHeaders };

export default {
  enablePush,
  disablePush,
  sendTestPush,
  hasLocalSubscription,
  isWebPushSupported,
  notificationPermission,
  isOptedOut,
  isIos,
  isIosStandalonePwa,
};
