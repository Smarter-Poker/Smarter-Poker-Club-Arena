/**
 * Ban and Unban in the member panel go through the server's status door.
 *
 * club_members.status is server owned (trg_club_members_status_guard,
 * supabase/migrations/20260924045900_...). ClubMemberManagement's toggleBan
 * used to write the status column directly, which the guard now refuses, so
 * Ban and Unban would have failed for everyone. They now call
 * MembershipService.updateStatus, which resolves only on a confirmed change,
 * and a refusal reaches the operator in the server's own words.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  status: 'banned' as string,
  updateStatus: vi.fn(),
  from: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../src/lib/supabase', () => {
  const answer = (table: string) => {
    if (table === 'club_members') {
      return {
        data: [
          {
            user_id: 'member-1',
            role: 'player',
            chip_balance: 0,
            created_at: '2026-09-01T00:00:00Z',
            last_active: null,
            status: h.status,
            total_rake: 0,
          },
        ],
        error: null,
      };
    }
    return { data: [{ id: 'member-1', username: 'River Rat', avatar_url: '' }], error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'in']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => void) => resolve(answer(table));
    return chain;
  };
  return {
    supabase: {
      from: (table: string) => {
        h.from(table);
        return chainFor(table);
      },
    },
  };
});

vi.mock('../../src/services/MembershipService', () => ({
  MembershipService: {
    updateStatus: (...args: unknown[]) => h.updateStatus(...args),
    updateRole: vi.fn(),
    removeMember: vi.fn(),
  },
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => h.toast }));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(`uuid-of-${id}`),
}));
vi.mock('../../src/services/IntegrityActionService', () => ({
  liveSeatTableIds: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { ClubMemberManagement } from '../../src/components/admin/ClubMemberManagement';

describe('ClubMemberManagement Ban and Unban', () => {
  beforeEach(() => {
    h.updateStatus.mockReset();
    h.from.mockClear();
    h.toast.success.mockClear();
    h.toast.error.mockClear();
  });

  it('Unban asks the server to set the member active and reports success', async () => {
    h.status = 'banned';
    h.updateStatus.mockResolvedValue(true);
    render(<ClubMemberManagement clubId="club-7" isAdmin />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unban' }));

    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Member Unbanned'));
    expect(h.updateStatus).toHaveBeenCalledTimes(1);
    expect(h.updateStatus).toHaveBeenCalledWith('club-7', 'member-1', 'active');
    // The panel only reads club_members; the status write is the server's.
    expect(h.from.mock.calls.every(([t]) => t === 'club_members' || t === 'profiles')).toBe(true);
  });

  it("Ban shows the server's refusal and claims nothing", async () => {
    h.status = 'active';
    h.updateStatus.mockRejectedValue(
      new Error('Staff Can Only Change The Status Of Members Ranked Below Them')
    );
    render(<ClubMemberManagement clubId="club-7" isAdmin />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));

    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        'Staff Can Only Change The Status Of Members Ranked Below Them'
      )
    );
    expect(h.updateStatus).toHaveBeenCalledWith('club-7', 'member-1', 'banned');
    expect(h.toast.success).not.toHaveBeenCalled();
  });
});
