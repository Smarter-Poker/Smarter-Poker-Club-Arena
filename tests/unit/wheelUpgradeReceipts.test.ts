import { beforeEach, describe, expect, it, vi } from 'vitest';
import receipts from '../fixtures/diamond-wheel-v2-receipts.json';
import stateReceipt from '../fixtures/diamond-wheel-v2-state.json';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import service, { type WheelSpinResult } from '../../src/services/DiamondWheelService';
import {
  assertWheelReceipt,
  clearWheelPending,
  readWheelPending,
  saveWheelPending,
  type WheelPendingSpin,
} from '../../src/utils/wheelPendingSpin';

// Mutations of a retained real v2 receipt exercise decoding boundaries only.
// Real v3 PostgreSQL receipts separately prove both committed HMAC draws.
const legacy = receipts.find((r) => r.value.outcome.kind === 'upgrade')!.value;
function receipt(ord = 5): WheelSpinResult {
  const r = structuredClone(legacy) as unknown as WheelSpinResult;
  r.contract_version = 3;
  r.segment_version = 3;
  r.fairness.domain = 'wheel-v3';
  const secondary = r.secondary!;
  secondary.fairness.domain = 'wheel-v3-upgrade';
  secondary.fairness.eligible_ords = [1, 2, 3, 4, 5, 6, 7, 8];
  secondary.segments = [
    ...secondary.segments.map((s) => ({ ...s, weight: 20000, probability: 0.2 })),
    ...[5, 10, 25, 100].map((multiplier, i) => ({
      ord: i + 5,
      kind: 'chips' as const,
      multiplier,
      amount: 25 * multiplier,
      value_chips: 25 * multiplier,
      label: `${multiplier}x Chips`,
      weight: [9600, 7400, 2000, 1000][i],
      probability: [0.096, 0.074, 0.02, 0.01][i],
      locked: false,
      unlocks_at: null,
    })),
  ];
  secondary.outcome = { ...secondary.segments[ord - 1] };
  if (ord > 4) delete r.bonus;
  else r.bonus!.game = secondary.outcome.game!;
  return r;
}
function attempt(r: WheelSpinResult): WheelPendingSpin {
  return {
    userId: 'd1000000-0000-4000-8000-000000000004',
    clubId: r.club_id,
    commitId: r.fairness.commit_id,
    commitHash: r.fairness.server_seed_hash,
    clientSeed: r.fairness.client_seed,
    mode: 'paid',
    ticketId: null,
    contractVersion: 3,
    entryDiamonds: r.entry_value_diamonds,
  };
}
const spin = (r: WheelSpinResult) =>
  service.spinV2({ ...attempt(r), entryDiamonds: r.entry_value_diamonds! });
beforeEach(() => {
  rpc.mockReset();
  localStorage.clear();
});

describe('eight-outcome Upgrade receipt and recovery boundaries', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('accepts secondary sector %s', async (ord) => {
    const raw = receipt(ord);
    rpc.mockResolvedValue({ data: raw, error: null });
    const result = await spin(raw);
    assertWheelReceipt(result, attempt(raw));
    expect(result.contract_version).toBe(3);
    expect(result.secondary?.segments).toHaveLength(8);
    expect(result.secondary?.outcome).toMatchObject(raw.secondary!.outcome);
    if (ord > 4) expect(result.bonus).toBeUndefined();
    else expect(result.bonus).toMatchObject({ game: raw.bonus!.game, base_diamonds: 5000 });
  });

  it.each<[string, (r: WheelSpinResult) => void]>([
    ['missing secondary', (r) => delete r.secondary],
    ['four sectors in v3', (r) => (r.secondary!.segments = r.secondary!.segments.slice(0, 4))],
    ['game award attached to chips', (r) => (r.bonus = receipt(1).bonus)],
    ['missing funded game award', (r) => Object.assign(r, { ...receipt(1), bonus: undefined })],
    ['unapproved chip multiplier', (r) => (r.secondary!.segments[4].multiplier = 4)],
    ['duplicate chip multiplier', (r) => (r.secondary!.segments[4].multiplier = 10)],
    ['different chip amount', (r) => (r.secondary!.outcome.amount += 1)],
    ['different chip value', (r) => (r.secondary!.outcome.value_chips += 1)],
    ['different selected weight', (r) => (r.secondary!.outcome.weight += 1)],
    ['different primary Upgrade budget', (r) => (r.outcome.amount += 1)],
    ['wrong table chip budget', (r) => (r.secondary!.segments[4].amount += 1)],
    ['wrong table game budget', (r) => (r.secondary!.segments[0].amount += 1)],
    ['wrong game boost', (r) => (r.secondary!.segments[0].multiplier = 1)],
    ['old secondary domain', (r) => (r.secondary!.fairness.domain = 'wheel-v2-upgrade')],
    ['old primary domain', (r) => (r.fairness.domain = 'wheel-v2')],
    ['different secondary commit', (r) => (r.secondary!.fairness.commit_id = 'other')],
    ['different secondary seed', (r) => (r.secondary!.fairness.server_seed = 'c'.repeat(64))],
    ['incomplete eligibility', (r) => r.secondary!.fairness.eligible_ords.pop()],
    ['different total weight', (r) => (r.secondary!.fairness.weight_total += 1)],
    ['locked secondary prize', (r) => (r.secondary!.segments[4].locked = true)],
  ])('retains the pending request for %s', async (_, mutate) => {
    const raw = receipt();
    const saved = attempt(raw);
    saveWheelPending(saved);
    mutate(raw);
    rpc.mockResolvedValue({ data: raw, error: null });
    await expect(spin(raw)).rejects.toThrow('Could Not Be Confirmed');
    expect(readWheelPending(saved.userId, saved.clubId)).toEqual(saved);
  });

  it('replays an uncertain v2 request after its first execution uses v3', async () => {
    const raw = receipt(8);
    const saved = { ...attempt(raw), contractVersion: 2 as const };
    saveWheelPending(saved);
    rpc.mockRejectedValueOnce(new Error('Connection Lost'));
    await expect(spin(raw)).rejects.toThrow('Connection Lost');
    expect(readWheelPending(saved.userId, saved.clubId)).toEqual(saved);
    rpc.mockResolvedValueOnce({ data: { ...raw, replayed: true }, error: null });
    const result = await spin(raw);
    assertWheelReceipt(result, saved);
    expect(result.replayed).toBe(true);
    expect(result.secondary?.outcome).toMatchObject({ kind: 'chips', amount: 2500 });
    clearWheelPending(saved);
    expect(readWheelPending(saved.userId, saved.clubId)).toBeNull();
  });

  it('does not downgrade a v3 request to a historical v2 result', async () => {
    const raw = receipt();
    rpc.mockResolvedValue({ data: legacy, error: null });
    const historical = await spin(raw);
    expect(() => assertWheelReceipt(historical, attempt(raw))).toThrow();
  });

  it('keeps both versions in history with their original final result', async () => {
    const raw = receipt(8);
    rpc.mockResolvedValue({ data: [raw, legacy], error: null });
    const history = await service.history(raw.club_id);
    expect(history.map((r) => r.contract_version)).toEqual([3, 2]);
    expect(history[0].secondary?.outcome).toMatchObject({ kind: 'chips', amount: 2500 });
    expect(history[0].bonus).toBeUndefined();
    expect(history[1].secondary?.segments).toHaveLength(4);
    expect(history[1].bonus?.game).toBe('plinko');
    raw.secondary!.outcome.amount += 1;
    rpc.mockResolvedValue({ data: [raw], error: null });
    await expect(service.history(raw.club_id)).rejects.toThrow();
  });

  it('reads all eight preview outcomes from the authoritative selected-stake quote', async () => {
    const raw = receipt();
    const state = {
      ...stateReceipt,
      contract_version: 3,
      segments: raw.segments,
      upgrade_segments: raw.secondary!.segments,
      config: { ...stateReceipt.config, spin_price_diamonds: 2500, segment_version: 3 },
    };
    rpc.mockResolvedValue({ data: state, error: null });
    const result = await service.getStateV2(raw.club_id, 2500);
    expect(result.contract_version).toBe(3);
    expect(result.upgrade_segments).toHaveLength(8);
    expect(result.upgrade_segments?.[7]).toMatchObject({ multiplier: 100, amount: 2500 });
    await expect(service.getStateV2(raw.club_id, 100)).rejects.toThrow();
    rpc.mockResolvedValue({
      data: { ...state, upgrade_segments: state.upgrade_segments.slice(0, 4) },
      error: null,
    });
    await expect(service.getStateV2(raw.club_id, 2500)).rejects.toThrow();
  });
});
