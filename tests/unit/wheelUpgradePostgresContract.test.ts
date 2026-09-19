/** Actual settled PostgreSQL receipts from the maintained isolated accounting
 * probe. Its entire public/auth fixture is rolled back; seeds are test-only. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/diamond-spins/wheel-v3-postgres-receipts.json';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import service, { type WheelSpinResult } from '../../src/services/DiamondWheelService';
import { hmacSha256Hex, verifyWheelReceiptFairness } from '../../src/utils/wheelFairness';
import { assertWheelReceipt } from '../../src/utils/wheelPendingSpin';

type RecordEntry = { kind: string; stake: number; value: WheelSpinResult };
const records = fixture.records as unknown as RecordEntry[];
const spins = records.filter((r) =>
  ['wheel', 'wheel-replay', 'wheel-historical-replay', 'wheel-legacy-v3'].includes(r.kind)
);
beforeEach(() => rpc.mockReset());

describe('real PostgreSQL eight-outcome Upgrade contract', () => {
  it('includes all twelve primary sectors and all eight secondary sectors', () => {
    expect(new Set(spins.map((r) => r.value.outcome.ord)).size).toBe(12);
    const upgraded = spins.filter((r) => r.value.secondary);
    expect([...new Set(upgraded.map((r) => r.value.secondary!.outcome.ord))].sort()).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(spins.some((r) => r.value.daily_bonus)).toBe(true);
    expect(spins.some((r) => r.value.welcome)).toBe(true);
    for (const freeMode of ['welcome', 'daily_bonus'] as const) {
      const hundred = spins.filter(
        (r) => r.value[freeMode] && r.value.secondary?.outcome.multiplier === 100
      );
      expect(hundred).toHaveLength(2);
      expect(hundred.map((r) => r.value.replayed).sort()).toEqual([false, true]);
      expect(hundred.every((r) => r.value.player_cost_diamonds === 0)).toBe(true);
    }
    expect(spins.filter((r) => r.kind === 'wheel-historical-replay')).toHaveLength(1);
  });

  it.each(
    spins.map((r, index) => ({
      ...r,
      label: `${index}: ${r.kind}, ${r.value.secondary?.outcome.label ?? r.value.outcome.label}`,
    }))
  )('$label', async ({ value: raw, stake = raw.entry_value_diamonds! }) => {
    rpc.mockResolvedValue({ data: structuredClone(raw), error: null });
    const request = {
      clubId: raw.club_id,
      commitId: raw.fairness.commit_id,
      clientSeed: raw.fairness.client_seed,
      entryDiamonds: stake,
      mode: raw.welcome
        ? ('welcome' as const)
        : raw.daily_bonus
          ? ('daily_bonus' as const)
          : ('paid' as const),
      ticketId: raw.bonus_ticket_id ?? null,
    };
    const result = await service.spinV2(request);
    assertWheelReceipt(result, {
      ...request,
      userId: 'fixture-player',
      commitHash: raw.fairness.server_seed_hash,
      contractVersion: raw.contract_version,
    });
    expect(result.contract_version).toBe(raw.contract_version);
    expect((await verifyWheelReceiptFairness(result)).fair).toBe(true);
    expect(result.balances).toEqual(raw.balances);
    expect(result.replayed).toBe(raw.replayed);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('fn_wheel_spin_v2', {
      p_club_id: request.clubId,
      p_commit_id: request.commitId,
      p_client_seed: request.clientSeed,
      p_entry_diamonds: stake,
      p_mode: request.mode === 'daily_bonus' ? 'daily' : request.mode,
      p_bonus_ticket_id: request.ticketId,
    });
    if (raw.secondary) {
      expect(result.secondary?.segments).toHaveLength(raw.contract_version === 3 ? 8 : 4);
      expect(result.secondary?.outcome).toMatchObject({
        kind: raw.secondary.outcome.kind,
        multiplier: raw.secondary.outcome.multiplier,
        amount: raw.secondary.outcome.amount,
        value_chips: raw.secondary.outcome.value_chips,
      });
      if (raw.secondary.outcome.kind === 'chips') {
        expect(result.bonus).toBeUndefined();
        expect(result.secondary!.outcome.amount).toBe(
          (stake * raw.secondary.outcome.multiplier!) / 100
        );
      } else {
        expect(result.bonus).toMatchObject({
          game: raw.secondary.outcome.game,
          entry_diamonds: stake,
          base_diamonds: stake * 2,
          boost_multiplier: 2,
        });
      }
    }
  });

  it.each(records.filter((r) => r.kind === 'wheel-state'))(
    'consumes the server state and secondary quote at $stake diamonds',
    async ({ value: raw, stake }) => {
      rpc.mockResolvedValue({ data: raw, error: null });
      const state = await service.getStateV2(raw.club_id, stake);
      expect(state.contract_version).toBe(3);
      expect(state.segments).toHaveLength(12);
      expect(state.upgrade_segments).toHaveLength(8);
      expect(
        state.upgrade_segments?.filter((s) => s.kind === 'chips').map((s) => s.amount)
      ).toEqual([(stake * 5) / 100, (stake * 10) / 100, (stake * 25) / 100, stake]);
    }
  );

  it('matches half-entry quotes and the actual sealed whole-unit payout for all four odd-stake rewards', async () => {
    const half = spins.filter((r) => r.kind === 'wheel' && r.value.outcome.multiplier === 0.5);
    expect(new Set(half.map((r) => r.value.outcome.kind))).toEqual(
      new Set(['diamonds', 'throwables', 'time_bank', 'rabbit_hunt'])
    );
    for (const { value: raw, stake } of half) {
      expect(stake).toBe(25);
      const segment = raw.segments!.find((s) => s.ord === raw.outcome.ord)!;
      expect(segment.amount).toBe(12.5);
      expect(segment.value_chips).toBe(0.125);
      const f = raw.fairness;
      const domain = raw.outcome.kind === 'diamonds' ? 'wheel-v3-diamonds' : 'wheel-v3-consumable';
      const h = await hmacSha256Hex(f.server_seed, `${domain}:${f.client_seed}:${f.nonce}`);
      const expected = 12 + (BigInt(`0x${h.slice(0, 12)}`) + 1n <= 140737488355328n ? 1 : 0);
      expect(raw.outcome.value_chips).toBe(expected / 100);
      if (raw.outcome.kind === 'diamonds') expect(raw.outcome.amount).toBe(expected);
      else
        expect(
          raw.outcome.grants!.reduce(
            (sum, g) => sum + g.uses * (g.feature === 'throwable' ? 1 : 5),
            0
          )
        ).toBe(expected);
    }
  });

  it('decodes the actual history RPC with its retained v2 and v3 final outcomes', async () => {
    const record = records.find((r) => r.kind === 'wheel-history');
    expect(record).toBeDefined();
    const raw = record!.value as unknown as WheelSpinResult[];
    rpc.mockResolvedValue({ data: structuredClone(raw), error: null });
    const history = await service.history(raw[0].club_id, 100);
    expect(history).toHaveLength(raw.length);
    expect(new Set(history.map((r) => r.contract_version))).toEqual(new Set([2, 3]));
    for (const [i, result] of history.entries()) {
      expect(result.spin_id).toBe(raw[i].spin_id);
      expect(result.secondary?.outcome.kind).toBe(raw[i].secondary?.outcome.kind);
      expect(result.secondary?.outcome.amount).toBe(raw[i].secondary?.outcome.amount);
      expect((await verifyWheelReceiptFairness(result)).fair).toBe(true);
    }
    expect(rpc).toHaveBeenCalledExactlyOnceWith('fn_wheel_history', {
      p_club_id: raw[0].club_id,
      p_limit: 100,
    });
  });

  it('refuses a changed secondary draw even when the first draw still verifies', async () => {
    const raw = spins.find((r) => r.value.secondary?.outcome.kind === 'chips')!.value;
    rpc.mockResolvedValue({ data: raw, error: null });
    const result = await service.spinV2({
      clubId: raw.club_id,
      commitId: raw.fairness.commit_id,
      clientSeed: raw.fairness.client_seed,
      entryDiamonds: raw.entry_value_diamonds!,
      mode: 'paid',
      ticketId: null,
    });
    result.secondary!.fairness.roll += 1;
    expect((await verifyWheelReceiptFairness(result)).fair).toBe(false);
  });
});
