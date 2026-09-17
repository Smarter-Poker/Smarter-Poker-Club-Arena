/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ClubsService membership semantics
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two regressions this suite locks down (audit 2026-08-20):
 *
 * 1. getUserMemberships returned EVERY club_members row for the user, with no
 *    status filter. Requesting to join an approval-required club creates a
 *    status='pending' row, so the requester saw a full club card on the lobby
 *    carousel — and could open — a club they had not been admitted to.
 *
 * 2. joinClub redeemed the stored referral code even when the join came back
 *    pending. A rejected request would still have credited the referrer, which
 *    is unrecoverable. Pending joins must leave the code stored, unredeemed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Recording supabase mock ──────────────────────────────────────────────

interface QueryRecord {
  table: string;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown]>;
}

const queries: QueryRecord[] = [];
let membershipRows: unknown[] = [];
let joinRpcResult: { data: unknown; error: unknown } = { data: null, error: null };

vi.mock('../../src/lib/supabase', () => {
  const makeChain = (table: string) => {
    const record: QueryRecord = { table, eq: [], in: [] };
    queries.push(record);
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        record.eq.push([col, val]);
        return chain;
      },
      in: (col: string, val: unknown) => {
        record.in.push([col, val]);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      // Awaiting the builder resolves the query
      then: (resolve: (v: unknown) => void) =>
        resolve({
          data: table === 'club_members' ? membershipRows : [],
          error: null,
          count: 0,
        }),
    };
    return chain;
  };

  return {
    supabase: {
      from: (table: string) => makeChain(table),
      rpc: vi.fn((name: string) => {
        if (name === 'fn_join_club') return Promise.resolve(joinRpcResult);
        // batch member-count enrichment etc.
        return Promise.resolve({ data: [], error: null });
      }),
    },
    getAuthUser: vi.fn().mockResolvedValue({
      data: { user: { id: 'user-under-test' } },
      error: null,
    }),
  };
});

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/clubIdResolver')>()),
  resolveClubUUID: vi.fn().mockResolvedValue('club-uuid-1'),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

const redeemCode = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../src/services/ReferralService', () => ({
  referralService: { redeemCode: (...a: unknown[]) => redeemCode(...a) },
}));

// ─── Import AFTER mocks ───────────────────────────────────────────────────

import {
  getUserMemberships,
  joinClub,
  clearMembershipsWarmCache,
} from '../../src/services/ClubsService';

beforeEach(() => {
  clearMembershipsWarmCache();
  queries.length = 0;
  membershipRows = [];
  joinRpcResult = { data: null, error: null };
  redeemCode.mockClear();
  localStorage.clear();
});

describe('getUserMemberships', () => {
  it('keeps chip memberships and excludes Diamond, retired, and unknown-asset rows', async () => {
    membershipRows = [
      { club_id: 'chip', club: { id: 'chip', asset: 'chips', lifecycle_status: 'active' } },
      {
        club_id: 'diamond',
        club: { id: 'diamond', asset: 'diamonds', lifecycle_status: 'active' },
      },
      { club_id: 'retired', club: { id: 'retired', asset: 'chips', lifecycle_status: 'retired' } },
      { club_id: 'unknown', club: { id: 'unknown', lifecycle_status: 'active' } },
    ];
    const result = await getUserMemberships({ id: 'user-under-test' });
    expect(result.map((row) => row.club_id)).toEqual(['chip']);
  });

  it('requests only active/approved memberships (pending joins are not memberships)', async () => {
    await getUserMemberships({ id: 'user-under-test' });

    const membershipQuery = queries.find((q) => q.table === 'club_members');
    expect(membershipQuery).toBeDefined();
    expect(membershipQuery!.eq).toContainEqual(['user_id', 'user-under-test']);

    const statusFilter = membershipQuery!.in.find(([col]) => col === 'status');
    expect(statusFilter, 'getUserMemberships must filter by status').toBeDefined();
    expect(statusFilter![1]).toEqual(['active', 'approved']);
  });
});

describe('joinClub referral redemption', () => {
  it('redeems a stored referral code after a real (active) join', async () => {
    localStorage.setItem('referral_club-uuid-1', 'FRIEND10');
    joinRpcResult = {
      data: { club_id: 'club-uuid-1', user_id: 'user-under-test', status: 'active' },
      error: null,
    };

    await joinClub('club-uuid-1');
    await Promise.resolve(); // let the fire-and-forget chain settle

    expect(redeemCode).toHaveBeenCalledWith('user-under-test', 'FRIEND10');
    // Single-shot: the code must be cleared so a bad code cannot loop forever
    expect(localStorage.getItem('referral_club-uuid-1')).toBeNull();
  });

  it('does NOT redeem when the join is pending approval, and keeps the code', async () => {
    localStorage.setItem('referral_club-uuid-1', 'FRIEND10');
    joinRpcResult = {
      data: { club_id: 'club-uuid-1', user_id: 'user-under-test', status: 'pending' },
      error: null,
    };

    await joinClub('club-uuid-1');
    await Promise.resolve();

    expect(redeemCode).not.toHaveBeenCalled();
    expect(localStorage.getItem('referral_club-uuid-1')).toBe('FRIEND10');
  });

  it('is a no-op when no referral code was stored', async () => {
    joinRpcResult = {
      data: { club_id: 'club-uuid-1', user_id: 'user-under-test', status: 'active' },
      error: null,
    };

    await joinClub('club-uuid-1');
    await Promise.resolve();

    expect(redeemCode).not.toHaveBeenCalled();
  });
});
