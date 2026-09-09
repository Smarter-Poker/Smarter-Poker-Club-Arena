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

  it('sends the ledger a cent amount, never a float artifact', async () => {
    // 50 - 33.33 is 16.670000000000002 in IEEE754; that number reached
    // table_pending_addons.amount verbatim, and the post-commit obligation
    // check (applied + refunded must equal amount, both ROUND(..., 2)) then
    // refused the receipt forever - a wedged table.
    const engine = engineWith(33.33, 0, true);
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: null } as any);
    const res = await engine.addChips('hero', 40, 'op-cent');
    expect(res.applied).toBe(16.67);
    expect(rpc).toHaveBeenCalledWith(
      'atomic_table_addon',
      expect.objectContaining({ p_amount: 16.67 })
    );
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
      pending_id: null,
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

describe('the rows the hand envelope resolved are announced (verified lease path)', () => {
  /* On production every cash engine is lease-verified, so a mid-hand add-on
     is resolved INSIDE fn_ca_process_hand_post_commit_obligations, which
     returns only a count. processPendingAddOns never sees it. This is the
     read-back that makes the bubble and the private frame fire for the case
     they were written for, and rebuilds the cap cache the landed rows would
     otherwise be double-counted from. */
  function envelopeEngine() {
    const engine = engineWith(1.12, 49.95, false);
    engine.isTournamentTable = () => false;
    engine.lifecycleCanMutate = () => true;
    const rpcTable = new Map<string, any>();
    const calls: Array<{ table: string; filter: string; args: unknown[] }> = [];
    const from = vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
      // The list answered depends on the FILTER used, so the two reads of
      // table_pending_addons (`.in('id', ids)` = the frozen rows, `.is(
      // 'resolved_at', null)` = what is still owed) cannot share a fixture.
      let key = `${table}:list`;
      const chain: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation((...args: unknown[]) => {
          calls.push({ table, filter: 'eq', args });
          return chain;
        }),
        is: vi.fn().mockImplementation((...args: unknown[]) => {
          calls.push({ table, filter: 'is', args });
          key = `${table}:open`;
          return chain;
        }),
        in: vi.fn().mockImplementation((...args: unknown[]) => {
          calls.push({ table, filter: 'in', args });
          key = `${table}:byId`;
          return chain;
        }),
        maybeSingle: vi.fn().mockImplementation(async () => rpcTable.get(`${table}:single`)),
        then: (resolve: any) => Promise.resolve(rpcTable.get(key)).then(resolve),
      };
      return chain;
    }) as any);
    return { engine, rpcTable, from, calls };
  }

  it('emits the bubble for a landed row, the private frame for a reduced one, and rebuilds the cap', async () => {
    const { engine, rpcTable, calls } = envelopeEngine();
    rpcTable.set('hand_atomic_commits:single', {
      data: { ids: ['cd60239c-4030-4e38-b968-f972b9af67ae'] },
      error: null,
    });
    // Still owed after the hand: nothing. The 49.95 the cache held landed.
    rpcTable.set('table_pending_addons:open', { data: [], error: null });
    rpcTable.set('table_pending_addons:byId', {
      data: [
        {
          id: 'cd60239c-4030-4e38-b968-f972b9af67ae',
          user_id: 'hero',
          kind: 'addon',
          amount: '49.95',
          applied_to_stack: '48.88',
          refunded: '1.07',
          resolved_at: '2026-09-04T23:15:18Z',
        },
      ],
      error: null,
    });
    const players = [{ user_id: 'hero', seat_number: 3, stack: 50, is_horse: false }];
    await engine.announceEnvelopeResolvedAddOns('hand-1', players, 1);

    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      engine.tableId,
      expect.objectContaining({ type: 'add_on_applied', user_id: 'hero', seat: 3, amount: 48.88 })
    );
    expect(engine.hub.sendToUser).toHaveBeenCalledWith(
      engine.tableId,
      'hero',
      expect.objectContaining({
        kind: 'add_on_adjusted',
        pending_id: 'cd60239c-4030-4e38-b968-f972b9af67ae',
        requested: 49.95,
        applied: 48.88,
        refunded: 1.07,
      })
    );
    // The frozen rows were read BY ID, the cache from what is STILL open,
    // and the stale 49.95 - now in the stack - is gone from the cache.
    expect(calls).toContainEqual({
      table: 'table_pending_addons',
      filter: 'in',
      args: ['id', ['cd60239c-4030-4e38-b968-f972b9af67ae']],
    });
    expect(calls).toContainEqual({
      table: 'table_pending_addons',
      filter: 'is',
      args: ['resolved_at', null],
    });
    expect(engine.pendingAddOns.size).toBe(0);
    expect(engine.requestPendingAddOnSweep).not.toHaveBeenCalled();
  });

  it('keeps a row that is still owed in the cache, and asks for the sweep that will land it', async () => {
    const { engine, rpcTable } = envelopeEngine();
    rpcTable.set('hand_atomic_commits:single', { data: { ids: [] }, error: null });
    rpcTable.set('table_pending_addons:open', {
      data: [{ user_id: 'hero', amount: '20' }],
      error: null,
    });
    await engine.announceEnvelopeResolvedAddOns('hand-1b', [], 0);
    expect(engine.pendingAddOns.get('hero')).toBe(20);
    expect(engine.requestPendingAddOnSweep).toHaveBeenCalled();
  });

  it('spends no read when the receipt says zero rows and the cache is empty', async () => {
    const { engine, from } = envelopeEngine();
    engine.pendingAddOns.clear();
    await engine.announceEnvelopeResolvedAddOns('hand-1c', [], 0);
    expect(from).not.toHaveBeenCalled();
  });

  it('spends no read on a tournament table', async () => {
    const { engine, from } = envelopeEngine();
    engine.isTournamentTable = () => true;
    await engine.announceEnvelopeResolvedAddOns('hand-1d', [], undefined);
    expect(from).not.toHaveBeenCalled();
  });

  it('is silent for a hand with no frozen rows and leaves an empty cache alone', async () => {
    const { engine, rpcTable, from } = envelopeEngine();
    engine.pendingAddOns.clear();
    rpcTable.set('hand_atomic_commits:single', { data: { ids: [] }, error: null });
    // No count on the receipt: read to find out.
    await engine.announceEnvelopeResolvedAddOns('hand-2', [], undefined);
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
    expect(engine.hub.sendToUser).not.toHaveBeenCalled();
    // One read (the envelope), no second: nothing to rebuild.
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('engine start seeds the cap cache from the rows the sweep could not resolve', async () => {
    const { engine, rpcTable } = envelopeEngine();
    engine.pendingAddOns.clear();
    engine.processPendingAddOns = vi.fn().mockResolvedValue(undefined);
    rpcTable.set('table_pending_addons:open', {
      // A frozen-but-unresolved row, and float noise from two rows summed.
      data: [
        { user_id: 'hero', amount: '0.1' },
        { user_id: 'hero', amount: '0.2' },
      ],
      error: null,
    });
    await engine.resolveOrphanedAddOns();
    expect(engine.pendingAddOns.get('hero')).toBe(0.3);
    expect(engine.requestPendingAddOnSweep).toHaveBeenCalled();
  });

  it('a rebuild that a concurrent mid-hand add-on overtook is discarded, not applied stale', async () => {
    const { engine, rpcTable } = envelopeEngine();
    engine.pendingAddOns.set('hero', 5);
    engine.requestPendingAddOnSweep = () => {
      engine.pendingAddOnSweepGen += 1;
    };
    rpcTable.set('table_pending_addons:open', { data: [], error: null });
    // The read is in flight when addChips writes the map and bumps the gen.
    const original = supabase.from;
    const from = vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
      const chain = (original as any).call(supabase, table);
      engine.pendingAddOnSweepGen += 1; // the overtaking write
      return chain;
    }) as any);
    await engine.rebuildPendingAddOnCache();
    from.mockRestore();
    expect(engine.pendingAddOns.get('hero')).toBe(5);
  });

  it('never throws: a failed read is reported, the hand is not restarted over a bubble', async () => {
    const { engine, rpcTable } = envelopeEngine();
    rpcTable.set('hand_atomic_commits:single', { data: null, error: new Error('read failed') });
    await expect(engine.announceEnvelopeResolvedAddOns('hand-3', [], 1)).resolves.toBeUndefined();
  });

  it('holds an adjustment that found no socket, delivers it once on the next connect, then forgets it', () => {
    const engine = engineWith(1, 0, false);
    // Nobody connected: sendToUser reports 0 sockets.
    engine.hub.sendToUser.mockReturnValue(0);
    engine.tellPlayerAddOnAdjusted('hero', 'addon', 48.88, 1.07, 'row-1');
    engine.hub.sendToUser.mockClear();
    engine.hub.sendToUser.mockReturnValue(1);
    engine.rePushAddOnAdjusted('hero');
    engine.rePushAddOnAdjusted('someone-else');
    expect(engine.hub.sendToUser).toHaveBeenCalledTimes(1);
    expect(engine.hub.sendToUser.mock.calls[0][2]).toEqual(
      expect.objectContaining({ kind: 'add_on_adjusted', pending_id: 'row-1' })
    );
    // Delivered once; a second connect (onResync fires on EVERY connect)
    // does not greet the player with it again.
    engine.hub.sendToUser.mockClear();
    engine.rePushAddOnAdjusted('hero');
    expect(engine.hub.sendToUser).not.toHaveBeenCalled();
  });

  it('does not hold an adjustment that was delivered to an open socket', () => {
    const engine = engineWith(1, 0, false); // sendToUser -> 1
    engine.tellPlayerAddOnAdjusted('hero', 'addon', 48.88, 1.07, 'row-2');
    engine.hub.sendToUser.mockClear();
    engine.rePushAddOnAdjusted('hero');
    expect(engine.hub.sendToUser).not.toHaveBeenCalled();
  });
});
