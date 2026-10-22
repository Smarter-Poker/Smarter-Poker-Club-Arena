import { beforeEach, describe, expect, it, vi } from 'vitest';
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: { from } }));
import { lightningAnchorSeat } from './lightningAnchor.js';
const ids = Array.from(
  { length: 8 },
  (_, i) =>
    `${i + 1}`.repeat(8) +
    '-' +
    `${i + 1}`.repeat(4) +
    '-4' +
    `${i + 1}`.repeat(3) +
    '-8' +
    `${i + 1}`.repeat(3) +
    '-' +
    `${i + 1}`.repeat(12)
);
const [player, pool, seat, table, cluster, occupancy, cash, hand] = ids;
let reads: Record<string, any>;
let calls: Array<{ name: string; chain: any }>;
let replaceOnFence = false;
let failure: string | undefined;
beforeEach(() => {
  replaceOnFence = false;
  failure = undefined;
  calls = [];
  reads = {
    lightning_pool_session: {
      player_id: player,
      cluster_id: cluster,
      anchor_seat_id: seat,
      exited_at: null,
      cash_player_session_id: cash,
      entered_at: '2026-10-20T18:00:00Z',
    },
    table_seats: {
      table_id: table,
      seat_number: 2,
      occupancy_id: occupancy,
      user_id: player,
      left_at: null,
    },
    cash_player_session: { id: cash, opened_at: '2026-10-20T17:00:00Z' },
    lightning_pool_slot: [{ id: seat }],
    lightning_hand_player: { hand_id: hand },
    lightning_hand: { hand_id: hand },
  };
  from.mockReset().mockImplementation((name: string) => {
    const answer = () => ({
      data:
        replaceOnFence && name === 'table_seats' && calls.filter((c) => c.name === name).length > 1
          ? { ...reads[name], occupancy_id: cash }
          : reads[name],
      error: failure === name ? { message: 'unavailable' } : null,
    });
    const chain: any = {};
    for (const method of ['select', 'eq', 'is', 'in', 'not', 'gte', 'limit'])
      chain[method] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => answer());
    chain.then = (resolve: any) => Promise.resolve(answer()).then(resolve);
    calls.push({ name, chain });
    return chain;
  });
});
describe('completed hand eligibility belongs to the original open pool', () => {
  it('pins pool/player/slot/original cash and settled hand, then rechecks current occupancy', async () => {
    expect(
      await lightningAnchorSeat(pool, player, { requireOpen: true, requireCompletedHand: true })
    ).toMatchObject({ completedHandOccupancyId: occupancy });
    const q = (name: string) => calls.find((c) => c.name === name)!.chain;
    expect(q('cash_player_session').eq.mock.calls).toEqual([
      ['id', cash],
      ['player_id', player],
      ['table_id', table],
    ]);
    expect(q('lightning_pool_slot').eq.mock.calls).toEqual([
      ['pool_session_id', pool],
      ['player_id', player],
    ]);
    expect(q('lightning_hand_player').in).toHaveBeenCalledWith('pool_slot_id', [seat]);
    expect(q('lightning_hand_player').not).toHaveBeenCalledWith('stack_after', 'is', null);
    expect(q('lightning_hand').not).toHaveBeenCalledWith('settled_at', 'is', null);
    expect(q('lightning_hand').gte).toHaveBeenCalledWith('settled_at', '2026-10-20T18:00:00Z');
    expect(calls.filter((c) => c.name === 'table_seats')).toHaveLength(2);
  });
  it.each(['cash_player_session', 'lightning_hand_player', 'lightning_hand'])(
    'does not qualify missing %s',
    async (name) => {
      reads[name] = null;
      expect(
        await lightningAnchorSeat(pool, player, { requireOpen: true, requireCompletedHand: true })
      ).toBeNull();
    }
  );
  it('does not qualify a replacement occupancy after awaited proof', async () => {
    replaceOnFence = true;
    expect(
      await lightningAnchorSeat(pool, player, { requireOpen: true, requireCompletedHand: true })
    ).toBeNull();
  });
  it('refuses unknown reads rather than inventing a completed hand', async () => {
    failure = 'lightning_hand_player';
    await expect(
      lightningAnchorSeat(pool, player, { requireOpen: true, requireCompletedHand: true })
    ).rejects.toThrow('participation read failed');
  });
  it('does not qualify a new cash session after pool entry', async () => {
    reads.cash_player_session.opened_at = '2026-10-20T19:00:00Z';
    expect(
      await lightningAnchorSeat(pool, player, { requireOpen: true, requireCompletedHand: true })
    ).toBeNull();
  });
});
