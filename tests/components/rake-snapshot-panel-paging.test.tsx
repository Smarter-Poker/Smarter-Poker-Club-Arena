import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PAGING, DEDUPING AND REFRESH IN THE RAKE SNAPSHOT PANEL.
 *
 * Both bugs this file pins were found by READING the code during review, not by
 * a test, and neither would have shown up in a screenshot. They are the two
 * ways paging and realtime break each other when added in the same change.
 *
 *   1. The cursor was rows.length - the DEDUPED count. Every duplicate dropped
 *      walked the server cursor backwards, so the next page re-read rows
 *      already on screen, dedupe dropped those too, and on a busy list Load
 *      More stopped advancing while still inviting another press.
 *
 *   2. Every background refresh re-read page one and replaced the list. With
 *      realtime wired to nine club events, an operator who had opened four
 *      pages watched them collapse whenever anyone played a hand.
 */

const CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const USER_ID = '2b1b6a4e-3a5c-4f9f-9c07-9d1f2a7c5e11';

const { rpcMock, bus } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  bus: { handler: null as ((payload: unknown) => void) | null },
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: rpcMock, from: vi.fn() },
}));

vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: (_events: string[], handler: (payload: unknown) => void) => {
    bus.handler = handler;
  },
}));

import RakeSnapshotPanel from '../../src/components/club/RakeSnapshotPanel';

/** One agent row, named so a page can be identified on screen. */
function agentRow(n: number) {
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
    sub_agents: 0,
    is_unassigned: false,
  };
}

function snapshotWith(rows: ReturnType<typeof agentRow>[], total: number, offset: number) {
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
    delta: { fee_pct: 12.5, games_pct: null, fee_abs: 100, winnings_abs: 10 },
    series: [],
    series_bucket: 'day',
    breakdown: rows,
    breakdown_kind: 'agent',
    breakdown_total: 900,
    breakdown_count: total,
    breakdown_offset: offset,
    breakdown_live: false,
    rake_complete_through: null,
    generated_at: '2026-09-03T04:00:00Z',
  };
}

/** Every offset the panel asked the database for, in order. */
function offsetsRequested(): number[] {
  return rpcMock.mock.calls
    .filter(([fn]) => fn === 'ca_rake_snapshot')
    .map(([, args]) => (args as { p_offset?: number }).p_offset ?? 0);
}

beforeEach(() => {
  rpcMock.mockReset();
  bus.handler = null;
  sessionStorage.clear();
});

afterEach(() => cleanup());

describe('rake snapshot paging', () => {
  it('pages from the server cursor, not from the deduped row count', async () => {
    // TWO presses, not one. The first press cannot exercise the cursor
    // arithmetic at all: load() already sets the cursor to the size of page
    // one, so a single Load More reads the right offset even when the
    // accumulation is broken. A mutation that froze the increment passed a
    // one-press version of this test, which is how the gap was found.
    //
    // Page two deliberately repeats a row from page one, which is what the
    // real window does when it moves while an operator is reading it.
    const pages: Record<number, ReturnType<typeof agentRow>[]> = {
      0: [agentRow(1), agentRow(2), agentRow(3)],
      3: [agentRow(3), agentRow(4), agentRow(5)],
      6: [agentRow(6), agentRow(7)],
    };

    rpcMock.mockImplementation((fn: string, args: { p_offset?: number }) => {
      if (fn !== 'ca_rake_snapshot') return Promise.resolve({ data: null, error: null });
      const offset = args?.p_offset ?? 0;
      return Promise.resolve({
        data: snapshotWith(pages[offset] ?? [], 8, offset),
        error: null,
      });
    });

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByText('Agent 1');
    expect(screen.getByText(/Showing 3 Of 8/i)).toBeInTheDocument();

    (await screen.findByRole('button', { name: /Load .* More/i })).click();
    await screen.findByText('Agent 5');
    // The duplicate is dropped from the LIST...
    expect(screen.getAllByText('Agent 3')).toHaveLength(1);

    (await screen.findByRole('button', { name: /Load .* More/i })).click();
    await screen.findByText('Agent 7');

    // ...but never from the CURSOR. Three rows were served, then three more,
    // so the third page is asked for at 6. Paging on the deduped count would
    // have asked for 5 - re-reading a row already shown, dropping it again,
    // and drifting further behind on every press until the list stalled with
    // Load More still on screen.
    expect(offsetsRequested()).toEqual([0, 3, 6]);
    expect(screen.getByText(/Showing 7 Of 8/i)).toBeInTheDocument();
  });

  it('a background refresh does not collapse pages the operator opened', async () => {
    const pageOne = [agentRow(1), agentRow(2)];
    const pageTwo = [agentRow(3), agentRow(4)];

    rpcMock.mockImplementation((fn: string, args: { p_offset?: number }) => {
      if (fn !== 'ca_rake_snapshot') return Promise.resolve({ data: null, error: null });
      const offset = args?.p_offset ?? 0;
      return Promise.resolve({
        data: snapshotWith(offset === 0 ? pageOne : pageTwo, 4, offset),
        error: null,
      });
    });

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByText('Agent 1');
    (await screen.findByRole('button', { name: /Load .* More/i })).click();
    await screen.findByText('Agent 4');

    // A club event fires - somebody played a hand. This is the ordinary case
    // once realtime is wired, not an edge case.
    await act(async () => {
      bus.handler?.({ clubId: CLUB_ID });
    });

    // The expansion survives. Before the fix this re-read page one and the
    // rows below it disappeared under the operator.
    await waitFor(() => expect(screen.getByText('Agent 4')).toBeInTheDocument());
    expect(screen.getByText('Agent 1')).toBeInTheDocument();
  });

  it('says how many rows exist behind the page', async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({ data: snapshotWith([agentRow(1)], 207, 0), error: null })
        : Promise.resolve({ data: null, error: null })
    );

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByText('Agent 1');

    // The whole point: a list that stops early has to admit it.
    expect(screen.getByText(/Showing 1 Of 207/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load .* More/i })).toBeInTheDocument();
  });

  it('offers no Load More once the list is complete', async () => {
    rpcMock.mockImplementation((fn: string) =>
      fn === 'ca_rake_snapshot'
        ? Promise.resolve({ data: snapshotWith([agentRow(1), agentRow(2)], 2, 0), error: null })
        : Promise.resolve({ data: null, error: null })
    );

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByText('Agent 1');

    expect(screen.getByText(/Showing 2 Of 2/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load .* More/i })).toBeNull();
  });

  it('never claims fewer rows exist than are already on screen', async () => {
    // A later read can legitimately return a smaller count than the rows
    // already accumulated. "Showing 3 of 2" reads as a bug in the page rather
    // than movement in the world.
    const pageOne = [agentRow(1), agentRow(2)];
    rpcMock.mockImplementation((fn: string, args: { p_offset?: number }) => {
      if (fn !== 'ca_rake_snapshot') return Promise.resolve({ data: null, error: null });
      const offset = args?.p_offset ?? 0;
      return Promise.resolve({
        data: offset === 0 ? snapshotWith(pageOne, 4, 0) : snapshotWith([agentRow(3)], 1, offset),
        error: null,
      });
    });

    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);
    await screen.findByText('Agent 1');
    (await screen.findByRole('button', { name: /Load .* More/i })).click();
    await screen.findByText('Agent 3');

    expect(screen.getByText(/Showing 3 Of 3/i)).toBeInTheDocument();
  });
});
