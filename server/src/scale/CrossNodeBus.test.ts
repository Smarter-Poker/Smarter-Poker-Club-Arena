import { describe, it, expect, vi } from 'vitest';
import { InMemoryCrossNodeBus, Topics } from './CrossNodeBus.js';

describe('Topics', () => {
  it('builds canonical topic strings', () => {
    expect(Topics.lobby).toBe('lobby.update');
    expect(Topics.presence('club-9')).toBe('presence.club-9');
    expect(Topics.waitlist('t-1')).toBe('waitlist.t-1');
    expect(Topics.tournament('mtt-5')).toBe('tournament.mtt-5');
  });
});

describe('InMemoryCrossNodeBus', () => {
  it('delivers published payloads to exact-topic subscribers with an envelope', () => {
    const bus = new InMemoryCrossNodeBus({ nodeId: 'node-A' });
    const seen: unknown[] = [];
    bus.subscribe<{ n: number }>(Topics.lobby, (payload, env) => {
      seen.push({ payload, env });
    });
    bus.publish(Topics.lobby, { n: 42 });

    expect(seen).toHaveLength(1);
    const { payload, env } = seen[0] as any;
    expect(payload).toEqual({ n: 42 });
    expect(env.topic).toBe(Topics.lobby);
    expect(env.senderId).toBe('node-A');
    expect(typeof env.messageId).toBe('string');
    expect(typeof env.publishedAt).toBe('number');
  });

  it('does not deliver to a topic with no subscribers, or before subscribing', () => {
    const bus = new InMemoryCrossNodeBus();
    // publish before any subscriber — must be a no-op (no throw)
    expect(() => bus.publish('waitlist.t-1', {})).not.toThrow();
    const handler = vi.fn();
    bus.subscribe('waitlist.t-1', handler);
    // publishing a DIFFERENT topic must not hit it
    bus.publish('waitlist.t-2', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports prefix (pattern) subscriptions', () => {
    const bus = new InMemoryCrossNodeBus();
    const got: string[] = [];
    bus.subscribePattern(Topics.presenceAll, (_p, env) => got.push(env.topic));

    bus.publish(Topics.presence('club-1'), { s: 'online' });
    bus.publish(Topics.presence('club-2'), { s: 'away' });
    bus.publish(Topics.lobby, {}); // different family — should NOT match

    expect(got.sort()).toEqual(['presence.club-1', 'presence.club-2']);
  });

  it('unsubscribe stops delivery for both exact and pattern subs', () => {
    const bus = new InMemoryCrossNodeBus();
    const exact = vi.fn();
    const pattern = vi.fn();
    const s1 = bus.subscribe('lobby.update', exact);
    const s2 = bus.subscribePattern('presence.', pattern);

    bus.publish('lobby.update', {});
    bus.publish('presence.c1', {});
    expect(exact).toHaveBeenCalledTimes(1);
    expect(pattern).toHaveBeenCalledTimes(1);

    s1.unsubscribe();
    s2.unsubscribe();
    bus.publish('lobby.update', {});
    bus.publish('presence.c1', {});
    expect(exact).toHaveBeenCalledTimes(1);
    expect(pattern).toHaveBeenCalledTimes(1);
  });

  it('fans out to multiple subscribers on the same topic', () => {
    const bus = new InMemoryCrossNodeBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('tournament.x', a);
    bus.subscribe('tournament.x', b);
    bus.publish('tournament.x', { hand: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing handler and reports via onError without blocking others', () => {
    const onError = vi.fn();
    const bus = new InMemoryCrossNodeBus({ onError });
    const good = vi.fn();
    bus.subscribe('lobby.update', () => {
      throw new Error('boom');
    });
    bus.subscribe('lobby.update', good);

    bus.publish('lobby.update', {});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1); // still delivered
  });

  it('generates a nodeId when none supplied', () => {
    const bus = new InMemoryCrossNodeBus();
    expect(bus.nodeId).toMatch(/^node-/);
  });

  it('close() stops further delivery', async () => {
    const bus = new InMemoryCrossNodeBus();
    const h = vi.fn();
    bus.subscribe('lobby.update', h);
    await bus.close();
    bus.publish('lobby.update', {});
    expect(h).not.toHaveBeenCalled();
  });
});
