import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ from: vi.fn(), failedPage: '', profiles: [] as number[] }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: state.from } }));
vi.mock('../../src/hooks', () => ({ useClubRole: () => ({ isAdmin: true }) }));
vi.mock('../../src/hooks/usePlayerPreference', async () => {
  const { useState } = await import('react');
  return { usePlayerPreference: () => useState('') };
});
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, pill }: any) => (
    <section>
      <span>{pill}</span>
      {children}
    </section>
  ),
}));
import RegistrationApprovalsPanel from '../../src/components/tournament/RegistrationApprovalsPanel';
import { MembershipService } from '../../src/services/MembershipService';
const ids = Array.from({ length: 1001 }, (_, i) => `player-${String(i).padStart(4, '0')}`);
beforeEach(() => {
  state.failedPage = '';
  state.profiles = [];
  state.from.mockImplementation((table: string) => {
    let cursor = '';
    let limit = 5000;
    let requested = ids;
    let sort = 'user_id';
    let ascending = true;
    const b: any = {
      select: () => b,
      eq: () => b,
      gt: (_: string, value: string) => {
        cursor = value;
        return b;
      },
      limit: (value: number) => {
        limit = value;
        return b;
      },
      order: (key: string, options: any) => {
        sort = key;
        ascending = options.ascending;
        return b;
      },
      in: (_: string, values: string[]) => {
        requested = values;
        state.profiles.push(values.length);
        return b;
      },
      then: (resolve: any, reject: any) => {
        if (cursor && state.failedPage === table)
          return Promise.resolve({
            data: null,
            error: { message: 'second page unavailable' },
          }).then(resolve, reject);
        const rows = (table === 'profiles' ? requested : ids)
          .filter((id) => id > cursor)
          .map((id) =>
            table === 'club_members'
              ? {
                  user_id: id,
                  club_id: 'club',
                  role: 'player',
                  status: 'active',
                  joined_at: '2026-10-29',
                  membership_lifecycle_status: 'active',
                }
              : table === 'profiles'
                ? { id, alias: id === ids.at(-1) ? 'Last Member' : id }
                : { user_id: id, created_at: '2026-10-29' }
          );
        rows.sort(
          (a: any, b: any) =>
            String(a[sort] ?? '').localeCompare(String(b[sort] ?? '')) * (ascending ? 1 : -1)
        );
        return Promise.resolve({ data: rows.slice(0, Math.min(limit, 1000)), error: null }).then(
          resolve,
          reject
        );
      },
    };
    return b;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('reads the complete approval set beyond the database response ceiling', async () => {
  render(<RegistrationApprovalsPanel tournamentId="event" clubId="club" authorizedToRegister />);
  expect(await screen.findByText('1001 Approved')).toBeInTheDocument();
});
it('loads and names the member beyond the first membership page', async () => {
  const members = await MembershipService.getClubMembers('club');
  expect(members).toHaveLength(1001);
  expect(members.find((m) => m.userId === ids.at(-1))?.displayName).toBe('Last Member');
  expect(Math.max(...state.profiles)).toBeLessThanOrEqual(1000);
});
it('does not present a partial approval page as a complete editable list', async () => {
  state.failedPage = 'tournament_registration_approvals';
  render(<RegistrationApprovalsPanel tournamentId="event" clubId="club" authorizedToRegister />);
  expect(await screen.findByText('Could Not Load Registration Approvals.')).toBeInTheDocument();
  expect(screen.queryByText('1000 Approved')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
});
it('rejects an incomplete membership read instead of hiding later candidates', async () => {
  state.failedPage = 'club_members';
  await expect(MembershipService.getClubMembers('club')).rejects.toThrow('second page unavailable');
});

it('keeps membership-page failure visible and retries the complete read', async () => {
  state.failedPage = 'club_members';
  render(<RegistrationApprovalsPanel tournamentId="event" clubId="club" authorizedToRegister />);
  expect(await screen.findByText('Could Not Load Registration Approvals.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  state.failedPage = '';
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('1001 Approved')).toBeInTheDocument();
});
