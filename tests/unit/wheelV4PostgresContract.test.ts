/**
 * WHEEL v4, CHECKED AGAINST WHAT POSTGRES ACTUALLY WROTE.
 *
 * Every receipt here came out of tests/sql/diamond-wheel-v4-draw-and-cards.sql,
 * which spins the real fn_wheel_spin_v2 four hundred times in the isolated
 * accounting fixture and prints its own WHEEL_SAMPLE notices. The whole fixture
 * is rolled back and every seed is synthetic, so nothing here is a hand-written
 * idea of what the server sends (owner rulings 2026-09-21, R2/R12/R13/R15/R18).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/diamond-spins/wheel-v4-postgres-receipts.json';
import v3fixture from '../fixtures/diamond-spins/wheel-v3-postgres-receipts.json';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import service, {
  type WheelCardPickConfirmed,
  type WheelSpinResult,
} from '../../src/services/DiamondWheelService';
import {
  verifyWheelCardPick,
  verifyWheelReceiptFairness,
  wheelV4MainWeights,
  wheelV4UpgradeWeights,
} from '../../src/utils/wheelFairness';
import { assertWheelAward } from '../../src/utils/wheelAward';
import { assertWheelReceipt } from '../../src/utils/wheelPendingSpin';
import { WHEEL_V4_FOLLOW, WHEEL_V4_WEIGHTS } from '../../src/utils/wheelV4Model';

type Entry = { kind: string; stake: number; value: unknown };
const records = fixture.records as unknown as Entry[];
const by = (kind: string) => records.find((r) => r.kind === kind)!.value;
const spins = records
  .filter((r) => /^wheel-v4-(\d+|first|cross-tier|upgrade-|vip-\d+|cards)/.test(r.kind))
  .map((r) => ({ kind: r.kind, value: r.value as WheelSpinResult }));

beforeEach(() => rpc.mockReset());

describe('real PostgreSQL wheel v4 receipts', () => {
  it('covers all twelve ords, both Upgrade tiers, the VIP table and the card game', () => {
    expect(new Set(spins.map((r) => r.value.outcome.ord)).size).toBe(12);
    expect(spins.every((r) => r.value.contract_version === 4)).toBe(true);
    expect(spins.every((r) => r.value.model === 'wheel-v4')).toBe(true);
    expect(spins.every((r) => r.value.segment_version === 4)).toBe(true);
    expect(spins.every((r) => r.value.fairness.domain === 'wheel-v4')).toBe(true);
    expect(spins.some((r) => r.value.secondary?.outcome.kind === 'bonus')).toBe(true);
    expect(spins.some((r) => r.value.secondary?.outcome.kind === 'chips')).toBe(true);
    expect(spins.filter((r) => r.value.vip).length).toBe(3);
    expect(spins.some((r) => r.value.outcome.cards)).toBe(true);
  });

  it.each(spins.map((r, index) => ({ ...r, index })))(
    'replays receipt $index ($kind) through the service, the validators and the verifier',
    async ({ value }) => {
      rpc.mockResolvedValueOnce({ data: value, error: null });
      const result = await service.spinV2({
        clubId: value.club_id,
        commitId: value.fairness.commit_id,
        clientSeed: value.fairness.client_seed,
        entryDiamonds: value.entry_value_diamonds!,
        mode: 'paid',
        ticketId: null,
      });
      expect(result.ok).toBe(true);
      expect(result.contract_version).toBe(4);
      assertWheelAward(result);
      assertWheelReceipt(result, {
        userId: 'probe',
        clubId: value.club_id,
        mode: 'paid',
        commitId: value.fairness.commit_id,
        commitHash: value.fairness.server_seed_hash,
        clientSeed: value.fairness.client_seed,
        ticketId: null,
        contractVersion: 4,
        entryDiamonds: value.entry_value_diamonds,
      });
      const verdict = await verifyWheelReceiptFairness(result);
      expect(verdict.fair).toBe(true);
      expect(verdict.lawMatches).toBe(true);
    }
  );

  it('the published table keeps the base weights while the draw uses its own row', () => {
    for (const { value } of spins) {
      expect(value.segments!.map((s) => s.weight)).toEqual([...WHEEL_V4_WEIGHTS]);
      expect(value.segments!.reduce((sum, s) => sum + s.weight, 0)).toBe(100000);
      expect(value.fairness.weights!.reduce((sum, w) => sum + w, 0)).toBe(
        value.fairness.weight_total
      );
      const previous = value.fairness.previous;
      expect(value.fairness.weights).toEqual(wheelV4MainWeights(previous));
      if (previous) expect(value.fairness.weights![previous.ord - 1]).toBe(0);
      expect(value.fairness.weights![value.outcome.ord - 1]).toBeGreaterThan(0);
    }
  });

  it('after an Upgrade that landed a Super game the ordinary game is gone too', () => {
    const crossed = by('wheel-v4-cross-tier') as WheelSpinResult;
    const previous = crossed.fairness.previous!;
    expect(previous.tier).toBe('super');
    expect(previous.ord).toBe(12);
    const row = crossed.fairness.weights!;
    const games = [1, 4, 7, 10];
    const excluded = { plinko: 1, crash: 4, crossing: 7, mines: 10 }[previous.game!];
    expect(row[excluded - 1]).toBe(0);
    // The weight moved only between games worth the same 0.8 of the entry.
    expect(row.reduce((sum, w) => sum + w, 0)).toBe(WHEEL_V4_WEIGHTS[11]);
    expect(games.filter((ord) => ord !== excluded).map((ord) => row[ord - 1])).toEqual([
      144, 144, 144,
    ]);
    expect(WHEEL_V4_FOLLOW[11][excluded - 1]).toBe(108);
  });

  it('the Upgrade wheel drops the Super twin of the previous ordinary game', () => {
    const upgrade = by('wheel-v4-upgrade-game') as WheelSpinResult;
    expect(upgrade.secondary!.fairness.domain).toBe('wheel-v4-upgrade');
    expect(upgrade.secondary!.fairness.weights).toEqual(
      wheelV4UpgradeWeights(upgrade.fairness.previous)
    );
    expect(upgrade.secondary!.fairness.weights!.reduce((sum, w) => sum + w, 0)).toBe(100000);
    expect(upgrade.secondary!.segments.reduce((sum, s) => sum + s.weight, 0)).toBe(100000);
  });

  it('a VIP is shown chips where the items were, and paid them', () => {
    const vip = spins.filter((r) => r.value.vip);
    expect(vip.map((r) => r.value.outcome.ord).sort((a, b) => a - b)).toEqual([3, 6, 9]);
    for (const { value } of vip) {
      expect(value.outcome.kind).toBe('chips');
      expect(value.outcome.grants).toBeUndefined();
      expect(value.segments!.filter((s) => s.kind === 'chips')).toHaveLength(6);
      expect(
        value.segments!.some((s) =>
          ['throwables', 'time_bank', 'rabbit_hunt'].includes(s.kind as string)
        )
      ).toBe(false);
      const expected = { 3: 0.2, 6: 0.25, 9: 0.3 }[value.outcome.ord as 3 | 6 | 9];
      expect(value.outcome.multiplier).toBe(expected);
      expect(value.outcome.amount).toBeCloseTo((value.entry_value_diamonds! * expected) / 100, 10);
      expect(value.outcome.value_chips).toBe(value.outcome.amount);
    }
    // The VIP table is worth exactly what the standard one is.
    const table = (
      by('wheel-v4-vip-state') as {
        segments: Array<{ ord: number; weight: number; multiplier?: number }>;
      }
    ).segments;
    const swapped = table.filter((s) => [3, 6, 9].includes(s.ord));
    expect(swapped.reduce((sum, s) => sum + s.weight * s.multiplier!, 0)).toBeCloseTo(5000, 6);
  });

  it('Diamonds seals three cards, pays one on the pick and reveals all three', async () => {
    const spin = by('wheel-v4-cards') as WheelSpinResult;
    const pick = by('wheel-v4-card-pick') as WheelCardPickConfirmed;
    const replay = by('wheel-v4-card-pick-replay') as WheelCardPickConfirmed;
    expect(spin.outcome.kind).toBe('diamonds');
    expect(spin.outcome.cards).toEqual({
      award_id: pick.award_id,
      risk_diamonds: spin.entry_value_diamonds,
      status: 'pending',
    });
    /* WHAT `amount` MEANS ON A PENDING DIAMONDS OUTCOME. Every other outcome
       carries what it PAID there; this one has paid nothing yet and carries
       what is RISKED, which is the spin's own entry. The two rules in
       wheelAward - a non-bonus outcome's amount is above zero, and a v4
       Diamonds amount equals cards.risk_diamonds - only agree because the
       server writes exactly that, so the server's own bytes pin it here: the
       amount is the risk, it is the entry, it is positive, and value_chips is
       that risk at the bridge rate rather than any of the three prizes. */
    expect(spin.outcome.amount).toBe(spin.outcome.cards!.risk_diamonds);
    expect(spin.outcome.amount).toBe(spin.entry_value_diamonds);
    expect(spin.outcome.amount).toBeGreaterThan(0);
    expect(spin.outcome.value_chips).toBeCloseTo(
      spin.entry_value_diamonds! / spin.diamonds_per_chip!,
      9
    );
    // Nothing is paid at the spin: the three values are worth 11/6 of the risk
    // and none of them is on the receipt.
    expect(spin.outcome.value_chips).toBeLessThan(
      (3 * spin.entry_value_diamonds!) / spin.diamonds_per_chip!
    );
    expect(() => assertWheelAward(spin)).not.toThrow();
    // The validator holds the server to it, both ways.
    for (const broken of [
      { ...spin, outcome: { ...spin.outcome, amount: 0 } },
      { ...spin, outcome: { ...spin.outcome, amount: spin.outcome.amount + 1 } },
    ])
      expect(() => assertWheelAward(broken as WheelSpinResult)).toThrow();
    // The spin never carries the values.
    expect(JSON.stringify(spin.outcome.cards)).not.toContain('values');
    expect(pick.spin_id).toBe(spin.spin_id);
    const risk = pick.risk_diamonds;
    expect([...pick.cards].sort((a, b) => a - b)).toEqual(
      [Math.floor(risk / 2), 2 * risk, 3 * risk].sort((a, b) => a - b)
    );
    expect(pick.paid_diamonds).toBe(pick.cards[pick.picked - 1]);
    expect(replay.paid_diamonds).toBe(pick.paid_diamonds);
    expect(replay.cards).toEqual(pick.cards);
    expect(replay.replayed).toBe(true);
    const verdict = await verifyWheelCardPick(pick);
    expect(verdict.fair).toBe(true);
    expect(verdict.computedPermutation).toBe(pick.fairness.permutation);
    // Every permutation is worth eleven sixths of the risk.
    const total = pick.cards.reduce((sum, v) => sum + v, 0);
    expect(total * 2).toBe(11 * risk);
  });

  it('a state carries the run, the queue, the VIP flag and the model', () => {
    const state = by('wheel-v4-run-state') as Record<string, unknown>;
    expect(state.contract_version).toBe(4);
    expect(state.model_version).toBe('wheel-v4');
    expect(state.vip).toBe(false);
    expect((state.auto_run as { spins: number }).spins).toBe(5);
    expect((state.pending_awards as unknown[]).length).toBe(4);
    expect((state.pending_cards as unknown[]).length).toBe(1);
    const ended = by('wheel-v4-run-end') as Record<string, unknown>;
    expect(ended.ok).toBe(true);
    expect(ended.spins_done).toBe(5);
    expect((ended.pending_awards as unknown[]).length).toBe(4);
  });

  it('a receipt that reweighted itself is refused even though its own maths adds up', async () => {
    const value = JSON.parse(
      JSON.stringify(spins.find((r) => r.value.fairness.previous)!.value)
    ) as WheelSpinResult;
    const weights = [...value.fairness.weights!];
    // Move one unit between two other ords: the total, the eligible list and the
    // walk all still agree, and only the published law disagrees.
    const donor = weights.findIndex((w, i) => w > 1 && i + 1 !== value.outcome.ord);
    const taker = weights.findIndex((w, i) => w > 0 && i !== donor && i + 1 !== value.outcome.ord);
    weights[donor] -= 1;
    weights[taker] += 1;
    value.fairness.weights = weights;
    const verdict = await verifyWheelReceiptFairness(value);
    expect(verdict.lawMatches).toBe(false);
    expect(verdict.fair).toBe(false);
  });

  it('a receipt whose published table was edited is refused', async () => {
    const value = JSON.parse(JSON.stringify(spins[0].value)) as WheelSpinResult;
    value.segments![1].weight += 1;
    const verdict = await verifyWheelReceiptFairness(value);
    expect(verdict.fair).toBe(false);
    expect(() => assertWheelAward(value)).toThrow(/Could Not Be Confirmed/);
  });

  it('v3 receipts still verify under their own rules', async () => {
    const legacy = (v3fixture.records as unknown as Entry[])
      .filter((r) => ['wheel', 'wheel-replay'].includes(r.kind))
      .map((r) => r.value as WheelSpinResult);
    expect(legacy.length).toBeGreaterThan(20);
    for (const receipt of legacy) {
      expect(receipt.fairness.weights).toBeUndefined();
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      // The service is what turns PostgREST's nulls into absent fields, so a v3
      // receipt is checked exactly the way the browser actually receives it.
      const result = await service.spinV2({
        clubId: receipt.club_id,
        commitId: receipt.fairness.commit_id,
        clientSeed: receipt.fairness.client_seed,
        entryDiamonds: receipt.entry_value_diamonds!,
        mode: receipt.welcome ? 'welcome' : receipt.daily_bonus ? 'daily_bonus' : 'paid',
        ticketId: receipt.bonus_ticket_id ?? null,
      });
      expect(result.contract_version).toBe(3);
      assertWheelAward(result);
      const verdict = await verifyWheelReceiptFairness(result);
      expect(verdict.lawMatches).toBe(true);
      expect(verdict.fair).toBe(true);
    }
  });
});
