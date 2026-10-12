/**
 * A PLATE NEVER CLAIMS WHAT WAS NOT READ (launch audit D-08 / R-02, round 2,
 * 2026-10-09). The riveted statement fills both of its painted plates in every
 * state; the blue one said "Up To Date" under "Loading Your Statement...", under
 * "The Statement Could Not Be Loaded" and under a refusal - a claim about the
 * player's movements that nothing had read. It says so only for a statement
 * that loaded and has no earlier page; otherwise it names the control, disabled.
 * Harness: tests/unit/ChipStatement.test.tsx.
 */
import { render, screen, waitFor } from '@testing-library/react';
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

import ChipStatement from '../../src/components/wallet/ChipStatement';

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
});

const plates = () =>
  Array.from(document.querySelectorAll('.sc__foot .sc-plate')).map((plate) => ({
    label: plate.textContent?.trim(),
    aria: plate.getAttribute('aria-label'),
    disabled: (plate as HTMLButtonElement).disabled,
  }));

describe('the blue plate of the riveted statement', () => {
  it('does not say Up To Date while the statement is still loading', () => {
    rpc.mockReturnValue(new Promise(() => {}));
    render(<ChipStatement scope="player" />);
    expect(screen.getByText('Loading Your Statement...')).toBeTruthy();
    expect(plates()[1]).toEqual({
      label: 'Earlier Movements',
      aria: 'Earlier Movements',
      disabled: true,
    });
    expect(document.body.textContent).not.toContain('Up To Date');
  });

  it('does not say Up To Date for a statement that could not be loaded', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom', code: 'XX000' } });
    render(<ChipStatement scope="player" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(plates()[1].label).toBe('Earlier Movements');
    expect(plates()[1].disabled).toBe(true);
    expect(plates()[1].aria).not.toBe('Every Movement Is Shown');
  });

  it('says Up To Date only when a loaded statement has no earlier page', async () => {
    rpc.mockResolvedValueOnce({
      data: statement({ has_more: false, next_cursor: null }),
      error: null,
    });
    render(<ChipStatement scope="player" />);
    await waitFor(() => screen.getByText('Up To Date'));
    expect(plates()[1]).toEqual({
      label: 'Up To Date',
      aria: 'Every Movement Is Shown',
      disabled: true,
    });
  });
});
