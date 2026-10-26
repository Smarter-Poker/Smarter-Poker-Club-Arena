/**
 * A NEW PLAYER'S DURABLE TIME BANK, IN ONE ROUND TRIP (2026-10-26). The open
 * pool sessions name the anchor seats and the players' live seats carry the
 * banks; the seat read used to wait for the session read. Both go together
 * now, and only the seat an open session anchors, held by that session's own
 * player, is used.
 */
import { describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  pending: [] as Array<{ table: string; answer: (v: unknown) => void }>,
}));
vi.mock('./client.js', () => ({
  supabase: {
    from(table: string) {
      const q: any = {
        select: () => q,
        eq: () => q,
        in: () => q,
        is: () => q,
        then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
          return new Promise((answer) => io.pending.push({ table, answer })).then(
            onFulfilled,
            onRejected
          );
        },
      };
      return q;
    },
  },
}));

const { lightningAnchorTimeBanks, lightningSeatsSittingOut } = await import('./lightningAnchor.js');
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('lightningAnchorTimeBanks', () => {
  it('asks for the sessions and the seats together, and keeps only each session anchor', async () => {
    const P1 = uid(1);
    const P2 = uid(2);
    const done = lightningAnchorTimeBanks(uid(100), [P1, P2]);
    await tick();
    // Both reads are in flight before either has answered.
    expect(io.pending.map((p) => p.table).sort()).toEqual([
      'lightning_pool_session',
      'table_seats',
    ]);
    const answer = (table: string, v: unknown) =>
      io.pending.find((p) => p.table === table)!.answer(v);
    answer('table_seats', {
      data: [
        // P1's anchor seat.
        { id: uid(11), user_id: P1, time_bank_remaining: 25, time_bank_uses_remaining: 2 },
        // P1's seat in another Cluster: not an anchor of THIS Cluster's session.
        { id: uid(12), user_id: P1, time_bank_remaining: 99, time_bank_uses_remaining: 9 },
        // P2's anchor seat, but the row names another occupant: never used.
        { id: uid(21), user_id: uid(3), time_bank_remaining: 5, time_bank_uses_remaining: 1 },
      ],
      error: null,
    });
    answer('lightning_pool_session', {
      data: [
        { player_id: P1, anchor_seat_id: uid(11) },
        { player_id: P2, anchor_seat_id: uid(21) },
      ],
      error: null,
    });
    const out = await done;
    expect([...out]).toEqual([[P1, { remainingSeconds: 25, usesRemaining: 2 }]]);
  });

  it('either read failing throws, as before (the ledger then seeds from the allowance)', async () => {
    io.pending.length = 0;
    const done = lightningAnchorTimeBanks(uid(100), [uid(1)]);
    await tick();
    io.pending
      .find((p) => p.table === 'table_seats')!
      .answer({ data: null, error: { message: 'x' } });
    io.pending
      .find((p) => p.table === 'lightning_pool_session')!
      .answer({ data: [{ player_id: uid(1), anchor_seat_id: uid(11) }], error: null });
    await expect(done).rejects.toThrow('anchor seat time bank read failed');
  });
});

describe('lightningSeatsSittingOut (the parked anchor sit-out clock reads the row)', () => {
  it('names only occupants whose live row, same occupancy, says is_sitting_out', async () => {
    io.pending.length = 0;
    const T = uid(500);
    const done = lightningSeatsSittingOut(T, [
      { userId: uid(1), occupancyId: uid(61) },
      { userId: uid(2), occupancyId: uid(62) },
      { userId: uid(3), occupancyId: uid(63) },
    ]);
    await tick();
    io.pending
      .find((p) => p.table === 'table_seats')!
      .answer({
        data: [
          { user_id: uid(1), occupancy_id: uid(61), is_sitting_out: true, left_at: null },
          // Memory said sat out; the row says playing.
          { user_id: uid(2), occupancy_id: uid(62), is_sitting_out: false, left_at: null },
          // A different occupancy of the chair: not the occupant memory meant.
          { user_id: uid(3), occupancy_id: uid(99), is_sitting_out: true, left_at: null },
        ],
        error: null,
      });
    expect([...(await done)]).toEqual([uid(1)]);
  });

  it('a read that fails throws, so nobody is stood up on a guess', async () => {
    io.pending.length = 0;
    const done = lightningSeatsSittingOut(uid(500), [{ userId: uid(1), occupancyId: uid(61) }]);
    await tick();
    io.pending
      .find((p) => p.table === 'table_seats')!
      .answer({ data: null, error: { message: 'x' } });
    await expect(done).rejects.toThrow('table_seats sit-out read failed');
  });
});
