/**
 * PRIVATE FRAMES ON THE TABLE SOCKET (disconnect audit items 11 + 12)
 *
 * sendToUser delivers one player's own facts (hole cards, the engine's copy
 * of their pre-action) to every open socket that player holds on a table,
 * and to nobody else. Outside the seq chain, never retained, never replayed.
 */
import { describe, it, expect } from 'vitest';
import { TableStateHub, type HubSubscriber } from './TableStateHub.js';

function sub(id: string, userId?: string, readyState = 1) {
  const outbox: string[] = [];
  const s: HubSubscriber & { outbox: string[] } = {
    id,
    userId,
    outbox,
    readyState,
    send(data: string) {
      outbox.push(data);
    },
  };
  return s;
}

const T = 'table-1';

describe('TableStateHub.sendToUser', () => {
  it('reaches every open socket the user holds on that table, and no one else', () => {
    const hub = new TableStateHub();
    const heroPhone = sub('a', 'hero');
    const heroLaptop = sub('b', 'hero');
    const villain = sub('c', 'villain');
    const watcher = sub('d');
    for (const s of [heroPhone, heroLaptop, villain, watcher]) hub.subscribe(T, s);

    const n = hub.sendToUser(T, 'hero', { kind: 'hole_cards', row: { cards: ['Ah', 'Kh'] } });
    expect(n).toBe(2);
    for (const s of [heroPhone, heroLaptop]) {
      const frames = s.outbox.map((f) => JSON.parse(f)).filter((m) => m.type === 'USER_EVENT');
      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual({
        type: 'USER_EVENT',
        tableId: T,
        payload: { kind: 'hole_cards', row: { cards: ['Ah', 'Kh'] } },
      });
    }
    expect(villain.outbox.some((f) => f.includes('USER_EVENT'))).toBe(false);
    expect(watcher.outbox.some((f) => f.includes('USER_EVENT'))).toBe(false);
  });

  it('skips a socket that is not open and returns 0 when the user is not subscribed', () => {
    const hub = new TableStateHub();
    const closing = sub('a', 'hero', 2);
    hub.subscribe(T, closing);
    expect(hub.sendToUser(T, 'hero', { kind: 'pre_action', action: null })).toBe(0);
    expect(hub.sendToUser(T, 'nobody', { kind: 'pre_action', action: null })).toBe(0);
    expect(hub.sendToUser('no-such-table', 'hero', { kind: 'pre_action', action: null })).toBe(0);
  });

  it('does not touch the per-table event sequence', () => {
    const hub = new TableStateHub();
    const hero = sub('a', 'hero');
    hub.subscribe(T, hero);
    hub.sendToUser(T, 'hero', { kind: 'pre_action', action: 'auto_fold' });
    hub.emitEvent(T, { type: 'turn_change' });
    const ev = hero.outbox.map((f) => JSON.parse(f)).find((m) => m.type === 'EVENT');
    expect(ev.seq).toBe(1);
  });
});
