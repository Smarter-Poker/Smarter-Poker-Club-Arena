/**
 * EVERYONE HEARS IT (BBJ build plan phase 3.1).
 *
 * The client used to learn about a jackpot by watching `bbj_pools.hit_count`
 * go up. `payload.old` carries only the primary key, so the "previous" count
 * was always 0 and the real gate was a module variable that reset on every
 * page load - which is why Dan saw the same old jackpot announced at every
 * login. And the row it watched updates 40,219 times a day to carry a signal
 * that fires about once a fortnight.
 *
 * These pin the replacement: the `bbj_winners` INSERT, one row per jackpot,
 * written inside the payout transaction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Handler = (payload: { new?: Record<string, unknown> }) => void;
let bound: { config: Record<string, unknown>; handler: Handler } | null = null;
const removeChannel = vi.fn();
const channelName = vi.fn();

const rpc = vi.fn();
const fromTables = vi.fn();

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (t: string) => fromTables(t),
    channel: (name: string) => {
      channelName(name);
      const ch = {
        on: (_evt: string, config: Record<string, unknown>, handler: Handler) => {
          bound = { config, handler };
          return ch;
        },
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: (...a: unknown[]) => removeChannel(...a),
  },
}));

const emit = vi.fn();
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: (...a: unknown[]) => emit(...a) },
}));
const reportError = vi.fn();
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...a: unknown[]) => reportError(...a),
}));

import { watchBbjHits, __resetBbjHitFeedForTests } from '../../src/lib/bbjHitFeed';

const POOL = 'pool-9';
const AWARDED = '2026-09-06T12:00:00.000Z';

/** The row Realtime delivers. `winner_*` is the BAD BEAT holder - verified
 *  against production hand #1007239, where the 50% share sits on `winner_`. */
const winnerRow = (over: Record<string, unknown> = {}) => ({
  pool_id: POOL,
  table_id: 'table-7',
  hand_number: 1007239,
  winner_display_name: 'AlaskaAlex',
  winner_payout: '892.44',
  total_payout: '1784.85',
  awarded_at: AWARDED,
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 400));

beforeEach(() => {
  bound = null;
  rpc.mockReset();
  emit.mockReset();
  reportError.mockReset();
  removeChannel.mockReset();
  channelName.mockReset();
  fromTables.mockReset();
  fromTables.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
  });
  __resetBbjHitFeedForTests();
});

afterEach(() => __resetBbjHitFeedForTests());

describe('it listens to the ledger row, not to a counter', () => {
  it('binds to the bbj_winners INSERT for the pool', () => {
    const stop = watchBbjHits(POOL);
    expect(bound?.config).toEqual({
      event: 'INSERT',
      schema: 'public',
      table: 'bbj_winners',
      filter: `pool_id=eq.${POOL}`,
    });
    /* By POOL, not by club: a union banks one jackpot for all of its clubs, so
       a club_id filter would silently stop a union player hearing a hit at a
       sister club - which is the whole point of a union-wide jackpot. */
    stop();
  });

  it('three surfaces share one channel, and the last one closes it', () => {
    const a = watchBbjHits(POOL);
    const b = watchBbjHits(POOL);
    const c = watchBbjHits(POOL);
    expect(channelName).toHaveBeenCalledTimes(1);
    a();
    b();
    expect(removeChannel).not.toHaveBeenCalled();
    c();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });
});

describe('what it announces', () => {
  it('prefers the arena name from the ledger function over the column on the row', async () => {
    /* Measured on production for hand #1007239: fn_bbj_recent_hits says
       `buf_pam` and bbj_winners.winner_display_name says `AlaskaAlex` for the
       same hit. The function returns the ARENA name, which is what the rest of
       the platform shows the player. */
    rpc.mockResolvedValue({
      data: [
        {
          table_id: 'table-7',
          table_name: 'Diamond 3',
          bad_beat_name: 'buf_pam',
          bad_beat_amount: '892.44',
          game_variant: 'Omaha',
          big_blind: 2,
        },
      ],
      error: null,
    });
    const stop = watchBbjHits(POOL);
    bound!.handler({ new: winnerRow() });
    await settle();

    expect(emit).toHaveBeenCalledTimes(1);
    const [type, payload] = emit.mock.calls[0];
    expect(type).toBe('BBJ_HIT_GLOBAL');
    expect(payload).toMatchObject({
      tableId: 'table-7',
      tableName: 'Diamond 3',
      winnerName: 'buf_pam',
      amount: 892.44,
      gameVariant: 'Omaha',
      bigBlind: 2,
      handNumber: 1007239,
      emittedAt: new Date(AWARDED).getTime(),
    });
    stop();
  });

  it('announces from the row itself when the enrichment fails', async () => {
    /* The path this replaces emitted `tableId: ''` here, which the only
       subscriber drops on its first line - the fallback was dead code and a
       failed lookup meant the biggest event on the platform passed in
       silence. The row carries enough on its own. */
    rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    const stop = watchBbjHits(POOL);
    bound!.handler({ new: winnerRow() });
    await settle();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      tableId: 'table-7',
      winnerName: 'AlaskaAlex',
      amount: 892.44,
      handNumber: 1007239,
    });
    stop();
  });

  it('stamps the hit with when it was AWARDED, not when it arrived', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const stop = watchBbjHits(POOL);
    bound!.handler({ new: winnerRow() });
    await settle();
    /* BBJHitAnnouncer refuses an unstamped event (requireStamp) and refuses a
       stale one. A wall-clock stamp would make a replayed row look live. */
    expect(emit.mock.calls[0][1].emittedAt).toBe(new Date(AWARDED).getTime());
    stop();
  });

  it('falls back to the total when no share amount can be read', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const stop = watchBbjHits(POOL);
    bound!.handler({ new: winnerRow({ winner_payout: null }) });
    await settle();
    expect(emit.mock.calls[0][1].amount).toBe(1784.85);
    stop();
  });

  it('says so rather than emitting something guaranteed to be dropped', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const stop = watchBbjHits(POOL);
    bound!.handler({ new: winnerRow({ table_id: undefined }) });
    await settle();
    expect(emit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalled();
    expect(String(reportError.mock.calls[0][1])).toContain('hit_without_table');
    stop();
  });
});
