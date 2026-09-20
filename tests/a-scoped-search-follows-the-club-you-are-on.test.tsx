/**
 * The admin Player Search kept searching the club you LEFT.
 *
 * PlayerSearch scopes its query with `club_members!inner(club_id).eq(clubId)`.
 * That scoping exists because of a real incident, recorded in the component
 * itself: `clubId` was a declared prop that the query referenced nowhere, so a
 * staff member sitting on one club's Players tab searched every profile on the
 * platform - all 1,022 of them, email included.
 *
 * The scoping was then put back into a `useCallback` whose dependency array is
 * `[query, searchType]`. `clubId` is missing from it, and a useCallback with an
 * incomplete array does not merely skip a re-render: it keeps handing back the
 * FIRST closure it ever built, so the `clubId` the query reads is frozen at
 * whatever the component mounted with.
 *
 * That is not a theoretical mount. The component's only consumer is
 * AgentManagementPage, which renders `<PlayerSearch clubId={clubId} />` with no
 * React `key` and takes `clubId` from `useParams`. React Router swaps a route
 * param on the SAME component instance - /clubA/agents -> /clubB/agents does
 * not remount anything - so the page showed club B while the search ran club
 * A's query. The fix for the 1,022-profile leak simply stopped applying on the
 * second club an admin visited.
 *
 * The stale QUERY is only half of it. `results` is state, and state survives a
 * route-param swap too, so club A's usernames, emails and balances stayed
 * rendered on club B's Players tab until someone typed a new search. A stale
 * result list is the same disclosure as a stale query, one navigation later.
 *
 * These tests drive the swap the way React Router does: one render, one
 * instance, a changed prop.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlayerSearch } from '../src/components/admin/PlayerSearch';

/** Recorded PostgREST filters and the rows each club would really return. */
const db = vi.hoisted(() => ({
  eqCalls: [] as Array<{ column: string; value: unknown }>,
  membersByClub: {} as Record<string, Array<{ id: string; username: string; email: string }>>,
}));

/**
 * A PostgREST-shaped stub that answers `profiles` with the members of whichever
 * club the query scoped itself to - so "which club did this search ask for" is
 * observable both in `db.eqCalls` and in what lands on screen.
 */
vi.mock('../src/lib/supabase', () => {
  const build = (table: string) => {
    let scopedClub: string | null = null;
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ['select', 'limit', 'ilike', 'in', 'order', 'or', 'not', 'filter']) {
      builder[method] = vi.fn(chain);
    }
    builder.eq = vi.fn((column: string, value: unknown) => {
      db.eqCalls.push({ column, value });
      if (column === 'club_members.club_id') scopedClub = String(value);
      return builder;
    });
    builder.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) => {
      const rows =
        table === 'profiles'
          ? (db.membersByClub[scopedClub ?? ''] ?? []).map((p) => ({
              ...p,
              avatar_url: null,
              status: 'active',
              created_at: '2026-01-01T00:00:00.000Z',
              last_active: '2026-01-02T00:00:00.000Z',
            }))
          : [];
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    };
    return builder;
  };
  return { supabase: { from: vi.fn((table: string) => build(table)) } };
});

const clubScopeOf = (call: { column: string; value: unknown }) =>
  call.column === 'club_members.club_id';

const clickSearch = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(document.querySelector('button.search-btn') as HTMLButtonElement);

/**
 * Types the term and searches.
 *
 * The SECOND search in the tests below deliberately does not retype anything.
 * `query` is in the dependency array, so touching the box is enough to rebuild
 * the callback and quietly capture a fresh `clubId` - which would make a
 * broken component look fixed. Changing the club and nothing else is exactly
 * the navigation being tested.
 */
async function searchFor(user: ReturnType<typeof userEvent.setup>, term: string) {
  await user.type(screen.getByPlaceholderText(/Search By username/i), term);
  await clickSearch(user);
}

beforeEach(() => {
  db.eqCalls.length = 0;
  // Both clubs have a member matching the same term, so one search string
  // serves both navigations and `query` never has to change.
  db.membersByClub = {
    'club-a': [{ id: 'p-a1', username: 'aces_only', email: 'aces@clubA.example' }],
    'club-b': [{ id: 'p-b1', username: 'alpha_bravo', email: 'alpha@clubB.example' }],
  };
});

describe('a scoped search follows the club you are on', () => {
  it('scopes the first search to the club it was mounted with', async () => {
    const user = userEvent.setup();
    render(<PlayerSearch clubId="club-a" />);

    await searchFor(user, 'a');

    await waitFor(() => expect(screen.getByText('aces_only')).toBeInTheDocument());
    expect(db.eqCalls.filter(clubScopeOf).map((c) => c.value)).toEqual(['club-a']);
  });

  it('scopes the next search to the club the route now points at', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PlayerSearch clubId="club-a" />);

    await searchFor(user, 'a');
    await waitFor(() => expect(screen.getByText('aces_only')).toBeInTheDocument());

    // Exactly what React Router does to this component: same instance, no
    // remount, a different `clubId` prop. No `key` is passed at the only call
    // site, so there is nothing to force one.
    rerender(<PlayerSearch clubId="club-b" />);

    // Same search term, same search type - the ONLY thing that changed is the
    // club, so the memoized callback is reused verbatim.
    await clickSearch(user);

    await waitFor(() => expect(screen.getByText('alpha_bravo')).toBeInTheDocument());
    // The second search must ask the database for club B. Before the fix it
    // asked for club-a a second time, and club B's Players tab listed club A.
    expect(db.eqCalls.filter(clubScopeOf).map((c) => c.value)).toEqual(['club-a', 'club-b']);
    expect(screen.queryByText('aces_only')).not.toBeInTheDocument();
  });

  it('does not leave the previous club members on screen after the route changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PlayerSearch clubId="club-a" />);

    await searchFor(user, 'a');
    await waitFor(() => expect(screen.getByText('aces@clubA.example')).toBeInTheDocument());

    rerender(<PlayerSearch clubId="club-b" />);

    // Nothing has been searched in club B yet, so club B's tab must show
    // nothing - not club A's roster with its email column.
    await waitFor(() => {
      expect(screen.queryByText('aces_only')).not.toBeInTheDocument();
      expect(screen.queryByText('aces@clubA.example')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Search For Players To Manage')).toBeInTheDocument();
  });

  it('still refuses to search at all when no club is in the route', async () => {
    const user = userEvent.setup();
    render(<PlayerSearch />);

    await searchFor(user, 'a');

    await waitFor(() =>
      expect(screen.getByText('No Club Selected. Open This From A Club.')).toBeInTheDocument()
    );
    expect(db.eqCalls.filter(clubScopeOf)).toHaveLength(0);
  });
});
