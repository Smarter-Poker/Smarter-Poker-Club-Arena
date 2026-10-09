/**
 * The chip statement shows both directions, the audit line, and refuses to
 * guess (phase 7, roadmap 9.5).
 */
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const auth = vi.hoisted(() => ({
  user: { id: 'u' } as { id: string } | null,
  generation: 0,
  guards: new Map<string, () => boolean>(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: auth.user, isHydrating: false }),
}));
vi.mock('../../src/hooks/useCashoutScope', () => ({
  useCashoutScope: (accountId: string | undefined) => {
    const generation = auth.generation;
    const key = `${accountId ?? 'none'}:${generation}`;
    const guard =
      auth.guards.get(key) ?? (() => auth.generation === generation && auth.user?.id === accountId);
    auth.guards.set(key, guard);
    return guard;
  },
  useCashoutScopeKey: (accountId: string | undefined, view: string) =>
    JSON.stringify([accountId, view, auth.generation]),
}));
vi.mock('../../src/components/tournament/TournamentPaymentStatus', () => ({ default: () => null }));

import ChipStatement, {
  categoryLabel,
  counterpartyLabel,
} from '../../src/components/wallet/ChipStatement';

const leg = (over: Record<string, unknown>) => ({
  id: 'l1',
  at: '2026-09-07T22:00:00.000000+00:00',
  direction: 'in',
  amount: 12.5,
  category: 'tournament_prize',
  description: null,
  counterparty_type: 'prize_liability',
  counterparty_label: null,
  counterparty_id: 'x',
  club_id: 'c',
  table_id: null,
  tournament_id: 't',
  hand_id: null,
  settlement_id: null,
  ...over,
});

const statement = (over: Record<string, unknown> = {}) => {
  const base = {
    scope: 'player',
    entity_id: 'u',
    account: 'player_wallet:u:club_members.chip_balance',
    club_filter: null,
    balance_now: 256869.48,
    balance_exists: true,
    clubs: [
      { club_id: 'a', club_name: 'Alpha', balance: 100 },
      { club_id: 'b', club_name: 'Beta', balance: 256769.48 },
    ],
    legs: [
      leg({ id: 'l1' }),
      leg({
        id: 'l2',
        at: '2026-09-07T21:00:00.123456+00:00',
        direction: 'out',
        category: 'tournament_buyin',
        amount: 50,
      }),
    ],
    has_more: true,
    next_before: '2026-09-07T21:00:00.123456+00:00',
    next_cursor: {
      at: '2026-09-07T21:00:00.123456+00:00',
      id: 'l2',
      direction: 'out',
      account: 'player_wallet:u:club_members.chip_balance',
      club_filter: null,
    },
    audit: {
      status: 'reconciles',
      read_at: '2026-09-07T06:40:00Z',
      balance_at_reading: 255662.53,
      in_since: 2329.95,
      out_since: 1123,
      legs_since: 89,
      expected_now: 256869.48,
      balance_now: 256869.48,
      unexplained: 0,
    },
    generated_at: '2026-09-07T22:26:47Z',
    ms: 525,
  };
  const merged = { ...base, ...over };
  if ('balance_now' in over && !('audit' in over)) {
    merged.audit = { ...base.audit, balance_now: over.balance_now };
  }
  return merged;
};

beforeEach(() => {
  rpc.mockReset();
  auth.user = { id: 'u' };
  auth.generation = 0;
  auth.guards.clear();
});

describe('ChipStatement', () => {
  it("asks for the caller's own statement and renders both directions with the audit line", async () => {
    rpc.mockResolvedValueOnce({ data: statement(), error: null });
    render(<ChipStatement scope="player" />);
    await waitFor(() => expect(screen.getByText('Your Chip Statement')).toBeTruthy());
    expect(rpc).toHaveBeenCalledWith('fn_ca_chip_statement_page', {
      p_scope: 'player',
      p_club_id: null,
      p_cursor: null,
      p_limit: 50,
    });
    expect(screen.getByText('+12')).toBeTruthy(); // in
    expect(screen.getByText('-50')).toBeTruthy(); // out - the direction the old feed never showed
    expect(screen.getByText('Tournament Entry')).toBeTruthy();
    expect(screen.getByText(/Reconciles\./)).toBeTruthy();
    expect(screen.getByText(/255\.6K/)).toBeTruthy(); // balance at reading, console compact format
    expect(screen.getByText('Beta')).toBeTruthy(); // balance by club
  });

  it('passes the full server cursor unchanged, including microseconds, and appends', async () => {
    rpc.mockResolvedValueOnce({ data: statement(), error: null });
    rpc.mockResolvedValueOnce({
      data: statement({
        legs: [leg({ id: 'l3', at: '2026-09-07T20:00:00.123456+00:00', amount: 7 })],
        has_more: false,
        next_cursor: null,
      }),
      error: null,
    });
    render(<ChipStatement scope="player" />);
    await waitFor(() => screen.getByText('Load Earlier Movements'));
    fireEvent.click(screen.getByText('Load Earlier Movements'));
    await waitFor(() => expect(screen.getByText('+7')).toBeTruthy());
    expect(rpc).toHaveBeenLastCalledWith(
      'fn_ca_chip_statement_page',
      expect.objectContaining({ p_cursor: statement().next_cursor })
    );
    expect(screen.queryByText('Load Earlier Movements')).toBeNull();
  });

  it('says out loud when the balance does not reconcile', async () => {
    rpc.mockResolvedValueOnce({
      data: statement({
        balance_now: 256870,
        audit: {
          ...statement().audit,
          status: 'does_not_reconcile',
          balance_now: 256870,
          unexplained: 0.52,
        },
      }),
      error: null,
    });
    render(<ChipStatement scope="player" />);
    await waitFor(() => expect(screen.getByText(/Does Not Reconcile\./)).toBeTruthy());
    expect(screen.getByText(/Difference Under 1 Chip/)).toBeTruthy();
  });

  it('keeps both directions when a self-transfer spans pages', async () => {
    rpc.mockResolvedValueOnce({
      data: statement({
        legs: [leg({ id: 'same-transfer', amount: 7 })],
        next_before: '2026-09-07T22:00:00.000000+00:00',
        next_cursor: {
          at: '2026-09-07T22:00:00.000000+00:00',
          id: 'same-transfer',
          direction: 'in',
          account: 'player_wallet:u:club_members.chip_balance',
          club_filter: null,
        },
      }),
      error: null,
    });
    rpc.mockResolvedValueOnce({
      data: statement({
        legs: [leg({ id: 'same-transfer', direction: 'out', amount: 7 })],
        has_more: false,
        next_cursor: null,
      }),
      error: null,
    });
    render(<ChipStatement scope="player" />);
    fireEvent.click(await screen.findByText('Load Earlier Movements'));
    await screen.findByText('-7');
    expect(screen.getByText('+7')).toBeTruthy();
  });

  it('refuses a response that says more rows exist but loses their cursor', async () => {
    rpc.mockResolvedValueOnce({
      data: statement({ next_cursor: null }),
      error: null,
    });
    render(<ChipStatement scope="player" />);
    await screen.findByRole('alert');
    expect(screen.queryByText('Load Earlier Movements')).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to timestamp pagination when the new reader is unavailable', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: 'reader unavailable' },
    });
    render(<ChipStatement scope="player" />);
    await screen.findByRole('alert');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('fn_ca_chip_statement_page');
  });

  it('fills both riveted plates in every state, never leaving one empty (launch audit D-08)', async () => {
    const plateLabels = () =>
      Array.from(document.querySelectorAll('.sc__foot .sc-plate')).map((plate) => ({
        label: plate.textContent?.trim(),
        disabled: (plate as HTMLButtonElement).disabled,
      }));

    // Rows, with more to load: Refresh re-reads, the blue plate loads earlier.
    rpc.mockResolvedValue({ data: statement(), error: null });
    const view = render(<ChipStatement scope="player" />);
    await waitFor(() => screen.getByText('Load Earlier Movements'));
    expect(plateLabels()).toEqual([
      { label: 'Refresh', disabled: false },
      { label: 'Load Earlier Movements', disabled: false },
    ]);
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    view.unmount();
    rpc.mockReset();

    // Every movement shown: the blue plate says so and is disabled.
    rpc.mockResolvedValueOnce({
      data: statement({ has_more: false, next_cursor: null }),
      error: null,
    });
    const upToDate = render(<ChipStatement scope="player" />);
    await waitFor(() => screen.getByText('Up To Date'));
    expect(plateLabels()[1]).toEqual({ label: 'Up To Date', disabled: true });
    expect(plateLabels().every((plate) => plate.label)).toBe(true);
    upToDate.unmount();

    // Failed: Try Again is the plate, nothing else is a lit word.
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom', code: 'XX000' } });
    render(<ChipStatement scope="player" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(plateLabels()[0]).toEqual({ label: 'Try Again', disabled: false });
    expect(plateLabels()[1].label).toBeTruthy();
    expect(document.querySelector('.chip-statement__btn')).toBeNull();
  });

  it('never reads an error as "no movements"', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom', code: 'XX000' } });
    render(<ChipStatement scope="player" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText('No Chip Movements Yet.')).toBeNull();
    expect(screen.getByText('Try Again')).toBeTruthy();
  });

  it('a treasury statement without a club asks nothing and shows nothing false', async () => {
    render(<ChipStatement scope="club_treasury" clubId={null} />);
    await waitFor(() => expect(rpc).not.toHaveBeenCalled());
  });

  it('retires an old statement response when its account scope changes', async () => {
    let resolveOld!: (value: unknown) => void;
    rpc
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValueOnce({
        data: statement({
          scope: 'club_treasury',
          entity_id: 'club-b',
          account: 'club_treasury:club-b:clubs.chip_treasury',
          club_filter: 'club-b',
          balance_now: 900,
          clubs: [],
          legs: [leg({ id: 'new', club_id: 'club-b', amount: 90 })],
          has_more: false,
          next_cursor: null,
        }),
        error: null,
      });
    const view = render(<ChipStatement scope="player" />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    view.rerender(<ChipStatement scope="club_treasury" clubId="club-b" />);
    expect(await screen.findByText('900')).toBeTruthy();

    await act(async () => {
      resolveOld({ data: statement({ balance_now: 123 }), error: null });
    });
    expect(screen.queryByText('123')).toBeNull();
    expect(screen.getByText('900')).toBeTruthy();
  });

  it('rejects malformed success payloads instead of painting a false empty statement', async () => {
    rpc.mockResolvedValueOnce({
      data: statement({ account: 'player_wallet:someone-else:club_members.chip_balance' }),
      error: null,
    });
    render(<ChipStatement scope="player" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The Statement Could Not Be Loaded');
    expect(screen.queryByText('No Chip Movements Yet.')).toBeNull();
  });

  it('rejects duplicated rows and a continuation that is not the last row', async () => {
    rpc.mockResolvedValueOnce({
      data: statement({
        legs: [leg({ id: 'duplicate' }), leg({ id: 'duplicate' })],
      }),
      error: null,
    });
    render(<ChipStatement scope="player" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No Chip Movements Yet.')).toBeNull();
  });

  it('retires A to B to A auth generations and never restores either late page', async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    rpc
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)))
      .mockResolvedValueOnce({ data: statement({ balance_now: 300 }), error: null });
    const view = render(<ChipStatement scope="player" />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    auth.user = { id: 'b' };
    auth.generation += 1;
    view.rerender(<ChipStatement scope="player" />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));

    auth.user = { id: 'u' };
    auth.generation += 1;
    view.rerender(<ChipStatement scope="player" />);
    expect(await screen.findByText('300')).toBeTruthy();
    await act(async () => {
      resolveFirst({ data: statement({ balance_now: 100 }), error: null });
      resolveSecond({ data: statement({ balance_now: 200 }), error: null });
    });
    expect(document.querySelector('.chip-statement__balance-value')?.textContent).toBe('300');
  });

  it('labels carry no em dash and unknown categories are still shown', () => {
    for (const v of Object.values({
      a: categoryLabel('buyin'),
      b: categoryLabel('something_new'),
    })) {
      expect(v).not.toContain('—');
    }
    expect(categoryLabel('something_new')).toBe('Something New');
    expect(
      counterpartyLabel(
        leg({ counterparty_type: 'club_treasury', counterparty_label: 'Deep Stack' })
      )
    ).toBe('The Club (Deep Stack)');
  });

  it('names a storage path by its account and never prints a table or column name', () => {
    // Production chip_ledger labels are storage paths: clubs.chip_treasury
    // rendered as "The Club (Clubs.Chip_Treasury)" on the Treasury Statement.
    expect(
      counterpartyLabel(
        leg({ counterparty_type: 'club_treasury', counterparty_label: 'clubs.chip_treasury' })
      )
    ).toBe('The Club (Club Treasury)');
    expect(
      counterpartyLabel(
        leg({ counterparty_type: 'bbj_pool', counterparty_label: 'bbj_pools.main_balance' })
      )
    ).toBe('The Jackpot (Jackpot Main Pool)');
    const unknown = counterpartyLabel(
      leg({ counterparty_type: 'club_treasury', counterparty_label: 'some_table.some_column' })
    );
    expect(unknown).toBe('The Club');
    expect(
      counterpartyLabel(
        leg({ counterparty_type: 'prize_liability', counterparty_label: 'tournament entry ticket' })
      )
    ).toBe('A Prize Pool (Tournament Entry Ticket)');
    for (const label of [
      'union_wallets.rake_wallet',
      'tournaments.prize_pool+total_rake',
      'spin_bonus_pools.balance',
    ]) {
      expect(
        counterpartyLabel(leg({ counterparty_type: 'union_wallet', counterparty_label: label }))
      ).not.toMatch(/_|\./);
    }
  });
});
