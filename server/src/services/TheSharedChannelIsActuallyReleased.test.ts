/**
 * A CHANNEL NOBODY REMOVED IS A CHANNEL STILL THERE
 * ═══════════════════════════════════════════════════════════════════════════
 * `BombRequestBus` exists because the engine held one Realtime channel per
 * bomb-pot table against a socket whose hard cap is 100 - 123,219
 * `ChannelRateLimitReached` errors in 24 hours, measured 2026-09-06. It
 * replaced them with ONE shared channel.
 *
 * That fix had the same leak inside it in a smaller shape. It closed the
 * shared channel with `channel.unsubscribe()`, which leaves the socket but
 * leaves the channel OBJECT in the client's registry - and
 * `supabase.channel(topic)` APPENDS rather than de-duplicating by topic. So
 * every open/close cycle stranded one dead entry under
 * `engine:bomb-requests`, and the next open created a second live channel on a
 * topic that already had one. On a platform where bomb-pot tables come and go
 * all day that accumulates for the life of the process.
 *
 * THE DANGEROUS DIRECTION is not "leaks a channel". It is a bus that stops
 * dispatching: a released handle that never re-opens, or a handler that stops
 * being reached, takes the FAST path to a manual bomb pot away silently. The
 * durable path (`tables.bomb_pot_manual_pending`, re-read on the throttled
 * config refresh) still fires the bomb, so nothing would look broken except
 * the delay - which is exactly why it has to be pinned here rather than
 * noticed in production.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Every channel object the fake client has ever handed out, in order. */
const created: FakeChannel[] = [];
/** The channel objects `removeChannel` was called with, in order. */
const removed: FakeChannel[] = [];

type StatusCb = (status: string) => void;

class FakeChannel {
  public readonly topic: string;
  public handler: ((message: unknown) => void) | null = null;
  public statusCb: StatusCb | null = null;
  public unsubscribeCalls = 0;

  constructor(topic: string) {
    this.topic = topic;
  }

  on(_type: string, _filter: unknown, cb: (message: unknown) => void): this {
    this.handler = cb;
    return this;
  }

  subscribe(cb?: StatusCb): this {
    this.statusCb = cb ?? null;
    return this;
  }

  unsubscribe(): void {
    this.unsubscribeCalls += 1;
  }
}

vi.mock('./supabase/client.js', () => ({
  supabase: {
    channel: (topic: string) => {
      const ch = new FakeChannel(topic);
      created.push(ch);
      return ch;
    },
    removeChannel: async (ch: FakeChannel) => {
      removed.push(ch);
      return 'ok';
    },
  },
}));

const bus = await import('./BombRequestBus.js');

beforeEach(() => {
  // Leave the module with no listeners and no channel between cases.
  for (let i = 0; i < 8; i += 1) bus.unsubscribeBombRequests(`t${i}`);
  created.length = 0;
  removed.length = 0;
});

describe('the shared bomb-request channel', () => {
  it('opens exactly one channel however many tables ask', () => {
    bus.subscribeBombRequests('t0', () => {});
    bus.subscribeBombRequests('t1', () => {});
    bus.subscribeBombRequests('t2', () => {});

    expect(created.length).toBe(1);
    expect(created[0].topic).toBe(bus.BOMB_REQUEST_TOPIC);
    expect(bus.bombRequestListenerCount()).toBe(3);
    expect(bus.bombRequestChannelOpen()).toBe(true);
  });

  it('keeps the channel while any table is still listening', () => {
    bus.subscribeBombRequests('t0', () => {});
    bus.subscribeBombRequests('t1', () => {});
    bus.unsubscribeBombRequests('t0');

    expect(bus.bombRequestChannelOpen()).toBe(true);
    expect(removed.length).toBe(0);
  });

  it('REMOVES the channel when the last table goes, not merely unsubscribes it', () => {
    // The pin. `unsubscribe()` leaves the object in the client's registry and
    // the next open appends a duplicate on the same topic.
    bus.subscribeBombRequests('t0', () => {});
    const ch = created[0];
    bus.unsubscribeBombRequests('t0');

    expect(removed).toEqual([ch]);
    expect(bus.bombRequestChannelOpen()).toBe(false);
  });

  it('leaves nothing behind across repeated open and close cycles', () => {
    // Three full cycles: three channels created, three removed, none stranded.
    for (let i = 0; i < 3; i += 1) {
      bus.subscribeBombRequests('t0', () => {});
      bus.unsubscribeBombRequests('t0');
    }
    expect(created.length).toBe(3);
    expect(removed.length).toBe(3);
    expect(created).toEqual(removed);
  });

  it('dispatches a request to the table it names and to nobody else', () => {
    const hit: string[] = [];
    bus.subscribeBombRequests('t0', () => hit.push('t0'));
    bus.subscribeBombRequests('t1', () => hit.push('t1'));

    created[0].handler?.({ payload: { table_id: 't1' } });
    expect(hit).toEqual(['t1']);
  });

  it('survives a broadcast with no table_id, a wrong type, and a null message', () => {
    // A malformed broadcast must never reach a dealing loop.
    const hit: string[] = [];
    bus.subscribeBombRequests('t0', () => hit.push('t0'));
    const h = created[0].handler!;
    expect(() => h({ payload: {} })).not.toThrow();
    expect(() => h({ payload: { table_id: 42 } })).not.toThrow();
    expect(() => h(null)).not.toThrow();
    expect(() => h({})).not.toThrow();
    expect(hit).toEqual([]);
  });

  it('does not let one table handler throwing stop the bus', () => {
    // The handler marks a manual bomb as pushed on a live engine. If it throws
    // the bus must still be usable for the next request rather than dead.
    bus.subscribeBombRequests('t0', () => {
      throw new Error('engine blew up');
    });
    expect(() => created[0].handler?.({ payload: { table_id: 't0' } })).not.toThrow();

    const hit: string[] = [];
    bus.subscribeBombRequests('t1', () => hit.push('t1'));
    created[0].handler?.({ payload: { table_id: 't1' } });
    expect(hit).toEqual(['t1']);
  });

  it('registering the same table twice replaces the handler and opens nothing new', () => {
    const hit: string[] = [];
    bus.subscribeBombRequests('t0', () => hit.push('first'));
    bus.subscribeBombRequests('t0', () => hit.push('second'));

    expect(created.length).toBe(1);
    expect(bus.bombRequestListenerCount()).toBe(1);
    created[0].handler?.({ payload: { table_id: 't0' } });
    expect(hit).toEqual(['second']);
  });

  it('unsubscribing a table that never registered is harmless', () => {
    expect(() => bus.unsubscribeBombRequests('never-seen')).not.toThrow();
    expect(bus.bombRequestChannelOpen()).toBe(false);
    expect(removed.length).toBe(0);
  });

  it('releases the handle on a terminal status so the next table re-opens it', () => {
    // Without this, ONE CHANNEL_ERROR left the handle reading as open for the
    // life of the process and the fast path was gone until the next deploy,
    // with nothing saying so - the shape 10.86 is about.
    bus.subscribeBombRequests('t0', () => {});
    const first = created[0];
    first.statusCb?.('CHANNEL_ERROR');

    expect(bus.bombRequestChannelOpen()).toBe(false);
    expect(removed).toEqual([first]);

    bus.subscribeBombRequests('t1', () => {});
    expect(created.length).toBe(2);
    expect(bus.bombRequestChannelOpen()).toBe(true);
  });

  it('treats TIMED_OUT the same way, and SUBSCRIBED as no news', () => {
    bus.subscribeBombRequests('t0', () => {});
    created[0].statusCb?.('SUBSCRIBED');
    expect(bus.bombRequestChannelOpen()).toBe(true);
    expect(removed.length).toBe(0);

    created[0].statusCb?.('TIMED_OUT');
    expect(bus.bombRequestChannelOpen()).toBe(false);
    expect(removed.length).toBe(1);
  });

  it('does not remove a channel twice when a deliberate close reports CLOSED', () => {
    // removeChannel drives the channel to CLOSED, so the status callback fires
    // for a handle the bus has already let go of. The identity check in
    // releaseChannel is what makes that a no-op.
    bus.subscribeBombRequests('t0', () => {});
    const ch = created[0];
    bus.unsubscribeBombRequests('t0');
    expect(removed).toEqual([ch]);

    ch.statusCb?.('CLOSED');
    expect(removed).toEqual([ch]);
  });

  it('a status arriving after a NEW channel is open does not close the new one', () => {
    // The ordering that would break the bus: an old channel's late error
    // report tearing down its replacement.
    bus.subscribeBombRequests('t0', () => {});
    const first = created[0];
    first.statusCb?.('CHANNEL_ERROR');

    bus.subscribeBombRequests('t0', () => {});
    const second = created[1];
    expect(second).not.toBe(first);

    first.statusCb?.('CHANNEL_ERROR');
    expect(bus.bombRequestChannelOpen()).toBe(true);
    expect(removed).toEqual([first]);
  });
});
