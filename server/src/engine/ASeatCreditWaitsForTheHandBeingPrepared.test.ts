/**
 * A SEAT CREDIT WAITS FOR THE HAND BEING PREPARED (2026-09-28).
 *
 * Midway Union's first weekly close (book 2026-09-21 07:00 .. 09-28 07:00 UTC)
 * was refused by fn_union_pnl_close_quality: 85 accepted cash hands carried
 * original_seat_or_starting_stack_unproven. Every one had exactly one direct
 * (apply_to_seat) add-on committed 0.006-6.7s before the hand's original cash
 * manifest. addChips read `handController === null` ("between hands") while
 * dealHand() was preparing the next hand under the seat boundary, so the chips
 * landed on table_seats.stack after the roster's stacks had been snapshotted,
 * and the manifest found the seat disagreeing with the dealt stack.
 *
 * These pins fail on the pre-fix addChips (the RPC fires at once with
 * p_apply_to_seat: true while the boundary is held) and pass once a seat
 * credit takes the seat boundary before deciding seat versus queue.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { supabase } = await import('../services/supabase.js');

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

afterEach(() => {
  vi.restoreAllMocks();
});

function engineWith(stack: number) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack, is_horse: false }];
  engine.getMaxBuyIn = () => 500;
  engine.handController = null;
  engine.hub = { emitEvent: vi.fn(), sendToUser: vi.fn().mockReturnValue(1) };
  engine.broadcastCurrentState = vi.fn();
  engine.requestPendingAddOnSweep = vi.fn();
  engine.chipContinuity = { evaluate: vi.fn().mockResolvedValue(undefined) };
  engine.isContinuityActive = () => false;
  return engine;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('a between-hands add-on cannot land under a roster already snapshotted', () => {
  it('waits while a hand is being prepared, then queues it once the hand has started', async () => {
    const engine = engineWith(75.1);
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: 24326.46, error: null } as any);

    // dealHand() owns the seat boundary and has snapshotted stack 75.1.
    const releasePreparation = await engine.acquireSeatBoundary();
    const pendingResult = engine.addChips('hero', 147.9, 'op-race');
    await flush();
    // Pre-fix: atomic_table_addon already ran with p_apply_to_seat: true here.
    expect(rpc).not.toHaveBeenCalled();

    // The hand starts (controller set) and preparation releases the boundary.
    engine.handController = {};
    releasePreparation();
    const res = await pendingResult;

    expect(res).toEqual({ success: true, queued: true, applied: 147.9 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'atomic_table_addon',
      expect.objectContaining({ p_amount: 147.9, p_apply_to_seat: false })
    );
    // The dealt stack is untouched; the chips are delivered by settlement.
    expect(engine.seatedPlayers[0].stack).toBe(75.1);
    expect(engine.pendingAddOns.get('hero')).toBe(147.9);
  });

  it('lands on the seat when the prepared hand was abandoned before it started', async () => {
    const engine = engineWith(75.1);
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: 1, error: null } as any);
    const releasePreparation = await engine.acquireSeatBoundary();
    const pendingResult = engine.addChips('hero', 147.9, 'op-abandoned');
    await flush();
    expect(rpc).not.toHaveBeenCalled();
    releasePreparation(); // no controller: still between hands
    const res = await pendingResult;
    expect(res).toEqual({ success: true, applied: 147.9 });
    expect(rpc).toHaveBeenCalledWith(
      'atomic_table_addon',
      expect.objectContaining({ p_apply_to_seat: true })
    );
    expect(engine.seatedPlayers[0].stack).toBe(223);
  });

  it('hand preparation waits for an in-flight seat credit, so the dealt stack includes it', async () => {
    const engine = engineWith(75.1);
    let finishRpc!: (v: unknown) => void;
    vi.spyOn(supabase, 'rpc').mockReturnValue(
      new Promise((resolve) => {
        finishRpc = resolve;
      }) as any
    );
    const addOn = engine.addChips('hero', 147.9, 'op-inflight');
    await flush();

    let prepared = false;
    const preparation = engine.acquireSeatBoundary().then((release: () => void) => {
      prepared = true;
      return release;
    });
    await flush();
    // Pre-fix: preparation got the boundary at once and snapshotted 75.1.
    expect(prepared).toBe(false);

    finishRpc({ data: 1, error: null });
    await addOn;
    const release = await preparation;
    expect(prepared).toBe(true);
    expect(engine.seatedPlayers[0].stack).toBe(223);
    release();
  });

  it('a mid-hand request still queues without waiting for the boundary', async () => {
    const engine = engineWith(75.1);
    engine.handController = {};
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: 1, error: null } as any);
    const held = await engine.acquireSeatBoundary(); // e.g. a departure queued
    const res = await engine.addChips('hero', 10, 'op-mid');
    expect(res.queued).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      'atomic_table_addon',
      expect.objectContaining({ p_apply_to_seat: false })
    );
    held();
  });
});
