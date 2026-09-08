/**
 * Store readiness, phases 3c and 4b: the store's own billing and the OS's own
 * push, both reached only inside the app. Behavioural where the module is
 * importable under jsdom; text where the pin is wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const enableNativePush = vi.fn(async () => ({ ok: true, permission: 'granted' as const }));
const disableNativePush = vi.fn(async () => ({ ok: true }));
const hasNativeSubscription = vi.fn(async () => true);
vi.mock('../../src/lib/native/push', () => ({
  enableNativePush: () => enableNativePush(),
  disableNativePush: () => disableNativePush(),
  hasNativeSubscription: () => hasNativeSubscription(),
  nativeNotificationPermission: async () => 'granted',
}));

const handleAppUrl = vi.fn(async (_u: string) => {});
vi.mock('../../src/lib/native/deepLinks', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/native/deepLinks')>();
  return { ...real, handleAppUrl: (u: string) => handleAppUrl(u) };
});
const openInAppBrowser = vi.fn(async (_u: string) => {});
vi.mock('../../src/lib/native/browser', () => ({
  openInAppBrowser: (u: string) => openInAppBrowser(u),
}));

function pretendNative(on: boolean) {
  const w = window as unknown as { Capacitor?: unknown };
  if (on) w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  else delete w.Capacitor;
}

describe('push inside the app goes to the device token, and the web path is untouched', () => {
  beforeEach(() => {
    enableNativePush.mockClear();
    disableNativePush.mockClear();
    hasNativeSubscription.mockClear();
    localStorage.clear();
  });
  afterEach(() => pretendNative(false));

  it('the app supports push (the OS does it) and IS the installed app', async () => {
    const pc = await import('../../src/lib/pushClient');
    pretendNative(true);
    expect(pc.isWebPushSupported()).toBe(true);
    expect(pc.isIosStandalonePwa()).toBe(true);
    pretendNative(false);
    // jsdom: no PushManager, so the browser answer is still no.
    expect(pc.isWebPushSupported()).toBe(false);
  });

  it('enable/disable/hasLocalSubscription branch to the native transport and keep the opt-out marker honest', async () => {
    const pc = await import('../../src/lib/pushClient');
    pretendNative(true);
    localStorage.setItem('sp_push_opt_out', '1');
    expect(await pc.enablePush()).toEqual({ ok: true, permission: 'granted' });
    expect(enableNativePush).toHaveBeenCalledTimes(1);
    expect(pc.isOptedOut()).toBe(false);
    expect(pc.notificationPermission()).toBe('granted');

    expect(await pc.disablePush()).toEqual({ ok: true });
    expect(disableNativePush).toHaveBeenCalledTimes(1);
    expect(pc.isOptedOut()).toBe(true);

    expect(await pc.hasLocalSubscription()).toBe(true);
    expect(hasNativeSubscription).toHaveBeenCalledTimes(1);
  });

  it('in a browser the native transport is never reached', async () => {
    const pc = await import('../../src/lib/pushClient');
    pretendNative(false);
    const r = await pc.enablePush();
    expect(r.ok).toBe(false);
    expect(enableNativePush).not.toHaveBeenCalled();
    expect(await pc.hasLocalSubscription()).toBe(false);
    expect(hasNativeSubscription).not.toHaveBeenCalled();
  });
});

describe('a notification tap is routed like a deep link', () => {
  beforeEach(() => {
    handleAppUrl.mockClear();
    openInAppBrowser.mockClear();
  });

  it('a Club Arena url goes through the app; any other Hub page opens the in-app browser; nothing goes nowhere', async () => {
    // The real module is not mocked (the pushClient mock above targets the
    // pushClient consumers); import it fresh.
    vi.doUnmock('../../src/lib/native/push');
    vi.resetModules();
    const { openPushUrl } = await import('../../src/lib/native/push');

    await openPushUrl('/hub/club-arena/clubs/abc?tab=tables');
    expect(handleAppUrl).toHaveBeenCalledWith(
      'https://smarter.poker/hub/club-arena/clubs/abc?tab=tables'
    );
    expect(openInAppBrowser).not.toHaveBeenCalled();

    await openPushUrl('/hub/social');
    expect(openInAppBrowser).toHaveBeenCalledWith('https://smarter.poker/hub/social');

    await openPushUrl(undefined);
    expect(handleAppUrl).toHaveBeenLastCalledWith('https://smarter.poker/hub/club-arena');
  });
});

describe('the store sheet asks for the same product the web would have sent Stripe', () => {
  it('maps plans and packages, and refuses lifetime (not a store product)', async () => {
    const { nativePurchaseRequestFor } =
      await import('../../src/pages/marketplace/marketplaceShared');
    expect(nativePurchaseRequestFor('subscription', [{ plan: 'vip-monthly' }])).toEqual({
      kind: 'vip',
      tier: 'monthly',
    });
    expect(nativePurchaseRequestFor('subscription', [{ plan: 'vip-yearly' }])).toEqual({
      kind: 'vip',
      tier: 'yearly',
    });
    expect(nativePurchaseRequestFor('subscription', [{ plan: 'vip-annual' }])).toEqual({
      kind: 'vip',
      tier: 'yearly',
    });
    expect(nativePurchaseRequestFor('subscription', [{ plan: 'vip-lifetime' }])).toBeNull();
    expect(nativePurchaseRequestFor('diamonds', [{ packageId: 'starter' }])).toEqual({
      kind: 'diamonds',
      packageKey: 'starter',
    });
    expect(nativePurchaseRequestFor('diamonds', [{}])).toBeNull();
  });
});

describe('wiring that only a phone can exercise', () => {
  it('startCheckout branches to the store before Stripe, only inside the app', () => {
    const src = read('src/pages/marketplace/marketplaceShared.ts');
    const branch = src.indexOf('if (isNativePlatform()) {');
    const stripe = src.indexOf("'/api/store/create-checkout-session'");
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(stripe);
    expect(src).toContain("await import('../../lib/native/purchases')");
  });

  it('the membership tab has Restore Purchases and store subscription management, native only', () => {
    const src = read('src/pages/marketplace/MembershipTab.tsx');
    expect(src).toContain('Restore Purchases');
    expect(src).toContain('restoreNativePurchases(userId)');
    expect(src).toContain('openNativeSubscriptionManagement()');
    // the web keeps its link
    expect(src).toContain('href="/hub/diamond-store?tab=vip"');
  });

  it('the shell attaches the push listeners at boot and primes the cached permission', () => {
    const shell = read('src/lib/nativeShell.ts');
    expect(shell).toContain('wirePush()');
    expect(shell).toContain('initNativePush()');
    expect(shell).toContain('primeNativePushState()');
    const cfg = read('capacitor.config.ts');
    expect(cfg).toMatch(/presentationOptions:\s*\['badge',\s*'sound',\s*'alert'\]/);
  });

  it('the device token rides the same /api/push/subscribe row with transport fcm and the shared device id', () => {
    const push = read('src/lib/native/push.ts');
    expect(push).toContain("transport: 'fcm'");
    expect(push).toContain("fetch('/api/push/subscribe'");
    expect(push).toContain('pushDeviceId()');
    expect(push).toContain('pushAuthHeaders()');
    expect(push).toContain("method: 'DELETE'");
  });

  it('sign-up in the app asks for a date of birth and never sends a minor to signUp()', () => {
    const auth = read('src/pages/AuthPage.tsx');
    const check = auth.indexOf('signupAge < MINIMUM_AGE');
    const signUp = auth.indexOf('supabase.auth.signUp(');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(signUp);
    expect(auth).toContain('id="signup-birthday"');
    expect(auth).toContain("supabase.rpc('fn_set_my_birthday'");
    expect(auth).toContain('{IS_NATIVE_BUILD && (');
  });

  it('a Hub page does not open as a frame inside the app (cross-origin there); it opens beside it', () => {
    const mt = read('src/pages/MultiTablePage.tsx');
    const fn = mt.indexOf('const openHubTab = useCallback(');
    const decline = mt.indexOf('if (isNativePlatform()) return false;', fn);
    const makeTab = mt.indexOf('makeHubTab(path)', fn);
    expect(decline).toBeGreaterThan(fn);
    expect(decline).toBeLessThan(makeTab);
  });

  it('relative /api calls inside the app go to smarter.poker (the webview origin has no API)', () => {
    const main = read('src/main.tsx');
    expect(main).toContain('installHubFetchShim()');
    const shim = read('src/lib/native/hubFetchShim.ts');
    expect(shim).toContain('WEB_ORIGIN');
  });
});
