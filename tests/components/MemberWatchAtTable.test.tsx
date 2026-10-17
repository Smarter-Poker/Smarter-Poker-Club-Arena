/**
 * WATCH AT TABLE ON THE PLAYER RECORD (Dan 2026-10-16)
 *
 * "WHEN YOU ARE INSIDE OF PLAYER MANAGEMENT, AND THE PLAYER IS 'AT A TABLE'
 * THERE SHOULD BE A BUTTON TO EASILY CLICK TO BE REDIRECTED AND WATCH THEM."
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toast }));

import MemberWatchAtTable from '../../src/components/club/MemberWatchAtTable';
import { PlayerSearchService } from '../../src/services/PlayerSearchService';

function Where() {
  const location = useLocation();
  return <span aria-label="current route">{`${location.pathname}${location.search}`}</span>;
}

function renderRecord(seated: boolean) {
  return render(
    <MemoryRouter initialEntries={['/record']}>
      <Routes>
        <Route
          path="/record"
          element={
            <MemberWatchAtTable
              clubUuid="club-1"
              memberUserId="player-1"
              seated={seated}
              fallback={<p>Record Caption</p>}
            />
          }
        />
        <Route path="/table/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Player Record: Watch At Table', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    toast.error.mockReset();
  });

  it('asks for nothing and shows the caption while the player is not seated', () => {
    const live = vi.spyOn(PlayerSearchService, 'getMemberLiveTable');
    renderRecord(false);
    expect(screen.getByText('Record Caption')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(live).not.toHaveBeenCalled();
  });

  it('offers Watch At Table for the seated player and opens the observer view', async () => {
    const user = userEvent.setup();
    vi.spyOn(PlayerSearchService, 'getMemberLiveTable').mockResolvedValue({
      table_id: 'table-9',
      name: 'midnight cash',
      stakes: '$1/$2',
      is_tournament: false,
    });
    const access = vi.spyOn(PlayerSearchService, 'getTableWatchAccess').mockResolvedValue({
      found: true,
      table_id: 'table-9',
      can_watch: true,
      action: 'watch',
    });
    renderRecord(true);

    const button = await screen.findByRole('button', { name: 'Watch At Table, Midnight Cash' });
    expect(screen.queryByText('Record Caption')).not.toBeInTheDocument();
    expect(PlayerSearchService.getMemberLiveTable).toHaveBeenCalledWith('player-1', 'club-1');

    await user.click(button);

    expect(access).toHaveBeenCalledWith('table-9', 'player-1');
    await waitFor(() =>
      expect(screen.getByLabelText('current route')).toHaveTextContent('/table/table-9?observer=1')
    );
  });

  it('keeps the caption when no live table can be read', async () => {
    vi.spyOn(PlayerSearchService, 'getMemberLiveTable').mockResolvedValue(null);
    renderRecord(true);
    await waitFor(() => expect(PlayerSearchService.getMemberLiveTable).toHaveBeenCalled());
    expect(screen.getByText('Record Caption')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not route when the player has already left the table', async () => {
    const user = userEvent.setup();
    vi.spyOn(PlayerSearchService, 'getMemberLiveTable').mockResolvedValue({
      table_id: 'table-9',
      name: 'midnight cash',
      stakes: '',
      is_tournament: false,
    });
    vi.spyOn(PlayerSearchService, 'getTableWatchAccess').mockResolvedValue({
      found: false,
      can_watch: false,
      action: 'unavailable',
    });
    renderRecord(true);

    await user.click(await screen.findByRole('button', { name: /Watch At Table/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This Player Has Left The Table.')
    );
    expect(screen.queryByLabelText('current route')).not.toBeInTheDocument();
    expect(screen.getByText('Record Caption')).toBeInTheDocument();
  });

  it('is wired into the Player Record from the record presence', () => {
    const page = readFileSync(
      resolve(__dirname, '../../src/pages/MemberManagementPage.tsx'),
      'utf8'
    );
    expect(page).toContain('<MemberWatchAtTable');
    expect(page).toContain('seated={detail!.presence.is_seated}');
  });
});
