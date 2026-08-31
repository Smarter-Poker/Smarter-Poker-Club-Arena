import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../src/components/common/Toast';
import FindPlayerModal from '../../src/components/modals/FindPlayerModal';
import JoinClubModal from '../../src/components/modals/JoinClubModal';
import { ClubJoinService } from '../../src/services/ClubJoinService';
import {
  PlayerSearchService,
  type PlayerSearchResult,
} from '../../src/services/PlayerSearchService';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current route">{`${location.pathname}${location.search}`}</output>;
}

function JoinWatchHarness() {
  const navigate = useNavigate();
  return (
    <JoinClubModal
      isOpen
      initialCode="48291"
      onClose={() => undefined}
      onSuccess={() => navigate('/table/live-table-1?observer=1')}
    />
  );
}

const locatedPlayer: PlayerSearchResult = {
  id: 'player-1',
  username: 'sharkplayer',
  display_name: 'Shark Player',
  avatar_url: null,
  relationship: 'public',
  presence_status: 'playing',
  sensitive_accounts: [],
  tables: [
    {
      id: 'seat-1',
      table_id: 'live-table-1',
      name: 'Midnight Cash',
      game_variant: 'NLH',
      stakes: '1 / 2',
      club_uuid: 'club-uuid-1',
      club_id: 48291,
      club_slug: 'midnight-club',
      club_name: 'Midnight Club',
      can_watch: true,
      access_action: 'watch',
    },
  ],
};

describe('Club Entry live-watch handoff', () => {
  beforeEach(() => {
    vi.spyOn(ClubJoinService, 'resumePending').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the intended observer route after an immediate club join', async () => {
    const user = userEvent.setup();
    vi.spyOn(ClubJoinService, 'preview').mockResolvedValue({
      found: true,
      id: 'club-uuid-1',
      club_id: 48291,
      slug: 'midnight-club',
      name: 'Midnight Club',
      member_count: 42,
      requires_approval: false,
      membership_status: null,
    });
    vi.spyOn(ClubJoinService, 'join').mockResolvedValue({
      success: true,
      status: 'active',
      club: {
        id: 'club-uuid-1',
        club_id: 48291,
        slug: 'midnight-club',
        name: 'Midnight Club',
      },
    });

    render(
      <MemoryRouter>
        <ToastProvider>
          <JoinWatchHarness />
          <LocationProbe />
        </ToastProvider>
      </MemoryRouter>
    );

    await user.click(await screen.findByRole('button', { name: 'Confirm Join Midnight Club' }));

    await waitFor(() =>
      expect(screen.getByLabelText('current route')).toHaveTextContent(
        '/table/live-table-1?observer=1'
      )
    );
  });

  it('resumes the observer route when membership became active before confirmation', async () => {
    const user = userEvent.setup();
    const join = vi.spyOn(ClubJoinService, 'join');
    vi.spyOn(ClubJoinService, 'preview').mockResolvedValue({
      found: true,
      id: 'club-uuid-1',
      club_id: 48291,
      slug: 'midnight-club',
      name: 'Midnight Club',
      member_count: 42,
      requires_approval: false,
      membership_status: 'active',
    });

    render(
      <MemoryRouter>
        <ToastProvider>
          <JoinWatchHarness />
          <LocationProbe />
        </ToastProvider>
      </MemoryRouter>
    );

    await user.click(await screen.findByRole('button', { name: 'Enter Club' }));

    await waitFor(() =>
      expect(screen.getByLabelText('current route')).toHaveTextContent(
        '/table/live-table-1?observer=1'
      )
    );
    expect(join).not.toHaveBeenCalled();
  });

  it('revalidates stale search access and hands a non-member to Join Club', async () => {
    const user = userEvent.setup();
    const onMembershipRequired = vi.fn();
    vi.spyOn(PlayerSearchService, 'search').mockResolvedValue({
      items: [locatedPlayer],
      total: 1,
      hasMore: false,
      offset: 0,
      limit: 20,
    });
    vi.spyOn(PlayerSearchService, 'getTableWatchAccess').mockResolvedValue({
      found: true,
      table_id: 'live-table-1',
      club_uuid: 'club-uuid-1',
      club_id: 48291,
      club_slug: 'midnight-club',
      can_watch: false,
      action: 'request_join',
    });

    render(
      <MemoryRouter>
        <FindPlayerModal
          isOpen
          onClose={() => undefined}
          onMembershipRequired={onMembershipRequired}
        />
      </MemoryRouter>
    );

    await user.type(screen.getByRole('searchbox'), 'Shark');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: /Midnight Cash/ }));

    await waitFor(() =>
      expect(onMembershipRequired).toHaveBeenCalledWith({
        code: 'midnight-club',
        watchTableId: 'live-table-1',
      })
    );
    expect(PlayerSearchService.getTableWatchAccess).toHaveBeenCalledWith('live-table-1');
  });
});
