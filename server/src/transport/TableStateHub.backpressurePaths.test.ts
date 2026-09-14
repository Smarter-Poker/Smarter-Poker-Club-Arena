import { describe, expect, it } from 'vitest';
import { TableStateHub, type HubSubscriber } from './TableStateHub.js';

const HARD = 4 * 1024 * 1024;
const SOFT = 256 * 1024;

function socket(id: string, bufferedAmount = 0) {
  const sub: HubSubscriber & {
    bufferedAmount: number;
    readyState: number;
    frames: string[];
    evictions: number;
  } = {
    id,
    userId: 'hero',
    bufferedAmount,
    readyState: 1,
    frames: [],
    evictions: 0,
    send(data: string) {
      this.frames.push(data);
      this.bufferedAmount += Buffer.byteLength(data);
    },
    evict() {
      this.evictions++;
    },
  };
  return sub;
}

const reveal = (type: string) => ({ type, replay_until: Date.now() + 60_000 });

describe('TableStateHub hard backpressure covers every send path', () => {
  it('refuses an over-limit subscribing socket before snapshot or reveal replay', () => {
    const hub = new TableStateHub();
    hub.publish('table', { pot: 1 });
    hub.emitEvent('table', reveal('spin_reveal'));
    const slow = socket('slow', HARD + 1);
    hub.subscribe('table', slow);
    expect(slow.frames).toEqual([]);
    expect(slow.evictions).toBe(1);
    expect(hub.subscriberCount('table')).toBe(0);
    expect(hub.replayStats().replayedEvents).toBe(0);
  });

  it('stops a repeated resync stream even if the quiet table never broadcasts again', () => {
    const hub = new TableStateHub();
    const slow = socket('slow');
    hub.subscribe('table', slow);
    hub.publish('table', { content: 'x'.repeat(32 * 1024) });
    for (let i = 0; i < 300; i++) hub.resync('table', slow);
    const bytesAtEviction = slow.bufferedAmount;
    const framesAtEviction = slow.frames.length;
    // Existing semantics allow one frame to cross HARD. The next send must
    // evict, including when only client-requested snapshots are being sent.
    expect(bytesAtEviction).toBeGreaterThan(HARD);
    expect(bytesAtEviction).toBeLessThan(HARD + 33 * 1024);
    expect(slow.evictions).toBe(1);
    expect(hub.subscriberCount('table')).toBe(0);
    for (let i = 0; i < 300; i++) hub.resync('table', slow);
    expect(slow.bufferedAmount).toBe(bytesAtEviction);
    expect(slow.frames).toHaveLength(framesAtEviction);
    expect(hub.backpressureStats().hardDropped).toBe(1);
  });

  it('evicts an over-limit private recipient while healthy copies still receive their cards', () => {
    const hub = new TableStateHub();
    const slow = socket('slow');
    const healthy = socket('healthy');
    hub.subscribe('table', slow);
    hub.subscribe('table', healthy);
    slow.bufferedAmount = HARD + 1;
    expect(hub.sendToUser('table', 'hero', { kind: 'hole_cards', cards: ['Ah', 'Kh'] })).toBe(1);
    expect(slow.frames).toEqual([]);
    expect(slow.evictions).toBe(1);
    expect(healthy.frames.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: 'USER_EVENT',
        tableId: 'table',
        payload: { kind: 'hole_cards', cards: ['Ah', 'Kh'] },
      },
    ]);
    expect(hub.subscriberCount('table')).toBe(1);
  });

  it('preserves snapshot and private recovery above SOFT while still below HARD', () => {
    const hub = new TableStateHub();
    hub.publish('table', { pot: 2 });
    const slow = socket('slow', SOFT + 1);
    hub.subscribe('table', slow);
    expect(hub.resync('table', slow)).toBe(true);
    expect(hub.sendToUser('table', 'hero', { kind: 'hole_cards' })).toBe(1);
    expect(slow.frames.map((frame) => JSON.parse(frame).type)).toEqual([
      'SNAPSHOT',
      'SNAPSHOT',
      'USER_EVENT',
    ]);
    expect(slow.evictions).toBe(0);
  });

  it('checks the buffer between retained frames and leaves unsent reveals replayable', () => {
    const hub = new TableStateHub();
    hub.emitEvent('table', reveal('first'));
    hub.emitEvent('table', reveal('second'));
    const slow = socket('slow', HARD - 1);
    hub.subscribe('table', slow);
    expect(slow.frames).toHaveLength(1);
    expect(JSON.parse(slow.frames[0]).payload.type).toBe('first');
    expect(slow.evictions).toBe(1);
    expect(hub.replayStats().replayedEvents).toBe(1);
    const reconnected = socket('reconnected');
    hub.subscribe('table', reconnected);
    expect(reconnected.frames.map((frame) => JSON.parse(frame).payload.type)).toEqual([
      'first',
      'second',
    ]);
  });

  it('never resyncs or replays into a closing socket', () => {
    const hub = new TableStateHub();
    hub.publish('table', { pot: 2 });
    const closing = socket('closing');
    hub.subscribe('table', closing);
    closing.frames.length = 0;
    closing.readyState = 2;
    hub.emitEvent('table', reveal('spin_reveal'));
    hub.resync('table', closing);
    expect(closing.frames).toEqual([]);
    expect(hub.subscriberCount('table')).toBe(0);
    expect(closing.evictions).toBe(0);
  });

  it('a throwing transport eviction cannot interrupt healthy private delivery', () => {
    const hub = new TableStateHub();
    const slow = socket('slow');
    const healthy = socket('healthy');
    slow.evict = () => {
      throw new Error('socket already lost');
    };
    hub.subscribe('table', slow);
    hub.subscribe('table', healthy);
    slow.bufferedAmount = HARD + 1;
    expect(hub.sendToUser('table', 'hero', { kind: 'pre_action' })).toBe(1);
    expect(healthy.frames).toHaveLength(1);
    expect(hub.subscriberCount('table')).toBe(1);
  });

  it('does not resurrect the evicted adapter if resubscribe races transport cleanup', () => {
    const hub = new TableStateHub();
    hub.publish('table', { pot: 3 });
    const stale = socket('stale', HARD + 1);
    hub.subscribe('table', stale);
    stale.bufferedAmount = 0;
    hub.subscribe('table', stale);
    hub.publish('table', { pot: 4 });
    expect(stale.frames).toEqual([]);
    expect(stale.evictions).toBe(1);
    expect(hub.subscriberCount('table')).toBe(0);
    const fresh = socket('fresh');
    hub.subscribe('table', fresh);
    expect(fresh.frames).toHaveLength(1);
  });
});
