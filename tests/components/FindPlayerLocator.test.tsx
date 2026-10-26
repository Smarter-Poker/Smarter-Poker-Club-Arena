import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FindPlayerModal from '../../src/components/modals/FindPlayerModal';
import {
  FUZZY_MIN_CHARS,
  QUERY_MAX_CHARS,
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
  display_name: 'shark player',
  avatar_url: null,
  relationship: 'public',
  presence_status: 'playing',
  match_score: 0.62,
  sensitive_accounts: [
    {
      club_uuid: 'managed-club-1',
      club_name: 'deep stack society',
      role: 'sub_agent',
      access: 'downline',
      wallets: { chip_balance: 0, player_wallet: 0, agent_wallet: 0, promo_wallet: 0 },
      downline: { downline_direct: 0, downline_total: 0 },
      stats: null,
    },
  ],
  affiliations: {
    clubs: [
      {
        club_uuid: 'club-uuid-1',
        club_id: 48291,
        club_slug: 'midnight-club',
        club_name: 'midnight club',
        role: 'member',
        is_gated: false,
        viewer_membership_status: 'active',
        viewer_action: 'member',
      },
      {
        club_uuid: 'club-uuid-2',
        club_id: 55110,
        club_slug: 'ivory-room',
        club_name: 'ivory room',
        role: 'member',
        is_gated: true,
        viewer_membership_status: null,
        viewer_action: 'request_join',
      },
    ],
    unions: [{ union_id: 'union-1', union_name: 'midway union', union_code: '900' }],
    has_hidden: true,
  },
  tables: [
    {
      id: 'seat-1',
      table_id: 'live-table-1',
      name: 'midnight cash',
      game_variant: 'nlh',
      stakes: '$1/$2',
      club_uuid: 'club-uuid-1',
      club_id: 48291,
      club_slug: 'midnight-club',
      club_name: 'midnight club',
      is_tournament: false,
      can_watch: true,
      access_action: 'watch',
    },
    {
      id: 'seat-2',
      table_id: 'live-table-2',
      tournament_id: 'tourney-1',
      name: 'ivory nightly',
      game_variant: 'mtt',
      stakes: '$50 buy-in',
      club_uuid: 'club-uuid-2',
      club_id: 55110,
      club_slug: 'ivory-room',
      club_name: 'ivory room',
      is_tournament: true,
      can_watch: false,
      access_action: 'request_join',
    },
  ],
};

function page(items: PlayerSearchResult[]): PlayerSearchPage {
  return { items, total: items.length, hasMore: false, offset: 0, limit: 20, fuzzy: true };
}

function renderLocator() {
  const onClose = vi.fn();
  const onMembershipRequired = vi.fn();
  const view = render(
    <MemoryRouter>
      <FindPlayerModal isOpen onClose={onClose} onMembershipRequired={onMembershipRequired} />
    </MemoryRouter>
  );
  return { ...view, onClose, onMembershipRequired };
}

/** Type a query and run the explicit search, then wait for results to land. */
async function search(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('searchbox'), 'shark');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByRole('button', { name: /Midnight Cash/ });
}

/**
 * Club names appear both as affiliation chips and inside the live-game cards, so
 * affiliation assertions are scoped to the affiliations region to stay unambiguous.
 */
function affiliations() {
  return within(screen.getByRole('region', { name: /Clubs And Unions/ }));
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

  describe('a pasted paragraph never breaks the search (2026-10-25)', () => {
    // Dan's searches all failed with "Could Not Search Right Now" because a long
    // pasted message was sitting in the field; the server refuses anything over
    // 64 characters. The field now holds at most 64 and the request never carries more.
    const paragraph =
      'VERIFY YOUR WORK AND CODE AND RUN THE TESTS BEFORE YOU SAY IT IS DONE '.repeat(12);

    it(`caps the field at ${QUERY_MAX_CHARS} characters`, () => {
      renderLocator();
      expect(screen.getByRole('searchbox')).toHaveAttribute('maxLength', String(QUERY_MAX_CHARS));
    });

    it('searches with at most the limit when a long value lands in the field', async () => {
      const user = userEvent.setup();
      renderLocator();
      const box = screen.getByRole('searchbox');
      await user.click(box);
      await user.paste(paragraph);
      expect((box as HTMLInputElement).value.length).toBeLessThanOrEqual(QUERY_MAX_CHARS);
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await waitFor(() => expect(PlayerSearchService.search).toHaveBeenCalled());
      for (const [call] of vi.mocked(PlayerSearchService.search).mock.calls) {
        expect(call.query.length).toBeLessThanOrEqual(QUERY_MAX_CHARS);
      }
      expect(screen.queryByText(/Could Not Search Right Now/i)).not.toBeInTheDocument();
    });
  });

  describe('the result area always answers the words in the field (2026-10-25)', () => {
    it('drops an earlier empty answer as soon as a new name is typed', async () => {
      vi.mocked(PlayerSearchService.search).mockImplementation(async (options) =>
        page(options.query === 'nobody' ? [] : [locatedPlayer])
      );
      const user = userEvent.setup();
      renderLocator();
      const box = screen.getByRole('searchbox');
      await user.type(box, 'nobody');
      await user.click(screen.getByRole('button', { name: 'Search' }));
      expect(await screen.findByText('No Matching Players Were Found.')).toBeInTheDocument();

      await user.clear(box);
      await user.type(box, '333');
      expect(screen.queryByText('No Matching Players Were Found.')).not.toBeInTheDocument();
    });

    it('does not reopen the suggestion list over the results the player asked for', async () => {
      const user = userEvent.setup();
      renderLocator();
      await user.type(screen.getByRole('searchbox'), 'shark');
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await screen.findByRole('button', { name: /Midnight Cash/ });
      // Long enough for a stranded debounce to have fired if it were still armed.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  describe('clubs and unions', () => {
    it('names the clubs and unions the player belongs to', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      // One quiet line for the clubs and unions. Ivory Room's join action already
      // rides on its live game's Watch At Table shell, so it is not offered twice.
      expect(
        affiliations().getByText('Midnight Club / Ivory Room / Midway Union / Private Clubs')
      ).toBeInTheDocument();
      expect(affiliations().queryByRole('button')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Apply To Join, Ivory Nightly' })
      ).toBeInTheDocument();
      expect(screen.getByText('Shark Player')).toBeInTheDocument();
    });

    it('drops the text nobody needs (Dan 2026-10-16)', async () => {
      const user = userEvent.setup();
      renderLocator();
      expect(screen.queryByText('Network Locator')).not.toBeInTheDocument();
      expect(screen.queryByText('Live')).not.toBeInTheDocument();
      expect(screen.queryByText('Enter A Name Or Player Number.')).not.toBeInTheDocument();
      await search(user);

      expect(screen.queryByText('Public')).not.toBeInTheDocument();
      expect(screen.queryByText('Clubs')).not.toBeInTheDocument();
      expect(screen.queryByText('Unions')).not.toBeInTheDocument();
      expect(screen.queryByText('Your Club')).not.toBeInTheDocument();
      expect(screen.queryByText(/Playing Now - /)).not.toBeInTheDocument();
      expect(screen.getByText('Playing')).toBeInTheDocument();
    });

    it('prints the handle only when it differs from the name', async () => {
      const user = userEvent.setup();
      vi.mocked(PlayerSearchService.search).mockResolvedValue(
        page([{ ...locatedPlayer, username: 'dinodollars', display_name: 'Dinodollars' }])
      );
      renderLocator();
      await search(user);
      expect(screen.queryByText('@Dinodollars')).not.toBeInTheDocument();
    });

    it('signals private clubs without naming or counting them', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      expect(affiliations().getByText(/Private Clubs$/)).toBeInTheDocument();
    });

    it('routes a gated club chip into the join flow with no table to return to', async () => {
      const user = userEvent.setup();
      // No live game in Ivory Room, so its join action is a word of its own.
      vi.mocked(PlayerSearchService.search).mockResolvedValue(
        page([{ ...locatedPlayer, tables: [locatedPlayer.tables[0]] }])
      );
      const { onMembershipRequired } = renderLocator();
      await search(user);

      await user.click(affiliations().getByRole('button', { name: 'Apply To Join Ivory Room' }));

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
    });
  });

  describe('live games', () => {
    it('distinguishes a cash game from a tournament in the socket', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      expect(screen.getByText('Cash')).toBeInTheDocument();
      expect(screen.getByText('MTT')).toBeInTheDocument();
      expect(screen.getByText('Midnight Cash · 1/2')).toBeInTheDocument();
    });

    it('offers a Watch At Table button for a table in a club the viewer belongs to', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      expect(
        screen.getByRole('button', { name: 'Watch At Table, Midnight Cash' })
      ).toBeInTheDocument();
    });

    it('opens the observer view from Watch At Table after revalidating access', async () => {
      const user = userEvent.setup();
      vi.spyOn(PlayerSearchService, 'getTableWatchAccess').mockResolvedValue({
        found: true,
        table_id: 'live-table-1',
        club_uuid: 'club-uuid-1',
        can_watch: true,
        action: 'watch',
      });
      const { onClose } = renderLocator();
      await search(user);

      await user.click(screen.getByRole('button', { name: 'Watch At Table, Midnight Cash' }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(PlayerSearchService.getTableWatchAccess).toHaveBeenCalledWith(
        'live-table-1',
        'player-1'
      );
    });

    it('tells a non-member to apply first, without hiding the game', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      expect(
        screen.getByRole('button', { name: 'Apply To Join, Ivory Nightly' })
      ).toBeInTheDocument();
      expect(screen.getByText('Ivory Nightly · Ivory Room')).toBeInTheDocument();
    });

    it('does not reopen a join flow after the locator was dismissed during access verification', async () => {
      const user = userEvent.setup();
      let resolve!: (
        value: Awaited<ReturnType<typeof PlayerSearchService.getTableWatchAccess>>
      ) => void;
      vi.spyOn(PlayerSearchService, 'getTableWatchAccess').mockReturnValue(
        new Promise((done) => {
          resolve = done;
        })
      );
      const { onClose, onMembershipRequired } = renderLocator();
      await search(user);
      await user.click(screen.getByRole('button', { name: /Ivory Nightly/ }));
      await user.click(screen.getByRole('button', { name: 'Close' }));
      await act(async () =>
        resolve({
          found: true,
          table_id: 'live-table-2',
          club_uuid: 'club-uuid-2',
          club_id: 55110,
          club_slug: 'ivory-room',
          can_watch: false,
          action: 'request_join',
        })
      );
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onMembershipRequired).not.toHaveBeenCalled();
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
      expect(PlayerSearchService.getTableWatchAccess).toHaveBeenCalledWith(
        'live-table-2',
        'player-1'
      );
    });
  });

  describe('dynamic Title Case', () => {
    it('capitalizes authorized account labels returned by the server', async () => {
      const user = userEvent.setup();
      renderLocator();
      await search(user);

      await user.click(screen.getByRole('button', { name: 'Account Data' }));

      expect(screen.getByText('Deep Stack Society')).toBeInTheDocument();
      expect(screen.getByText('Downline / Sub Agent')).toBeInTheDocument();
    });
  });

  describe('close affordance', () => {
    it('ignores a click on the backdrop', async () => {
      const user = userEvent.setup();
      const { container, onClose } = renderLocator();

      await user.click(container.firstChild as HTMLElement);

      expect(onClose).not.toHaveBeenCalled();
    });

    it('has the corner X every popup carries (Dan 2026-09-23)', async () => {
      /* This pinned the OPPOSITE until 2026-09-23 - "no corner dismiss
         control", the quiet exit at the bottom being the only way out. Dan:
         "FOR THE BBJ, TABLE SETTINGS OR ANYTHING ELSE THAT POPS UP, THERE
         SHOULD ALWAYS BE AN 'X' IN THE TOP RIGHT CORNER TO 'CLOSE THE PAGE'.
         YOU SHOULD NEVER HAVE TO GO TO THE BOTTOM OF THE PAGE TO CLOSE IT."
         The console prints it; the quiet exit below stays. */
      const user = userEvent.setup();
      const { onClose } = renderLocator();

      const corner = screen.getByRole('button', { name: 'Close' });
      expect(corner.className).toContain('sc__close');
      await user.click(corner);

      expect(onClose).toHaveBeenCalled();
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

    expect(screen.getByRole('button', { name: /Midnight Cash/ })).toBeInTheDocument();
  });
});
