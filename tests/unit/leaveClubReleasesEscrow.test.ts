/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEAVING A CLUB MUST NOT STRAND CHIPS IN ESCROW
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Defect, found 2026-08-25:
 *
 *   leaveClub step 3 cancelled a pending cashout with a direct table write,
 *
 *       supabase.from('cashout_requests')
 *               .update({ status: 'cancelled', cancelled_at: ... })
 *
 *   inside a try/catch marked "(non-critical)". Earlier the same day the
 *   migration `20260825_role_scoped_cashier_agent_wallet_and_cashout_escrow`
 *   dropped the `cashout_update` policy that had allowed that write, because it
 *   also let a player set their own request to 'approved'. Every write moved to
 *   SECURITY DEFINER functions; this caller did not move with them.
 *
 *   The statement did not start failing. It started doing NOTHING. RLS with no
 *   UPDATE policy matches zero rows rather than raising, PostgREST answers 200,
 *   and supabase-js returns the error in the result object rather than throwing
 *   even when there is one - so the catch could never fire and leaveClub
 *   reported success either way.
 *
 *   Cost, for a leaver holding a pending cashout: the request stayed 'pending'
 *   and the chip_escrow row stayed unreleased, so those chips were never added
 *   back to chip_balance and were therefore NOT part of the treasury return in
 *   step 5 either. Step 5 then removed the membership. The chips survived only
 *   as an escrow row belonging to somebody who was no longer a member.
 *
 * Verified against production before the fix, as a real player, in a rolled-back
 * transaction: UPDATE on cashout_requests affected 0 rows.
 *
 * What follows pins the two properties that matter: the cancellation goes
 * through the RPC that actually returns the chips, and a refusal stops the
 * departure instead of being swallowed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Op {
  table: string;
  verb: 'select' | 'update' | 'delete' | 'insert';
}

const ops: Op[] = [];
let pendingCashoutRows: Array<{ id: string; club_id: string; player_id: string; amount: string; status: string }> = [];
const row = (id: string) => ({ id, club_id: 'club-1', player_id: 'player-1', amount: '12.34', status: 'pending' });
let accountCurrent = true;
let pendingCashoutError: unknown = null;
let leaveRpc: { data: unknown; error: unknown } = {
  data: { success: true },
  error: null,
};

const cancelCashout = vi.fn(async (_id: string, _userId: string, _opId?: string, _intent?: unknown) => true);

vi.mock('../../src/services/CashoutService', () => ({
  captureCashoutAccountGuard: () => () => accountCurrent,
  cashoutService: {
    cancelCashout: (id: string, userId: string, opId: string, intent: unknown) => cancelCashout(id, userId, opId, intent),
  },
}));

vi.mock('../../src/services/CashoutOperation', () => ({
  // This leave-flow unit isolates the protocol already covered by the actual
  // wrapper/storage/service tests, while asserting the exact per-row intent.
  prepareCashoutOperation: async (intent: any) => {
    if (!intent.isCurrent()) throw new Error('Account Changed');
    return intent;
  },
  captureCashoutStart: (intent: any) => {
    if (!intent.isCurrent()) throw new Error('Account Changed');
    return intent;
  },
  assertCashoutStartCurrent: (intent: any) => {
    if (!intent.isCurrent()) throw new Error('Account Changed');
  },
  captureCashoutReceiptCheck: (original: any, isCurrent: () => boolean) => ({ ...original, isCurrent }),
  recoverCashoutOperation: async (intent: any) => {
    if (!intent.isCurrent()) throw new Error('Cashout Changed');
    return { found: false };
  },
  runCashoutOperation: (intent: any) => cancelCashout(intent.targetId, intent.userId, 'retained-operation', {
    clubId: intent.clubId, amount: intent.amount, playerId: intent.playerId, isCurrent: intent.isCurrent,
  }),
}));

vi.mock('../../src/lib/supabase', () => {
  const makeChain = (table: string) => {
    const chain: any = {
      select: () => {
        ops.push({ table, verb: 'select' });
        return chain;
      },
      update: () => {
        ops.push({ table, verb: 'update' });
        return chain;
      },
      delete: () => {
        ops.push({ table, verb: 'delete' });
        return chain;
      },
      insert: () => {
        ops.push({ table, verb: 'insert' });
        return chain;
      },
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve({
          // step 1: the membership lookup
          data: { role: 'player', chip_balance: 500, credit_used: 0 },
          error: null,
        }),
      then: (resolve: (v: unknown) => void) =>
        resolve(
          table === 'cashout_requests'
            ? { data: pendingCashoutRows, error: pendingCashoutError }
            : { data: [], error: null }
        ),
    };
    return chain;
  };

  return {
    supabase: {
      from: (table: string) => makeChain(table),
      rpc: vi.fn(async (name: string) => {
        if (name === 'fn_member_leave_to_treasury') return leaveRpc;
        return { data: null, error: null };
      }),
    },
    getAuthUser: vi.fn().mockResolvedValue({
      data: { user: { id: 'player-1' } },
      error: null,
    }),
  };
});

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn(async (id: string) => id),
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const { leaveClub } = await import('../../src/services/ClubsService');
const { supabase } = await import('../../src/lib/supabase');

beforeEach(() => {
  vi.mocked(supabase.rpc).mockClear();
  ops.length = 0;
  pendingCashoutRows = [];
  accountCurrent = true;
  pendingCashoutError = null;
  leaveRpc = { data: { success: true }, error: null };
  cancelCashout.mockClear();
  cancelCashout.mockResolvedValue(true);
});

describe('leaveClub closes a pending cashout through the refunding path', () => {
  it('never writes to cashout_requests directly', async () => {
    pendingCashoutRows = [row('cashout-a')];
    await leaveClub('club-1');

    const directWrites = ops.filter((o) => o.table === 'cashout_requests' && o.verb !== 'select');
    expect(
      directWrites,
      'a direct write to cashout_requests is denied by RLS and silently does nothing'
    ).toEqual([]);
  });

  it('cancels each pending cashout through the verified v2 service', async () => {
    pendingCashoutRows = [row('cashout-a'), row('cashout-b')];
    await leaveClub('club-1');

    expect(cancelCashout).toHaveBeenCalledTimes(2);
    expect(cancelCashout).toHaveBeenCalledWith('cashout-a', 'player-1', 'retained-operation', expect.objectContaining({ clubId: 'club-1', amount: 12.34, playerId: 'player-1', isCurrent: expect.any(Function) }));
    expect(cancelCashout).toHaveBeenCalledWith('cashout-b', 'player-1', 'retained-operation', expect.objectContaining({ clubId: 'club-1', amount: 12.34, playerId: 'player-1' }));
  });

  it('does not call the cashout RPC when there is nothing pending', async () => {
    pendingCashoutRows = [];
    await leaveClub('club-1');
    expect(cancelCashout).not.toHaveBeenCalled();
  });

  it('stops the departure when the escrow cannot be returned', async () => {
    /* The chips are still in escrow. Completing the leave would delete the
       membership and strand them, so the refusal must propagate. */
    pendingCashoutRows = [row('cashout-a')];
    cancelCashout.mockRejectedValueOnce(new Error('That Cash Out Has Already Been Dealt With'));

    await expect(leaveClub('club-1')).rejects.toThrow('Already Been Dealt With');

    expect(supabase.rpc).not.toHaveBeenCalledWith('fn_member_leave_to_treasury', expect.anything());
  });

  it('treats an unreadable cashout list as unknown, never as none', async () => {
    /* A failed SELECT returns data:null. Reading that as "no pending cashouts"
       is the empty-success-state bug: it would leave without checking. */
    pendingCashoutError = { message: 'permission denied' };
    await expect(leaveClub('club-1')).rejects.toThrow(/cash out waiting/i);
    expect(cancelCashout).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalledWith('fn_member_leave_to_treasury', expect.anything());
  });
});

// These stop before treasury departure and do not reinterpret an unknown refund as success.
it.each(['amount', 'club_id', 'player_id', 'status'])('refuses an unverified pending cashout %s', async field => {
  pendingCashoutRows = [{ ...row('cashout-a'), [field]: 'unverified' }];
  await expect(leaveClub('club-1')).rejects.toThrow('Could Not Verify');
  expect(cancelCashout).not.toHaveBeenCalled();
  expect(supabase.rpc).not.toHaveBeenCalledWith('fn_member_leave_to_treasury', expect.anything());
});
it('stops after a refund response if the captured account changed', async () => {
  pendingCashoutRows = [row('cashout-a')];
  cancelCashout.mockImplementationOnce(async () => { accountCurrent = false; return true; });
  await expect(leaveClub('club-1')).rejects.toThrow('Account Changed');
  expect(supabase.rpc).not.toHaveBeenCalledWith('fn_member_leave_to_treasury', expect.anything());
});
