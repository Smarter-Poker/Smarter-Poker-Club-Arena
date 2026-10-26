/**
 * EVERY HORSE AT ONCE (2026-10-26). A settled boundary's horse top-ups are
 * each horse's own request - its own seat, session, wallet and key, the same
 * request a person's browser sends for their own seat - so they go out
 * together, through the same path, instead of one horse after another.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  seatReads: [] as Array<{ playerId: string; answer: (v: unknown) => void }>,
  request: vi.fn(),
  wallet: vi.fn(),
}));
vi.mock('../services/supabase.js', () => {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => {
        filters[c] = v;
        return q;
      },
      is: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () =>
        table === 'table_seats'
          ? new Promise((answer) => f.seatReads.push({ playerId: String(filters.user_id), answer }))
          : Promise.resolve({ data: { baseline: 20 }, error: null }),
    };
    return q;
  };
  return { supabase: { from }, readClubChipBalances: f.wallet };
});
vi.mock('./LightningTopUp.js', () => ({ requestLightningTopUp: f.request }));

const { requestLightningHorseTopUps } = await import('./LightningHorseTopUp.js');
const { horseCashTopUpStyle } = await import('../services/HorseTopUpStyle.js');

const toppers = Array.from({ length: 400 }, (_, i) => `horse-${i}`)
  .filter((id) => horseCashTopUpStyle(id, 'plo5') === 'auto_top_up')
  .slice(0, 3);
const seat = (id: string) => ({
  data: {
    table_id: `anchor-${id}`,
    stack: 20,
    auto_rebuy: true,
    club_id: 'club',
    is_sitting_out: false,
    leave_pending: false,
    tables: {
      cluster_id: 'cluster',
      game_variant: 'plo5',
      big_blind: 1,
      min_buy_in: 20,
      max_buy_in: 100,
    },
  },
  error: null,
});
const tick = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  f.seatReads.length = 0;
  vi.clearAllMocks();
  f.wallet.mockImplementation(async (_club: string, ids: string[]) => new Map([[ids[0], 100000]]));
  f.request.mockResolvedValue({ queued: true, charged: false, applied: 0 });
});

describe('a boundary tops its horses up together', () => {
  it('every horse is asked before any one of them has answered', async () => {
    expect(toppers).toHaveLength(3);
    const done = requestLightningHorseTopUps({
      handId: 'hand-a',
      clusterId: 'cluster',
      horsePlayers: toppers.map((playerId) => ({ playerId })),
    });
    await tick();
    expect(f.seatReads.map((r) => r.playerId).sort()).toEqual([...toppers].sort());
    for (const r of f.seatReads) r.answer(seat(r.playerId));
    await done;
    // Each through its own original request, under its own hand/player key.
    expect(f.request.mock.calls.map((c) => c[1]).sort()).toEqual([...toppers].sort());
    expect(new Set(f.request.mock.calls.map((c) => c[2])).size).toBe(3);
  });

  it('one horse failing does not stop the others, and the failure is still reported', async () => {
    const done = requestLightningHorseTopUps({
      handId: 'hand-b',
      clusterId: 'cluster',
      horsePlayers: toppers.map((playerId) => ({ playerId })),
    });
    await tick();
    const [bad, ...good] = f.seatReads;
    bad.answer({ data: null, error: new Error('seat read failed') });
    for (const r of good) r.answer(seat(r.playerId));
    await expect(done).rejects.toThrow('seat read failed');
    expect(f.request.mock.calls.map((c) => c[1]).sort()).toEqual(
      good.map((r) => r.playerId).sort()
    );
  });
});
