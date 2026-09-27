import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ channels: [] as any[], emit: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn(() => {
      const channel = {
        bindings: [] as any[],
        status: (_status: string) => {},
        on: vi.fn((_type, config, callback) => {
          channel.bindings.push({ config, callback });
          return channel;
        }),
        subscribe: vi.fn((callback) => {
          channel.status = callback;
          return channel;
        }),
        unsubscribe: vi.fn(),
      };
      fixture.channels.push(channel);
      return channel;
    }),
    removeChannel: vi.fn(),
  },
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: fixture.emit } }));
import { postgresSyncHooks } from '../../src/services/PostgresSyncHooks';

const row = (overrides = {}) => ({
  club_id: 'club-a',
  user_id: 'user-a',
  chip_balance: 100,
  promo_balance: 10,
  locked_chips: 20,
  role: 'member',
  status: 'active',
  ...overrides,
});
const member = (channel = fixture.channels.at(-1)) =>
  channel.bindings.find((b: any) => b.config.table === 'club_members').callback;
const flush = () => vi.advanceTimersByTime(350);

beforeEach(() => {
  vi.useFakeTimers();
  postgresSyncHooks.destroy();
  fixture.channels.length = 0;
  fixture.emit.mockClear();
  postgresSyncHooks.init('user-a');
});
afterEach(() => {
  postgresSyncHooks.destroy();
  vi.useRealTimers();
});

describe('the published membership stream carries live wallet invalidations', () => {
  it('uses the existing own-user membership binding without the retired wallet listener', () => {
    const bindings = fixture.channels[0].bindings;
    expect(bindings.filter((b: any) => b.config.table === 'club_members')).toHaveLength(1);
    expect(bindings.find((b: any) => b.config.table === 'club_members').config.filter).toBe(
      'user_id=eq.user-a'
    );
    expect(bindings.some((b: any) => b.config.table === 'wallets')).toBe(false);
  });
  it('coalesces balance changes and leaves unrelated membership UI alone', () => {
    member()({ eventType: 'UPDATE', new: row() });
    flush();
    fixture.emit.mockClear();
    member()({ eventType: 'UPDATE', new: row({ chip_balance: 110 }) });
    member()({ eventType: 'UPDATE', new: row({ chip_balance: 120 }) });
    flush();
    expect(fixture.emit.mock.calls).toEqual([
      [
        'BALANCE_UPDATED',
        {
          source: 'postgres_sync_membership',
          userId: 'user-a',
        },
      ],
    ]);
  });
  it('does not refetch balances or club pages for a last-seen timestamp update', () => {
    member()({ eventType: 'UPDATE', new: row() });
    flush();
    fixture.emit.mockClear();
    member()({ eventType: 'UPDATE', new: row({ updated_at: 'later', hands_played: 40 }) });
    flush();
    expect(fixture.emit).not.toHaveBeenCalled();
  });
  it('keeps role and access updates while ignoring another users unfiltered deletion', () => {
    member()({ eventType: 'UPDATE', new: row() });
    flush();
    fixture.emit.mockClear();
    member()({ eventType: 'UPDATE', new: row({ role: 'agent' }) });
    flush();
    expect(fixture.emit.mock.calls).toEqual([['CLUB_UPDATED', { clubId: 'club-a' }]]);
    fixture.emit.mockClear();
    member()({ eventType: 'DELETE', old: { club_id: 'club-b', user_id: 'user-b' } });
    flush();
    expect(fixture.emit).not.toHaveBeenCalled();
    member()({ eventType: 'DELETE', old: { club_id: 'club-a', user_id: 'user-a' } });
    flush();
    expect(fixture.emit).toHaveBeenCalledWith('CLUB_LEFT', { clubId: 'club-a' });
    expect(fixture.emit).toHaveBeenCalledWith(
      'BALANCE_UPDATED',
      expect.objectContaining({ userId: 'user-a' })
    );
  });
  it('refreshes on subscription recovery and forgets pre-disconnect field baselines', () => {
    member()({ eventType: 'UPDATE', new: row() });
    flush();
    fixture.emit.mockClear();
    fixture.channels[0].status('SUBSCRIBED');
    flush();
    expect(fixture.emit).toHaveBeenCalledWith(
      'BALANCE_UPDATED',
      expect.objectContaining({ userId: 'user-a' })
    );
  });
  it('rejects late messages and connection status from a destroyed same-user channel', () => {
    const old = fixture.channels[0];
    postgresSyncHooks.destroy();
    postgresSyncHooks.init('user-a');
    fixture.emit.mockClear();
    member(old)({ eventType: 'UPDATE', new: row() });
    old.status('SUBSCRIBED');
    flush();
    expect(fixture.emit).not.toHaveBeenCalled();
  });
  it('clears queued old-account signals on an account switch', () => {
    member()({ eventType: 'UPDATE', new: row() });
    postgresSyncHooks.init('user-b');
    flush();
    expect(fixture.emit).not.toHaveBeenCalled();
    member()({ eventType: 'UPDATE', new: row() });
    flush();
    expect(fixture.emit).not.toHaveBeenCalled();
  });
  it('keeps the existing five-attempt limit across failed channel replacements', () => {
    for (const delay of [2000, 4000, 8000, 16000, 30000]) {
      fixture.channels.at(-1).status('CHANNEL_ERROR');
      vi.advanceTimersByTime(delay);
    }
    expect(fixture.channels).toHaveLength(6);
    fixture.channels.at(-1).status('CHANNEL_ERROR');
    vi.advanceTimersByTime(60000);
    expect(fixture.channels).toHaveLength(6);
  });
  it('cancels a pending replacement when the current channel recovers', () => {
    fixture.channels[0].status('CHANNEL_ERROR');
    fixture.channels[0].status('SUBSCRIBED');
    vi.advanceTimersByTime(2000);
    expect(fixture.channels).toHaveLength(1);
    fixture.channels[0].status('CHANNEL_ERROR');
    vi.advanceTimersByTime(1999);
    expect(fixture.channels).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(fixture.channels).toHaveLength(2);
  });
});
