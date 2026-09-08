/**
 * THE ADD-ON ADJUSTS ITSELF, AND SAYS SO (Dan 2026-09-04).
 *
 * Dan: "IF YOU ADD ON DURING A HAND ... AND YOU WIN THE POT, THE ADD ON NEEDS
 * TO BE AUTO ADJUSTED. I ADDED ON FOR $49.95 BUT THEN WON THE VERY SMALL POT,
 * MY ADD ON NEEDS TO ADJUST TO ONLY ALLOW FOR $49.95 - REMAINING CHIPS. THIS
 * NEEDS TO BE A REAL TIME ADJUSTMENT."
 *
 * Two halves. The landing cap already existed (resolve_pending_addon caps at
 * max buy-in less the post-pot stack and refunds the rest - his 49.95 landed
 * as 48.88 with 1.07 returned). What did not:
 *
 *   1. addChips counted queued chips against the cap ONLY while
 *      `handController` was set. Settlement nulls the controller before step
 *      8e resolves the ledger, so a second request in that window (the auto
 *      top-up fires there) was sized as if the queued 49.95 did not exist.
 *   2. Nothing told the player. The refund reached a console.log.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { supabase } = await import('../services/supabase.js');

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

afterEach(() => {
  vi.restoreAllMocks();
});

function engineWith(stack: number, pending: number, midHand: boolean) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack, is_horse: false }];
  engine.getMaxBuyIn = () => 50;
  engine.handController = midHand ? {} : null;
  if (pending > 0) engine.pendingAddOns.set('hero', pending);
  engine.hub = { emitEvent: vi.fn(), sendToUser: vi.fn().mockReturnValue(1) };
  engine.broadcastCurrentState = vi.fn();
  engine.requestPendingAddOnSweep = vi.fn();
  engine.chipContinuity = { evaluate: vi.fn().mockResolvedValue(undefined) };
  engine.isContinuityActive = () => false;
  return engine;
}

describe('addChips sizes a request against the chips already queued', () => {
  it('between hands, with a queued add-on still unresolved, the cap counts it', async () => {
    // 0.05 behind, 49.95 already debited and queued, hand just ended and the
    // controller is null: the room left is 50 - (0.05 + 49.95) = 0. The old
    // branch saw 49.95 of room and applied straight to the seat.
    const engine = engineWith(0.05, 49.95, false);
    const rpc = vi.spyOn(supabase, 'rpc');
    const res = await engine.addChips('hero', 0.85, 'op-1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/maximum buy-in/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('mid-hand, the same arithmetic (unchanged)', async () => {
    const engine = engineWith(0.05, 49.95, true);
    const rpc = vi.spyOn(supabase, 'rpc');
    const res = await engine.addChips('hero', 0.85, 'op-2');
    expect(res.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('with room, the request is capped to the room that is really left', async () => {
    // 10 behind, 20 queued: room is 20, not 40.
    const engine = engineWith(10, 20, false);
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: null } as any);
    const res = await engine.addChips('hero', 40, 'op-3');
    expect(res.success).toBe(true);
    expect(res.applied).toBe(20);
    expect(rpc).toHaveBeenCalledWith(
      'atomic_table_addon',
      expect.objectContaining({ p_amount: 20, p_apply_to_seat: true })
    );
  });
});

describe('the player is told when the landing was reduced', () => {
  it('sends a private add_on_adjusted frame with the numbers that moved', () => {
    const engine = engineWith(1.12, 0, false);
    engine.handCount = 7;
    engine.tellPlayerAddOnAdjusted('hero', 'addon', 48.88, 1.07);
    expect(engine.hub.sendToUser).toHaveBeenCalledTimes(1);
    const [tableId, userId, payload] = engine.hub.sendToUser.mock.calls[0];
    expect(tableId).toBe(TABLE);
    expect(userId).toBe('hero');
    expect(payload).toEqual({
      kind: 'add_on_adjusted',
      addon_kind: 'addon',
      requested: 49.95,
      applied: 48.88,
      refunded: 1.07,
      max_buy_in: 50,
      hand_number: 7,
    });
  });

  it('says so even when nothing landed (already at the maximum)', () => {
    const engine = engineWith(50, 0, false);
    engine.tellPlayerAddOnAdjusted('hero', 'addon', 0, 49.95);
    const [, , payload] = engine.hub.sendToUser.mock.calls[0];
    expect(payload.applied).toBe(0);
    expect(payload.refunded).toBe(49.95);
    expect(payload.requested).toBe(49.95);
  });

  it('is silent when the whole add-on landed - nothing was adjusted', () => {
    const engine = engineWith(1, 0, false);
    engine.tellPlayerAddOnAdjusted('hero', 'addon', 49, 0);
    expect(engine.hub.sendToUser).not.toHaveBeenCalled();
  });
});
