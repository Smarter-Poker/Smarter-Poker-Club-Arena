import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SEARCH, SORT AND THE DRILL OUT OF THE CLUB LIST.
 *
 * The list is paged, so a search that runs in the browser searches the fifty
 * rows that happen to be loaded out of two hundred - and looks like it works.
 * These tests pin that every filter and every ordering is a QUESTION PUT TO
 * THE SERVER, and that the two of them survive Load More.
 *
 * The drill has a failure mode that is invisible until a club owner tries it:
 * 'agent' is not among the scopes an owner is offered, because an owner holds
 * no downline of their own. Opening an agent from the club list puts them in
 * that scope legitimately, and the guard that keeps operators out of scopes
 * they do not hold would otherwise fire on the next render and bounce them
 * straight back out of the row they just opened.
 */

const CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const USER_ID = '2b1b6a4e-3a5c-4f9f-9c07-9d1f2a7c5e11';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: rpcMock, from: vi.fn() },
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: () => {},
}));

import RakeSnapshotPanel from '../../src/components/club/RakeSnapshotPanel';

function agentRow(n: number, canDrill = true) {
  return {
    agent_user_id: `agent-${n}`,
    name: `Agent ${n}`,
    avatar_url: null,
    role: 'agent',
    commission_rate: 0.45,
    direct_players: 4,
    direct_active: 2,
    direct_rake: 100 - n,
    direct_hands: 50,
    network_players: 4,
    network_rake: 100 - n,
    sub_agents: 1,
    commission_earned: 10 + n,
    commission_outstanding: 0,
    commission_settled: 10 + n,
    can_drill: canDrill,
    is_unassigned: false,
  };
}

function downlineRow(n: number) {
  return {
    player_id: `player-${n}`,
    name: `Player ${n}`,
    role: 'member',
    depth: 1,
    upline_user_id: 'agent-1',
    upline_name: 'Agent 1',
    rake: 10 * n,
    hands: 5,
    last_hand_at: null,
    downline_players: 0,
    downline_rake: 0,
  };
}

function clubSnapshot(
  rows: unknown[],
  count: number,
  applied: { search?: string | null; sort?: string } = {}
) {
  return {
    scope: 'club',
    scope_label: 'Deep Stack Society',
    club_id: CLUB_ID,
    union_id: null,
    range: { start: '2026-09-01', end: '2026-09-03', days: 3 },
    previous_range: { start: '2026-08-29', end: '2026-08-31', days: 3 },
    summary: {
      games: 12,
      total_winnings: 100,
      mtt_winnings: 0,
      cash_fee: 900,
      mtt_fee: 0,
      fee: 900,
      hands: 500,
    },
    previous: { fee: 800 },
    delta: { fee_pct: 1, games_pct: null, fee_abs: 1, winnings_abs: 1 },
    series: [],
    series_bucket: 'day',
    breakdown: rows,
    breakdown_kind: 'agent',
    breakdown_total: 900,
    commission_total: 100,
    breakdown_count: count,
    breakdown_offset: 0,
    breakdown_live: false,
    rake_complete_through: null,
    applied_search: applied.search ?? null,
    applied_sort: applied.sort ?? 'rake',
    generated_at: '2026-09-03T04:00:00Z',
  };
}

function downlineSnapshot(rows: unknown[]) {
  return {
    ...clubSnapshot([], 0),
    scope: 'agent',
    scope_label: 'Deep Stack Society',
    breakdown: rows,
    breakdown_kind: 'downline',
    breakdown_count: rows.length,
    breakdown_live: true,
  };
}

/** Every ca_rake_snapshot call, in order, with only what these tests care about. */
function asked() {
  return rpcMock.mock.calls
    .filter(([fn]) => fn === 'ca_rake_snapshot')
    .map(
      ([, a]) =>
        a as {
          p_search?: string | null;
          p_sort?: string;
          p_offset?: number;
          p_scope?: string;
          p_agent_user_id?: string | null;
        }
    );
}

beforeEach(() => {
  rpcMock.mockReset();
  sessionStorage.clear();
  vi.useRealTimers();
});
afterEach(() => cleanup());

describe('rake snapshot search and sort', () => {
  it('asks the SERVER to search, and does not filter what it already has', async () => {
    rpcMock.mockImplementation((fn: string, a: { p_search?: string | null }) => {
      if (fn !== 'ca_rake_snapshot') return Promise.resolve({ data: null, error: null });
      const rows = a?.p_search ? [agentRow(2)] : [agentRow(1), agentRow(2), agentRow(3)];
      return Promise.resolve({
        data: clubSnapshot(rows, a?.p_search ? 1 : 3, { search: a?.p_search ?? null }),
        error: null,
      });
    });

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByText('Agent 1');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Agent 2' } });

    // The row it does not match must LEAVE, and it must leave because the
    // server said so. If the panel filtered locally, Agent 1 would vanish
    // without any request carrying the term - which is the version of this
    // that silently searches one page of many.
    await waitFor(() => expect(screen.queryByText('Agent 1')).not.toBeInTheDocument());
    expect(asked().some((a) => a.p_search === 'Agent 2')).toBe(true);
    expect(screen.getByText('Agent 2')).toBeInTheDocument();
  });

  it('counts the matches while the shares stay against the whole club', async () => {
    rpcMock.mockImplementation((fn: string, a: { p_search?: string | null }) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({
            data: clubSnapshot(
              a?.p_search ? [agentRow(2)] : [agentRow(1), agentRow(2), agentRow(3)],
              a?.p_search ? 1 : 3,
              { search: a?.p_search ?? null }
            ),
            error: null,
          })
        : Promise.resolve({ data: null, error: null })
    );

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByText('Agent 1');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Agent 2' } });

    await screen.findByText(/1 Matching Row/i);
    // The denominator is unchanged, so the note under the table still reports
    // the club's figure rather than the matched row's.
    expect(screen.getByText(/Sums To 900/i)).toBeInTheDocument();
  });

  it('carries the search and the sort into Load More', async () => {
    rpcMock.mockImplementation((fn: string, a: { p_offset?: number }) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({
            data: clubSnapshot(
              (a?.p_offset ?? 0) === 0 ? [agentRow(1), agentRow(2)] : [agentRow(3)],
              3,
              { search: 'Agent', sort: 'cost' }
            ),
            error: null,
          })
        : Promise.resolve({ data: null, error: null })
    );

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByText('Agent 1');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cost' } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Agent' } });
    await waitFor(() =>
      expect(asked().some((a) => a.p_search === 'Agent' && a.p_sort === 'cost')).toBe(true)
    );

    (await screen.findByRole('button', { name: /Load .* More/i })).click();

    // A second page fetched without the filter is a second page of a DIFFERENT
    // list, appended to the first as though it belonged.
    await waitFor(() => {
      const page2 = asked().filter((a) => (a.p_offset ?? 0) > 0);
      expect(page2.length).toBeGreaterThan(0);
      for (const a of page2) {
        expect(a.p_search).toBe('Agent');
        expect(a.p_sort).toBe('cost');
      }
    });
  });

  it('says so when nothing matches, and leaves a way back', async () => {
    rpcMock.mockImplementation((fn: string, a: { p_search?: string | null }) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({
            data: clubSnapshot(a?.p_search ? [] : [agentRow(1)], a?.p_search ? 0 : 1, {
              search: a?.p_search ?? null,
            }),
            error: null,
          })
        : Promise.resolve({ data: null, error: null })
    );

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByText('Agent 1');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzz' } });

    // An empty list that also hides its own search box is a dead end.
    await screen.findByText(/Nothing In This List Matches/i);
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    screen.getByRole('button', { name: /^Clear$/i }).click();
    await screen.findByText('Agent 1');
  });
});

describe('rake snapshot drill out of the club list', () => {
  it('opens only the rows the server says will open', async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({
            data: clubSnapshot([agentRow(1, true), agentRow(2, false)], 2),
            error: null,
          })
        : Promise.resolve({ data: null, error: null })
    );

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByText('Agent 1');

    // Offering a door to everyone and handling the refusal afterwards is the
    // version that ships an error toast per click.
    expect(screen.getByRole('button', { name: /Agent 1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Agent 2/ })).not.toBeInTheDocument();
    expect(screen.getByText('Agent 2')).toBeInTheDocument();
  });

  it('stays in the downline it opened, even though the owner holds no downline', async () => {
    rpcMock.mockImplementation((fn: string, a: { p_scope?: string }) => {
      if (fn !== 'ca_rake_snapshot') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({
        data:
          a?.p_scope === 'agent'
            ? downlineSnapshot([downlineRow(1), downlineRow(2)])
            : clubSnapshot([agentRow(1)], 1),
        error: null,
      });
    });

    // 'club' ONLY - exactly what a club owner is offered, and the condition
    // under which the scope guard used to bounce the drill back.
    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByRole('button', { name: /Agent 1/ });

    act(() => screen.getByRole('button', { name: /Agent 1/ }).click());

    await screen.findByText('Player 1');
    const agentCalls = asked().filter((a) => a.p_scope === 'agent');
    expect(agentCalls.length).toBeGreaterThan(0);
    expect(agentCalls[0].p_agent_user_id).toBe('agent-1');
    // And it STAYS. A bounce would re-read club scope on the next render.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText('Player 1')).toBeInTheDocument();
  });

  it('offers a way back to the list it came from, not to a book the owner lacks', async () => {
    rpcMock.mockImplementation((fn: string, a: { p_scope?: string }) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({
            data:
              a?.p_scope === 'agent'
                ? downlineSnapshot([downlineRow(1)])
                : clubSnapshot([agentRow(1)], 1),
            error: null,
          })
        : Promise.resolve({ data: null, error: null })
    );

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    const row = await screen.findByRole('button', { name: /Agent 1/ });
    act(() => row.click());
    await screen.findByText('Player 1');

    // "My Downline" would be both wrong and a dead end here.
    const back = await screen.findByRole('button', { name: /Back To Club/i });
    act(() => back.click());
    await screen.findByText('Agent 1');

    // Landing back on the club list is not enough on its own. Dropping only
    // the trail leaves the scope on 'agent' with nobody in focus; the guard
    // that keeps an operator out of scopes they do not hold then rescues it a
    // render later, so the screen looks right. In between, the panel asks for
    // "my downline" - and an owner has not got one, so the real answer is a
    // refusal that flashes up under them. This mutation survived a test that
    // only checked where it landed.
    for (const c of asked().filter((x) => x.p_scope === 'agent')) {
      expect(c.p_agent_user_id, 'asked for a downline with nobody in focus').not.toBeNull();
    }
  });

  it('does not carry an agent-name search into a list of player names', async () => {
    rpcMock.mockImplementation((fn: string, a: { p_scope?: string; p_search?: string | null }) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({
            data:
              a?.p_scope === 'agent'
                ? downlineSnapshot([downlineRow(1)])
                : clubSnapshot([agentRow(1)], 1, { search: a?.p_search ?? null }),
            error: null,
          })
        : Promise.resolve({ data: null, error: null })
    );

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByRole('button', { name: /Agent 1/ });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Agent' } });
    await waitFor(() => expect(asked().some((a) => a.p_search === 'Agent')).toBe(true));

    act(() => screen.getByRole('button', { name: /Agent 1/ }).click());
    await screen.findByText('Player 1');

    // It was matching AGENT names. Carried in it filters PLAYER names, and
    // hides most of the book the operator just asked to see.
    for (const a of asked().filter((c) => c.p_scope === 'agent')) {
      expect(a.p_search ?? null).toBeNull();
    }
  });
});
