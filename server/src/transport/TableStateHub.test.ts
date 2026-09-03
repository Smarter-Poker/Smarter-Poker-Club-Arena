import { describe, it, expect, beforeEach } from 'vitest';
import { TableStateHub, type HubSubscriber } from './TableStateHub.js';

function makeSub(id: string, readyState = 1 /* OPEN */) {
  const outbox: string[] = [];
  const sub: HubSubscriber & {
    outbox: string[];
    close(): void;
    _readyState: number;
    // B12: writable so a test can simulate a socket whose send buffer is backed up.
    _bufferedAmount: number;
    sendCalls: number;
  } = {
    id,
    outbox,
    _readyState: readyState,
    _bufferedAmount: 0,
    sendCalls: 0,
    get readyState() {
      return this._readyState;
    },
    get bufferedAmount() {
      return this._bufferedAmount;
    },
    send(data: string) {
      this.sendCalls++;
      outbox.push(data);
    },
    close() {
      this._readyState = 3; // CLOSED
    },
  } as any;
  return sub;
}

function parse(msg: string) {
  return JSON.parse(msg);
}

describe('TableStateHub', () => {
  const TABLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  let hub: TableStateHub;

  beforeEach(() => {
    hub = new TableStateHub();
  });

  describe('publish', () => {
    it('sends SNAPSHOT to first subscriber on first publish', () => {
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      hub.publish(TABLE, { pot: 10 });
      expect(sub.outbox).toHaveLength(1);
      const msg = parse(sub.outbox[0]);
      expect(msg.type).toBe('SNAPSHOT');
      expect(msg.tableId).toBe(TABLE);
      expect(msg.seq).toBe(1);
      expect(msg.state).toEqual({ pot: 10 });
    });

    it('sends DELTA with JSON Patch after first snapshot', () => {
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      hub.publish(TABLE, { pot: 10, stage: 'preflop' });
      hub.publish(TABLE, { pot: 15, stage: 'preflop' });
      expect(sub.outbox).toHaveLength(2);
      const delta = parse(sub.outbox[1]);
      expect(delta.type).toBe('DELTA');
      expect(delta.seq).toBe(2);
      expect(delta.prev).toBe(1);
      expect(delta.patch).toEqual([{ op: 'replace', path: '/pot', value: 15 }]);
    });

    it('skips empty-patch publishes and does NOT advance seq (Round 25 reconnect-FSM fix)', () => {
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      hub.publish(TABLE, { pot: 10 });
      hub.publish(TABLE, { pot: 10 }); // identical — no-op
      // Only the SNAPSHOT should have been sent; no empty DELTA.
      expect(sub.outbox).toHaveLength(1);
      // seq must stay put: advancing it on a no-op makes the next real DELTA
      // look like a gap to the client, triggering a spurious full resync.
      expect(hub.lastSeq(TABLE)).toBe(1);
    });

    it('fans out to all open subscribers', () => {
      const s1 = makeSub('s1');
      const s2 = makeSub('s2');
      const s3 = makeSub('s3');
      hub.subscribe(TABLE, s1);
      hub.subscribe(TABLE, s2);
      hub.subscribe(TABLE, s3);
      hub.publish(TABLE, { pot: 10 });
      expect(s1.outbox).toHaveLength(1);
      expect(s2.outbox).toHaveLength(1);
      expect(s3.outbox).toHaveLength(1);
    });

    it('evicts closed subscribers on publish', () => {
      const s1 = makeSub('s1');
      const s2 = makeSub('s2');
      hub.subscribe(TABLE, s1);
      hub.subscribe(TABLE, s2);
      hub.publish(TABLE, { pot: 10 });
      expect(hub.subscriberCount(TABLE)).toBe(2);
      s2.close();
      hub.publish(TABLE, { pot: 20 });
      expect(hub.subscriberCount(TABLE)).toBe(1);
    });

    it('seq is monotonic per table', () => {
      hub.publish(TABLE, { a: 1 });
      hub.publish(TABLE, { a: 2 });
      hub.publish(TABLE, { a: 3 });
      expect(hub.lastSeq(TABLE)).toBe(3);
    });

    it('seq is independent per table', () => {
      const t2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      hub.publish(TABLE, { a: 1 });
      hub.publish(TABLE, { a: 2 });
      hub.publish(t2, { b: 1 });
      expect(hub.lastSeq(TABLE)).toBe(2);
      expect(hub.lastSeq(t2)).toBe(1);
    });
  });

  describe('subscribe', () => {
    it('immediately sends current SNAPSHOT on late join', () => {
      hub.publish(TABLE, { pot: 10 });
      hub.publish(TABLE, { pot: 20 });
      const latecomer = makeSub('late');
      hub.subscribe(TABLE, latecomer);
      expect(latecomer.outbox).toHaveLength(1);
      const msg = parse(latecomer.outbox[0]);
      expect(msg.type).toBe('SNAPSHOT');
      expect(msg.seq).toBe(2);
      expect(msg.state).toEqual({ pot: 20 });
    });

    it('no snapshot yet - subscriber waits for first publish', () => {
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      expect(sub.outbox).toHaveLength(0);
      hub.publish(TABLE, { pot: 5 });
      expect(sub.outbox).toHaveLength(1);
      expect(parse(sub.outbox[0]).type).toBe('SNAPSHOT');
    });
  });

  describe('unsubscribe / unsubscribeAll', () => {
    it('unsubscribe stops future delivery', () => {
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      hub.publish(TABLE, { pot: 10 });
      hub.unsubscribe(TABLE, sub);
      hub.publish(TABLE, { pot: 20 });
      expect(sub.outbox).toHaveLength(1);
    });

    it('unsubscribeAll clears from every table', () => {
      const t2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      hub.subscribe(t2, sub);
      hub.unsubscribeAll(sub);
      hub.publish(TABLE, { a: 1 });
      hub.publish(t2, { b: 1 });
      expect(sub.outbox).toHaveLength(0);
    });

    it('unsubscribe is safe on unknown table', () => {
      const sub = makeSub('s1');
      expect(() => hub.unsubscribe('unknown', sub)).not.toThrow();
    });
  });

  describe('resync', () => {
    it('re-sends latest snapshot to a specific subscriber', () => {
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      hub.publish(TABLE, { pot: 10 });
      hub.publish(TABLE, { pot: 20 });
      expect(sub.outbox).toHaveLength(2); // SNAPSHOT + DELTA
      const ok = hub.resync(TABLE, sub);
      expect(ok).toBe(true);
      expect(sub.outbox).toHaveLength(3);
      const last = parse(sub.outbox[2]);
      expect(last.type).toBe('SNAPSHOT');
      expect(last.seq).toBe(2);
      expect(last.state).toEqual({ pot: 20 });
    });

    it('returns false when no snapshot has been published', () => {
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      const ok = hub.resync(TABLE, sub);
      expect(ok).toBe(false);
    });
  });

  describe('dropTable', () => {
    it('removes the room entirely when nobody is watching', () => {
      const gone = makeSub('s1');
      hub.subscribe(TABLE, gone);
      hub.publish(TABLE, { pot: 10 });
      hub.unsubscribe(TABLE, gone);
      hub.dropTable(TABLE);
      expect(hub.subscriberCount(TABLE)).toBe(0);
      expect(hub.hasSnapshot(TABLE)).toBe(false);
      expect(hub.lastSeq(TABLE)).toBe(0);
    });

    // 2026-08-15 REGRESSION GUARD. dropTable is called on every engine teardown
    // (watchdog kill, zombie rebuild, failed start, tournament table break) —
    // all of which happen while players are still connected. It used to delete
    // the room outright, destroying the subscriber Set. Since the ONLY
    // hub.subscribe call site is a new WebSocket upgrade, nothing re-subscribed
    // those sockets: the rebuilt engine published into an empty room while every
    // player's socket stayed open and healthy (server PINGs, client PONGs) and
    // received nothing ever again. A table could be fully recovered server-side
    // and still be frozen forever on every screen.
    it('keeps live subscribers and resets sequence state so the next publish is a full SNAPSHOT', () => {
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      hub.publish(TABLE, { pot: 10 });
      sub.outbox.length = 0;

      hub.dropTable(TABLE);

      // The viewer survives the engine rebuild...
      expect(hub.subscriberCount(TABLE)).toBe(1);
      // ...is told why the sequence is about to reset...
      const notice = sub.outbox.map((m) => JSON.parse(m)).find((m) => m.type === 'EVENT');
      expect(notice?.payload?.type).toBe('engine_restarting');
      // ...and the room is reset so the next publish cannot be a DELTA against
      // a pre-restart baseline the new engine never produced.
      expect(hub.hasSnapshot(TABLE)).toBe(false);
      expect(hub.lastSeq(TABLE)).toBe(0);

      const seq = hub.publish(TABLE, { pot: 99 });
      expect(seq).toBe(1);
      const first = sub.outbox
        .map((m) => JSON.parse(m))
        .filter((m) => m.type === 'SNAPSHOT')
        .pop();
      expect(first?.state).toEqual({ pot: 99 });
    });
  });

  describe('metrics', () => {
    it('counts totalSubscribers across tables', () => {
      const t2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      hub.subscribe(TABLE, makeSub('s1'));
      hub.subscribe(TABLE, makeSub('s2'));
      hub.subscribe(t2, makeSub('s3'));
      expect(hub.totalSubscribers()).toBe(3);
    });
  });
  describe('C16 - payload is serialized once per publish, not per subscriber', () => {
    it('hands every subscriber the identical string instance', () => {
      const a = makeSub('a');
      const b = makeSub('b');
      const c = makeSub('c');
      hub.subscribe(TABLE, a);
      hub.subscribe(TABLE, b);
      hub.subscribe(TABLE, c);

      hub.publish(TABLE, { pot: 100 });

      // Same content for all three...
      expect(a.outbox[0]).toBe(b.outbox[0]);
      expect(b.outbox[0]).toBe(c.outbox[0]);
      // ...and it is literally the SAME string object, which is only possible if
      // JSON.stringify ran once outside the per-subscriber loop. This is the
      // regression guard: moving stringify back inside the loop still produces
      // equal strings, but no longer the same reference.
      expect(a.outbox[0] === b.outbox[0]).toBe(true);
      expect(Object.is(a.outbox[0], c.outbox[0])).toBe(true);
    });
  });

  describe('B12 - WebSocket backpressure', () => {
    const SOFT = 256 * 1024;
    const HARD = 4 * 1024 * 1024;

    it('keeps sending to a subscriber whose buffer is healthy', () => {
      const fast = makeSub('fast');
      hub.subscribe(TABLE, fast);
      hub.publish(TABLE, { pot: 1 });
      hub.publish(TABLE, { pot: 2 });
      expect(fast.outbox).toHaveLength(2);
      expect(hub.backpressureStats().softDropped).toBe(0);
    });

    it('drops DELTAs to a backed-up subscriber without touching the healthy one', () => {
      const slow = makeSub('slow');
      const fast = makeSub('fast');
      hub.subscribe(TABLE, slow);
      hub.subscribe(TABLE, fast);

      hub.publish(TABLE, { pot: 1 }); // SNAPSHOT to both
      expect(slow.outbox).toHaveLength(1);

      slow._bufferedAmount = SOFT + 1;
      hub.publish(TABLE, { pot: 2 }); // DELTA

      expect(slow.outbox).toHaveLength(1); // dropped
      expect(fast.outbox).toHaveLength(2); // unaffected
      expect(hub.backpressureStats().softDropped).toBe(1);
      // still subscribed — it can catch up once its buffer drains
      expect(hub.subscriberCount(TABLE)).toBe(2);
    });

    it('resumes delivery once the buffer drains', () => {
      const slow = makeSub('slow');
      hub.subscribe(TABLE, slow);
      hub.publish(TABLE, { pot: 1 });

      slow._bufferedAmount = SOFT + 1;
      hub.publish(TABLE, { pot: 2 });
      expect(slow.outbox).toHaveLength(1);

      slow._bufferedAmount = 0;
      hub.publish(TABLE, { pot: 3 });
      expect(slow.outbox).toHaveLength(2);
    });

    it('never drops a SNAPSHOT - it is how a gapped client recovers', () => {
      const slow = makeSub('slow');
      slow._bufferedAmount = SOFT + 1;
      hub.subscribe(TABLE, slow);
      hub.publish(TABLE, { pot: 1 }); // first publish is a SNAPSHOT
      expect(slow.outbox).toHaveLength(1);
      expect(parse(slow.outbox[0]).type).toBe('SNAPSHOT');
    });

    it('evicts a subscriber past the hard limit instead of buffering for it', () => {
      const hopeless = makeSub('hopeless');
      const fine = makeSub('fine');
      hub.subscribe(TABLE, hopeless);
      hub.subscribe(TABLE, fine);
      hub.publish(TABLE, { pot: 1 });

      hopeless._bufferedAmount = HARD + 1;
      hub.publish(TABLE, { pot: 2 });

      expect(hub.subscriberCount(TABLE)).toBe(1);
      expect(hub.backpressureStats().hardDropped).toBe(1);
      expect(fine.outbox).toHaveLength(2);
    });

    it('treats a subscriber with no bufferedAmount as healthy', () => {
      const plain = {
        id: 'plain',
        readyState: 1,
        sent: [] as string[],
        send(d: string) {
          this.sent.push(d);
        },
      };
      hub.subscribe(TABLE, plain as unknown as HubSubscriber);
      hub.publish(TABLE, { pot: 1 });
      hub.publish(TABLE, { pot: 2 });
      expect(plain.sent).toHaveLength(2);
    });
  });
});
