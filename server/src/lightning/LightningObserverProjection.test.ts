import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { TableStateHub } = await import('../transport/TableStateHub.js');
const { LightningObserverProjection } = await import('./LightningObserverProjection.js');
const { buildHost, formedHand, uid, flush, fakeBackend } =
  await import('../testing/lightningHostTestKit.js');

function viewer(hub: InstanceType<typeof TableStateHub>, table = 'anchor') {
  const messages: any[] = [];
  const sub = {
    id: String(Math.random()),
    userId: 'observer',
    readyState: 1,
    bufferedAmount: 0,
    send: (data: string) => messages.push(JSON.parse(data)),
  };
  hub.subscribe(table, sub);
  return { messages, sub };
}

describe('Lightning public physical observer projection', () => {
  it('keeps a single hand, rotates at finish and reconnects to the selected public hand', () => {
    const hub = new TableStateHub();
    let enabled = true;
    const observer = new LightningObserverProjection(hub, () => (enabled ? ['anchor'] : []));
    const a = { clusterId: 'cluster' },
      b = { clusterId: 'cluster' };
    const first = viewer(hub);
    hub.publish('anchor', { hand_id: 'old-cash' });
    observer.started(a);
    observer.event(a, { event: 'hand_started', hand_id: 'a' });
    observer.state(a, { hand_id: 'a', stage: 'preflop' });
    observer.state(b, { hand_id: 'b', stage: 'flop' });
    observer.event(b, { event: 'other-hand', hand_id: 'b' });
    hub.publish('anchor', { hand_id: 'old-cash' });
    hub.emitEvent('anchor', { event: 'stale-cash' });
    expect(hub.sendToUser('anchor', 'observer', { hole_cards: ['As', 'Ah'] })).toBe(0);
    const reconnect = viewer(hub);
    expect(reconnect.messages[0].state).toEqual({
      table_id: 'anchor',
      lightning_observer: true,
      hand_id: 'a',
      stage: 'preflop',
    });
    expect(first.messages.filter((m) => m.type === 'EVENT').map((m) => m.payload.event)).toEqual([
      'hand_started',
    ]);
    observer.finished(a);
    hub.resync('anchor', reconnect.sub);
    expect(reconnect.messages.at(-1).state).toEqual({
      table_id: 'anchor',
      lightning_observer: true,
      hand_id: 'b',
      stage: 'flop',
    });
    observer.event(a, { event: 'late-a' });
    expect(reconnect.messages.some((m) => m.payload?.event === 'late-a')).toBe(false);
    observer.finished(b);
    hub.publish('anchor', { hand_id: 'old-cash' });
    expect(viewer(hub).messages[0].state.hand_id).toBe('b');
    enabled = false;
    hub.publish('anchor', { hand_id: 'classic-resumed' });
    expect(viewer(hub).messages[0].state.hand_id).toBe('classic-resumed');
  });

  it('wires public observers through the production hosting owner without granting pool access', async () => {
    const { LightningHosting, LightningRegistry } = await import('./LightningRegistry.js');
    const { LIGHTNING_AUTO_REBUY_DEFAULTS } = await import('./LightningConfig.js');
    const hub = new TableStateHub();
    const registry = new LightningRegistry({
      viewAccess: async () => false,
      roomOwner: async () => null,
    });
    const observers = new LightningObserverProjection(hub, () => ['anchor']);
    const hand = formedHand(6, 7899);
    const fb = fakeBackend(hand, Array(6).fill(200), new Set());
    const hosting = new LightningHosting({
      registry,
      backend: fb.backend,
      hub,
      observers,
      leaseFor: () => ({ instance: 'test', generation: uid(4242) }),
      hostOptions: { sleep: () => Promise.resolve(), logger: { log() {}, warn() {}, error() {} } },
    });
    const host = hosting.startHand(
      hand,
      {
        matcherVersion: null,
        workerMode: 'form',
        passIntervalMs: 1000,
        keepaliveIntervalMs: 5000,
        maxHandsPerPass: 7,
        dealWindowMs: 600000,
        autoRebuy: LIGHTNING_AUTO_REBUY_DEFAULTS,
      },
      () => {}
    );
    try {
      await flush();
      expect(viewer(hub).messages[0]?.state.hand_id).toBe(host.currentHandId);
      expect(await registry.authorize('anchor', 'observer')).toMatchObject({ allowed: false });
      expect(host.roomOf('observer')).toBeNull();
    } finally {
      await host.abort('test_complete');
    }
  });

  it('uses real host shared projection without private cards, personal actions or observer participation', async () => {
    const hub = new TableStateHub();
    const observer = new LightningObserverProjection(hub, () => ['anchor']);
    const view = viewer(hub);
    const formed = formedHand(6, 7891);
    const fixture = buildHost(formed, Array(6).fill(200), {
      rules: { is_anonymous: true },
      deps: {
        onDealing: (h) => observer.started(h),
        onPublicState: (h, state) => observer.state(h, state),
        onPublicEvent: (h, event) => observer.event(h, event),
        onFinished: (h) => observer.finished(h),
      },
    });
    try {
      await fixture.host.start();
      await flush();
      const current = viewer(hub).messages[0].state;
      expect(current.hand_id).toBe(fixture.host.currentHandId);
      expect(current.players).toHaveLength(6);
      expect(current.lightning).toBeUndefined();
      const publicWire = JSON.stringify(view.messages);
      expect(publicWire).not.toContain('USER_EVENT');
      expect(publicWire).not.toContain('hole_cards');
      expect(publicWire).not.toContain('fast_fold_available');
      expect(fixture.hub.frames.filter((f) => f.kind === 'private')).toHaveLength(6);
      expect(fixture.host.roomOf('observer')).toBeNull();
      expect(fixture.hub.frames.some((f) => f.room === 'anchor')).toBe(false);
      for (const seat of current.players) {
        expect(seat.username).toBe(`Player ${seat.seat}`);
        expect(seat.cards ?? []).toEqual([]);
      }
    } finally {
      await fixture.host.abort('test_complete');
    }
  });
});
