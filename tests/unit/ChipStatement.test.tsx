/**
 * The chip statement shows both directions, the audit line, and refuses to
 * guess (phase 7, roadmap 9.5).
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: null }) }));

import ChipStatement, {
  categoryLabel,
  counterpartyLabel,
} from '../../src/components/wallet/ChipStatement';

const leg = (over: Record<string, unknown>) => ({
  id: 'l1',
  at: '2026-09-07T22:00:00Z',
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

const statement = (over: Record<string, unknown> = {}) => ({
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
    leg({ id: 'l2', direction: 'out', category: 'tournament_buyin', amount: 50 }),
  ],
  has_more: true,
  next_before: '2026-09-07T15:42:03Z',
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
  ...over,
});

beforeEach(() => rpc.mockReset());

describe('ChipStatement', () => {
  it("asks for the caller's own statement and renders both directions with the audit line", async () => {
    rpc.mockResolvedValueOnce({ data: statement(), error: null });
    render(<ChipStatement scope="player" />);
    await waitFor(() => expect(screen.getByText('Your Chip Statement')).toBeTruthy());
    expect(rpc).toHaveBeenCalledWith('fn_ca_chip_statement', {
      p_scope: 'player',
      p_club_id: null,
      p_before: null,
      p_limit: 50,
    });
    expect(screen.getByText('+12.50')).toBeTruthy(); // in
    expect(screen.getByText('-50.00')).toBeTruthy(); // out - the direction the old feed never showed
    expect(screen.getByText('Tournament Entry')).toBeTruthy();
    expect(screen.getByText(/Reconciles\./)).toBeTruthy();
    expect(screen.getByText(/255,662\.53/)).toBeTruthy(); // balance at reading
    expect(screen.getByText('Beta')).toBeTruthy(); // balance by club
  });

  it('pages with next_before and appends', async () => {
    rpc.mockResolvedValueOnce({ data: statement(), error: null });
    rpc.mockResolvedValueOnce({
      data: statement({ legs: [leg({ id: 'l3', amount: 7 })], has_more: false, next_before: null }),
      error: null,
    });
    render(<ChipStatement scope="player" />);
    await waitFor(() => screen.getByText('Load Earlier Movements'));
    fireEvent.click(screen.getByText('Load Earlier Movements'));
    await waitFor(() => expect(screen.getByText('+7.00')).toBeTruthy());
    expect(rpc).toHaveBeenLastCalledWith(
      'fn_ca_chip_statement',
      expect.objectContaining({ p_before: '2026-09-07T15:42:03Z' })
    );
    expect(screen.queryByText('Load Earlier Movements')).toBeNull();
  });

  it('says out loud when the balance does not reconcile', async () => {
    rpc.mockResolvedValueOnce({
      data: statement({
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
    expect(screen.getByText(/Difference 0\.52/)).toBeTruthy();
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
});
