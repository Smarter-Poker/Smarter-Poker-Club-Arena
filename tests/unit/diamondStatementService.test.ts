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
  profit_burn_bps: 2000,
  profit_burn: 220,
  credited_net: 880,
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
  profit_burn_bps: 2000,
  days: [structuredClone(row)],
  next_before_day: null,
});
beforeEach(() => rpc.mockReset());
describe('daily owner statement boundary', () => {
  it('uses only the authenticated owner and server keyset cursor', async () => {
    rpc.mockResolvedValue({ data: response(), error: null });
    const result = await loadDiamondStatements('2026-09-19');
    expect(result.days[0].net_diamonds).toBe(1100);
    expect(result.profit_burn_bps).toBe(2000);
    expect(result.days[0].profit_burn).toBe(220);
    expect(result.days[0].credited_net).toBe(880);
    expect(rpc).toHaveBeenCalledWith('fn_diamond_spin_statements', { p_before_day: '2026-09-19' });
  });
  it('accepts the three settlement lines exactly as the day recorded them (owner ruling 2026-09-21, R14)', async () => {
    // A negative day burns nothing and the whole shortfall is the wallet debit.
    const negative = response();
    negative.days[0] = {
      ...row,
      entry_diamonds: 0,
      bonus_diamonds: 0,
      mint_entry_diamonds: 0,
      net_diamonds: -100,
      profit_burn: 0,
      credited_net: -100,
      hosts: [{ ...row.hosts[0], entries: 0, net_diamonds: -100 }],
    };
    rpc.mockResolvedValue({ data: negative, error: null });
    expect((await loadDiamondStatements()).days[0].credited_net).toBe(-100);
    // A day settled before the burn recorded rate 0 and was credited in full.
    const legacy = response();
    legacy.days[0] = { ...row, profit_burn_bps: 0, profit_burn: 0, credited_net: 1100 };
    rpc.mockResolvedValue({ data: legacy, error: null });
    expect((await loadDiamondStatements()).days[0].profit_burn_bps).toBe(0);
    // Whole diamonds, rounded down: 99 net burns 19, never 20.
    const odd = response();
    odd.days[0] = {
      ...row,
      entry_diamonds: 199,
      bonus_diamonds: 0,
      mint_entry_diamonds: 0,
      net_diamonds: 99,
      profit_burn: 19,
      credited_net: 80,
    };
    odd.days[0].hosts = [{ ...row.hosts[0], entries: 199, net_diamonds: 99 }];
    rpc.mockResolvedValue({ data: odd, error: null });
    expect((await loadDiamondStatements()).days[0].profit_burn).toBe(19);
    // An open day has no lines yet.
    const open = response();
    open.days[0] = {
      ...row,
      status: 'open',
      settled_at: null,
      wallet_transaction_id: null,
      profit_burn_bps: null,
      profit_burn: null,
      credited_net: null,
    };
    rpc.mockResolvedValue({ data: open, error: null });
    expect((await loadDiamondStatements()).days[0].credited_net).toBeNull();
  });
  it.each(['burn', 'credit', 'rate', 'open', 'zero', 'top'])(
    'refuses settlement lines that do not add up (%s)',
    async (bad) => {
      const r: any = response();
      if (bad === 'burn') r.days[0].profit_burn = 221;
      if (bad === 'credit') r.days[0].credited_net = 1100;
      if (bad === 'rate') r.days[0].profit_burn_bps = 2500;
      if (bad === 'open') {
        r.days[0].status = 'open';
        r.days[0].settled_at = null;
        r.days[0].wallet_transaction_id = null;
      }
      if (bad === 'zero') {
        r.days[0] = {
          ...row,
          entry_diamonds: 0,
          bonus_diamonds: 0,
          mint_entry_diamonds: 100,
          net_diamonds: 0,
          profit_burn: 0,
          credited_net: 0,
        };
        r.days[0].hosts = [{ ...row.hosts[0], entries: 100, net_diamonds: 0 }];
      }
      if (bad === 'top') r.profit_burn_bps = '2000';
      rpc.mockResolvedValue({ data: r, error: null });
      await expect(loadDiamondStatements()).rejects.toThrow('Could Not Be Verified');
    }
  );
  it('retains negative and zero net statements without inventing wallet transfers', async () => {
    const r = response();
    r.days[0] = {
      ...row,
      entry_diamonds: 0,
      bonus_diamonds: 0,
      mint_entry_diamonds: 0,
      net_diamonds: -100,
      profit_burn: 0,
      credited_net: -100,
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
