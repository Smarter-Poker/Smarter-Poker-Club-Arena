import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import service from '../../src/services/DiamondWheelService';
import {
  assertWheelReceipt,
  readWheelPending,
  saveWheelPending,
  type WheelPendingSpin,
} from '../../src/utils/wheelPendingSpin';
const attempt: WheelPendingSpin = {
  userId: '10000000-0000-0000-0000-000000000001',
  clubId: '10000000-0000-0000-0000-000000000002',
  commitId: '10000000-0000-0000-0000-000000000003',
  commitHash: 'a'.repeat(64),
  clientSeed: 'the-same-spin',
  ticketId: null,
  mode: 'paid',
  contractVersion: 2,
  entryDiamonds: 250,
};
const segments = [
  ['bonus', 'plinko'],
  ['bonus', 'crash'],
  ['bonus', 'crossing'],
  ['bonus', 'mines'],
  ['upgrade'],
  ['chips', null, 1],
  ['chips', null, 2],
  ['chips', null, 3],
  ['throwables'],
  ['time_bank'],
  ['rabbit_hunt'],
  ['diamonds'],
].map(([kind, game, multiplier], i) => ({
  ord: i + 1,
  kind,
  game: game ?? undefined,
  multiplier: multiplier ?? undefined,
  amount: kind === 'chips' ? 2.5 * Number(multiplier) : 100,
  value_chips: 1,
  label: String(kind),
  weight: 1,
  probability: 1 / 12,
  locked: false,
  unlocks_at: null,
}));
function receipt() {
  return {
    ok: true,
    contract_version: 2,
    segments,
    spin_id: '10000000-0000-0000-0000-000000000004',
    club_id: attempt.clubId,
    welcome: false,
    daily_bonus: false,
    entry_value_diamonds: 250,
    player_cost_diamonds: 250,
    spin_price_diamonds: 250,
    created_at: '2026-09-17T19:00:00Z',
    outcome: segments[5],
    fairness: {
      domain: 'wheel-v2',
      commit_id: attempt.commitId,
      server_seed_hash: attempt.commitHash,
      server_seed: 'b'.repeat(64),
      client_seed: attempt.clientSeed,
      nonce: 1,
      roll: 0,
      weight_total: 12,
      eligible_ords: segments.map((s) => s.ord),
      locked: [],
    },
  };
}
const spin = () => service.spinV2({ ...attempt, entryDiamonds: attempt.entryDiamonds! });
beforeEach(() => {
  rpc.mockReset();
  localStorage.clear();
});
describe('versioned wheel entry and recovery', () => {
  it('keeps the chosen stake and version through reload and sends exactly that request', async () => {
    saveWheelPending(attempt);
    expect(readWheelPending(attempt.userId, attempt.clubId)).toEqual(attempt);
    rpc.mockResolvedValue({ data: receipt(), error: null });
    const result = await spin();
    assertWheelReceipt(result, attempt);
    expect(rpc).toHaveBeenCalledWith('fn_wheel_spin_v2', {
      p_club_id: attempt.clubId,
      p_commit_id: attempt.commitId,
      p_client_seed: attempt.clientSeed,
      p_entry_diamonds: 250,
      p_mode: 'paid',
      p_bonus_ticket_id: null,
    });
  });
  it.each([24, 2501, 25.5, NaN])(
    'refuses an invalid saved entry %s before a money request',
    (entryDiamonds) => {
      expect(() => saveWheelPending({ ...attempt, entryDiamonds })).toThrow();
      expect(rpc).not.toHaveBeenCalled();
    }
  );
  it('refuses a paid receipt for a different entry and preserves its recovery identity', async () => {
    saveWheelPending(attempt);
    rpc.mockResolvedValue({ data: { ...receipt(), entry_value_diamonds: 100 }, error: null });
    const result = await spin();
    expect(() => assertWheelReceipt(result, attempt)).toThrow();
    expect(readWheelPending(attempt.userId, attempt.clubId)).toEqual(attempt);
  });
  it('never downgrades a malformed or unreadable v2 contract to a different money route', async () => {
    rpc.mockResolvedValueOnce({ data: { enabled: true }, error: null });
    await expect(service.getStateV2(attempt.clubId)).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('uses legacy state only after explicit inactive v2 state', async () => {
    rpc.mockResolvedValueOnce({ data: { contract_version: 2, enabled: false }, error: null });
    rpc.mockResolvedValueOnce({ data: { ok: true, available: true, segments: [] }, error: null });
    expect((await service.getStateV2(attempt.clubId)).contract_version).toBeUndefined();
    expect(rpc.mock.calls[1][0]).toBe('fn_wheel_state');
  });
  it('refuses an empty or partial new prize table', async () => {
    const r = receipt();
    r.segments = r.segments.slice(1);
    rpc.mockResolvedValue({ data: r, error: null });
    await expect(spin()).rejects.toThrow();
  });
  it('keeps free entry value fixed at one hundred diamonds', () => {
    expect(() => saveWheelPending({ ...attempt, mode: 'welcome', entryDiamonds: 250 })).toThrow();
    expect(() =>
      saveWheelPending({ ...attempt, mode: 'welcome', entryDiamonds: 100 })
    ).not.toThrow();
  });
});
