/**
 * A DIAMOND SEAT CREDIT WAITS FOR THE HAND BEING PREPARED (2026-10-08).
 *
 * Production 2026-10-07: three Diamond cash hands (04:35, 08:44 and 15:24 UTC)
 * were refused by fn_poker_diamond_settle_cash_hand with
 * diamond_hand_stale_seat, and each table stopped dealing. Every one had
 * exactly one horse top-up through fn_poker_diamond_top_up committed 2-4 s
 * after the previous hand's receipt: addChips read `handController === null`
 * while dealHand() was preparing the next hand under the seat boundary, so the
 * Diamonds landed on table_seats.stack after the roster's stacks had been
 * snapshotted, and the settler found the seat disagreeing with stack_before.
 *
 * The chip lane has waited on the seat boundary since 2026-09-28
 * (ASeatCreditWaitsForTheHandBeingPrepared.test.ts); the Diamond branch
 * returned above it. These pins fail on the pre-fix addChips (the custody RPC
 * fires at once while the boundary is held) and pass once a Diamond seat
 * credit, and the intent sweep that lands queued top-ups, take the boundary
 * before deciding.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase/client.js';

const TABLE = '00000000-0000-0000-0000-00000000d1a7';
const diamondTable = {
  id: TABLE,
  club_id: 'arena',
  union_id: null,
  arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
  game_variant: 'nlh',
  tournament_id: null,
  cluster_id: null,
  status: 'waiting',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 20,
  max_buy_in: 200,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function engineWith(stack: number) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.tableInfo = { ...diamondTable };
  engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack, is_horse: true }];
  engine.getMaxBuyIn = () => 200;
  engine.handController = null;
  engine.lifecycleCanMutate = () => true;
  engine.broadcastCurrentState = vi.fn();
  return engine;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('a between-hands Diamond top-up cannot land under a roster already snapshotted', () => {
  it('waits while a hand is being prepared, then becomes an intent once the hand has started', async () => {
    const engine = engineWith(40);
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { stack: 140 }, error: null } as any);

    // dealHand() owns the seat boundary and has snapshotted stack 40.
    const releasePreparation = await engine.acquireSeatBoundary();
    const pending = engine.addChips('hero', 100, 'op-race');
    await flush();
    // Pre-fix: fn_poker_diamond_top_up already ran here and raised the seat.
    expect(rpc, 'a Diamond top-up landed under a prepared roster').not.toHaveBeenCalled();

    // The hand starts (controller set) and preparation releases the boundary.
    engine.handController = {};
    releasePreparation();
    const res = await pending;

    expect(res).toEqual({ success: true, queued: true, applied: 100 });
    expect(rpc).not.toHaveBeenCalled();
    // The dealt stack is untouched; the intent lands after settlement.
    expect(engine.seatedPlayers[0].stack).toBe(40);
    expect([...engine.diamondTopUpIntents.values()]).toEqual([{ userId: 'hero', amount: 100 }]);
  });

  it('lands on the seat when the prepared hand was abandoned before it started', async () => {
    const engine = engineWith(40);
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { stack: 140 }, error: null } as any);
    const releasePreparation = await engine.acquireSeatBoundary();
    const pending = engine.addChips('hero', 100, 'op-abandoned');
    await flush();
    expect(rpc).not.toHaveBeenCalled();
    releasePreparation(); // no controller: still between hands
    await expect(pending).resolves.toEqual({ success: true, applied: 100 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('fn_poker_diamond_top_up');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_amount: 100, p_expected_stack: 40 });
    expect(engine.seatedPlayers[0].stack).toBe(140);
  });

  it('hand preparation waits for an in-flight Diamond top-up, so the dealt stack includes it', async () => {
    const engine = engineWith(40);
    let finishRpc!: (v: unknown) => void;
    vi.spyOn(supabase, 'rpc').mockReturnValue(
      new Promise((resolve) => {
        finishRpc = resolve;
      }) as any
    );
    const topUp = engine.addChips('hero', 100, 'op-inflight');
    await flush();

    let prepared = false;
    const preparation = engine.acquireSeatBoundary().then((release: () => void) => {
      prepared = true;
      return release;
    });
    await flush();
    // Pre-fix: preparation got the boundary at once and snapshotted 40.
    expect(prepared).toBe(false);

    finishRpc({ data: { stack: 140 }, error: null });
    await topUp;
    const release = await preparation;
    expect(prepared).toBe(true);
    expect(engine.seatedPlayers[0].stack).toBe(140);
    release();
  });

  it('the intent sweep does not land a queued top-up while a hand is being prepared', async () => {
    const engine = engineWith(40);
    engine.handController = {};
    await engine.addChips('hero', 100, 'op-queued');
    engine.handController = null;
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { stack: 140 }, error: null } as any);

    const releasePreparation = await engine.acquireSeatBoundary();
    const sweep = engine.processPendingAddOns(engine.seatedPlayers);
    await flush();
    expect(rpc, 'an intent landed under a prepared roster').not.toHaveBeenCalled();

    // The prepared hand starts: the intent waits for its settlement.
    engine.handController = {};
    releasePreparation();
    await sweep;
    expect(rpc).not.toHaveBeenCalled();
    expect(engine.diamondTopUpIntents.size, 'the intent was dropped').toBe(1);
  });
});
