import { describe, expect, it } from 'vitest';
import {
  CONTEXTUAL_COOLDOWN_MS,
  cooldownKey,
  decidePushOffer,
  enableOutcome,
  failureDetail,
  isContextualSurface,
  isCoolingDown,
  startCooldown,
  type PushEnvironment,
} from '../../src/lib/pushPromptPolicy';

const base: PushEnvironment = {
  supported: true,
  iosNeedsInstall: false,
  optedOut: false,
  permission: 'default',
  subscribed: false,
};

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

describe('decidePushOffer', () => {
  it('asks a supported, unsubscribed device', () => {
    expect(decidePushOffer(base, true)).toBe('ask');
    expect(decidePushOffer(base, false)).toBe('ask');
  });

  it('never asks a device that already holds a subscription', () => {
    expect(decidePushOffer({ ...base, subscribed: true, permission: 'granted' }, true)).toBeNull();
    expect(decidePushOffer({ ...base, subscribed: true, permission: 'granted' }, false)).toBeNull();
  });

  it('asks again when permission was granted but no subscription exists', () => {
    expect(decidePushOffer({ ...base, permission: 'granted' }, true)).toBe('ask');
  });

  it('respects an explicit off everywhere', () => {
    expect(decidePushOffer({ ...base, optedOut: true }, true)).toBeNull();
    expect(decidePushOffer({ ...base, optedOut: true }, false)).toBeNull();
  });

  it('a blocked browser gets the unblock instruction only on the notifications page', () => {
    expect(decidePushOffer({ ...base, permission: 'denied' }, false)).toBe('blocked');
    expect(decidePushOffer({ ...base, permission: 'denied' }, true)).toBeNull();
  });

  it('an iPhone outside the Home Screen app gets the install guidance, never an ask', () => {
    const ios = {
      ...base,
      supported: false,
      iosNeedsInstall: true,
      permission: 'unsupported' as const,
    };
    expect(decidePushOffer(ios, true)).toBe('install');
    expect(decidePushOffer(ios, false)).toBe('install');
  });

  it('any other browser without push shows nothing', () => {
    expect(
      decidePushOffer({ ...base, supported: false, permission: 'unsupported' }, true)
    ).toBeNull();
  });
});

describe('per-surface cooldown', () => {
  const now = 1_800_000_000_000;

  it('only cashier, cashier receipt and tournament registration are contextual', () => {
    expect(isContextualSurface('cashier')).toBe(true);
    expect(isContextualSurface('cashier_receipt')).toBe(true);
    expect(isContextualSurface('tournament_registration')).toBe(true);
    expect(isContextualSurface('notifications_page')).toBe(false);
    expect(isContextualSurface('first_run')).toBe(false);
    expect(isContextualSurface('settings')).toBe(false);
  });

  it('is not cooling down before it has ever been shown', () => {
    expect(isCoolingDown('cashier', 'u1', now, memoryStorage())).toBe(false);
  });

  it('cools down from the moment it is shown, for exactly its window', () => {
    const st = memoryStorage();
    startCooldown('cashier_receipt', 'u1', now, st);
    expect(st.m.get(cooldownKey('cashier_receipt', 'u1'))).toBe(String(now));
    expect(isCoolingDown('cashier_receipt', 'u1', now + 1, st)).toBe(true);
    const window = CONTEXTUAL_COOLDOWN_MS.cashier_receipt;
    expect(isCoolingDown('cashier_receipt', 'u1', now + window - 1, st)).toBe(true);
    expect(isCoolingDown('cashier_receipt', 'u1', now + window, st)).toBe(false);
  });

  it('is per surface and per account', () => {
    const st = memoryStorage();
    startCooldown('cashier', 'u1', now, st);
    expect(isCoolingDown('cashier', 'u1', now + 1, st)).toBe(true);
    expect(isCoolingDown('tournament_registration', 'u1', now + 1, st)).toBe(false);
    expect(isCoolingDown('cashier', 'u2', now + 1, st)).toBe(false);
  });

  it('the cashier asks at most weekly, events every three days', () => {
    expect(CONTEXTUAL_COOLDOWN_MS.cashier).toBe(7 * 24 * 60 * 60 * 1000);
    expect(CONTEXTUAL_COOLDOWN_MS.cashier_receipt).toBe(3 * 24 * 60 * 60 * 1000);
    expect(CONTEXTUAL_COOLDOWN_MS.tournament_registration).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('a stamp from the future or garbage never freezes the offer', () => {
    const st = memoryStorage();
    st.setItem(cooldownKey('cashier', 'u1'), String(now + 60_000));
    expect(isCoolingDown('cashier', 'u1', now, st)).toBe(false);
    st.setItem(cooldownKey('cashier', 'u1'), 'not-a-number');
    expect(isCoolingDown('cashier', 'u1', now, st)).toBe(false);
  });

  it('storage that throws (private mode) never throws out of the policy', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(isCoolingDown('cashier', 'u1', now, broken)).toBe(false);
    expect(() => startCooldown('cashier', 'u1', now, broken)).not.toThrow();
  });
});

describe('enableOutcome', () => {
  it('maps every enablePush result to one funnel event', () => {
    expect(enableOutcome({ ok: true, permission: 'granted' }, true)).toEqual({
      event: 'accepted',
      detail: null,
    });
    expect(enableOutcome({ ok: false, permission: 'denied' }, true)).toEqual({
      event: 'declined',
      detail: 'permission_denied',
    });
    expect(enableOutcome({ ok: false, permission: 'default' }, true)).toEqual({
      event: 'declined',
      detail: 'permission_dismissed',
    });
    expect(
      enableOutcome({ ok: false, error: 'Subscribing this device timed out after 20s' }, true)
    ).toEqual({
      event: 'failed',
      detail: 'timeout',
    });
    expect(enableOutcome({ ok: false, error: 'anything' }, false)).toEqual({
      event: 'unsupported',
      detail: null,
    });
  });

  it('failure details are bounded categories, never the message', () => {
    for (const msg of [
      'The Notification Service Worker Did Not Start. Reload And Try Again.',
      'Push Is Not Configured On This Deployment Yet.',
      'Could not load the push key (500)',
      'You Need To Be Signed In To Enable Notifications.',
      'This Device Is Registered To Another Account. Sign Out There First.',
      'https://fcm.googleapis.com/fcm/send/abc123 went away',
      undefined,
    ]) {
      expect(failureDetail(msg)).toMatch(/^[a-z0-9:_-]{1,64}$/);
    }
    expect(failureDetail('Push Is Not Configured On This Deployment Yet.')).toBe('not_configured');
    expect(failureDetail('This Device Is Registered To Another Account.')).toBe('device_owned');
  });
});
