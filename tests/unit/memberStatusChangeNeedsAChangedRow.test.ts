/**
 * A member status change succeeds only when the server confirms it.
 *
 * MembershipService.updateStatus (ClubDetailPage's Suspend, ClubMemberManagement's
 * Ban and Unban) used to write club_members directly. PostgREST answers an
 * UPDATE that RLS filtered out, or that named somebody who is not a member of
 * this club, with zero rows and no error, and the service used to call that
 * success (#5171). The status is now server owned: the write goes through
 * fn_club_set_member_status, and the same rule holds against its answer. No
 * success flag, or a success that does not name exactly the status asked for,
 * is a failure, and nothing is announced.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
  calls: [] as Array<[string, unknown[]]>,
  emit: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['update', 'eq', 'select']) {
    chain[m] = (...args: unknown[]) => {
      h.calls.push([m, args]);
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(h.result);
  return {
    supabase: {
      from: (table: string) => (h.calls.push(['from', [table]]), chain),
      rpc: (fn: string, args: unknown) => (
        h.calls.push(['rpc', [fn, args]]),
        Promise.resolve(h.result)
      ),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: h.emit, subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
}));

import { MembershipService } from '../../src/services/MembershipService';

describe('MembershipService.updateStatus', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.emit.mockClear();
  });

  it('refuses when the server did not report a success, and announces nothing', async () => {
    h.result = { data: { success: false }, error: null };
    await expect(MembershipService.updateStatus('club-1', 'user-1', 'suspended')).rejects.toThrow(
      'The Club Did Not Accept The Status Change'
    );
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('refuses when the server answered with nothing at all', async () => {
    h.result = { data: null, error: null };
    await expect(MembershipService.updateStatus('club-1', 'user-1', 'suspended')).rejects.toThrow(
      'The Club Did Not Accept The Status Change'
    );
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('throws the database error instead of returning false', async () => {
    const error = { message: 'permission denied', code: '42501' };
    h.result = { data: null, error };
    await expect(MembershipService.updateStatus('club-1', 'user-1', 'suspended')).rejects.toBe(
      error
    );
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('refuses a success that names a different status, and announces nothing', async () => {
    h.result = { data: { success: true, unchanged: false, new_status: 'banned' }, error: null };
    await expect(MembershipService.updateStatus('club-1', 'user-1', 'suspended')).rejects.toThrow(
      'The Club Did Not Confirm The Status Change'
    );
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('asks the server and succeeds on exactly the confirmed status', async () => {
    h.result = {
      data: { success: true, unchanged: false, user_id: 'user-1', new_status: 'suspended' },
      error: null,
    };
    await expect(MembershipService.updateStatus('club-1', 'user-1', 'suspended')).resolves.toBe(
      true
    );
    expect(h.calls).toContainEqual([
      'rpc',
      [
        'fn_club_set_member_status',
        { p_club_id: 'club-1', p_user_id: 'user-1', p_status: 'suspended', p_reason: null },
      ],
    ]);
    expect(h.calls.some(([m]) => m === 'from' || m === 'update')).toBe(false);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith('CLUB_UPDATED', { clubId: 'club-1' });
  });

  it('announces nothing when the server confirms the member already had that status', async () => {
    h.result = {
      data: { success: true, unchanged: true, user_id: 'user-1', new_status: 'suspended' },
      error: null,
    };
    await expect(MembershipService.updateStatus('club-1', 'user-1', 'suspended')).resolves.toBe(
      true
    );
    expect(h.emit).not.toHaveBeenCalled();
  });
});
