/**
 * S-07 / D-16 (2026-10-09): the cashier's Club Bank and promo pot come from the
 * role-checked fn_club_money_panel, never from clubs.chip_treasury /
 * clubs.promo_balance (production grants SELECT on those columns to every API
 * caller). An unreadable or refused panel is Unavailable, never 0. A viewer
 * with no agents row has no float yet, which is a fact, not an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  panel: { data: null as unknown, error: null as null | { message: string; code?: string } },
  agent: { data: null as unknown, error: null as null | { message: string } },
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
  fromCalls: [] as string[],
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push([name, args]);
      return { abortSignal: async () => state.panel };
    }),
    from: vi.fn((table: string) => {
      state.fromCalls.push(table);
      const chain: any = {};
      for (const method of ['select', 'eq', 'abortSignal']) chain[method] = () => chain;
      chain.maybeSingle = async () => state.agent;
      return chain;
    }),
  },
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  isUUID: (v: string) => /^[0-9a-f-]{36}$/.test(v),
  resolveClubUUID: vi.fn(async (id: string) => id),
}));
import { readCashierBalances } from '../../src/services/cashierBalanceRead';

const CLUB = 'a1000000-0000-4000-8000-000000000001';
const USER = 'b1000000-0000-4000-8000-000000000002';
const signal = new AbortController().signal;
const authorized = (extra: Record<string, unknown> = {}) => ({
  authorized: true,
  scope: 'club',
  club_id: CLUB,
  club_name: 'Deep Stack Society',
  in_union: false,
  union_id: null,
  club_treasury: 1234.56,
  club_pool: 10,
  club_promo_wallet: 78.9,
  ...extra,
});

beforeEach(() => {
  state.panel = { data: authorized(), error: null };
  state.agent = { data: null, error: null };
  state.rpcCalls = [];
  state.fromCalls = [];
});

describe('readCashierBalances reads club money through the role-checked panel (S-07)', () => {
  it('calls fn_club_money_panel and never selects clubs.chip_treasury / promo_balance', async () => {
    const snapshot = await readCashierBalances(CLUB, USER, 'club_bank', signal);
    expect(state.rpcCalls).toEqual([['fn_club_money_panel', { p_club_id: CLUB }]]);
    expect(state.fromCalls).not.toContain('clubs');
    expect(snapshot).toEqual({
      clubId: CLUB,
      name: 'Deep Stack Society',
      inUnion: false,
      bank: 1234.56,
      promoPot: 78.9,
      promoFloat: null,
      hasFloat: null,
    });
  });
  it('does not read the agents row for the club bank cashier', async () => {
    await readCashierBalances(CLUB, USER, 'club_bank', signal);
    expect(state.fromCalls).toEqual([]);
  });
  it('a refused panel (authorized:false, no error) is Unavailable, never 0', async () => {
    state.panel = { data: { authorized: false, reason: 'not_a_member' }, error: null };
    await expect(readCashierBalances(CLUB, USER, 'club_bank', signal)).rejects.toThrow(
      'The club balance is unavailable'
    );
  });
  it.each([
    ['null data', null],
    ['an empty array', []],
    ['a string', 'nope'],
  ])('%s from the panel is Unavailable, never 0', async (_label, data) => {
    state.panel = { data, error: null };
    await expect(readCashierBalances(CLUB, USER, 'club_bank', signal)).rejects.toThrow(
      'The club balance is unavailable'
    );
  });
  it('a panel error is thrown, so the modal shows Unavailable instead of 0.00', async () => {
    state.panel = { data: null, error: { message: 'permission denied', code: '42501' } };
    await expect(readCashierBalances(CLUB, USER, 'club_bank', signal)).rejects.toMatchObject({
      message: 'permission denied',
    });
  });
  it('unwraps a table-shaped panel and reads in_union from the panel', async () => {
    state.panel = { data: [authorized({ in_union: true, union_id: 'u' })], error: null };
    const snapshot = await readCashierBalances(CLUB, USER, 'club_bank', signal);
    expect(snapshot.inUnion).toBe(true);
    expect(snapshot.bank).toBe(1234.56);
  });
  it('a missing treasury figure is null, not 0', async () => {
    state.panel = {
      data: authorized({ club_treasury: undefined, club_promo_wallet: '' }),
      error: null,
    };
    const snapshot = await readCashierBalances(CLUB, USER, 'club_bank', signal);
    expect(snapshot.bank).toBeNull();
    expect(snapshot.promoPot).toBeNull();
  });
});

describe('the agent float row (D-16)', () => {
  it('reports hasFloat:false with a zero float when the viewer has no agents row', async () => {
    const snapshot = await readCashierBalances(CLUB, USER, 'agent_wallet', signal);
    expect(state.fromCalls).toEqual(['agents']);
    expect(snapshot.hasFloat).toBe(false);
    expect(snapshot.bank).toBe(0);
    expect(snapshot.promoFloat).toBe(0);
    expect(snapshot.promoPot).toBe(78.9);
  });
  it('reports hasFloat:true with the live balances when the row exists', async () => {
    state.agent = {
      data: { agent_wallet_balance: '500.25', promo_wallet_balance: 3 },
      error: null,
    };
    const snapshot = await readCashierBalances(CLUB, USER, 'agent_wallet', signal);
    expect(snapshot.hasFloat).toBe(true);
    expect(snapshot.bank).toBe(500.25);
    expect(snapshot.promoFloat).toBe(3);
  });
  it('an agents read error is thrown, never reported as no float', async () => {
    state.agent = { data: null, error: { message: 'permission denied' } };
    await expect(readCashierBalances(CLUB, USER, 'agent_wallet', signal)).rejects.toMatchObject({
      message: 'permission denied',
    });
  });
  it('the promo cashier reads both the pot and the float', async () => {
    state.agent = { data: { agent_wallet_balance: 1, promo_wallet_balance: 22 }, error: null };
    const snapshot = await readCashierBalances(CLUB, USER, 'promo_wallet', signal);
    expect(snapshot.promoPot).toBe(78.9);
    expect(snapshot.promoFloat).toBe(22);
    expect(snapshot.hasFloat).toBe(true);
  });
});
