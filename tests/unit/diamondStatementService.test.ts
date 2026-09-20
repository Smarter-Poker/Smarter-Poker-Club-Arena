import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDiamondStatements } from '../../src/services/DiamondStatementService';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
const id = '11111111-1111-4111-8111-111111111111';
const row = {
  day: '2026-09-18',
  status: 'settled',
  entry_diamonds: 1000,
  bonus_diamonds: 100,
  mint_entry_diamonds: 100,
  diamond_prizes: 50,
  throwables: 25,
  time_banks: 10,
  rabbit_hunts: 10,
  other_expenses: 5,
  net_diamonds: 1100,
  settled_at: '2026-09-19T05:05:00Z',
  wallet_transaction_id: id,
  hosts: [
    {
      host_id: id,
      host_kind: 'union',
      host_name: 'Example Union',
      entries: 1200,
      expenses: 100,
      net_diamonds: 1100,
    },
  ],
};
const response = () => ({
  ok: true,
  timezone: 'America/Chicago',
  days: [structuredClone(row)],
  next_before_day: null,
});
beforeEach(() => rpc.mockReset());
describe('daily owner statement boundary', () => {
  it('uses only the authenticated owner and server keyset cursor', async () => {
    rpc.mockResolvedValue({ data: response(), error: null });
    const result = await loadDiamondStatements('2026-09-19');
    expect(result.days[0].net_diamonds).toBe(1100);
    expect(rpc).toHaveBeenCalledWith('fn_diamond_spin_statements', { p_before_day: '2026-09-19' });
  });
  it('retains negative and zero net statements without inventing wallet transfers', async () => {
    const r = response();
    r.days[0] = {
      ...row,
      entry_diamonds: 0,
      bonus_diamonds: 0,
      mint_entry_diamonds: 0,
      net_diamonds: -100,
      hosts: [{ ...row.hosts[0], entries: 0, net_diamonds: -100 }],
    };
    rpc.mockResolvedValue({ data: r, error: null });
    expect((await loadDiamondStatements()).days[0].net_diamonds).toBe(-100);
  });
  it.each(['totals', 'host', 'date', 'order', 'cursor', 'fraction', 'timezone', 'null'])(
    'refuses unreadable %s instead of showing false zero',
    async (bad) => {
      const r: any = response();
      if (bad === 'totals') r.days[0].net_diamonds++;
      if (bad === 'host') r.days[0].hosts[0].entries++;
      if (bad === 'date') r.days[0].day = 'Unknown';
      if (bad === 'order') r.days.push(structuredClone(r.days[0]));
      if (bad === 'cursor') r.next_before_day = '2026-09-17';
      if (bad === 'fraction') r.days[0].entry_diamonds = 0.1;
      if (bad === 'timezone') r.timezone = 'UTC';
      if (bad === 'null') r.days[0].throwables = null;
      rpc.mockResolvedValue({ data: r, error: null });
      await expect(loadDiamondStatements()).rejects.toThrow('Could Not Be Verified');
    }
  );
  it('exposes transport and authorization refusal', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('Unavailable') });
    await expect(loadDiamondStatements()).rejects.toThrow('Unavailable');
    rpc.mockResolvedValue({ data: { ok: false, error: 'Sign In' }, error: null });
    await expect(loadDiamondStatements()).rejects.toThrow('Sign In');
  });
});
