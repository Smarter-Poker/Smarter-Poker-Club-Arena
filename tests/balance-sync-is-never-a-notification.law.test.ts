/**
 * BALANCE SYNC IS NEVER A NOTIFICATION (Dan, 2026-10-21, binding).
 *
 * Dan, verbatim, with a lock-screen screenshot of "Balance Updated from
 * Smarter.Poker / Source: postgres_sync_connected": "THIS PUSH NOTIFICATION
 * HAS GOT TO STOP APPEARING".
 *
 * BALANCE_UPDATED is the bus's internal "reload your balances" signal. Every
 * realtime reconnect emits it (source postgres_sync_connected), so it fired a
 * banner each time a phone woke or changed network. Pages keep subscribing
 * to it; it must never reach the service worker's showNotification or the
 * native local notification.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('balance sync is never a notification', () => {
  it('MasterBus does not forward BALANCE_UPDATED as a notification event', () => {
    const src = read('src/core/MasterBus.ts');
    const list = src.match(/const CRITICAL_EVENTS: BusEventType\[\] = \[([\s\S]*?)\];/);
    expect(list).not.toBeNull();
    expect(list![1]).not.toContain("'BALANCE_UPDATED'");
  });

  it('the service worker refuses BALANCE_UPDATED before showNotification', () => {
    const src = read('public/sw-bus.js');
    expect(src).toMatch(/NEVER_NOTIFY = new Set\(\[[^\]]*'BALANCE_UPDATED'/);
    const guard = src.indexOf('NEVER_NOTIFY.has(eventType)');
    const show = src.indexOf('showNotification(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(show);
    expect(src).not.toContain('Source: ${');
  });

  it('a running worker shows nothing for BALANCE_UPDATED and still shows real events', async () => {
    const handlers: Array<(event: unknown) => void> = [];
    const shown: string[] = [];
    const self = {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        if (type === 'message') handlers.push(handler);
      },
      clients: { matchAll: async () => [] },
      registration: { showNotification: (title: string) => shown.push(title) },
    };
    runInNewContext(read('public/sw-bus.js'), { self });
    for (const type of ['BALANCE_UPDATED', 'CLUB_JOINED']) {
      const event = {
        data: {
          type: 'BUS_EVENT',
          event: { type, payload: { source: 'postgres_sync_connected', clubName: 'Shark' } },
        },
      };
      handlers.forEach((handler) => handler(event));
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('Club Joined');
  });

  it('the native app never schedules a BALANCE_UPDATED banner', () => {
    const src = read('src/lib/native/localNotifications.ts');
    expect(src).toMatch(/if \(eventType === 'BALANCE_UPDATED'\) return false;/);
    expect(src).not.toContain("BALANCE_UPDATED: 'Balance Updated'");
    expect(src).not.toContain('Source: ${');
  });
});
