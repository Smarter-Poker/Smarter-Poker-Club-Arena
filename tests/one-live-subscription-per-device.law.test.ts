/**
 * ONE LIVE PUSH SUBSCRIPTION PER DEVICE.
 *
 * Dan, 2026-08-30, from an iPhone: "I'M GETTING DOUBLE NOTIFICATIONS FOR THE
 * SAME OPEN SEAT."
 *
 * WHAT WAS ACTUALLY WRONG
 * ────────────────────────────────────────────────────────────────────────
 * A push endpoint is NOT stable. The browser mints a fresh one after a
 * service-worker reinstall, after site data is cleared, after a PWA re-add,
 * and on a failed-then-retried subscribe. The old row stays `is_active` with
 * nothing pointing at it: it is still a perfectly valid endpoint, so the push
 * service never 410s it and no reaper removes it. `/api/cron/push-dispatch`
 * selects EVERY active row for the user and sends to each, so one phone gets
 * one notification once per stale row.
 *
 * `replacesEndpoint` was supposed to cover this and cannot: it only works
 * while the CLIENT still remembers the endpoint being replaced, which is
 * precisely what is lost in every case above.
 *
 * The server-side cure already existed, and Club Arena was not using it.
 * `/api/push/subscribe` retires a user's other live rows carrying the same
 * `deviceId` before upserting, and a partial unique index enforces it:
 *
 *     push_subscriptions_one_active_per_device_uidx
 *     ON (user_id, device_id) WHERE is_active AND device_id IS NOT NULL
 *
 * Note the `device_id IS NOT NULL`. Rows without one are exempt. Club Arena
 * never sent the field, so every row this app had ever written was exempt from
 * the guard built to prevent this exact duplicate - and Club Arena is the app
 * on the phone, so it is the app the complaint came from.
 *
 * Measured on production immediately before this fix: one account, 22 rows,
 * 4 active for 2 physical devices, two Seat Open banners on one iPhone.
 *
 * WHY THE KEY IS SHARED WITH THE WORLD HUB
 * ────────────────────────────────────────────────────────────────────────
 * Club Arena is served from /hub/club-arena/ on the SAME ORIGIN as the hub, so
 * the two apps share one localStorage. They must agree on one id for one
 * browser, or a phone that enabled notifications in the hub and again in Club
 * Arena becomes two devices to the server and the duplicate returns by a new
 * route. SHARED_DEVICE_ID_KEY is pinned as a literal on purpose: it is a
 * cross-repo contract with `Smarter-Poker-World-Hub/src/lib/push-client.js`,
 * and a test in this repo cannot import that file. Rename it in both or
 * neither.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Must equal DEVICE_ID_KEY in BOTH club-arena/src/lib/pushClient.ts and
 * Smarter-Poker-World-Hub/src/lib/push-client.js.
 */
const SHARED_DEVICE_ID_KEY = 'smarter-poker-push-device-id';

const VAPID_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

function signedInToken(): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `header.${b64({
    sub: '11111111-2222-3333-4444-555555555555',
    email: 'player@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

/**
 * `endpoint` is a parameter so a test can enrol twice with DIFFERENT
 * endpoints, which is the real-world case: the endpoint rotated, and the id in
 * storage is the only thing left that still identifies the device.
 */
function installBrowser(endpoint: string) {
  const subscription = {
    endpoint,
    options: {},
    toJSON: () => ({ keys: { p256dh: 'p256dh-value', auth: 'auth-value' } }),
    unsubscribe: vi.fn(async () => true),
  };

  const registration = {
    active: {},
    installing: null,
    waiting: null,
    pushManager: {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => subscription),
    },
  };

  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
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

  return { fetchMock };
}

function savedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/push/subscribe'));
  expect(call, 'the subscription must be POSTed to the server').toBeTruthy();
  return JSON.parse((call![1] as { body: string }).body);
}

describe('one live push subscription per device', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sends a deviceId, so the server can retire the other rows this device owns', async () => {
    // Without this field the server cannot run its same-device retire, and the
    // unique index does not apply either, because both are keyed on a NON-NULL
    // device_id. Every Club Arena row on production carried NULL here.
    const { fetchMock } = installBrowser('https://fcm.googleapis.com/fcm/send/first');
    const { enablePush } = await import('../src/lib/pushClient');

    const result = await enablePush();
    expect(result.ok).toBe(true);

    const body = savedBody(fetchMock);
    expect(typeof body.deviceId, 'deviceId must be sent on every subscribe').toBe('string');
    // The server validates /^[A-Za-z0-9-]{8,64}$/ and SILENTLY DROPS anything
    // else, which would put us straight back to a NULL device_id.
    expect(body.deviceId as string).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it('reads the id from the key the World Hub writes, not one of its own', async () => {
    // Same origin, one localStorage. If Club Arena minted its own key, a phone
    // that enabled notifications in both apps would be two devices to the
    // server and would receive everything twice - the same bug, new door.
    localStorage.setItem(SHARED_DEVICE_ID_KEY, 'hub-written-device-id-1234');

    const { fetchMock } = installBrowser('https://fcm.googleapis.com/fcm/send/first');
    const { enablePush } = await import('../src/lib/pushClient');
    await enablePush();

    expect(savedBody(fetchMock).deviceId).toBe('hub-written-device-id-1234');
  });

  it('keeps the SAME id when the endpoint rotates', async () => {
    // This is the whole point. A rotated endpoint produces a new row; the id is
    // the only thing left saying the new row and the old row are one phone.
    const first = installBrowser('https://fcm.googleapis.com/fcm/send/first');
    const { enablePush } = await import('../src/lib/pushClient');
    await enablePush();
    const idOne = savedBody(first.fetchMock).deviceId;
    expect(typeof idOne).toBe('string');

    vi.unstubAllGlobals();
    vi.resetModules();

    // Storage survives, the endpoint does not. Exactly what a service-worker
    // reinstall does to this device.
    const second = installBrowser('https://fcm.googleapis.com/fcm/send/SECOND-endpoint');
    const { enablePush: enableAgain } = await import('../src/lib/pushClient');
    await enableAgain();
    const bodyTwo = savedBody(second.fetchMock);

    expect(bodyTwo.endpoint).toBe('https://fcm.googleapis.com/fcm/send/SECOND-endpoint');
    expect(bodyTwo.deviceId, 'a re-subscribe must not mint a new device').toBe(idOne);
  });

  it('still enrols when localStorage throws', async () => {
    // Private windows and locked-down browsers throw on ACCESS, not just on
    // write. A missing device id costs a duplicate banner; a thrown one would
    // cost the entire subscription, which is far worse. Fail open, never
    // closed.
    //
    // The storage OBJECT is replaced rather than Storage.prototype patched:
    // jsdom's localStorage carries its own getItem/setItem, so a prototype
    // patch never reaches it and the test would pass while proving nothing.
    // That is exactly how the first draft of this test failed.
    const { fetchMock } = installBrowser('https://fcm.googleapis.com/fcm/send/first');
    const auth = JSON.stringify({ access_token: signedInToken() });
    const realStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');

    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        // Auth must still resolve, or this would pass for the wrong reason:
        // an unauthenticated enablePush() fails before it ever reaches the
        // subscribe POST this test inspects.
        getItem: (key: string) => (key === 'smarter-poker-auth' ? auth : denied()),
        setItem: denied,
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      },
    });

    try {
      const { enablePush } = await import('../src/lib/pushClient');
      const result = await enablePush();
      expect(result.ok, 'hostile storage must not cost the subscription').toBe(true);
      // Omitted, not null and not a literal 'null' string: the server
      // validates the shape and would otherwise store a junk device id.
      expect(savedBody(fetchMock).deviceId).toBeUndefined();
    } finally {
      if (realStorage) Object.defineProperty(window, 'localStorage', realStorage);
    }
  });
});
