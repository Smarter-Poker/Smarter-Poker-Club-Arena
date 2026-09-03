import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PANEL ON A UNION, WITH NO CLUB UNDERNEATH IT.
 *
 * Until Phase 7 the panel refused to read without a club - `if (!clubId)
 * return;` - so the union scope could only be reached by walking into a member
 * club, and the union was DERIVED from whichever club that happened to be. A
 * union lead who owns no club had no door; one who owns two got whichever club
 * they picked.
 *
 * These tests pin the union being handed over directly, and the club row that
 * opens out of it.
 */

const UNION_ID = 'fade0000-0000-0000-0000-000000000001';
const CLUB_A = 'a0000000-0000-0000-0000-000000000001';
const USER_ID = '2b1b6a4e-3a5c-4f9f-9c07-9d1f2a7c5e11';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: rpcMock, from: vi.fn() } }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: () => {},
}));

import RakeSnapshotPanel from '../../src/components/club/RakeSnapshotPanel';

function clubRow(id: string, name: string, canDrill = true) {
  return {
    club_id: id,
    name,
    code: name.slice(0, 3).toUpperCase(),
    avatar_url: null,
    fee: 1000,
    cash_fee: 900,
    mtt_fee: 100,
    winnings: 50,
    hands: 500,
    games: 12,
    can_drill: canDrill,
  };
}

function agentRow(n: number) {
  return {
    agent_user_id: `agent-${n}`,
    name: `Agent ${n}`,
    avatar_url: null,
    role: 'agent',
    commission_rate: null,
    direct_players: 4,
    direct_active: 2,
    direct_rake: 100,
    direct_hands: 50,
    network_players: 4,
    network_rake: 100,
    sub_agents: 0,
    // An overseer reads production, not cost: every commission cell is null.
    commission_earned: null,
    commission_outstanding: null,
    commission_settled: null,
    can_drill: false,
    is_unassigned: false,
  };
}

function payload(kind: 'club' | 'agent', rows: unknown[]) {
  return {
    scope: kind === 'club' ? 'union' : 'club',
    scope_label: kind === 'club' ? 'Diamond Union' : 'SHARK CLUB',
    club_id: kind === 'club' ? null : CLUB_A,
    union_id: UNION_ID,
    club_count: 2,
    range: { start: '2026-09-01', end: '2026-09-03', days: 3 },
    previous_range: { start: '2026-08-29', end: '2026-08-31', days: 3 },
    summary: {
      games: 12, total_winnings: 100, mtt_winnings: 0,
      cash_fee: 2000, mtt_fee: 0, fee: 2000, hands: 900,
    },
    previous: { fee: 1800 },
    delta: { fee_pct: 11, games_pct: null, fee_abs: 200, winnings_abs: 5 },
    series: [],
    series_bucket: 'day',
    breakdown: rows,
    breakdown_kind: kind,
    breakdown_total: 2000,
    commission_total: null,
    breakdown_count: rows.length,
    breakdown_offset: 0,
    breakdown_live: kind === 'agent',
    rake_complete_through: null,
    applied_search: null,
    applied_sort: 'rake',
    generated_at: '2026-09-03T06:00:00Z',
  };
}

function asked() {
  return rpcMock.mock.calls
    .filter(([fn]) => fn === 'ca_rake_snapshot')
    .map(([, a]) => a as {
      p_scope?: string; p_club_id?: string | null; p_union_id?: string | null;
      p_search?: string | null;
    });
}

beforeEach(() => {
  rpcMock.mockReset();
  sessionStorage.clear();
});
afterEach(() => cleanup());

describe('the rake snapshot on a union', () => {
  it('reads the union when there is no club at all', async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({ data: payload('club', [clubRow(CLUB_A, 'SHARK CLUB')]), error: null })
        : Promise.resolve({ data: null, error: null })
    );

    render(
      <RakeSnapshotPanel clubId={null} unionId={UNION_ID} userId={USER_ID} scopes={['union']} />
    );

    // The old guard was `if (!clubId) return;` - the panel would simply never
    // have asked, and this is the whole reason a union page could not exist.
    await screen.findByText('SHARK CLUB');
    const calls = asked();
    expect(calls.length, 'the panel never read anything').toBeGreaterThan(0);
    expect(calls[0].p_union_id, 'the union was not passed down').toBe(UNION_ID);
    expect(calls[0].p_club_id, 'a union page must not invent a club').toBeNull();
    expect(calls[0].p_scope).toBe('union');
  });

  it('opens only the member clubs the server says will open', async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({
            data: payload('club', [
              clubRow(CLUB_A, 'SHARK CLUB', true),
              clubRow('b0000000-0000-0000-0000-000000000002', 'Club JAQK', false),
            ]),
            error: null,
          })
        : Promise.resolve({ data: null, error: null })
    );

    render(
      <RakeSnapshotPanel clubId={null} unionId={UNION_ID} userId={USER_ID} scopes={['union']} />
    );
    // Waited on by ROLE, not by text: the club name also appears in the
    // panel's own subject line, so a text match finds more than one node.
    expect(await screen.findByRole('button', { name: /SHARK CLUB/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Club JAQK/ })).not.toBeInTheDocument();
    expect(screen.getByText('Club JAQK')).toBeInTheDocument();
  });

  it('stays in the club it opened, though the viewer holds no club scope', async () => {
    rpcMock.mockImplementation((fn: string, a: { p_scope?: string }) => {
      if (fn !== 'ca_rake_snapshot') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({
        data: a?.p_scope === 'club'
          ? payload('agent', [agentRow(1)])
          : payload('club', [clubRow(CLUB_A, 'SHARK CLUB')]),
        error: null,
      });
    });

    // scopes is UNION alone - exactly what a union lead who owns no club is
    // offered, and the condition under which the scope guard would otherwise
    // bounce the drill straight back out.
    render(
      <RakeSnapshotPanel clubId={null} unionId={UNION_ID} userId={USER_ID} scopes={['union']} />
    );
    const row = await screen.findByRole('button', { name: /SHARK CLUB/ });
    act(() => row.click());

    await screen.findByText('Agent 1');
    const clubCalls = asked().filter((c) => c.p_scope === 'club');
    expect(clubCalls.length).toBeGreaterThan(0);
    expect(clubCalls[0].p_club_id, 'the drill asked for no particular club').toBe(CLUB_A);

    // And it STAYS. A bounce would re-read union scope on the next render.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText('Agent 1')).toBeInTheDocument();
  });

  it('offers a way back to the union it came from', async () => {
    rpcMock.mockImplementation((fn: string, a: { p_scope?: string }) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({
            data: a?.p_scope === 'club'
              ? payload('agent', [agentRow(1)])
              : payload('club', [clubRow(CLUB_A, 'SHARK CLUB')]),
            error: null,
          })
        : Promise.resolve({ data: null, error: null })
    );

    render(
      <RakeSnapshotPanel clubId={null} unionId={UNION_ID} userId={USER_ID} scopes={['union']} />
    );
    const row = await screen.findByRole('button', { name: /SHARK CLUB/ });
    act(() => row.click());
    await screen.findByText('Agent 1');

    const back = await screen.findByRole('button', { name: /Back To Union/i });
    act(() => back.click());
    await screen.findByRole('button', { name: /SHARK CLUB/ });
  });

  it('does not carry a club-name search into a list of agent names', async () => {
    rpcMock.mockImplementation((fn: string, a: { p_scope?: string; p_search?: string | null }) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({
            data: a?.p_scope === 'club'
              ? payload('agent', [agentRow(1)])
              : payload('club', [clubRow(CLUB_A, 'SHARK CLUB')]),
            error: null,
          })
        : Promise.resolve({ data: null, error: null })
    );

    render(
      <RakeSnapshotPanel clubId={null} unionId={UNION_ID} userId={USER_ID} scopes={['union']} />
    );
    await screen.findByRole('button', { name: /SHARK CLUB/ });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'SHARK' } });
    await waitFor(() => expect(asked().some((c) => c.p_search === 'SHARK')).toBe(true));

    act(() => screen.getByRole('button', { name: /SHARK CLUB/ }).click());
    await screen.findByText('Agent 1');

    // It was matching CLUB names. Carried in it filters AGENT names, and hides
    // most of the list the operator just asked to see.
    for (const c of asked().filter((x) => x.p_scope === 'club')) {
      expect(c.p_search ?? null).toBeNull();
    }
  });

  it('steps back one level of the chain, not all of it', async () => {
    // union -> a club inside it -> an agent inside that. Backing out once must
    // land on the CLUB, still open, not collapse to the union.
    //
    // This is the bug the mutation hunt found. Clearing the club on any scope
    // but 'club' threw it away the moment an agent was opened, so backing out
    // asked for club scope with NO CLUB - which the database rejects outright
    // with "club scope needs a club". The one-level tests could not see it.
    rpcMock.mockImplementation((fn: string, a: { p_scope?: string }) => {
      if (fn !== 'ca_rake_snapshot') return Promise.resolve({ data: null, error: null });
      if (a?.p_scope === 'agent') {
        return Promise.resolve({
          data: {
            ...payload('agent', []),
            scope: 'agent',
            breakdown_kind: 'downline',
            breakdown: [
              {
                player_id: 'p1', name: 'Player One', role: 'member', depth: 1,
                upline_user_id: 'agent-1', upline_name: 'Agent 1',
                rake: 10, hands: 5, last_hand_at: null,
                downline_players: 0, downline_rake: 0,
              },
            ],
          },
          error: null,
        });
      }
      return Promise.resolve({
        data: a?.p_scope === 'club'
          ? payload('agent', [{ ...agentRow(1), can_drill: true }])
          : payload('club', [clubRow(CLUB_A, 'SHARK CLUB')]),
        error: null,
      });
    });

    render(
      <RakeSnapshotPanel clubId={null} unionId={UNION_ID} userId={USER_ID} scopes={['union']} />
    );

    const clubRowBtn = await screen.findByRole('button', { name: /SHARK CLUB/ });
    act(() => clubRowBtn.click());
    await screen.findByRole('button', { name: /Agent 1/ });
    act(() => screen.getByRole('button', { name: /Agent 1/ }).click());
    await screen.findByText('Player One');

    // One step back lands on the club, and the club is still named.
    const back = await screen.findByRole('button', { name: /Back To SHARK CLUB/i });
    act(() => back.click());
    await screen.findByRole('button', { name: /Agent 1/ });

    // Every club-scope read named a club. A read with none is the failure.
    for (const c of asked().filter((x) => x.p_scope === 'club')) {
      expect(c.p_club_id, 'asked for a club scope with no club').toBe(CLUB_A);
    }

    // A second step back reaches the union.
    //
    // Asserted on the LAST request rather than on a button, because the crumb
    // above the agent list is itself labelled with the club name - so looking
    // for a button matching /SHARK CLUB/ found the breadcrumb and passed while
    // the panel had not moved at all.
    const toUnion = await screen.findByRole('button', { name: /Back To Union/i });
    act(() => toUnion.click());
    await screen.findByRole('heading', { name: /Rake By Club/i });
    await waitFor(() => {
      const calls = asked();
      expect(calls[calls.length - 1].p_scope, 'the panel never went back to the union').toBe(
        'union'
      );
    });
  });

  it('returns to the union even when the viewer also holds the club chip', async () => {
    // The previous test could not see a broken back-out, because with only the
    // Union chip available the scope guard quietly rescues any scope the
    // viewer does not hold - so leaveDrill could do nothing at all and the
    // panel still landed on the union a render later.
    //
    // Give the viewer BOTH chips and that safety net is gone: a back-out that
    // fails to set the scope leaves the panel in club scope with no club, and
    // the database answers "club scope needs a club".
    rpcMock.mockImplementation((fn: string, a: { p_scope?: string }) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({
            data: a?.p_scope === 'club'
              ? payload('agent', [agentRow(1)])
              : payload('club', [clubRow(CLUB_A, 'SHARK CLUB')]),
            error: null,
          })
        : Promise.resolve({ data: null, error: null })
    );

    render(
      <RakeSnapshotPanel
        clubId={null}
        unionId={UNION_ID}
        userId={USER_ID}
        scopes={['union', 'club']}
      />
    );

    const row = await screen.findByRole('button', { name: /SHARK CLUB/ });
    act(() => row.click());
    await screen.findByText('Agent 1');

    const back = await screen.findByRole('button', { name: /Back To Union/i });
    act(() => back.click());
    await screen.findByRole('heading', { name: /Rake By Club/i });

    await waitFor(() => {
      const calls = asked();
      expect(calls[calls.length - 1].p_scope, 'the panel did not return to the union').toBe(
        'union'
      );
    });
    // And it never asked for a club scope without naming a club.
    for (const c of asked().filter((x) => x.p_scope === 'club')) {
      expect(c.p_club_id, 'club scope with no club is rejected by the database').toBe(CLUB_A);
    }
  });
});
