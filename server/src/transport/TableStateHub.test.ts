import { describe, it, expect, beforeEach } from 'vitest';
import { TableStateHub, type HubSubscriber } from './TableStateHub.js';

function makeSub(id: string, readyState = 1 /* OPEN */) {
  const outbox: string[] = [];
  const sub: HubSubscriber & { outbox: string[]; close(): void; _readyState: number } = {
    id,
    outbox,
    _readyState: readyState,
    get readyState() {
      return this._readyState;
    },
    send(data: string) {
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

    it('skips empty-patch publishes but still advances seq', () => {
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      hub.publish(TABLE, { pot: 10 });
      hub.publish(TABLE, { pot: 10 }); // identical
      // Only the SNAPSHOT should have been sent; no empty DELTA.
      expect(sub.outbox).toHaveLength(1);
      // But seq advanced internally.
      expect(hub.lastSeq(TABLE)).toBe(2);
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

    it('no snapshot yet — subscriber waits for first publish', () => {
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
    it('removes all state for a table', () => {
      const sub = makeSub('s1');
      hub.subscribe(TABLE, sub);
      hub.publish(TABLE, { pot: 10 });
      hub.dropTable(TABLE);
      expect(hub.subscriberCount(TABLE)).toBe(0);
      expect(hub.hasSnapshot(TABLE)).toBe(false);
      expect(hub.lastSeq(TABLE)).toBe(0);
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
});
