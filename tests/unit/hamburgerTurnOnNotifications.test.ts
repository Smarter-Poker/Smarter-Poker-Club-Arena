/**
 * The hamburger offers Turn On Notifications on every page until this device
 * receives push (Dan, 2026-10-31: "THE TURN ON NOTIFICATIONS IS GONE FROM THE
 * HAMBURGER MENU... THAT PROBABLY NEEDS TO BE ADDED BACK IN GLOBALLY").
 *
 * pushMenuState() decides the row from the same pushClient helpers the
 * Notifications page banner uses; the menu wiring is pinned from source.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({
  supported: true,
  ios: false,
  standalone: false,
  permission: 'default' as NotificationPermission | 'unsupported',
  subscribed: false,
  throws: false,
}));

vi.mock('../../src/lib/pushClient', () => ({
  isWebPushSupported: () => client.supported,
  isIos: () => client.ios,
  isIosStandalonePwa: () => client.standalone,
  notificationPermission: () => client.permission,
  hasLocalSubscription: async () => {
    if (client.throws) throw new Error('lookup failed');
    return client.subscribed;
  },
}));

import { pushMenuState } from '../../src/lib/pushMenuState';

beforeEach(() => {
  Object.assign(client, {
    supported: true,
    ios: false,
    standalone: false,
    permission: 'default',
    subscribed: false,
    throws: false,
  });
});

describe('pushMenuState', () => {
  it('asks on an eligible device that holds no subscription', async () => {
    expect(await pushMenuState()).toBe('ask');
  });

  it('hides the row once this device is enrolled and allowed', async () => {
    Object.assign(client, { permission: 'granted', subscribed: true });
    expect(await pushMenuState()).toBeNull();
  });

  it('still asks when permission is granted but no subscription exists', async () => {
    Object.assign(client, { permission: 'granted', subscribed: false });
    expect(await pushMenuState()).toBe('ask');
  });

  it('sends a blocked browser to the unblock instructions', async () => {
    client.permission = 'denied';
    expect(await pushMenuState()).toBe('blocked');
  });

  it('sends an iPhone or iPad in plain Safari to the install instructions', async () => {
    Object.assign(client, {
      supported: false,
      ios: true,
      standalone: false,
      permission: 'unsupported',
    });
    expect(await pushMenuState()).toBe('install');
  });

  it('offers nothing in a browser that cannot receive push at all', async () => {
    Object.assign(client, { supported: false, ios: false, permission: 'unsupported' });
    expect(await pushMenuState()).toBeNull();
  });

  it('offers the row when the subscription lookup fails', async () => {
    client.throws = true;
    expect(await pushMenuState()).toBe('ask');
  });
});

describe('HamburgerMenu wiring', () => {
  const menu = readFileSync('src/components/navigation/HamburgerMenu.tsx', 'utf8');

  it('re-reads the state each time the menu opens for a signed-in player', () => {
    expect(menu).toMatch(/void pushMenuState\(\)\.then/);
    expect(menu).toMatch(/\}, \[isOpen, user\?\.id\]\);/);
  });

  it('calls enablePush before anything is awaited, inside the tap', () => {
    expect(menu).toMatch(/const pending = enablePush\(\);\n\s+setPushBusy\(true\);/);
  });

  it('routes install and blocked states to the Notifications page banner', () => {
    expect(menu).toMatch(
      /if \(pushRow !== 'ask'\) \{[\s\S]{0,200}handleNavigate\('\/notifications'\);/
    );
  });

  it('uses the existing quick action design and Title Case copy', () => {
    expect(menu).toMatch(/\{pushBusy \? 'Turning On\.\.\.' : 'Turn On Notifications'\}/);
    expect(menu).toMatch(
      /className=\{`\$\{styles\.quickAction\} \$\{styles\.quickActionFull\}`\}\n\s+disabled=\{pushBusy\}/
    );
  });
});
