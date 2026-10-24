import React from 'react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import TournamentRankingHost from '../../src/components/tournament/TournamentRankingHost';
import { reportRemovedTournamentSeats } from '../../src/services/tournamentSeatExitReport';
import { clearSessionSummary, peekSessionSummary } from '../../src/services/pendingSessionSummary';

beforeAll(async () => {
  await import('../../src/components/tournament/TournamentRankingCard');
});

const mocks = vi.hoisted(() => ({ read: vi.fn(), rows: [] as any[] }));
vi.mock('../../src/services/tournamentResult', () => ({ fetchTournamentResult: mocks.read }));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => ({ userId: 'hero' }) }));
vi.mock('../../src/lib/supabase', () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    maybeSingle: async () => ({ data: null, error: null }),
    in: async () => ({ data: mocks.rows, error: null }),
  };
  return { supabase: { from: () => b } };
});
const row = {
  id: 'old-table',
  tournament_id: 'nightly',
  name: 'Nightly',
  club_id: 'club',
  union_id: null,
  arena: { id: 'club', asset: 'chips', is_platform: false, union_id: null },
};
const result = {
  tournamentId: 'nightly',
  name: 'Nightly',
  entryStatus: 'eliminated',
  finishPlace: 353,
  entrants: 375,
  prize: 0,
  bountyWinnings: 0,
  knockouts: 0,
  rebuys: 1,
  addOns: 1,
  buyInAmount: 35,
};
function Navigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/clubs/club/lobby')}>Land In Lobby</button>;
}
afterEach(() => {
  act(() => {
    for (let i = 0; i < 6; i++) clearSessionSummary();
  });
  vi.clearAllMocks();
});

describe('closed tournament seats deliver their reports before prune', () => {
  it.each(['mtt', 'spin', 'sng'])(
    'delivers a durable %s finish through the real host and lobby navigation',
    async (format) => {
      mocks.rows = [row];
      mocks.read.mockResolvedValue({ ...result, isSpin: format === 'spin' });
      render(
        <MemoryRouter initialEntries={['/tables']}>
          <Navigation />
          <TournamentRankingHost />
        </MemoryRouter>
      );
      let retained: Set<string>;
      await act(async () => {
        retained = await reportRemovedTournamentSeats(['old-table'], 'hero', () => true);
      });
      expect(retained!.size).toBe(0);
      const card = await screen.findByRole('dialog', { name: /tournament ranking/i });
      expect(card.textContent).toContain('353');
      expect(card.textContent).toContain('Buy-In: 35');
      expect(card.textContent).toContain('1 Rebuy');
      expect(card.textContent).toContain('1 Add-On');
      // /tables was an intermediate route. Landing must not acknowledge the card.
      fireEvent.click(screen.getByText('Land In Lobby'));
      expect(screen.getByRole('dialog', { name: /tournament ranking/i })).toBeTruthy();
    }
  );
  it('does not report a balancer move or a rebought entrant as a finish', async () => {
    mocks.rows = [row];
    mocks.read.mockResolvedValue({ ...result, entryStatus: 'playing', finishPlace: null });
    expect(
      (await reportRemovedTournamentSeats(['old-table'], 'hero', () => true, new Set(['nightly'])))
        .size
    ).toBe(0);
    expect(peekSessionSummary()).toBeNull();
  });
  it('keeps a Spin tab alive when seat release precedes the elimination commit', async () => {
    mocks.rows = [row];
    mocks.read.mockResolvedValue({ ...result, entryStatus: 'playing', finishPlace: null });
    expect([...(await reportRemovedTournamentSeats(['old-table'], 'hero', () => true))]).toEqual([
      'old-table',
    ]);
    expect(peekSessionSummary()).toBeNull();
    // The same explicit seat reconciliation can finish once its commit lands.
    mocks.read.mockResolvedValue({ ...result, isSpin: true, finishPlace: 3, entrants: 3 });
    render(
      <MemoryRouter>
        <TournamentRankingHost />
      </MemoryRouter>
    );
    await act(async () => {
      expect((await reportRemovedTournamentSeats(['old-table'], 'hero', () => true)).size).toBe(0);
    });
    const card = await screen.findByRole('dialog', { name: /tournament ranking/i });
    expect(card.textContent).toContain('3rd');
    expect(screen.getByRole('button', { name: /play again/i })).toBeTruthy();
  });
  it('retains an omitted table rather than treating an unreadable row as a cash exit', async () => {
    mocks.rows = [];
    expect([...(await reportRemovedTournamentSeats(['old-table'], 'hero', () => true))]).toEqual([
      'old-table',
    ]);
    expect(peekSessionSummary()).toBeNull();
  });
  it('retains the table when the finish is unreadable instead of silently pruning it', async () => {
    mocks.rows = [row];
    mocks.read.mockResolvedValue({ ...result, entryStatus: undefined, finishPlace: null });
    expect([...(await reportRemovedTournamentSeats(['old-table'], 'hero', () => true))]).toEqual([
      'old-table',
    ]);
    expect(peekSessionSummary()).toBeNull();
  });
  it("abandons a stale account or rebuild response without publishing another person's report", async () => {
    mocks.rows = [row];
    mocks.read.mockResolvedValue(result);
    await reportRemovedTournamentSeats(['old-table'], 'hero', () => false);
    expect(peekSessionSummary()).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
