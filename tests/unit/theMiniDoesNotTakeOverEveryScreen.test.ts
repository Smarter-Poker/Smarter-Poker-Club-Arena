/**
 * THE MINI DOES NOT TAKE OVER EVERY SCREEN
 *
 * BBJ phase 6 shipped a second jackpot tier that writes a `bbj_winners` row -
 * the same table the platform-wide announcement listens to. Three surfaces
 * subscribe to that INSERT, and none of them knew the difference:
 *
 *   lib/bbjHitFeed          -> BBJ_HIT_GLOBAL -> BBJHitAnnouncer, a full
 *                              announcement on EVERY page every player has open
 *   BBJTicker               -> the scrolling strip
 *   BBJRecentHits           -> the Previous Winners list
 *
 * The main jackpot fires about once a fortnight and pays six figures, which is
 * what earns it a takeover. A mini fires ABOUT FOUR TIMES A DAY for a few
 * hundred chips. Announcing both the same way would put an interruption on
 * every screen every six hours and make the real one indistinguishable from
 * background noise inside a week - CLAUDE.md 10.84's "an alarm that is always
 * on is an alarm that gets muted", except what gets muted here is the jackpot.
 *
 * So: the mini celebrates at its own table, appears in the ticker and the list
 * BADGED, and does not interrupt anybody else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Handler = (payload: { new?: Record<string, unknown> }) => void;
let bound: { handler: Handler } | null = null;
const emit = vi.fn();
const rpc = vi.fn();

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    channel: () => {
      const ch = {
        on: (_e: string, _c: unknown, handler: Handler) => {
          bound = { handler };
          return ch;
        },
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: vi.fn(),
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: (...a: unknown[]) => emit(...a) },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { watchBbjHits, __resetBbjHitFeedForTests } from '../../src/lib/bbjHitFeed';

const POOL = 'pool-1';
const row = (over: Record<string, unknown> = {}) => ({
  pool_id: POOL,
  table_id: 'table-1',
  hand_number: 42,
  winner_display_name: 'Someone',
  winner_payout: '500',
  total_payout: '1000',
  awarded_at: '2026-09-07T18:00:00.000Z',
  ...over,
});
const settle = () => new Promise((r) => setTimeout(r, 400));

beforeEach(() => {
  bound = null;
  emit.mockReset();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
  __resetBbjHitFeedForTests();
});
afterEach(() => __resetBbjHitFeedForTests());

describe('the platform-wide announcement', () => {
  it('fires for the main jackpot', async () => {
    const stop = watchBbjHits(POOL);
    bound!.handler({ new: row({ kind: 'main' }) });
    await settle();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe('BBJ_HIT_GLOBAL');
    stop();
  });

  it('fires for a row with no kind at all - every row written before the mini', async () => {
    const stop = watchBbjHits(POOL);
    bound!.handler({ new: row() });
    await settle();
    expect(emit).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does NOT fire for a mini', async () => {
    const stop = watchBbjHits(POOL);
    bound!.handler({ new: row({ kind: 'mini' }) });
    await settle();
    expect(emit).not.toHaveBeenCalled();
    stop();
  });

  it('refuses the mini BEFORE it does any enrichment work', async () => {
    /* The filter is the first line of announce() on purpose: four skipped
       announcements a day should also be four RPCs and two table reads that
       never happen. */
    const stop = watchBbjHits(POOL);
    bound!.handler({ new: row({ kind: 'mini' }) });
    await settle();
    expect(rpc).not.toHaveBeenCalled();
    stop();
  });
});
