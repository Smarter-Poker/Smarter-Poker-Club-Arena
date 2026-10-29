import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), members: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../src/hooks', () => ({ useClubRole: () => ({ isAdmin: true }) }));
vi.mock('../../src/hooks/usePlayerPreference', () => ({
  usePlayerPreference: () => ['', vi.fn()],
}));
vi.mock('../../src/services/MembershipService', () => ({
  MembershipService: { getClubMembers: mocks.members },
}));
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
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function deferred() {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it('never lets an old event approval response replace the current event', async () => {
  const old = deferred();
  mocks.members.mockResolvedValue([{ userId: 'player', displayName: 'Player One' }]);
  mocks.from.mockImplementation(() => {
    let event = '';
    const b: any = {
      select: () => b,
      eq: (_: string, v: string) => {
        event = v;
        return b;
      },
      order: () => (event === 'old' ? old.promise : Promise.resolve({ data: [], error: null })),
    };
    return b;
  });
  const { rerender } = render(
    <RegistrationApprovalsPanel tournamentId="old" clubId="club" authorizedToRegister />
  );
  rerender(<RegistrationApprovalsPanel tournamentId="new" clubId="club" authorizedToRegister />);
  await screen.findByRole('button', { name: 'Approve' });
  await act(async () =>
    old.resolve({ data: [{ user_id: 'player', created_at: '2026-10-29' }], error: null })
  );
  expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  expect(screen.getByText('0 Approved')).toBeInTheDocument();
});
it('clears the prior event approval count while the next event is loading', async () => {
  const next = deferred();
  mocks.members.mockResolvedValue([{ userId: 'player', displayName: 'Player One' }]);
  mocks.from.mockImplementation(() => {
    let event = '';
    const b: any = {
      select: () => b,
      eq: (_: string, v: string) => {
        event = v;
        return b;
      },
      order: () =>
        event === 'new'
          ? next.promise
          : Promise.resolve({
              data: [{ user_id: 'player', created_at: '2026-10-29' }],
              error: null,
            }),
    };
    return b;
  });
  const { rerender } = render(
    <RegistrationApprovalsPanel tournamentId="old" clubId="club" authorizedToRegister />
  );
  await screen.findByRole('button', { name: 'Revoke' });
  rerender(<RegistrationApprovalsPanel tournamentId="new" clubId="club" authorizedToRegister />);
  await waitFor(() => expect(screen.queryByText('1 Approved')).not.toBeInTheDocument());
});
