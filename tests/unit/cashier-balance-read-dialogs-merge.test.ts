/**
 * THE CASHIER BALANCE READ, MERGED (2026-10-09). The first cashier swarm read
 * the agents row the way the server does (audit C2-1: a missing row is an
 * empty wallet, a NULL column is coalesce(..., 0), and the credit line rides
 * with the Agent Wallet); the launch audit moved the club figures onto the
 * role-checked fn_club_money_panel and flagged a missing row (S-07, D-16).
 * These cases fail against either side alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  agent: { data: null as unknown, error: null as null | { message: string } },
  tables: [] as string[],
  rpcs: [] as string[],
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn((name: string) => {
      state.rpcs.push(name);
      return {
        abortSignal: async () => ({
          data: {
            authorized: true,
            scope: 'club',
            club_name: 'Deep Stack Society',
            in_union: false,
            union_id: null,
            club_treasury: 900,
            club_promo_wallet: 7,
          },
          error: null,
        }),
      };
    }),
    from: vi.fn((table: string) => {
      state.tables.push(table);
      const chain: Record<string, unknown> = {};
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

beforeEach(() => {
  state.agent = { data: null, error: null };
  state.tables = [];
  state.rpcs = [];
});

describe('the merged cashier balance read', () => {
  it('an agents row whose balances are NULL is a float holding 0, as the server coalesces it', async () => {
    state.agent = {
      data: {
        agent_wallet_balance: null,
        promo_wallet_balance: null,
        is_prepaid: null,
        credit_limit: null,
        credit_used: null,
      },
      error: null,
    };
    const read = await readCashierBalances(CLUB, USER, 'agent_wallet', signal);
    expect(read.hasFloat).toBe(true);
    expect(read.bank).toBe(0);
    expect(read.promoFloat).toBe(0);
    expect(read.credit).toBe(0);
  });

  it('tracking credit never enlarges the funded Agent Wallet beside the role-checked club figures', async () => {
    state.agent = {
      data: {
        agent_wallet_balance: 5,
        promo_wallet_balance: 3,
        is_prepaid: false,
        credit_limit: 100,
        credit_used: 40,
      },
      error: null,
    };
    const agent = await readCashierBalances(CLUB, USER, 'agent_wallet', signal);
    expect(agent).toMatchObject({
      bank: 5,
      credit: 0,
      promoPot: 7,
      promoFloat: 3,
      hasFloat: true,
    });
    const promo = await readCashierBalances(CLUB, USER, 'promo_wallet', signal);
    expect(promo).toMatchObject({ credit: 0, promoPot: 7, promoFloat: 3, hasFloat: true });
    expect(state.rpcs.every((name) => name === 'fn_club_money_panel')).toBe(true);
    expect(state.tables).not.toContain('clubs');
  });

  it('no agents row is no float, no line and an empty wallet, never Unavailable', async () => {
    const read = await readCashierBalances(CLUB, USER, 'agent_wallet', signal);
    expect(read).toMatchObject({ bank: 0, credit: 0, promoFloat: 0, hasFloat: false });
  });

  it('the Club Bank cashier lends nothing and never reads the agents row', async () => {
    const read = await readCashierBalances(CLUB, USER, 'club_bank', signal);
    expect(read).toMatchObject({ bank: 900, credit: 0, promoFloat: null, hasFloat: null });
    expect(state.tables).toEqual([]);
  });
});
