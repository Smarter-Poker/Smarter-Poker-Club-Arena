/**
 * TableStateHub — hard-backpressure eviction closes the transport (2026-08-24).
 *
 * The hub used to only remove a hopeless subscriber from the room; the socket
 * stayed OPEN and silent, and the client sat blind until its staleness
 * watchdog fired up to 60 seconds later. The subscriber's optional evict()
 * lets the transport end the connection immediately, so the client's onclose
 * fires now and a fresh SNAPSHOT is seconds away instead of a minute.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/supabase/handFacts.js', () => ({
  captureAllInEquity: () => undefined,
  captureRitEvent: () => undefined,
}));

import { TableStateHub, type HubSubscriber } from './TableStateHub.js';

function mkSub(buffered: number): HubSubscriber & { sent: string[]; evicted: number } {
  const sub = {
    id: Math.random().toString(36).slice(2),
    readyState: 1,
    bufferedAmount: buffered,
    sent: [] as string[],
    evicted: 0,
    send(data: string) {
      sub.sent.push(data);
    },
    evict() {
      sub.evicted++;
    },
  };
  return sub;
}

describe('TableStateHub - hard backpressure evicts the transport', () => {
  it('calls evict() on a subscriber past the hard limit and removes it', () => {
    const hub = new TableStateHub();
    const healthy = mkSub(0);
    const hopeless = mkSub(5 * 1024 * 1024); // > 4 MiB hard limit
    hub.subscribe('t1', healthy);
    hub.subscribe('t1', hopeless);

    hub.publish('t1', { a: 1 });

    expect(hopeless.evicted).toBe(1);
    expect(hub.subscriberCount('t1')).toBe(1);
    expect(hub.backpressureStats().hardDropped).toBeGreaterThanOrEqual(1);
    // The healthy subscriber still got the message.
    expect(healthy.sent.length).toBe(1);
  });

  it('a throwing evict() cannot break delivery to everyone else', () => {
    const hub = new TableStateHub();
    const healthy = mkSub(0);
    const hopeless = mkSub(5 * 1024 * 1024);
    hopeless.evict = () => {
      throw new Error('transport already gone');
    };
    hub.subscribe('t2', hopeless);
    hub.subscribe('t2', healthy);

    hub.publish('t2', { b: 2 });

    expect(healthy.sent.length).toBe(1);
    expect(hub.subscriberCount('t2')).toBe(1);
  });

  it('a subscriber WITHOUT evict() is still removed (optional member)', () => {
    const hub = new TableStateHub();
    const hopeless = mkSub(5 * 1024 * 1024);
    delete (hopeless as Partial<HubSubscriber>).evict;
    hub.subscribe('t3', hopeless);
    hub.publish('t3', { c: 3 });
    expect(hub.subscriberCount('t3')).toBe(0);
  });
});
