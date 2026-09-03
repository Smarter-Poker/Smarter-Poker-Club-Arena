import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FindPlayerModal from '../../src/components/modals/FindPlayerModal';
import {
  FUZZY_MIN_CHARS,
  PlayerSearchService,
  type PlayerSearchPage,
  type PlayerSearchResult,
} from '../../src/services/PlayerSearchService';

/**
 * A player who is in two clubs the viewer can see (one joined, one gated), one
 * union, and two private clubs the viewer is not entitled to have named — and who
 * is sitting in one cash game the viewer may observe plus one tournament in a club
 * the viewer must apply to.
 */
const locatedPlayer: PlayerSearchResult = {
  id: 'player-1',
  username: 'sharkplayer',
  display_name: 'Shark Player',
  avatar_url: null,
  relationship: 'public',
  presence_status: 'playing',
  match_score: 0.62,
  sensitive_accounts: [],
  affiliations: {
    clubs: [
      {
        club_uuid: 'club-uuid-1',
        club_id: 48291,
        club_slug: 'midnight-club',
        club_name: 'Midnight Club',
        role: 'member',
        is_gated: false,
        viewer_membership_status: 'active',
        viewer_action: 'member',
      },
      {
        club_uuid: 'club-uuid-2',
        club_id: 55110,
        club_slug: 'ivory-room',
        club_name: 'Ivory Room',
        role: 'member',
        is_gated: true,
        viewer_membership_status: null,
        viewer_action: 'request_join',
      },
    ],
    unions: [{ union_id: 'union-1', union_name: 'Midway Union', union_code: '900' }],
    has_hidden: true,
  },
  // `id` mirrors `table_id` because the RPC builds the object with
  // 'id', live.table_id -- the fixture must not drift from the server shape.
  tables: [
    {
      id: 'live-table-1',
      table_id: 'live-table-1',
      name: 'Midnight Cash',
      game_variant: 'NLH',
      stakes: '$1/$2',
      club_uuid: 'club-uuid-1',
      club_id: 48291,
      club_slug: 'midnight-club',
      club_name: 'Midnight Club',
      is_tournament: false,
      can_watch: true,
      access_action: 'watch',
    },
    {
      id: 'live-table-2',
      table_id: 'live-table-2',
      tournament_id: 'tourney-1',
      name: 'Ivory Nightly',
      game_variant: 'MTT',
      stakes: '$50 Buy-In',
      club_uuid: 'club-uuid-2',
      club_id: 55110,
      club_slug: 'ivory-room',
      club_name: 'Ivory Room',
      is_tournament: true,
      can_watch: false,
      access_action: 'request_join',
    },
  ],
};

function page(items: PlayerSearchResult[]): PlayerSearchPage {
  return { items, total: items.length, hasMore: false, offset: 0, limit: 20, fuzzy: true };
}

/** Exposes the router's current location so navigation can be asserted. */
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current route">{`${location.pathname}${location.search}`}</output>;
}

function renderLocator() {
  const onClose = vi.fn();
  const onMembershipRequired = vi.fn();
  const view = render(
    <MemoryRouter>
      <FindPlayerModal isOpen onClose={onClose} onMembershipRequired={onMembershipRequired} />
      <LocationProbe />
    </MemoryRouter>
  );
  return { ...view, onClose, onMembershipRequired };
}

/** Type a query and run the explicit search, then wait for results to land. */
async function search(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('searchbox'), 'shark');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('Midnight Cash');
}

/**
 * Club names appear both as affiliation chips and inside the live-game cards, so
 * affiliation assertions are scoped to the affiliations region to stay unambiguous.
 */
function affiliations() {
  return within(screen.getByRole('region', { name: /Clubs And Unions/ }));
}

/** Same, but waits for the panel to arrive when there is no game card to await. */
async function affiliationsAsync() {
  return within(await screen.findByRole('region', { name: /Clubs And Unions/ }));
}

describe('Find A Player locator', () => {
  beforeEach(() => {
    vi.spyOn(PlayerSearchService, 'search').mockResolvedValue(page([locatedPlayer]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fuzzy matching threshold', () => {
    it('does not query for suggestions before the third character', async () => {
      const user = userEvent.setup();
      renderLocator();

      await user.type(screen.getByRole('searchbox'), 'sh');

      // Long enough for the debounce to have fired if it were going to.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(PlayerSearchService.search).not.toHaveBeenCalled();
    });

    it(`queries for suggestions as soon as ${FUZZY_MIN_CHARS} characters are typed`, async () => {
      const user = userEvent.setup();
      renderLocator();

      await user.type(screen.getByRole('searchbox'), 'sha');

      await waitFor(() => expect(PlayerSearchService.search).toHaveBeenCalled());
      expect(vi.mocked(PlayerSearchService.search).mock.calls[0][0]).toMatchObject({
        query: 'sha',
      });
    });
  });

  describe('clubs and unions', () => {
    it('names the clubs and unions the player belongs to', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      expect(affiliations().getByText('Midnight Club')).toBeInTheDocument();
      expect(affiliations().getByText('Ivory Room')).toBeInTheDocument();
      expect(affiliations().getByText('Midway Union')).toBeInTheDocument();
    });

    it('admits private clubs are withheld without saying how many', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      const note = screen.getByText(/Private Clubs Not Shown/);
      expect(note).toBeInTheDocument();
      // A count is a membership-existence oracle: two viewers can subtract.
      expect(note.textContent).not.toMatch(/\d/);
    });

    it('says nothing about private clubs when none were withheld', async () => {
      const user = userEvent.setup();
      vi.mocked(PlayerSearchService.search).mockResolvedValue(
        page([
          { ...locatedPlayer, affiliations: { ...locatedPlayer.affiliations, has_hidden: false } },
        ])
      );
      renderLocator();
      await search(user);

      expect(screen.queryByText(/Private Clubs Not Shown/)).not.toBeInTheDocument();
    });

    it('renders a player who has affiliations but no live games', async () => {
      const user = userEvent.setup();
      vi.mocked(PlayerSearchService.search).mockResolvedValue(
        page([{ ...locatedPlayer, presence_status: 'offline', tables: [] }])
      );
      renderLocator();
      await user.type(screen.getByRole('searchbox'), 'shark');
      await user.click(screen.getByRole('button', { name: 'Search' }));

      expect(await affiliationsAsync()).toBeTruthy();
      expect(screen.getByText('Offline')).toBeInTheDocument();
      expect(screen.queryByText('Cash Game')).not.toBeInTheDocument();
    });

    it('routes a gated club chip into the join flow with no table to return to', async () => {
      const user = userEvent.setup();
      const { onMembershipRequired } = renderLocator();
      await search(user);

      await user.click(affiliations().getByRole('button', { name: 'Ivory Room Apply To Join' }));

      expect(onMembershipRequired).toHaveBeenCalledWith({
        code: 'ivory-room',
        watchTableId: null,
      });
    });

    it('does not offer a join action for a club the viewer already belongs to', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      expect(
        affiliations().queryByRole('button', { name: /Midnight Club/ })
      ).not.toBeInTheDocument();
      expect(affiliations().getByText('Your Club')).toBeInTheDocument();
    });
  });

  describe('live games', () => {
    it('distinguishes a cash game from a tournament', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      expect(screen.getByText('Cash Game')).toBeInTheDocument();
      expect(screen.getByText('Tournament')).toBeInTheDocument();
      expect(screen.getByText('Playing Now - 1 Cash Game And 1 Tournament')).toBeInTheDocument();
    });

    it('offers to observe a table in a club the viewer belongs to', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      expect(screen.getByText('Observe Table')).toBeInTheDocument();
    });

    it('tells a non-member to apply and wait for approval, without hiding the game', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      expect(screen.getByText('Ivory Nightly')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Members Only - Ivory Room Is Gated. Apply To Join And Wait For Approval Before You Can Observe.'
        )
      ).toBeInTheDocument();
    });

    it('returns you to your own seat instead of seating you as a spectator', async () => {
      const user = userEvent.setup();
      // can_watch is true for a table you are SITTING at, and every can_watch
      // used to route through observer=1 -- so opening your own live game put
      // you on your own hand as a spectator.
      vi.spyOn(PlayerSearchService, 'getTableWatchAccess').mockResolvedValue({
        found: true,
        table_id: 'live-table-1',
        club_uuid: 'club-uuid-1',
        club_id: 48291,
        club_slug: 'midnight-club',
        can_watch: true,
        action: 'play',
      });
      renderLocator();
      await search(user);

      await user.click(screen.getByRole('button', { name: /Midnight Cash/ }));

      await waitFor(() =>
        expect(screen.getByLabelText('current route')).toHaveTextContent('/table/live-table-1')
      );
      expect(screen.getByLabelText('current route').textContent).not.toContain('observer');
    });

    it('still opens a watchable table in observer mode', async () => {
      const user = userEvent.setup();
      vi.spyOn(PlayerSearchService, 'getTableWatchAccess').mockResolvedValue({
        found: true,
        table_id: 'live-table-1',
        club_uuid: 'club-uuid-1',
        club_id: 48291,
        club_slug: 'midnight-club',
        can_watch: true,
        action: 'watch',
      });
      renderLocator();
      await search(user);

      await user.click(screen.getByRole('button', { name: /Midnight Cash/ }));

      await waitFor(() =>
        expect(screen.getByLabelText('current route')).toHaveTextContent(
          '/table/live-table-1?observer=1'
        )
      );
    });

    it('labels a seat you occupy as a return, not an observation', async () => {
      const user = userEvent.setup();
      vi.mocked(PlayerSearchService.search).mockResolvedValue(
        page([
          {
            ...locatedPlayer,
            tables: [{ ...locatedPlayer.tables[0], can_watch: true, access_action: 'play' }],
          },
        ])
      );
      renderLocator();
      await search(user);

      expect(screen.getByText('Return To Seat')).toBeInTheDocument();
      expect(screen.queryByText('Observe Table')).not.toBeInTheDocument();
    });

    it('revalidates access at click time and hands a non-member to the join flow', async () => {
      const user = userEvent.setup();
      vi.spyOn(PlayerSearchService, 'getTableWatchAccess').mockResolvedValue({
        found: true,
        table_id: 'live-table-2',
        club_uuid: 'club-uuid-2',
        club_id: 55110,
        club_slug: 'ivory-room',
        can_watch: false,
        action: 'request_join',
      });
      const { onMembershipRequired } = renderLocator();
      await search(user);

      await user.click(screen.getByRole('button', { name: /Ivory Nightly/ }));

      await waitFor(() =>
        expect(onMembershipRequired).toHaveBeenCalledWith({
          code: 'ivory-room',
          watchTableId: 'live-table-2',
        })
      );
    });
  });

  describe('close affordance', () => {
    it('ignores a click on the backdrop', async () => {
      const user = userEvent.setup();
      const { container, onClose } = renderLocator();

      await user.click(container.firstChild as HTMLElement);

      expect(onClose).not.toHaveBeenCalled();
    });

    it('has no corner dismiss control', () => {
      renderLocator();

      expect(screen.queryByRole('button', { name: /^(×|✕|x|close)$/i })).not.toBeInTheDocument();
    });

    it('closes from the quiet exit at the bottom', async () => {
      const user = userEvent.setup();
      const { onClose } = renderLocator();

      await user.click(screen.getByRole('button', { name: 'Close The Player Locator' }));

      expect(onClose).toHaveBeenCalled();
    });

    it('keeps Escape working so keyboard users are never trapped', async () => {
      const user = userEvent.setup();
      const { onClose } = renderLocator();

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalled();
    });

    it('reopens with no stale suggestion list, so the first Escape still closes', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const onMembershipRequired = vi.fn();
      // HomePage keeps this mounted and toggles isOpen, so state must survive a
      // close/reopen cycle without leaking an empty listbox or eating an Escape.
      const { rerender } = render(
        <MemoryRouter>
          <FindPlayerModal isOpen onClose={onClose} onMembershipRequired={onMembershipRequired} />
        </MemoryRouter>
      );

      await user.type(screen.getByRole('searchbox'), 'sha');
      await screen.findByRole('listbox');
      await user.click(screen.getByRole('button', { name: 'Close The Player Locator' }));

      const reopen = (open: boolean) =>
        rerender(
          <MemoryRouter>
            <FindPlayerModal
              isOpen={open}
              onClose={onClose}
              onMembershipRequired={onMembershipRequired}
            />
          </MemoryRouter>
        );
      reopen(false);
      reopen(true);

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      onClose.mockClear();
      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalled();
    });

    it('spends the first Escape on the suggestion list, not the whole locator', async () => {
      const user = userEvent.setup();
      const { onClose } = renderLocator();

      await user.type(screen.getByRole('searchbox'), 'sha');
      await screen.findByRole('listbox');

      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('still renders a result whose affiliations are missing entirely', async () => {
    const user = userEvent.setup();
    const legacy = { ...locatedPlayer, affiliations: undefined } as unknown as PlayerSearchResult;
    vi.mocked(PlayerSearchService.search).mockResolvedValue(page([legacy]));
    renderLocator();
    await search(user);

    expect(screen.getByText('Midnight Cash')).toBeInTheDocument();
  });
});
