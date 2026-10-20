import { beforeEach, describe, expect, it, vi } from 'vitest';
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: { from } }));
import { lightningAnchorSeat } from './lightningAnchor.js';

const player = '11111111-1111-4111-8111-111111111111';
const pool = '22222222-2222-4222-8222-222222222222';
const seat = '33333333-3333-4333-8333-333333333333';
const table = '44444444-4444-4444-8444-444444444444';
const cluster = '55555555-5555-4555-8555-555555555555';
const occupancy = '66666666-6666-4666-8666-666666666666';
let session: Record<string, unknown>;
let anchor: Record<string, unknown>;
let chains: Array<{ name: string; eq: ReturnType<typeof vi.fn> }>;

beforeEach(() => {
  session = { player_id: player, cluster_id: cluster, anchor_seat_id: seat, exited_at: null };
  anchor = {
    table_id: table,
    seat_number: 2,
    occupancy_id: occupancy,
    user_id: player,
    left_at: null,
  };
  chains = [];
  from.mockReset().mockImplementation((name: string) => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({
        data: name === 'lightning_pool_session' ? session : anchor,
        error: null,
      })),
    };
    chains.push({ name, eq: chain.eq });
    return chain;
  });
});

describe('strict open room anchor lookup', () => {
  it('pins the exact pool and its actual seat, preserving a sitting-out return', async () => {
    expect(await lightningAnchorSeat(pool, player, { requireOpen: true })).toEqual({
      anchorTableId: table,
      seatNumber: 2,
      occupancyId: occupancy,
      clusterId: cluster,
    });
    expect(chains.map((c) => [c.name, c.eq.mock.calls])).toEqual([
      ['lightning_pool_session', [['id', pool]]],
      ['table_seats', [['id', seat]]],
    ]);
  });
  it('refuses a closed pool without resolving another pool or touching its seat', async () => {
    session.exited_at = '2026-10-20T18:00:00Z';
    expect(await lightningAnchorSeat(pool, player, { requireOpen: true })).toBeNull();
    expect(from).toHaveBeenCalledTimes(1);
  });
  it('refuses a departed anchor', async () => {
    anchor.left_at = '2026-10-20T18:00:00Z';
    expect(await lightningAnchorSeat(pool, player, { requireOpen: true })).toBeNull();
  });
  it.each(['pool', 'seat'])('refuses a %s belonging to another player', async (kind) => {
    (kind === 'pool' ? session : anchor)[kind === 'pool' ? 'player_id' : 'user_id'] = pool;
    expect(await lightningAnchorSeat(pool, player, { requireOpen: true })).toBeNull();
  });
  it('retains historical lookup by default for original cash-out receipt recovery', async () => {
    session.exited_at = '2026-10-20T18:00:00Z';
    anchor.left_at = '2026-10-20T18:00:00Z';
    expect(await lightningAnchorSeat(pool, player)).toMatchObject({ occupancyId: occupancy });
  });
});
