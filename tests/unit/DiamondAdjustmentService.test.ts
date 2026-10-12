/**
 * A DIAMOND CORRECTION SETTLES ONCE (DIAMOND PHASE 10, 2026-09-29)
 *
 * The client half of the four platform-staff doors: each method calls its one
 * door with only the ids, amount, reason and note (never a person - the
 * database names the caller), passes a refusal through under the database's
 * own name, and reads a settlement receipt, including a replay.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));

import {
  approveDiamondAdjustment,
  proposeDiamondAdjustment,
  rejectDiamondAdjustment,
  settleDiamondAdjustment,
} from '../../src/services/DiamondAdjustmentService';

const ADJ = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';
const HOUSE = '00000000-0000-0000-0000-00000000d1a0';
const answer = (data: unknown) => rpc.mockResolvedValueOnce({ data, error: null });

const receipt = {
  ok: true,
  replayed: false,
  adjustment_id: ADJ,
  status: 'settled',
  asset: 'diamonds',
  target_kind: 'diamond_wallet',
  target_id: PLAYER,
  amount: 25,
  direction: 'credit',
  source: 'diamond_house',
  supply_moved: 0,
  legs: [
    { ok: true, action: 'burn', source: 'house', amount: 25 },
    { ok: true, action: 'mint', destination: 'player', amount: 25 },
  ],
  proposed_by: 'a',
  approved_by: 'b',
  settled_by: 'b',
  settled_at: '2026-09-29T21:10:00Z',
};

beforeEach(() => rpc.mockReset());

describe('DiamondAdjustmentService', () => {
  it('proposes through its one door with no person in the call', async () => {
    answer({
      ok: true,
      adjustment_id: ADJ,
      status: 'proposed',
      amount: -10,
      target_kind: 'diamond_wallet',
    });
    const got = await proposeDiamondAdjustment({
      targetKind: 'diamond_wallet',
      targetId: PLAYER,
      amount: -10,
      reason: 'a stranded seat returned by hand',
    });
    expect(rpc).toHaveBeenCalledWith('fn_ca_diamond_adjustment_propose', {
      p_target_kind: 'diamond_wallet',
      p_target_id: PLAYER,
      p_amount: -10,
      p_reason: 'a stranded seat returned by hand',
    });
    expect(got).toEqual({
      ok: true,
      adjustmentId: ADJ,
      status: 'proposed',
      amount: -10,
      targetKind: 'diamond_wallet',
    });
  });

  it('passes a refusal through under the database name, with the rest as detail', async () => {
    answer({ ok: false, refused_reason: 'platform_staff_only' });
    await expect(
      proposeDiamondAdjustment({
        targetKind: 'diamond_house',
        targetId: null,
        amount: 40,
        reason: 'x'.repeat(20),
      })
    ).resolves.toEqual({ ok: false, refusedReason: 'platform_staff_only', detail: {} });

    answer({ ok: false, refused_reason: 'four_eyes_violated', adjustment_id: ADJ, actor: 'a' });
    await expect(approveDiamondAdjustment(ADJ)).resolves.toEqual({
      ok: false,
      refusedReason: 'four_eyes_violated',
      detail: { adjustment_id: ADJ, actor: 'a' },
    });
  });

  it('approves and rejects by id and note only', async () => {
    answer({ ok: true, adjustment_id: ADJ, status: 'approved', approver: 'b' });
    await expect(approveDiamondAdjustment(ADJ, 'checked the hand')).resolves.toEqual({
      ok: true,
      adjustmentId: ADJ,
      status: 'approved',
    });
    expect(rpc).toHaveBeenLastCalledWith('fn_ca_diamond_adjustment_approve', {
      p_adjustment_id: ADJ,
      p_note: 'checked the hand',
    });

    answer({ ok: true, adjustment_id: ADJ, status: 'rejected', rejected_by: 'b' });
    await expect(rejectDiamondAdjustment(ADJ)).resolves.toEqual({
      ok: true,
      adjustmentId: ADJ,
      status: 'rejected',
    });
    expect(rpc).toHaveBeenLastCalledWith('fn_ca_diamond_adjustment_reject', {
      p_adjustment_id: ADJ,
      p_note: null,
    });
  });

  it('reads a settlement receipt, and a replay of it', async () => {
    answer(receipt);
    const first = await settleDiamondAdjustment(ADJ);
    expect(rpc).toHaveBeenCalledWith('fn_ca_diamond_adjustment_settle', { p_adjustment_id: ADJ });
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      adjustmentId: ADJ,
      targetKind: 'diamond_wallet',
      targetId: PLAYER,
      amount: 25,
      direction: 'credit',
      source: 'diamond_house',
      supplyMoved: 0,
      settledBy: 'b',
    });
    answer({ ...receipt, replayed: true });
    const again = await settleDiamondAdjustment(ADJ);
    expect(again).toEqual({ ...first, replayed: true });

    answer({
      ...receipt,
      target_kind: 'diamond_house',
      target_id: HOUSE,
      amount: -5,
      source: 'new_issuance',
      supply_moved: -5,
    });
    await expect(settleDiamondAdjustment(ADJ)).resolves.toMatchObject({
      direction: 'debit',
      targetId: HOUSE,
      supplyMoved: -5,
    });
  });

  it('says so, by name, when nothing pays yet', async () => {
    answer({
      ok: false,
      refused_reason: 'diamond_correction_source_not_authorized',
      adjustment_id: ADJ,
    });
    await expect(settleDiamondAdjustment(ADJ)).resolves.toEqual({
      ok: false,
      refusedReason: 'diamond_correction_source_not_authorized',
      detail: { adjustment_id: ADJ },
    });
  });

  it('throws on a transport error or an answer that is not a door answer', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    await expect(settleDiamondAdjustment(ADJ)).rejects.toThrow('permission denied');
    answer([receipt]);
    await expect(settleDiamondAdjustment(ADJ)).rejects.toThrow('Invalid Adjustment Response');
    answer({ ...receipt, legs: [] });
    await expect(settleDiamondAdjustment(ADJ)).rejects.toThrow('Invalid Adjustment Receipt');
    answer({ ...receipt, amount: 2.5 });
    await expect(settleDiamondAdjustment(ADJ)).rejects.toThrow('Invalid Adjustment Amount');
  });
});
