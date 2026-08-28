/**
 * CLUB ARENA MUST BE ABLE TO ENROL A DEVICE FOR PUSH.
 *
 * THE STATE THIS TEST WAS WRITTEN AGAINST (measured 2026-08-27)
 * ────────────────────────────────────────────────────────────────────────
 *     select count(distinct user_id) from push_subscriptions;   ->  2
 *     select count(*) from push_outbox where status = 'skipped'
 *       and failure_reason = 'no_subscription'
 *       and created_at > now() - interval '7 days';             ->  2432
 *
 * Of 552 people offered a seat, one could receive the push. Not because the
 * server side was broken - the VAPID keys, /api/push/subscribe, push_outbox
 * and the dispatch cron were all live and correct - but because Club Arena
 * contained no code that could ever call pushManager.subscribe(). The prompt
 * lived in the World Hub's pages/_app.js, which this SPA never loads.
 *
 * Two of the four assertions below are structural rather than behavioural,
 * because the failure they guard is structural: not "this function returns the
 * wrong value" but "nothing calls this function at all", which is exactly the
 * shape that went unnoticed for eight days.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

/* ═══════════════════════════════════════════════════════════════════════
   A REAL ENROLMENT
   ═══════════════════════════════════════════════════════════════════════ */

const VAPID_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-endpoint';

function signedInToken(): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  const payload = {
    sub: '11111111-2222-3333-4444-555555555555',
    email: 'player@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return `header.${b64(payload)}.signature`;
}

interface Harness {
  register: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
}

function installBrowser(overrides: { existingSubscription?: unknown } = {}): Harness {
  const subscription = {
    endpoint: ENDPOINT,
    options: {},
    toJSON: () => ({ keys: { p256dh: 'p256dh-value', auth: 'auth-value' } }),
    unsubscribe: vi.fn(async () => true),
  };

  const getSubscription = vi.fn(async () => overrides.existingSubscription ?? null);
  const subscribe = vi.fn(async () => subscription);

  const registration = {
    active: {},
    installing: null,
    waiting: null,
    pushManager: { getSubscription, subscribe },
  };

  const register = vi.fn(async () => registration);

  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register,
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    },
  });

  (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};

  (globalThis as unknown as { Notification: unknown }).Notification = {
    permission: 'granted',
    requestPermission: vi.fn(async () => 'granted'),
  };

  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/push/vapid-public-key')) {
      return { ok: true, status: 200, json: async () => ({ key: VAPID_KEY }) };
    }
    if (String(url).includes('/api/push/subscribe')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, subscribed: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);

  localStorage.setItem('smarter-poker-auth', JSON.stringify({ access_token: signedInToken() }));
  localStorage.removeItem('sp_push_opt_out');

  return { register, subscribe, getSubscription, fetchMock };
}

describe('a Club Arena player can enrol this device for push', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('subscribes and persists the subscription to the hub API', async () => {
    const h = installBrowser();
    const { enablePush } = await import('../src/lib/pushClient');

    const result = await enablePush();

    expect(result.ok).toBe(true);
    expect(h.subscribe).toHaveBeenCalledTimes(1);

    const saved = h.fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/push/subscribe'));
    expect(saved, 'the subscription must be POSTed to the server').toBeTruthy();

    const init = saved![1] as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe('POST');
    // Hub API routes authenticate on a Bearer JWT from `smarter-poker-auth`,
    // not on cookies. Without this header the call 401s and the device is
    // never recorded, which looks identical to "push is broken".
    expect(init.headers.Authorization).toMatch(/^Bearer /);

    const body = JSON.parse(init.body);
    expect(body.endpoint).toBe(ENDPOINT);
    expect(body.keys).toEqual({ p256dh: 'p256dh-value', auth: 'auth-value' });
  });

  it('enrols on the ROOT service worker, not on Club Arena scope', async () => {
    // public/sw-bus.js has no 'push' listener. A subscription made against it
    // would be accepted by the browser, stored by the server, sent to
    // successfully, and displayed by nobody. Registering /sw.js also keeps ONE
    // subscription per device across both apps: push_subscriptions upserts on
    // (user_id, endpoint), so a second registration would mean two active rows
    // and every notification arriving twice.
    const h = installBrowser();
    const { enablePush } = await import('../src/lib/pushClient');

    await enablePush();

    expect(h.register).toHaveBeenCalledWith('/sw.js');
    for (const call of h.register.mock.calls) {
      expect(String(call[0])).not.toContain('sw-bus');
    }
  });

  it('explains a test push that was accepted by the server but suppressed', async () => {
    // The server answers 200 with ok:false when a real switch stopped the push
    // (mute_all, push_enabled). Reporting that as a bare failure would send the
    // player hunting a broken subscription that is working perfectly, so the
    // hint has to survive into the toast.
    installBrowser();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: false,
          sent: 0,
          reason: 'mute_all',
          hint: 'Mute All is switched on in your notification settings.',
        }),
      }))
    );
    const { sendTestPush } = await import('../src/lib/pushClient');

    const result = await sendTestPush();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Mute All');
  });

  it('refuses to re-subscribe a device the player switched off', async () => {
    // The OS permission stays 'granted' after an unsubscribe, so without the
    // opt-out marker the hourly repair loop would silently undo a deliberate
    // choice. That is a consent bug, not a UX wrinkle.
    installBrowser();
    const { isOptedOut, disablePush } = await import('../src/lib/pushClient');

    expect(isOptedOut()).toBe(false);
    await disablePush();
    expect(isOptedOut()).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   THE WIRING, ASSERTED AT THE SOURCE
   ═══════════════════════════════════════════════════════════════════════ */

describe('the enrolment path is actually reachable', () => {
  const APP = read('src/App.tsx');
  const SETTINGS = read('src/pages/SettingsPage.tsx');
  const NOTIF_PAGE = read('src/pages/NotificationsPage.tsx');
  const SW_BUS = read('public/sw-bus.js');

  it('mounts the prompt and the repair loop at the app root', () => {
    // A component nobody renders is the exact failure this whole change
    // exists to correct. Club Arena HAD notification code; it had no code
    // that could produce a subscription, and nothing said so.
    expect(APP).toContain('<FirstRunPushPrompt />');
    expect(APP).toContain('<PushSubscriptionSync />');
  });

  it('offers a way back in from the notifications page', () => {
    expect(NOTIF_PAGE).toContain('<PushEnableBanner />');
  });

  it('no longer claims push is enabled when only permission was granted', () => {
    // The old Settings button awaited notificationService.requestPermission(),
    // which returns a boolean and creates nothing, then toasted success and
    // rendered a permanent green "Active" badge. Anyone who pressed it was
    // told they were subscribed while push_subscriptions held nothing for
    // them.
    //
    // Asserted on the IMPORT rather than on the call site, because the file
    // still names that function in the comment recording what it used to do,
    // and that comment is the thing most worth keeping.
    expect(SETTINGS).not.toMatch(/^import .*notificationService.*$/m);
    expect(SETTINGS).not.toMatch(/await\s+notificationService\./);
    expect(SETTINGS).toContain('hasLocalSubscription');
    expect(SETTINGS).toContain('enablePush');
    expect(SETTINGS).toContain('disablePush');
  });

  it('never puts the one-time prompt on the felt', () => {
    // The prompt asks once per account per browser and then closes that door
    // for good. Landing on a live table means a person mid-hand dismisses it
    // reflexively and sp_firstrun_notif_<uid> records that reflex as a
    // considered no. It must DEFER, not spend the ask.
    const PROMPT = read('src/components/notifications/FirstRunPushPrompt.tsx');
    expect(PROMPT).toContain('SUPPRESSED_ROUTES');
    expect(PROMPT).toMatch(/'\/table'/);
    expect(PROMPT).toContain('useLocation');
    // The route must be a dependency of the arming effect, or leaving the
    // table would never re-arm and a player who only plays is never asked.
    expect(PROMPT).toMatch(/\[pending, state, suppressed\]/);
  });

  it('gives a subscribed device a way to prove push actually arrives', () => {
    const SETTINGS = read('src/pages/SettingsPage.tsx');
    const CLIENT = read('src/lib/pushClient.ts');
    expect(CLIENT).toContain('/api/push/test');
    expect(SETTINGS).toContain('sendTestPush');
    expect(SETTINGS).toContain('Send Test');
  });

  it('records why sw-bus.js is not the push worker', () => {
    // If a future change adds a 'push' handler to sw-bus.js, this fails and
    // sends the reader to the duplicate-subscription reasoning in
    // src/lib/pushClient.ts before they also point enrolment at it.
    expect(SW_BUS).not.toMatch(/addEventListener\(\s*['"]push['"]/);
  });
});
