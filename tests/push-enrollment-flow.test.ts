/**
 * PUSH ENROLLMENT FLOW (2026-09-27).
 *
 * Production, 2026-09-27: 62 push_subscriptions ever, 4 active across 2
 * accounts, 218 human profiles. Three defects and one missing flow:
 *
 *   1. Club Arena enrolled on the root '/sw.js' registration while the World
 *      Hub enrolled on '/push/sw.js'. One browser, two endpoints, one shared
 *      deviceId: every enrolment or hourly sync in either app retired the
 *      other's row as `superseded_same_device`.
 *   2. The silent hourly sync re-enrolled WHICHEVER account was signed in,
 *      because browser permission belongs to the origin, not to an account.
 *   3. Not Now closed the door permanently.
 *   4. Nothing asked at a moment where a notification is obviously useful.
 *
 * These tests RUN the real pushClient and pushNudgePolicy against a controlled
 * browser boundary. They do not prove a physical device received a push.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  COOLDOWNS_MS,
  MAX_DISMISSALS,
  NUDGE_MOMENTS,
  OWNER_USER_ID,
  decideNudge,
  legacyAskedKey,
  ledgerKey,
  parseLedger,
  readNudgeState,
  recordDismissed,
  recordShown,
  writeLedger,
} from '../src/lib/pushNudgePolicy';

const VAPID_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const NEW_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/shared-push-scope';
const LEGACY_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/legacy-root-scope';

function signedInToken(): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `header.${b64({
    sub: '11111111-2222-3333-4444-555555555555',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

function makeSubscription(endpoint: string, order: string[]) {
  return {
    endpoint,
    options: {},
    toJSON: () => ({ keys: { p256dh: `p256dh-${endpoint.length}`, auth: 'auth-value' } }),
    unsubscribe: vi.fn(async () => {
      order.push(`unsubscribe:${endpoint}`);
      return true;
    }),
  };
}

function installBrowser(
  opts: {
    legacy?: boolean;
    permission?: NotificationPermission;
    subscribeStatus?: number;
  } = {}
) {
  const order: string[] = [];
  const fresh = makeSubscription(NEW_ENDPOINT, order);
  const legacy = opts.legacy ? makeSubscription(LEGACY_ENDPOINT, order) : null;
  const pushReg = {
    scope: 'https://smarter.poker/push/',
    active: {},
    installing: null,
    waiting: null,
    pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => fresh) },
  };
  const rootReg = {
    scope: 'https://smarter.poker/',
    active: {},
    pushManager: { getSubscription: vi.fn(async () => legacy), subscribe: vi.fn() },
  };
  const register = vi.fn(async () => pushReg);
  const getRegistration = vi.fn(async (url?: string) => (url === '/' ? rootReg : pushReg));
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: { register, getRegistration, ready: Promise.resolve(pushReg) },
  });
  (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};
  const requestPermission = vi.fn(async () => 'granted');
  (globalThis as unknown as { Notification: unknown }).Notification = {
    permission: opts.permission ?? 'granted',
    requestPermission,
  };
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (String(url).includes('/api/push/vapid-public-key')) {
      return { ok: true, status: 200, json: async () => ({ key: VAPID_KEY }) };
    }
    if (String(url).includes('/api/push/subscribe')) {
      order.push(`${init?.method}:subscribe`);
      const status = opts.subscribeStatus ?? 200;
      return {
        ok: status === 200,
        status,
        json: async () =>
          status === 200 ? { ok: true } : { error: 'nope', code: 'repair_not_enrolled' },
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem('smarter-poker-auth', JSON.stringify({ access_token: signedInToken() }));
  return { order, fresh, legacy, register, fetchMock, requestPermission };
}

const posted = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/push/subscribe') && c[1]?.method === 'POST')
    .map((c) => JSON.parse(String(c[1].body)));

describe('one registration per device, shared with the World Hub', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('hands a legacy root subscription over: replaced on the server, then unsubscribed', async () => {
    const h = installBrowser({ legacy: true });
    const { enablePush } = await import('../src/lib/pushClient');

    const result = await enablePush();

    expect(result.ok).toBe(true);
    const [body] = posted(h.fetchMock);
    expect(body.endpoint).toBe(NEW_ENDPOINT);
    expect(body.replacesEndpoint).toBe(LEGACY_ENDPOINT);
    expect(body.deviceId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    // Unsubscribed only AFTER the server accepted the replacement.
    expect(h.order).toEqual(['POST:subscribe', `unsubscribe:${LEGACY_ENDPOINT}`]);
    expect(h.fresh.unsubscribe).not.toHaveBeenCalled();
  });

  it('keeps the legacy subscription when the server did not accept the replacement', async () => {
    const h = installBrowser({ legacy: true, subscribeStatus: 503 });
    const { enablePush } = await import('../src/lib/pushClient');

    const result = await enablePush();

    expect(result.ok).toBe(false);
    expect(h.legacy!.unsubscribe).not.toHaveBeenCalled();
  });

  it('reads this device status from the shared /push/ registration', async () => {
    installBrowser();
    const { hasLocalSubscription } = await import('../src/lib/pushClient');
    expect(await hasLocalSubscription()).toBe(false);
    expect(
      (navigator.serviceWorker.getRegistration as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0]
      )
    ).toEqual(['/push/']);
  });

  it('turning off removes both the shared and a legacy subscription', async () => {
    const h = installBrowser({ legacy: true });
    const pushReg = await navigator.serviceWorker.getRegistration('/push/');
    (pushReg!.pushManager.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(h.fresh);
    const { disablePush, isOptedOut } = await import('../src/lib/pushClient');

    expect((await disablePush()).ok).toBe(true);
    expect(isOptedOut()).toBe(true);
    expect(h.fresh.unsubscribe).toHaveBeenCalled();
    expect(h.legacy!.unsubscribe).toHaveBeenCalled();
  });
});

describe('the silent sync repairs, it never enrolls', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('asks the server for a repair only, and reports a refusal without claiming success', async () => {
    const h = installBrowser({ subscribeStatus: 409 });
    const { enablePush, isOptedOut } = await import('../src/lib/pushClient');

    const result = await enablePush({ repairOnly: true });

    expect(posted(h.fetchMock)[0].repairOnly).toBe(true);
    expect(result).toMatchObject({ ok: false, code: 'repair_not_enrolled' });
    expect(isOptedOut()).toBe(false);
  });

  it('never raises the permission dialog', async () => {
    const h = installBrowser({ permission: 'default' });
    const { enablePush } = await import('../src/lib/pushClient');

    const result = await enablePush({ repairOnly: true });

    expect(result.ok).toBe(false);
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(posted(h.fetchMock)).toHaveLength(0);
  });

  it('a tap-driven enable is not a repair', async () => {
    const h = installBrowser();
    const { enablePush } = await import('../src/lib/pushClient');
    await enablePush();
    expect(posted(h.fetchMock)[0].repairOnly).toBeUndefined();
  });
});

describe('when a player may be asked', () => {
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-09-27T16:00:00Z');
  const PLAYER = '00000000-0000-4000-8000-000000000001';
  const READY = {
    supported: true,
    iosNeedsInstall: false,
    permission: 'default',
    subscribed: false,
    optedOut: false,
  };
  const EMPTY = parseLedger(null);
  const decide = (over: Partial<Parameters<typeof decideNudge>[0]> = {}) =>
    decideNudge({
      userId: PLAYER,
      moment: 'club_joined',
      now: NOW,
      ledger: EMPTY,
      device: READY,
      ...over,
    });

  it('asks a fresh player at every meaningful moment', () => {
    for (const moment of NUDGE_MOMENTS)
      expect(decide({ moment })).toEqual({ show: true, variant: 'ask' });
  });

  it('never asks when there is nothing to say yes to', () => {
    expect(decide({ device: { ...READY, subscribed: true } })).toMatchObject({
      reason: 'already_on',
    });
    expect(decide({ device: { ...READY, optedOut: true } })).toMatchObject({ reason: 'opted_out' });
    expect(decide({ device: { ...READY, permission: 'denied' } })).toMatchObject({
      reason: 'blocked',
    });
    expect(decide({ device: { ...READY, supported: false } })).toMatchObject({
      reason: 'unsupported',
    });
    expect(decide({ device: { ...READY, supported: false, iosNeedsInstall: true } })).toEqual({
      show: true,
      variant: 'install',
    });
  });

  it('Not Now cools down for 7 then 30 days, and three end the contextual asks', () => {
    let ledger = recordDismissed(EMPTY, NOW);
    expect(decide({ ledger, now: NOW + COOLDOWNS_MS[0] - 1 })).toMatchObject({
      reason: 'cooling_down',
    });
    expect(decide({ ledger, now: NOW + COOLDOWNS_MS[0] + 1 }).show).toBe(true);
    ledger = recordDismissed(ledger, NOW + 8 * DAY);
    expect(decide({ ledger, now: NOW + 8 * DAY + COOLDOWNS_MS[1] - 1 })).toMatchObject({
      reason: 'cooling_down',
    });
    ledger = recordDismissed(ledger, NOW + 60 * DAY);
    expect(ledger.dismissals).toBe(MAX_DISMISSALS);
    expect(decide({ ledger, now: NOW + 3650 * DAY })).toMatchObject({
      reason: 'declined_repeatedly',
    });
  });

  it('asks at most once a day and runs the first-visit ask once', () => {
    const shown = recordShown(EMPTY, NOW);
    expect(decide({ ledger: shown, moment: 'rakeback_receipt', now: NOW + DAY - 1 })).toMatchObject(
      {
        reason: 'asked_recently',
      }
    );
    expect(decide({ ledger: shown, moment: 'first_run', now: NOW + 90 * DAY })).toMatchObject({
      reason: 'first_run_already_asked',
    });
    expect(decide({ moment: 'club_joined', legacyAskedAt: NOW - 20 * DAY }).show).toBe(true);
    expect(decide({ moment: 'first_run', legacyAskedAt: NOW - 20 * DAY })).toMatchObject({
      reason: 'first_run_already_asked',
    });
  });

  it('never nudges the owner to enroll for receipts', () => {
    for (const moment of ['rakeback_receipt', 'invoice_workspace']) {
      expect(decide({ userId: OWNER_USER_ID, moment })).toMatchObject({
        reason: 'owner_receipts_route_to_production_alerts',
      });
      expect(decide({ moment }).show).toBe(true);
    }
  });

  it('shares one ledger with the World Hub and survives broken storage', () => {
    localStorage.clear();
    localStorage.setItem(legacyAskedKey(PLAYER), String(NOW));
    writeLedger(localStorage, PLAYER, recordDismissed(EMPTY, NOW));
    expect(localStorage.getItem(`sp_push_nudge_v1_${PLAYER}`)).toBe(
      localStorage.getItem(ledgerKey(PLAYER))
    );
    expect(readNudgeState(localStorage, PLAYER).legacyAskedAt).toBe(NOW);
    const throwing = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('private mode');
      },
    };
    expect(readNudgeState(throwing, PLAYER).ledger).toEqual(EMPTY);
    expect(() => writeLedger(throwing, PLAYER, EMPTY)).not.toThrow();
  });
});
