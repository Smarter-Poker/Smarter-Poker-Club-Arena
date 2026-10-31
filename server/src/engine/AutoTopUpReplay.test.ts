import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
afterEach(() => {
  vi.restoreAllMocks();
  setMaintenanceFrozen(false);
});

describe('top-up HTTP replay reflects the funded chips once', () => {
  it('does not credit the in-memory seat twice when the durable debit replays', async () => {
    const e = new ServerTableEngine('dddddddd-dddd-dddd-dddd-dddddddddddd') as any;
    e.lifecycleCanMutate = () => true;
    e.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 10, is_horse: false }];
    e.readCashAddonReceipt = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ amount: 10, appliedToSeat: true, stack: 20, pending: 0 });
    e.getMaxBuyIn = () => 50;
    e.handController = null;
    e.broadcastCurrentState = vi.fn();
    e.chipContinuity = { evaluate: vi.fn().mockResolvedValue(undefined) };
    e.isContinuityActive = () => false;
    // The real RPC returns the same balance on replay and changes no rows.
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: 90, error: null } as any);
    await e.addChips('hero', 10, '11111111-1111-4111-8111-111111111111');
    await e.addChips('hero', 10, '11111111-1111-4111-8111-111111111111');
    expect(e.seatedPlayers[0].stack).toBe(20);
    expect(rpc).toHaveBeenCalled();
  });
});

describe('the original command owns delayed and concurrent replies', () => {
  function engine() {
    const e = new ServerTableEngine('dddddddd-dddd-dddd-dddd-dddddddddddd') as any;
    e.lifecycleCanMutate = () => true;
    e.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 10, is_horse: false }];
    e.getMaxBuyIn = () => 50;
    e.handController = null;
    e.broadcastCurrentState = vi.fn();
    e.requestPendingAddOnSweep = vi.fn();
    e.chipContinuity = { evaluate: vi.fn().mockResolvedValue(undefined) };
    e.isContinuityActive = () => false;
    e.readCashAddonReceipt = vi.fn(async () => null);
    return e;
  }
  it('keeps weekly admission until a queued top-up has settled', async () => {
    const e = engine();
    e.handController = {};
    let finish!: (r: any) => void;
    vi.spyOn(supabase, 'rpc').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }) as any
    );
    const operation = e.addChips('hero', 10, 'weekly-pending-top-up');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    e.weeklyHandPause.hold('weekly-accounting-owner');
    expect(e.weeklyHandPause.stable('weekly-accounting-owner')).toBe(false);
    finish({ data: 90, error: null });
    await operation;
    expect(e.weeklyHandPause.stable('weekly-accounting-owner')).toBe(true);
  });
  it('joins overlapping copies of one HTTP request', async () => {
    const e = engine();
    let finish!: (r: any) => void;
    const rpc = vi.spyOn(supabase, 'rpc').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }) as any
    );
    const first = e.addChips('hero', 10, 'same-operation');
    const duplicate = e.addChips('hero', 10, 'same-operation');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish({ data: 90, error: null });
    await Promise.all([first, duplicate]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(e.seatedPlayers[0].stack).toBe(20);
  });
  it('recovers a committed operation after both acknowledgements were lost', async () => {
    const e = engine();
    e.readCashAddonReceipt
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ amount: 10, appliedToSeat: true, stack: 20, pending: 0 });
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: null,
      error: { message: 'network failed' },
    } as any);
    await expect(e.addChips('hero', 10, 'lost-operation')).resolves.toMatchObject({
      success: true,
      applied: 10,
      replayed: false,
    });
    expect(e.seatedPlayers[0].stack).toBe(20);
  });
  it('recovers queued totals without counting a replay twice', async () => {
    const e = engine();
    e.handController = {};
    e.pendingAddOns.set('hero', 10);
    e.readCashAddonReceipt.mockResolvedValue({
      amount: 10,
      appliedToSeat: false,
      stack: 10,
      pending: 10,
      queued: true,
    });
    const rpc = vi.spyOn(supabase, 'rpc');
    await expect(e.addChips('hero', 10, 'queued-operation')).resolves.toMatchObject({
      success: true,
      queued: true,
      replayed: true,
    });
    expect(e.pendingAddOns.get('hero')).toBe(10);
    expect(e.seatedPlayers[0].stack).toBe(10);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('does not rewrite an active hand from a historical direct receipt', async () => {
    const e = engine();
    e.handController = {};
    e.seatedPlayers[0].stack = 7;
    e.readCashAddonReceipt.mockResolvedValue({
      amount: 10,
      appliedToSeat: true,
      stack: 20,
      pending: 0,
      queued: false,
    });
    await e.addChips('hero', 10, 'old-operation');
    expect(e.seatedPlayers[0].stack).toBe(7);
  });
  it('refuses new funding when its original receipt cannot be read', async () => {
    const e = engine();
    e.readCashAddonReceipt.mockRejectedValue(new Error('unavailable'));
    const rpc = vi.spyOn(supabase, 'rpc');
    await expect(e.addChips('hero', 10, 'unknown-operation')).resolves.toMatchObject({
      success: false,
      code: 'TRANSPORT',
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(e.seatedPlayers[0].stack).toBe(10);
  });
  it('discards a late receipt after the table generation loses authority', async () => {
    const e = engine();
    e.readCashAddonReceipt.mockImplementation(async () => {
      e.lifecycleCanMutate = () => false;
      return { amount: 10, appliedToSeat: true, stack: 20, pending: 0, queued: false };
    });
    const rpc = vi.spyOn(supabase, 'rpc');
    await expect(e.addChips('hero', 10, 'late-operation')).resolves.toMatchObject({
      success: false,
      code: 'TRANSPORT',
    });
    expect(e.seatedPlayers[0].stack).toBe(10);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('Diamond top-up retries preserve the original reservation', () => {
  function diamond() {
    const e = new ServerTableEngine('dddddddd-dddd-dddd-dddd-dddddddddddd') as any;
    e.tableInfo = { arena: { asset: 'diamonds' }, tournament_id: null };
    e.lifecycleCanMutate = () => true;
    e.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 40, is_horse: false }];
    e.getMaxBuyIn = () => 50;
    e.broadcastCurrentState = vi.fn();
    e.readDiamondAddonReceipt = vi.fn(async () => null);
    return e;
  }
  it('replays a full-sized queued intent before counting its own headroom', async () => {
    const e = diamond();
    e.handController = {};
    const first = await e.addChips('hero', 10, 'diamond-operation');
    const repeated = await e.addChips('hero', 10, 'diamond-operation');
    expect(first).toMatchObject({ success: true, queued: true, applied: 10 });
    expect(repeated).toMatchObject({ success: true, queued: true, applied: 10, replayed: true });
    expect(e.diamondTopUpIntents.size).toBe(1);
  });
  it('reads a completed reservation before refusing an already-full seat', async () => {
    const e = diamond();
    e.handController = null;
    e.readDiamondAddonReceipt.mockResolvedValue({
      amount: 10,
      appliedToSeat: true,
      stack: 50,
      pending: 0,
      queued: false,
    });
    const rpc = vi.spyOn(supabase, 'rpc');
    await expect(e.addChips('hero', 10, 'diamond-operation')).resolves.toMatchObject({
      success: true,
      replayed: true,
      applied: 10,
    });
    expect(e.seatedPlayers[0].stack).toBe(50);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('queued Diamond completion reaches its recorded-funding consumer', () => {
  function queued() {
    const e = new ServerTableEngine('dddddddd-dddd-dddd-dddd-dddddddddddd') as any;
    e.lifecycleCanMutate = () => true;
    e.handController = null;
    e.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 40, is_horse: false }];
    e.getMaxBuyIn = () => 50;
    e.broadcastCurrentState = vi.fn();
    e.hub = { sendToUser: vi.fn() };
    e.killForRestart = vi.fn();
    e.readDiamondAddonReceipt = vi.fn(async () => null);
    const id = '11111111-1111-4111-8111-111111111111';
    e.diamondTopUpIntents.set(id, { userId: 'hero', amount: 10 });
    return { e, id };
  }
  it('retains an unfunded intent without a write during maintenance', async () => {
    const { e } = queued();
    setMaintenanceFrozen(true);
    const rpc = vi.spyOn(supabase, 'rpc');
    await e.applyDiamondTopUpIntents(e.seatedPlayers);
    expect(rpc).not.toHaveBeenCalled();
    expect(e.diamondTopUpIntents.size).toBe(1);
    expect(e.hub.sendToUser).not.toHaveBeenCalled();
  });
  it('emits one private completion only after the original command commits', async () => {
    const { e, id } = queued();
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: { stack: 50 }, error: null } as any);
    await e.applyDiamondTopUpIntents(e.seatedPlayers);
    expect(e.seatedPlayers[0].stack).toBe(50);
    expect(e.hub.sendToUser).toHaveBeenCalledWith(
      e.tableId,
      'hero',
      expect.objectContaining({
        kind: 'diamond_top_up_completed',
        request_id: id,
        amount: 10,
        status: 'applied',
      })
    );
    await e.applyDiamondTopUpIntents(e.seatedPlayers);
    expect(e.hub.sendToUser).toHaveBeenCalledTimes(1);
  });
  it('recovers the original committed intent after thrown acknowledgements are lost', async () => {
    const { e, id } = queued();
    e.readDiamondAddonReceipt
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ amount: 10, appliedToSeat: true, stack: 50, pending: 0, queued: false });
    const rpc = vi.spyOn(supabase, 'rpc').mockRejectedValue(new Error('network failed'));
    await e.applyDiamondTopUpIntents(e.seatedPlayers);
    expect(rpc).toHaveBeenCalledTimes(2);
    for (const args of rpc.mock.calls)
      expect(args[1]).toMatchObject({ p_request_id: id, p_expected_stack: 40, p_amount: 10 });
    expect(e.seatedPlayers[0].stack).toBe(50);
    expect(e.hub.sendToUser).toHaveBeenCalledTimes(1);
    expect(e.killForRestart).not.toHaveBeenCalled();
  });
  it('does not manufacture a landing from a malformed success response', async () => {
    const { e } = queued();
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: null } as any);
    await e.applyDiamondTopUpIntents(e.seatedPlayers);
    expect(e.seatedPlayers[0].stack).toBe(40);
    expect(e.hub.sendToUser).not.toHaveBeenCalled();
    expect(e.killForRestart).toHaveBeenCalledWith('diamond_intent_outcome_unknown');
  });
});
