/**
 * A member status change succeeds only when a row changed.
 *
 * MembershipService.updateStatus (ClubDetailPage's Suspend) writes
 * club_members directly. PostgREST answers an UPDATE that RLS filtered out, or
 * that named somebody who is not a member of this club, with zero rows and no
 * error, and the service used to call that success.
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
  return { supabase: { from: (table: string) => (h.calls.push(['from', [table]]), chain) } };
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

  it('refuses when the update changed no row, and announces nothing', async () => {
    h.result = { data: [], error: null };
    await expect(MembershipService.updateStatus('club-1', 'user-1', 'suspended')).rejects.toThrow(
      'Member Status Was Not Changed'
    );
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('refuses when the update answered with no rows at all', async () => {
    h.result = { data: null, error: null };
    await expect(MembershipService.updateStatus('club-1', 'user-1', 'suspended')).rejects.toThrow(
      'Member Status Was Not Changed'
    );
  });

  it('throws the database error instead of returning false', async () => {
    const error = { message: 'permission denied', code: '42501' };
    h.result = { data: null, error };
    await expect(MembershipService.updateStatus('club-1', 'user-1', 'suspended')).rejects.toBe(
      error
    );
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('asks for the changed row back and succeeds on exactly that one row', async () => {
    h.result = { data: [{ user_id: 'user-1', status: 'suspended' }], error: null };
    await expect(MembershipService.updateStatus('club-1', 'user-1', 'suspended')).resolves.toBe(
      true
    );
    expect(h.calls).toContainEqual(['from', ['club_members']]);
    expect(h.calls).toContainEqual(['update', [{ status: 'suspended' }]]);
    expect(h.calls).toContainEqual(['select', ['user_id, status']]);
    expect(h.emit).toHaveBeenCalledWith('CLUB_UPDATED', { clubId: 'club-1' });
  });
});
