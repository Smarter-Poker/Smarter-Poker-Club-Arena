import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TournamentRankingHost from '../../src/components/tournament/TournamentRankingHost';
import {
  clearSessionSummary,
  publishSessionSummary,
} from '../../src/services/pendingSessionSummary';

const mocks = vi.hoisted(() => ({ query: vi.fn(), resolve: vi.fn(), filters: vi.fn() }));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => ({ userId: 'hero' }) }));
vi.mock('../../src/services/TableService', () => ({
  tableService: { resolveTournamentLiveTable: mocks.resolve },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (name: string) => {
      const query: any = {
        select: () => query,
        order: () => query,
        limit: () => query,
        eq: (...args: unknown[]) => {
          mocks.filters(...args);
          return query;
        },
        neq: () => query,
        or: () => query,
        maybeSingle: () =>
          name === 'profiles'
            ? Promise.resolve({ data: null, error: null })
            : mocks.query('origin'),
        then: (resolve: any, reject: any) => mocks.query('siblings').then(resolve, reject),
      };
      return query;
    },
  },
}));
function Location() {
  return (
    <output data-testid="location">
      {useLocation().pathname}
      {useLocation().search}
    </output>
  );
}
let generation = 0;
async function showCard() {
  render(
    <MemoryRouter initialEntries={['/clubs/home']}>
      <TournamentRankingHost />
      <Location />
    </MemoryRouter>
  );
  await act(async () =>
    publishSessionSummary({
      resultOnly: true,
      duration: 0,
      handsPlayed: 0,
      handsWon: 0,
      totalRebuys: 0,
      profitLoss: 0,
      biggestPot: 0,
      peakStack: 0,
      tournament: {
        userId: 'hero',
        tournamentId: 'finished-spin',
        finishSequence: String(++generation),
        isSpin: true,
        finishPlace: 3,
        entrants: 3,
        prize: 0,
        bountyWinnings: 0,
        knockouts: 0,
        rebuys: 0,
        addOns: 0,
      },
    })
  );
  await screen.findByRole('dialog', { name: /tournament ranking/i });
}
beforeAll(async () => {
  await import('../../src/components/tournament/TournamentRankingCard');
  await import('../../src/utils/tournamentPresentation');
});
beforeEach(() => {
  mocks.query.mockImplementation(async (kind) => ({
    data:
      kind === 'origin'
        ? {
            format_contract: 'spin-v1',
            club_id: 'home',
            buy_in_amount: 100,
            game_type: 'plo4',
            max_players: 3,
          }
        : [{ format_contract: 'spin-v1', id: 'next-spin', current_players: 1, max_players: 3 }],
    error: null,
  }));
  mocks.resolve.mockResolvedValue('next-table');
});
afterEach(() => {
  act(() => {
    for (let i = 0; i < 6; i++) clearSessionSummary();
  });
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('Spin result Play Again', () => {
  it('opens the same-club, same-stake Spin without purchasing a seat and deduplicates taps', async () => {
    await showCard();
    await act(async () => {
      const button = screen.getByRole('button', { name: /play again/i });
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/table/next-table')
    );
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('next-spin');
    expect(mocks.filters).toHaveBeenCalledWith('club_id', 'home');
    expect(mocks.filters).toHaveBeenCalledWith('buy_in_amount', 100);
    expect(mocks.filters).toHaveBeenCalledWith('game_type', 'plo4');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('does not navigate a dismissed report when a slow lookup eventually returns', async () => {
    await showCard();
    let complete!: (value: unknown) => void;
    mocks.resolve.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /play again/i }));
    });
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await act(async () => {
      complete('next-table');
    });
    expect(screen.getByTestId('location').textContent).toBe('/clubs/home');
  });
  it.each(['origin', 'siblings', 'table'])(
    'takes a usable fallback if the %s read never settles',
    async (stage) => {
      await showCard();
      const normalQuery = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation((kind) =>
        kind === stage ? new Promise(() => {}) : normalQuery(kind)
      );
      if (stage === 'table') mocks.resolve.mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /play again/i }));
      });
      await act(async () => {
        await vi.dynamicImportSettled();
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByTestId('location').textContent).toBe('/tournaments?type=spin');
      expect(screen.queryByRole('dialog')).toBeNull();
    }
  );
});
