import { describe, expect, it, vi } from 'vitest';
import { LightningOperatorEvents } from './LightningOperatorEvents.js';
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../hub/ChannelHub.js', () => ({ channelHub: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
function fixture() {
  let insert: (row: any) => void = () => undefined;
  let status: (s: string) => void = () => undefined;
  const lookup = vi.fn().mockResolvedValue({ data: { club_id: 'club-a' }, error: null });
  const channel = {
    on: vi.fn((_type, _filter, cb) => {
      insert = cb;
      return channel;
    }),
    subscribe: vi.fn((cb) => {
      status = cb;
      return channel;
    }),
  };
  const db = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: lookup }) }) })),
  };
  const send = vi.fn();
  return {
    db,
    lookup,
    send,
    insert: (row: any) => insert({ new: row }),
    status: (s: string) => status(s),
  };
}
describe('operator transaction event bridge', () => {
  it('sends only identifiers to the owning club, never private ledger payloads', async () => {
    const f = fixture();
    const events = new LightningOperatorEvents(f.db as any, f.send);
    events.start();
    f.insert({
      game_id: 'cluster-a',
      kind: 'operator_pause',
      id: 'event-a',
      at: 'now',
      payload: { cards: ['As'], user_id: 'private' },
    });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.send).toHaveBeenCalledWith('club-a', {
      type: 'lightning_operator_changed',
      clusterId: 'cluster-a',
      kind: 'operator_pause',
      eventId: 'event-a',
      timestamp: 'now',
    });
    f.status('SUBSCRIBED');
    expect(f.send).toHaveBeenLastCalledWith('club-a', { type: 'lightning_operator_resync' });
    await events.stop();
    expect(f.db.removeChannel).toHaveBeenCalledOnce();
  });
  it('discards a lookup completed after stop', async () => {
    const f = fixture();
    let resolve!: (v: any) => void;
    f.lookup.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const events = new LightningOperatorEvents(f.db as any, f.send);
    events.start();
    f.insert({ game_id: 'cluster-a', kind: 'operator_drain' });
    await events.stop();
    resolve({ data: { club_id: 'club-a' }, error: null });
    await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('does not broadcast a failed or missing club lookup', async () => {
    const f = fixture();
    f.lookup.mockResolvedValue({ data: null, error: new Error('unavailable') } as any);
    const events = new LightningOperatorEvents(f.db as any, f.send);
    await events.publish({ game_id: 'cluster-a', kind: 'operator_pause' });
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe('private original top-up completion delivery', () => {
  it('delivers a validated terminal receipt only to its own room callback', async () => {
    const f = fixture(),
      topUp = vi.fn();
    const events = new LightningOperatorEvents(f.db as any, f.send, topUp);
    const receipt = {
      success: true,
      status: 'applied',
      queued: false,
      charged: true,
      applied: 30,
      requested: 30,
      request_id: 'original01',
      table_id: 'anchor',
      user_id: 'user',
      pool_session_id: 'own-room',
      occupancy_id: 'occupancy',
      stack: 50,
    };
    await events.publish({ kind: 'lightning_top_up_completed', payload: receipt });
    expect(topUp).toHaveBeenCalledWith(receipt);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.lookup).not.toHaveBeenCalled();
    await events.publish({
      kind: 'lightning_top_up_completed',
      payload: { ...receipt, status: 'pending', queued: true, charged: false, applied: 0 },
    });
    expect(topUp).toHaveBeenCalledTimes(1);
  });
});
