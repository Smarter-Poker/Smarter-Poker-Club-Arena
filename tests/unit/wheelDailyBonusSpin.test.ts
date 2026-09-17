import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import service from '../../src/services/DiamondWheelService';
import {
  assertWheelReceipt,
  clearWheelPending,
  readWheelPending,
  saveWheelPending,
  type WheelPendingSpin,
} from '../../src/utils/wheelPendingSpin';
const attempt: WheelPendingSpin = {
  userId: '10000000-0000-0000-0000-000000000001',
  clubId: '10000000-0000-0000-0000-000000000002',
  commitId: '10000000-0000-0000-0000-000000000003',
  ticketId: '10000000-0000-0000-0000-000000000004',
  clientSeed: 'the-same-seed',
  commitHash: 'a'.repeat(64),
  mode: 'daily_bonus',
};
const receipt = () => ({
  ok: true,
  daily_bonus: true,
  welcome: false,
  spin_id: '10000000-0000-0000-0000-000000000005',
  club_id: attempt.clubId,
  host_id: attempt.clubId,
  bonus_ticket_id: attempt.ticketId,
  player_cost_diamonds: 0,
  entry_value_diamonds: 100,
  entry_funded_by: 'mint',
  spin_price_diamonds: 100,
  created_at: '2026-09-14T13:00:00Z',
  outcome: { kind: 'chips', ord: 2, amount: '0.20', label: '0.20 Chips', value_chips: '0.20' },
  fairness: {
    commit_id: attempt.commitId,
    client_seed: attempt.clientSeed,
    server_seed_hash: attempt.commitHash,
    server_seed: 'b'.repeat(64),
    eligible_ords: [1, 2],
    weight_total: 100000,
    roll: 24000,
    nonce: 1,
  },
  balances: { diamonds: 0, member_chips: '0.20' },
});
const spin = () =>
  service.dailyBonusSpin(attempt.clubId, attempt.commitId, attempt.clientSeed, attempt.ticketId!);
beforeEach(() => {
  rpc.mockReset();
  localStorage.clear();
});
describe('claimed Daily Bonus ticket contract', () => {
  it('names a ticket and an exact request; no caller-supplied price or Mint instruction', async () => {
    rpc.mockResolvedValue({ data: receipt(), error: null });
    const r = await spin();
    expect(r.outcome.amount).toBe(0.2);
    expect(r.player_cost_diamonds).toBe(0);
    expect(r.entry_funded_by).toBe('mint');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('fn_wheel_daily_bonus_spin', {
      p_club_id: attempt.clubId,
      p_commit_id: attempt.commitId,
      p_client_seed: attempt.clientSeed,
      p_ticket_id: attempt.ticketId,
    });
    expect(() => assertWheelReceipt(r, attempt)).not.toThrow();
  });
  it.each([null, {}, { ok: true }, { ok: 'true' }, { ok: false }])(
    'keeps an ambiguous response unresolved: %j',
    async (data) => {
      saveWheelPending(attempt);
      rpc.mockResolvedValue({ data, error: null });
      await expect(spin()).rejects.toThrow();
      expect(readWheelPending(attempt.userId, attempt.clubId)).toEqual(attempt);
    }
  );
  it.each([
    'bonus_ticket_id',
    'club_id',
    'entry_funded_by',
    'daily_bonus',
    'welcome',
    'player_cost_diamonds',
    'entry_value_diamonds',
  ])('refuses a mismatched %s', async (key) => {
    rpc.mockResolvedValue({ data: { ...receipt(), [key]: 'wrong' }, error: null });
    await expect(spin()).rejects.toThrow();
  });
  it('does not treat a missing cost as zero', async () => {
    const r = receipt();
    delete (r as Partial<typeof r>).player_cost_diamonds;
    rpc.mockResolvedValue({ data: r, error: null });
    await expect(spin()).rejects.toThrow();
  });
  it('retries after a lost response with the saved ticket, seed and commit', async () => {
    saveWheelPending(attempt);
    rpc.mockRejectedValueOnce(new Error('lost response'));
    await expect(spin()).rejects.toThrow();
    const saved = readWheelPending(attempt.userId, attempt.clubId)!;
    rpc.mockResolvedValueOnce({ data: { ...receipt(), replayed: true }, error: null });
    const r = await service.dailyBonusSpin(
      saved.clubId,
      saved.commitId,
      saved.clientSeed,
      saved.ticketId!
    );
    assertWheelReceipt(r, saved);
    clearWheelPending(saved);
    expect(r.replayed).toBe(true);
    expect(readWheelPending(attempt.userId, attempt.clubId)).toBeNull();
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it('keeps one account and club from inheriting another pending spin', () => {
    saveWheelPending(attempt);
    expect(readWheelPending('other', attempt.clubId)).toBeNull();
    expect(readWheelPending(attempt.userId, 'other')).toBeNull();
  });
  it('does not erase a newer tab request while clearing an earlier receipt', () => {
    const newer = { ...attempt, commitId: '10000000-0000-0000-0000-000000000006' };
    saveWheelPending(newer);
    clearWheelPending(attempt);
    expect(readWheelPending(attempt.userId, attempt.clubId)).toEqual(newer);
  });
  it('refuses to submit when durable recovery storage fails', () => {
    const setter = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveWheelPending(attempt)).toThrow('quota');
    expect(rpc).not.toHaveBeenCalled();
    setter.mockRestore();
  });
  it('does not expose an unclaimed spin on malformed availability', async () => {
    rpc.mockResolvedValue({ data: { ok: true, available: true, ticket_count: 1 }, error: null });
    await expect(service.dailyBonusState(attempt.clubId)).rejects.toThrow();
  });
  it('keeps a saved welcome request distinct from the claimed Daily reward', async () => {
    rpc.mockResolvedValue({ data: receipt(), error: null });
    const r = await spin();
    expect(() => assertWheelReceipt(r, { ...attempt, mode: 'welcome', ticketId: null })).toThrow();
  });
});
