import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const HAND_ID = '22222222-2222-4222-8222-222222222222';
const HAND_ID_TWO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAYER_ONE = '33333333-3333-4333-8333-333333333333';
const PLAYER_TWO = '44444444-4444-4444-8444-444444444444';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  tableResponse: vi.fn(),
  eq: vi.fn(),
  resolveClub: vi.fn(),
  downloadCsv: vi.fn(),
  toast: { info: vi.fn(), error: vi.fn() },
  reportError: vi.fn(),
  isMounted: { current: true },
}));

function range() {
  const endDate = new Date();
  const end = endDate.toISOString().slice(0, 10);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  return { start: startDate.toISOString().slice(0, 10), end };
}

function financialPayloadForRange(start: string, end: string) {
  const dayMs = 86_400_000;
  const days =
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / dayMs) + 1;
  const seriesDays = Math.min(days, 92);
  const seriesStart = new Date(Date.parse(`${end}T00:00:00Z`) - (seriesDays - 1) * dayMs)
    .toISOString()
    .slice(0, 10);
  const seriesStartMs = Date.parse(`${seriesStart}T00:00:00Z`);
  const totalHands = days * 10;
  const totalRake = days * 100;
  return {
    contract: 'ca_club_financials.v2',
    contract_version: 2,
    club_id: CLUB_ID,
    requested_start: start,
    requested_end: end,
    range: { start, end, days, first_day: start, series_from: seriesStart },
    union_id: null,
    totals: {
      raked_hands: totalHands,
      gross_rake: totalRake,
      bbj_drop: 0,
      net_rake: totalRake,
      pot_volume: days * 1_000,
      tournament_fees: 0,
      rakeback_paid: 0,
      rakeback_rows: 0,
      agent_commissions: 0,
      union_fee: 0,
      union_statements: 0,
      union_squareup: 0,
      net_revenue: totalRake,
    },
    daily: Array.from({ length: seriesDays }, (_, index) => ({
      d: new Date(seriesStartMs + index * dayMs).toISOString().slice(0, 10),
      raked_hands: 10,
      gross_rake: 100,
      bbj_drop: 0,
      pot_volume: 1_000,
      tournament_fees: 0,
      rakeback_paid: 0,
      agent_commissions: 0,
      union_fee: 0,
    })),
    by_table: [
      {
        table_id: '55555555-5555-4555-8555-555555555555',
        name: 'night owl',
        status: 'active',
        stakes: '10/20',
        variant: 'nlh',
        raked_hands: totalHands,
        rake: totalRake,
        players: 6,
        table_net: totalRake,
      },
    ],
    recent: [
      {
        id: 'rake-a',
        hand_id: HAND_ID,
        global_hand_id: 42,
        table_name: 'night owl',
        kind: 'cash_rake',
        rake_amount: 3,
        bbj_contribution: 1,
        pot_size: 1_000,
        num_players: 6,
        created_at: `${end}T12:00:00Z`,
      },
    ],
    data_updated_at: null,
    club_table_daily_updated_at: null,
    generated_at: new Date().toISOString(),
  };
}

function financialPayload() {
  const { start, end } = range();
  return financialPayloadForRange(start, end);
}

function handBreakdown(handId = HAND_ID) {
  return {
    found: true,
    hand_id: handId,
    rake_method: 'WEIGHTED_CONTRIBUTED',
    gross_pot: 1_000,
    regular_rake_collected: 3,
    bbj_drop_collected: 1,
    net_pot_paid_to_players: 996,
    total_eligible_contributions: 300,
    players: [
      {
        player_id: PLAYER_ONE,
        gross_contribution: 100,
        returned_uncalled: 0,
        eligible_contribution: 100,
        contribution_weight: 0.33333333,
        weighted_rake_credit: 1,
        bbj_attributed_contribution: 0.33,
      },
      {
        player_id: PLAYER_TWO,
        gross_contribution: 200,
        returned_uncalled: 0,
        eligible_contribution: 200,
        contribution_weight: 0.66666667,
        weighted_rake_credit: 2,
        bbj_attributed_contribution: 0.67,
      },
    ],
    reconciliation: {
      expected_regular_rake: 3,
      allocated_regular_rake: 3,
      difference: 0,
      valid: true,
    },
  };
}

vi.mock('../../src/lib/supabase', () => {
  class Query {
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq(column: string, value: unknown) {
      m.eq(this.table, column, value);
      return this;
    }
    not() {
      return this;
    }
    maybeSingle() {
      return Promise.resolve(m.tableResponse(this.table));
    }
  }
  return {
    supabase: {
      from: (table: string) => new Query(table),
      rpc: (...args: unknown[]) => m.rpc(...args),
    },
  };
});
vi.mock('../../src/hooks/useIsMounted', () => ({ useIsMounted: () => m.isMounted }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: (...args: unknown[]) => m.resolveClub(...args),
}));
vi.mock('../../src/utils/downloadCsv', () => ({
  downloadCsv: (...args: unknown[]) => m.downloadCsv(...args),
  toCsv: vi.fn(() => 'csv'),
}));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => m.reportError(...args),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => m.toast }));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    title,
    pill,
    plates,
    children,
  }: {
    title: string;
    pill?: string;
    plates?: {
      secondary?: { label: string; onClick?: () => void; disabled?: boolean };
      primary?: { label: string; onClick?: () => void; disabled?: boolean };
    };
    children: ReactNode;
  }) => (
    <section aria-label={title}>
      {pill && <span>{pill}</span>}
      {children}
      {plates?.secondary && (
        <button
          type="button"
          onClick={plates.secondary.onClick}
          disabled={plates.secondary.disabled}
        >
          {plates.secondary.label}
        </button>
      )}
      {plates?.primary && (
        <button type="button" onClick={plates.primary.onClick} disabled={plates.primary.disabled}>
          {plates.primary.label}
        </button>
      )}
    </section>
  ),
}));

import RakeReports, { parseHandBreakdownPayload } from '../../src/components/admin/RakeReports';

beforeEach(() => {
  vi.clearAllMocks();
  m.isMounted.current = true;
  m.resolveClub.mockResolvedValue(CLUB_ID);
  m.rpc.mockImplementation((name: string) =>
    Promise.resolve({
      data: name === 'ca_club_financials' ? financialPayload() : handBreakdown(),
      error: null,
    })
  );
});

afterEach(() => {
  m.isMounted.current = false;
  cleanup();
});

describe('Rake Reports console and truth boundary', () => {
  it('renders verified financial rows on approved painted consoles without decimals', async () => {
    render(<RakeReports clubId="shark-club" />);

    const summary = await screen.findByLabelText('Verified Rake Summary');
    expect(within(summary).getByText('700')).toBeInTheDocument();
    expect(within(summary).getByText('70')).toBeInTheDocument();
    const averageRow = within(summary).getByText('Average Rake Per Hand').closest('div');
    expect(averageRow?.querySelectorAll('dd')).toHaveLength(1);
    expect(averageRow?.querySelector('dd')).toHaveTextContent('10');
    expect(screen.getAllByText('Night Owl')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Export Daily CSV' })).toBeEnabled();
    expect(screen.queryByText('700.00')).toBeNull();
  });

  it('reuses the exact parent week snapshot and fetches fresh only on explicit refresh', async () => {
    const { start, end } = range();
    const snapshot = financialPayload();

    render(
      <RakeReports
        clubId="shark-club"
        initialSnapshot={{
          resolvedClubId: CLUB_ID,
          requestedStart: start,
          requestedEnd: end,
          financials: snapshot,
        }}
      />
    );

    expect(await screen.findByLabelText('Verified Rake Summary')).toBeInTheDocument();
    expect(m.resolveClub).not.toHaveBeenCalled();
    expect(m.rpc.mock.calls.filter(([name]) => name === 'ca_club_financials')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Report' }));
    await waitFor(() =>
      expect(m.rpc.mock.calls.filter(([name]) => name === 'ca_club_financials')).toHaveLength(1)
    );
    expect(m.resolveClub).toHaveBeenCalledWith('shark-club');
  });

  it('names the seven-point trend separately from month and year CSV coverage', async () => {
    m.rpc.mockImplementation(
      (name: string, args: { p_start?: string; p_end?: string } | undefined) =>
        Promise.resolve({
          data:
            name === 'ca_club_financials'
              ? financialPayloadForRange(args?.p_start as string, args?.p_end as string)
              : handBreakdown(),
          error: null,
        })
    );

    render(<RakeReports clubId="shark-club" />);
    await screen.findByRole('button', { name: /Night Owl, Hand 42/ });

    fireEvent.click(screen.getByRole('tab', { name: 'Thirty Days' }));
    expect(
      await screen.findByText(
        /The Trend Shows The Latest 7 Daily Points.*CSV Covers All 30 Returned Daily Points/
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'One Year' }));
    expect(
      await screen.findByText(
        /The Trend Shows The Latest 7 Daily Points.*CSV Covers All 92 Returned Daily Points/
      )
    ).toBeInTheDocument();
  });

  it('fails closed when the club financial payload is malformed', async () => {
    const malformed = financialPayload();
    (malformed.totals as Record<string, unknown>).gross_rake = '700';
    m.rpc.mockResolvedValue({ data: malformed, error: null });

    render(<RakeReports clubId="shark-club" />);

    expect(
      await screen.findByText(
        'The Rake Report Could Not Be Verified. No Zero Report Is Being Shown.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export Daily CSV' })).toBeNull();
  });

  it('renders a server refusal as restricted and exposes no report controls', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } });

    render(<RakeReports clubId="shark-club" />);

    expect(
      await screen.findByText('Rake Reports Are Available To Authorized Club Financial Staff.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export Daily CSV' })).toBeNull();
  });

  it('uses a verified recent-hand identity and never prints raw player ids', async () => {
    render(<RakeReports clubId="shark-club" />);
    fireEvent.click(await screen.findByRole('button', { name: /Night Owl, Hand 42/ }));

    expect(await screen.findByText('Player 1')).toBeInTheDocument();
    expect(screen.getByText('Player 2')).toBeInTheDocument();
    expect(screen.getByText('33.3%')).toBeInTheDocument();
    expect(m.rpc).toHaveBeenCalledWith('fn_hand_rake_breakdown', { p_hand_id: HAND_ID });
    expect(document.body.textContent).not.toContain(PLAYER_ONE);
    expect(document.body.textContent).not.toContain(PLAYER_TWO);
    expect(document.body.textContent).not.toContain(HAND_ID);
  });

  it('keeps the current club lookup locked when a stale club lookup finishes', async () => {
    const stale = deferred<{ data: ReturnType<typeof handBreakdown>; error: null }>();
    const current = deferred<{ data: ReturnType<typeof handBreakdown>; error: null }>();
    let breakdownReads = 0;
    m.rpc.mockImplementation((name: string) => {
      if (name === 'ca_club_financials') {
        return Promise.resolve({ data: financialPayload(), error: null });
      }
      breakdownReads += 1;
      if (breakdownReads === 1) return stale.promise;
      if (breakdownReads === 2) return current.promise;
      return Promise.resolve({ data: handBreakdown(), error: null });
    });

    const view = render(<RakeReports clubId="shark-club" />);
    fireEvent.click(await screen.findByRole('button', { name: /Night Owl, Hand 42/ }));
    await waitFor(() => expect(breakdownReads).toBe(1));

    view.rerender(<RakeReports clubId="other-club" />);
    const currentButton = await screen.findByRole('button', { name: /Night Owl, Hand 42/ });
    fireEvent.click(currentButton);
    await waitFor(() => expect(breakdownReads).toBe(2));

    await act(async () => {
      stale.resolve({ data: handBreakdown(), error: null });
      await Promise.resolve();
    });
    await waitFor(() => expect(currentButton).toBeDisabled());
    fireEvent.click(currentButton);
    expect(breakdownReads).toBe(2);

    await act(async () => {
      current.resolve({ data: handBreakdown(), error: null });
    });
    expect(await screen.findByText('Player 1')).toBeInTheDocument();
  });

  it('invalidates a stale hand lookup when the report window changes', async () => {
    const stale = deferred<{ data: ReturnType<typeof handBreakdown>; error: null }>();
    m.rpc.mockImplementation((name: string, args?: { p_start?: string; p_end?: string }) => {
      if (name === 'fn_hand_rake_breakdown') return stale.promise;
      const payload = financialPayloadForRange(args?.p_start as string, args?.p_end as string);
      if (args?.p_start === args?.p_end) payload.recent = [];
      return Promise.resolve({ data: payload, error: null });
    });

    render(<RakeReports clubId="shark-club" />);
    fireEvent.click(await screen.findByRole('button', { name: /Night Owl, Hand 42/ }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('fn_hand_rake_breakdown', { p_hand_id: HAND_ID })
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Today' }));
    expect(
      await screen.findByText('No Recent Raked Hands Are Available In This Returned Window.')
    ).toBeInTheDocument();

    await act(async () => {
      stale.resolve({ data: handBreakdown(), error: null });
      await Promise.resolve();
    });

    expect(screen.queryByText('Player 1')).toBeNull();
    expect(screen.queryByLabelText('Verified Hand Rake Summary')).toBeNull();
    expect(
      screen.getByText('Choose A Recent Raked Hand To Verify Its Player Allocation.')
    ).toBeInTheDocument();
  });

  it('invalidates a stale hand lookup when the same report window refreshes', async () => {
    const stale = deferred<{ data: ReturnType<typeof handBreakdown>; error: null }>();
    m.rpc.mockImplementation((name: string) => {
      if (name === 'fn_hand_rake_breakdown') return stale.promise;
      return Promise.resolve({ data: financialPayload(), error: null });
    });

    render(<RakeReports clubId="shark-club" />);
    fireEvent.click(await screen.findByRole('button', { name: /Night Owl, Hand 42/ }));
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('fn_hand_rake_breakdown', { p_hand_id: HAND_ID })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Report' }));
    expect(await screen.findByLabelText('Verified Rake Summary')).toBeInTheDocument();

    await act(async () => {
      stale.resolve({ data: handBreakdown(), error: null });
      await Promise.resolve();
    });

    expect(screen.queryByText('Player 1')).toBeNull();
    expect(screen.queryByLabelText('Verified Hand Rake Summary')).toBeNull();
  });

  it('resolves duplicate table-local hand numbers through their exact recent identities', async () => {
    const payload = financialPayload();
    payload.recent = [
      payload.recent[0],
      {
        ...payload.recent[0],
        id: 'rake-b',
        hand_id: HAND_ID_TWO,
        table_name: 'high noon',
        created_at: `${payload.range.end}T11:00:00Z`,
      },
    ];
    m.rpc.mockImplementation((name: string, args?: { p_hand_id?: string }) =>
      Promise.resolve({
        data:
          name === 'ca_club_financials'
            ? payload
            : handBreakdown(args?.p_hand_id === HAND_ID_TWO ? HAND_ID_TWO : HAND_ID),
        error: null,
      })
    );

    render(<RakeReports clubId="shark-club" />);
    const nightOwl = await screen.findByRole('button', { name: /Night Owl, Hand 42/ });
    const highNoon = screen.getByRole('button', { name: /High Noon, Hand 42/ });

    fireEvent.click(nightOwl);
    expect(await screen.findByText('Player 1')).toBeInTheDocument();
    fireEvent.click(highNoon);
    await waitFor(() =>
      expect(m.rpc).toHaveBeenCalledWith('fn_hand_rake_breakdown', { p_hand_id: HAND_ID_TWO })
    );
    expect(m.rpc).toHaveBeenCalledWith('fn_hand_rake_breakdown', { p_hand_id: HAND_ID });
    expect(document.body.textContent).not.toContain(HAND_ID);
    expect(document.body.textContent).not.toContain(HAND_ID_TWO);
  });

  it('names an empty recent-hand window without exposing a raw lookup field', async () => {
    const payload = financialPayload();
    payload.recent = [];
    m.rpc.mockResolvedValue({ data: payload, error: null });

    render(<RakeReports clubId="shark-club" />);

    expect(
      await screen.findByText('No Recent Raked Hands Are Available In This Returned Window.')
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Hand ID Or Hand Number')).toBeNull();
  });

  it.each([
    ['string money', { ...handBreakdown(), regular_rake_collected: '3' }],
    ['wrong hand binding', { ...handBreakdown(), hand_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    [
      'duplicate player identity',
      {
        ...handBreakdown(),
        players: [handBreakdown().players[0], handBreakdown().players[0]],
        reconciliation: {
          expected_regular_rake: 2,
          allocated_regular_rake: 2,
          difference: 0,
          valid: true,
        },
        regular_rake_collected: 2,
      },
    ],
    [
      'contradictory reconciliation',
      {
        ...handBreakdown(),
        reconciliation: {
          expected_regular_rake: 3,
          allocated_regular_rake: 3,
          difference: 1,
          valid: true,
        },
      },
    ],
    ['contradictory pot arithmetic', { ...handBreakdown(), net_pot_paid_to_players: 995 }],
    [
      'contradictory player contribution arithmetic',
      {
        ...handBreakdown(),
        players: [
          { ...handBreakdown().players[0], gross_contribution: 99 },
          handBreakdown().players[1],
        ],
      },
    ],
    [
      'contradictory eligible contribution total',
      {
        ...handBreakdown(),
        total_eligible_contributions: 301,
      },
    ],
    [
      'contradictory contribution weight',
      {
        ...handBreakdown(),
        players: [
          { ...handBreakdown().players[0], contribution_weight: 0.5 },
          handBreakdown().players[1],
        ],
      },
    ],
    [
      'contradictory weighted credit split',
      {
        ...handBreakdown(),
        players: [
          { ...handBreakdown().players[0], weighted_rake_credit: 1.01 },
          { ...handBreakdown().players[1], weighted_rake_credit: 1.99 },
        ],
      },
    ],
    [
      'partial player ledger row',
      {
        ...handBreakdown(),
        players: [
          { ...handBreakdown().players[0], contribution_weight: null },
          handBreakdown().players[1],
        ],
      },
    ],
    [
      'zero eligible player row',
      {
        ...handBreakdown(),
        players: [
          {
            ...handBreakdown().players[0],
            gross_contribution: 0,
            eligible_contribution: 0,
            contribution_weight: 0,
            weighted_rake_credit: 0,
          },
          {
            ...handBreakdown().players[1],
            gross_contribution: 300,
            eligible_contribution: 300,
            contribution_weight: 1,
            weighted_rake_credit: 3,
          },
        ],
      },
    ],
  ])('rejects a malformed %s receipt', (_label, receipt) => {
    expect(() => parseHandBreakdownPayload(receipt, HAND_ID)).toThrow(/Is Invalid/);
  });

  it('preserves a coherent legacy receipt whose optional player allocation bundle is absent', () => {
    const receipt = handBreakdown();
    receipt.players = receipt.players.map((player) => ({
      ...player,
      gross_contribution: null,
      eligible_contribution: null,
      contribution_weight: null,
      weighted_rake_credit: null,
      bbj_attributed_contribution: 0,
    }));
    receipt.reconciliation = {
      expected_regular_rake: 3,
      allocated_regular_rake: 0,
      difference: 3,
      valid: false,
    };

    expect(parseHandBreakdownPayload(receipt, HAND_ID)).toMatchObject({
      found: true,
      reconciliation: { valid: false },
    });
  });

  it('contains only painted console frames and no raw-id or generic-card presentation', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/admin/RakeReports.tsx'),
      'utf8'
    );
    const styles = readFileSync(
      resolve(process.cwd(), 'src/components/admin/RakeReports.css'),
      'utf8'
    );

    expect(source.match(/<SpadeConsole\b/g)).toHaveLength(7);
    expect(source.match(/if \(period === 'week'\) return 'Seven Days';/g)).toHaveLength(1);
    expect(source.match(/\{chipLabel\(data\.avgRakePerHand\)\}/g)).toHaveLength(1);
    expect(source).toContain('parseClubFinancialsPayload');
    expect(source).not.toMatch(/player_id\.slice|title=\{player\.player_id\}/);
    expect(source).not.toContain(".from('rake_records')");
    expect(source).not.toContain('Hand ID Or Hand Number');
    expect(source).not.toMatch(/Number\([^)]*\)\s*\|\|\s*0/);
    expect(source).not.toContain('.toFixed(');
    expect(source).not.toMatch(/[♠⚠]/u);
    expect(styles).not.toContain(':hover');
    expect(styles).not.toContain('linear-gradient');
    expect(styles).not.toContain('backdrop-filter');
  });
});
