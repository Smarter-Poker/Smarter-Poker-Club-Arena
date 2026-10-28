import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const auth = vi.hoisted(() => ({ id: null as string | null }));
const listeners = vi.hoisted(() => new Map<string, Set<(event: any) => void>>());
vi.unmock('../../src/hooks/useMasterBusSubscription');
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe(type: string, handler: (event: any) => void) {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
      return () => handlers.delete(handler);
    },
    emit(type: string, payload: unknown) {
      for (const handler of listeners.get(type) ?? []) handler({ payload });
    },
  },
}));
vi.mock('../../src/lib/authUtils', () => ({
  readLocalSession: () => (auth.id ? { userId: auth.id } : null),
}));
vi.mock('../../src/lib/supabase', () => {
  const q: any = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return { supabase: { from: () => q } };
});
import TournamentRankingHost from '../../src/components/tournament/TournamentRankingHost';
import { masterBus } from '../../src/core/MasterBus';
import { clearSessionSummary } from '../../src/services/pendingSessionSummary';
afterEach(() => {
  act(() => clearSessionSummary());
  sessionStorage.clear();
  auth.id = null;
});
it('restores the finish after SSO refresh and removes it when the account changes', async () => {
  // Prepare the real lazy card before timing auth recovery. Parallel test-file
  // transforms must not consume findByRole's deadline for the state transition.
  await import('../../src/components/tournament/TournamentRankingCard');
  sessionStorage.setItem(
    'club-arena-finish-reports-v1:hero',
    JSON.stringify({
      version: 1,
      acknowledged: [],
      reports: [
        {
          resultOnly: true,
          duration: 0,
          handsPlayed: 0,
          handsWon: 0,
          totalRebuys: 1,
          profitLoss: 0,
          biggestPot: 0,
          peakStack: 0,
          tournament: {
            userId: 'hero',
            tournamentId: 'auth-nightly',
            name: 'Nightly',
            finishPlace: 353,
            entrants: 375,
            prize: 0,
            bountyWinnings: 0,
            knockouts: 0,
            rebuys: 1,
            addOns: 1,
            buyInAmount: 35,
          },
        },
      ],
    })
  );
  render(
    <MemoryRouter>
      <TournamentRankingHost />
    </MemoryRouter>
  );
  expect(screen.queryByRole('dialog', { name: /tournament ranking/i })).toBeNull();
  await act(async () => {
    auth.id = 'hero';
    masterBus.emit('AUTH_STATE_CHANGED', { userId: 'hero', isAuthenticated: true });
  });
  const card = await screen.findByRole('dialog', { name: /tournament ranking/i });
  expect(card.textContent).toContain('353');
  expect(card.textContent).toContain('Buy-In: 35');
  await act(async () => {
    auth.id = 'other';
    masterBus.emit('AUTH_STATE_CHANGED', { userId: 'other', isAuthenticated: true });
  });
  expect(screen.queryByRole('dialog', { name: /tournament ranking/i })).toBeNull();
});
