/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEAVE MEANS NOW, AND THE AVATAR FINISHES ITS ACTION FIRST (Dan 2026-10-25)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim:
 *   "AVATARS SHOULD NOT LEAVE THE TABLE UNTIL AFTER THEIR ACTION IS COMPLETED."
 *   "IF A USER CLICKS LEAVE GAME, IT NEEDS TO LEAVE GAME RIGHT AWAY, NOT THE
 *    NEXT HAND OR IN A COUPLE HANDS, LEAVE NOW, EVEN IF ITS IN THE MIDDLE OF A
 *    HAND."
 *
 * What it did before:
 *   - off their turn, a leaver was NOT folded: an auto_fold was queued and the
 *     seat was sat out on the spot, so every watcher saw it grey out, lose its
 *     cards and wear SITTING OUT with no fold ever shown, while it stayed live
 *     in the hand until action came round;
 *   - an all-in leaver was REFUSED, so the seat stayed and was dealt the next
 *     hand, and the one after.
 *
 * Now: off-turn leavers fold at once (the controller's early fold), on-turn
 * leavers fold as before, and an all-in leaver's request is accepted and
 * recorded while the seat plays its hand out un-greyed and is sat out only
 * at settlement. Every spec has a human and a horse twin (CLAUDE.md 10.5).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const departure = vi.fn();
const cashout = vi.fn();

vi.mock('../services/supabase/seats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/supabase/seats.js')>();
  return { ...actual, requestSeatDeparture: (...args: unknown[]) => departure(...args) };
});
vi.mock('../services/supabase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/supabase.js')>();
  return {
    ...actual,
    atomicCashout: (...args: unknown[]) => cashout(...args),
    markSeatAsLeft: vi.fn(async () => {
      throw new Error('markSeatAsLeft must never be a leave fallback');
    }),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { deadlineScheduler } = await import('./DeadlineScheduler.js');

const TABLE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const HUMAN = 'bbbbbbbb-0000-4000-8000-000000000001';
const HORSE = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000003';
const OCC: Record<string, string> = {
  [HUMAN]: 'eeeeeeee-0000-4000-8000-000000000001',
  [HORSE]: 'eeeeeeee-0000-4000-8000-000000000002',
  [OTHER]: 'eeeeeeee-0000-4000-8000-000000000003',
};

type LivePlayer = { user_id: string; seat: number; is_folded: boolean; is_all_in: boolean };

function makeEngine(livePlayers: LivePlayer[], currentPlayerSeat: number) {
  const e = new ServerTableEngine(TABLE) as any;
  e.tableInfo = {
    id: TABLE,
    club_id: 'club',
    small_blind: 1,
    big_blind: 2,
    game_variant: 'nlh',
    max_players: 9,
    game_type: 'cash',
    min_buy_in: 80,
    max_buy_in: 400,
  };
  e.running = true;
  e.seatedPlayers = [HUMAN, HORSE, OTHER].map((user_id, i) => ({
    user_id,
    username: `p${i + 1}`,
    stack: 100,
    seat_number: i + 1,
    is_horse: user_id === HORSE,
    occupancy_id: OCC[user_id],
  }));
  const state = { players: livePlayers, currentPlayerSeat, stage: 'flop' };
  e.handController = {
    getState: () => state,
    performAction: vi.fn((seat: number, action: string) => {
      if (seat !== state.currentPlayerSeat || action !== 'fold') return false;
      livePlayers.find((p) => p.seat === seat)!.is_folded = true;
      return true;
    }),
    performImmediateFold: vi.fn((seat: number) => {
      if (seat === state.currentPlayerSeat) return false;
      livePlayers.find((p) => p.seat === seat)!.is_folded = true;
      return true;
    }),
  };
  e.hub = { emitEvent: vi.fn(), publish: vi.fn() };
  e.broadcastCurrentState = vi.fn(async () => undefined);
  return e;
}

const sittingOut = (e: any, userId: string): boolean =>
  e.disconnectEngine.isSittingOut(TABLE, userId);
const queuedAutoFold = (e: any, userId: string): boolean =>
  e.preActionEngine.getPreAction(TABLE, userId)?.action === 'auto_fold';

beforeEach(() => {
  departure.mockReset().mockResolvedValue(undefined);
  cashout.mockReset();
});
afterEach(() => {
  deadlineScheduler.cancelAll(TABLE);
});

for (const [who, id, seat] of [
  ['human', HUMAN, 1],
  ['horse', HORSE, 2],
] as const) {
  describe(`${who}: leave in the middle of a hand`, () => {
    it('off their turn: folds NOW (early fold), no queued auto_fold, out of the next deal', async () => {
      const live: LivePlayer[] = [
        { user_id: HUMAN, seat: 1, is_folded: false, is_all_in: false },
        { user_id: HORSE, seat: 2, is_folded: false, is_all_in: false },
        { user_id: OTHER, seat: 3, is_folded: false, is_all_in: false },
      ];
      const e = makeEngine(live, 3);
      const res = await e.leaveTable(id);

      expect(res).toMatchObject({ success: true, immediate: false });
      expect(departure).toHaveBeenCalledWith(id, TABLE, seat, OCC[id], 'voluntary');
      expect(e.handController.performImmediateFold).toHaveBeenCalledWith(seat, 'forced');
      expect(e.handController.performAction).not.toHaveBeenCalled();
      expect(live.find((p) => p.user_id === id)!.is_folded).toBe(true);
      expect(queuedAutoFold(e, id)).toBe(false);
      // The fold is done, so the seat may leave the deal straight away.
      expect(sittingOut(e, id)).toBe(true);
      expect(e.pendingSitOut.has(id)).toBe(false);
      // The player whose turn it is was not touched.
      expect(live.find((p) => p.user_id === OTHER)!.is_folded).toBe(false);
    });

    it('on their turn: folds through the ordinary turn door', async () => {
      const live: LivePlayer[] = [
        { user_id: HUMAN, seat: 1, is_folded: false, is_all_in: false },
        { user_id: HORSE, seat: 2, is_folded: false, is_all_in: false },
        { user_id: OTHER, seat: 3, is_folded: false, is_all_in: false },
      ];
      const e = makeEngine(live, seat);
      const res = await e.leaveTable(id);

      expect(res).toMatchObject({ success: true, immediate: false });
      expect(e.handController.performAction).toHaveBeenCalledWith(
        seat,
        'fold',
        undefined,
        'forced'
      );
      expect(e.handController.performImmediateFold).not.toHaveBeenCalled();
      expect(live.find((p) => p.user_id === id)!.is_folded).toBe(true);
      expect(sittingOut(e, id)).toBe(true);
    });

    it('all-in: the leave is ACCEPTED, the seat plays its hand out un-greyed, sat out at settlement', async () => {
      const live: LivePlayer[] = [
        { user_id: HUMAN, seat: 1, is_folded: false, is_all_in: id === HUMAN },
        { user_id: HORSE, seat: 2, is_folded: false, is_all_in: id === HORSE },
        { user_id: OTHER, seat: 3, is_folded: false, is_all_in: false },
      ];
      const e = makeEngine(live, 3);
      const res = await e.leaveTable(id);

      // Accepted and durable: never refused, never left seated for next hand.
      expect(res).toMatchObject({ success: true, immediate: false });
      expect(departure).toHaveBeenCalledWith(id, TABLE, seat, OCC[id], 'voluntary');
      // An all-in seat cannot fold, and is not asked to.
      expect(e.handController.performAction).not.toHaveBeenCalled();
      expect(e.handController.performImmediateFold).not.toHaveBeenCalled();
      expect(live.find((p) => p.user_id === id)!.is_folded).toBe(false);
      // Its action is not complete, so it is NOT shown sitting out yet...
      expect(sittingOut(e, id)).toBe(false);
      // ...but it is already out of the next deal.
      expect(e.pendingSitOut.has(id)).toBe(true);
    });
  });
}
