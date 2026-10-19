// @vitest-environment happy-dom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ membership: vi.fn() }));
vi.unmock('../../src/core/MasterBus');
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'owner' }, isHydrating: false }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/analytics', () => ({ capture: vi.fn() }));
vi.mock('../../src/stores/useArenaStore', () => ({ useArenaStore: {} }));
vi.mock('../../src/stores/useClubStore', () => ({ useClubStore: {} }));
vi.mock('../../src/stores/useTableStore', () => ({ useTableStore: {} }));
vi.mock('../../src/stores/useUnionStore', () => ({ useUnionStore: {} }));
vi.mock('../../src/stores/useWalletStore', () => ({ useWalletStore: {} }));
vi.mock('../../src/stores/useSettingsStore', () => ({ useSettingsStore: {} }));
vi.mock('../../src/stores/useUserStore', () => ({ useUserStore: {} }));
vi.mock('../../src/services/RealtimeChannelService', () => ({ realtimeChannelService: {} }));
vi.mock('../../src/components/arena/arenaAccess', () => ({
  useAutomaticArenaMembership: () => false,
}));
vi.mock('../../src/components/arena/ArenaAccessBoundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const method of ['select', 'eq', 'is', 'update', 'abortSignal']) chain[method] = self;
      chain.maybeSingle =
        table === 'club_members'
          ? mocks.membership
          : async () => ({
              data:
                table === 'profiles'
                  ? { role: 'player' }
                  : {
                      id: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
                      owner_id: 'owner',
                      banner_url: null,
                    },
              error: null,
            });
      return chain;
    },
  },
}));

import { masterBus } from '../../src/core/MasterBus';
import { ClubWorkspaceProvider } from '../../src/contexts/ClubWorkspaceContext';
import ClubMemberGuard from '../../src/components/auth/ClubMemberGuard';
import { saveClubBanner } from '../../src/services/ClubBannerService';

const clubId = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
function Draft() {
  const [value, setValue] = useState('');
  return (
    <input
      aria-label="Unsaved Club Banner Note"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}
beforeEach(() => {
  localStorage.clear();
  masterBus.reset();
  mocks.membership
    .mockReset()
    .mockResolvedValue({ data: { role: 'owner', status: 'active' }, error: null });
});
afterEach(() => {
  cleanup();
  masterBus.reset();
  vi.useRealTimers();
});

it('keeps a draft mounted after a real banner save while membership changes still fail closed', async () => {
  render(
    <MemoryRouter initialEntries={[`/clubs/${clubId}/banner-displays`]}>
      <ClubWorkspaceProvider>
        <Routes>
          <Route
            path="/clubs/:clubId/banner-displays"
            element={
              <ClubMemberGuard>
                <Draft />
              </ClubMemberGuard>
            }
          />
          <Route path="/invite/:clubId" element={<div>Membership Required</div>} />
        </Routes>
      </ClubWorkspaceProvider>
    </MemoryRouter>
  );
  const input = await screen.findByLabelText('Unsaved Club Banner Note');
  vi.useFakeTimers();
  await act(async () => {
    await saveClubBanner(clubId, 'owner', '/previous.png', null);
  });
  fireEvent.change(input, { target: { value: 'Keep My Club Banner Choice' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(screen.getByLabelText('Unsaved Club Banner Note')).toBe(input);
  expect(input).toHaveValue('Keep My Club Banner Choice');
  expect(mocks.membership).toHaveBeenCalledTimes(1);

  let resolveMembership!: (value: unknown) => void;
  mocks.membership.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveMembership = resolve;
      })
  );
  await act(async () => {
    masterBus.emit('CLUB_UPDATED', { clubId });
    await vi.advanceTimersByTimeAsync(400);
  });
  // A re-check keeps the verified page mounted until its answer arrives
  // (2026-10-19, tests/unit/aVerifiedClubPageStaysMountedWhileItsAccessIsRechecked.test.tsx);
  // the revocation still lands the moment the answer says so.
  expect(screen.getByLabelText('Unsaved Club Banner Note')).toBe(input);
  await act(async () => {
    resolveMembership({ data: null, error: null });
    await Promise.resolve();
  });
  expect(screen.getByText('Membership Required')).toBeInTheDocument();
});
