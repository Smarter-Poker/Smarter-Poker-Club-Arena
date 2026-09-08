// @vitest-environment happy-dom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import InvitePage from '../../src/pages/InvitePage';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  join: vi.fn(),
  auth: { user: { id: 'player-1' } as { id: string } | null },
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => mocks.auth }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/services/ClubJoinService', () => ({ ClubJoinService: { join: mocks.join } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { subscribeDebounced: () => () => {} } }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => {} }));
vi.mock('../../src/components/common/PageSkeleton', () => ({ default: () => <div>Loading</div> }));

describe('Diamond invitation entry', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({
      data: { id: 'diamond-id', name: 'Diamond Arena', asset: 'diamonds' },
      error: null,
    });
    mocks.from.mockReturnValue(query);
  });
  it.each([true, false])(
    'routes to guarded arena without membership or referral writes (signed in: %s)',
    async (signedIn) => {
      mocks.auth.user = signedIn ? { id: 'player-1' } : null;
      render(
        <MemoryRouter initialEntries={['/invite/diamond?ref=123']}>
          <Routes>
            <Route path="/invite/:clubId" element={<InvitePage />} />
            <Route path="/clubs/diamond-id" element={<div>Guarded Diamond Destination</div>} />
          </Routes>
        </MemoryRouter>
      );
      expect(await screen.findByText('Guarded Diamond Destination')).toBeTruthy();
      expect(mocks.from).toHaveBeenCalledTimes(1);
      expect(mocks.from).toHaveBeenCalledWith('clubs');
      expect(mocks.join).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /join club/i })).toBeNull();
    }
  );
});
