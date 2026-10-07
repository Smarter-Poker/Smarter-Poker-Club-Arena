/**
 * THE /transactions PAGE READS THE CHIP JOURNAL (launch audit, 2026-10-06).
 *
 * The page used to list chip_transactions, a partial receipt log: for one busy
 * production player over 24 hours it held the 257 tournament entries and none
 * of the 121 prizes or 11 bounties chip_ledger recorded, so the page showed a
 * player paying in and never being paid. It now renders the player's chip
 * statement (fn_ca_chip_statement_page over chip_ledger, bound to auth.uid()).
 *
 * What this pins:
 *   1. the page asks the statement RPC for the caller's own player statement,
 *      and never touches chip_transactions (or any table) directly;
 *   2. money in and money out both render, with signs and plain-word labels;
 *   3. a tab returning after a while, and a wallet change elsewhere in the app,
 *      both read the statement again rather than leaving it stale.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  refresh: () => {},
  bus: new Map<string, () => void>(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'viewer' }, isHydrating: false }),
}));
// One stable guard, as the real hook returns: a fresh function per render
// would change the statement's load callback every render and loop it.
const scopeIsCurrent = () => true;
vi.mock('../../src/hooks/useCashoutScope', () => ({
  useCashoutScope: () => scopeIsCurrent,
  useCashoutScopeKey: (accountId: string | undefined, view: string) =>
    JSON.stringify([accountId, view]),
}));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({
  useVisibilityRefresh: (fn: () => void) => {
    backend.refresh = fn;
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/TournamentPaymentStatus', () => ({
  default: () => null,
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: (event: string, fn: () => void) => {
      backend.bus.set(event, fn);
      return () => backend.bus.delete(event);
    },
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => backend.rpc(...a),
    from: (...a: unknown[]) => backend.from(...a),
  },
}));

import TransactionHistoryPage, {
  TRANSACTION_PAGE_SIZE,
} from '../../src/pages/TransactionHistoryPage';

const ACCOUNT = 'player_wallet:viewer:club_members.chip_balance';

const leg = (over: Record<string, unknown>) => ({
  id: 'l1',
  at: '2026-10-06T12:00:00.000000+00:00',
  direction: 'in',
  amount: 40,
  category: 'tournament_prize',
  description: null,
  counterparty_type: 'prize_liability',
  counterparty_label: null,
  counterparty_id: 't',
  club_id: 'c',
  table_id: null,
  tournament_id: 't',
  hand_id: null,
  settlement_id: null,
  ...over,
});

const statement = (legs: ReturnType<typeof leg>[]) => ({
  scope: 'player',
  entity_id: 'viewer',
  account: ACCOUNT,
  club_filter: null,
  balance_now: 500,
  balance_exists: true,
  clubs: [{ club_id: 'c', club_name: 'Deep Stack', balance: 500 }],
  legs,
  has_more: false,
  next_before: null,
  next_cursor: null,
  audit: { status: 'no_reading_yet', balance_now: 500 },
  generated_at: '2026-10-06T12:05:00Z',
  ms: 12,
});

beforeEach(() => {
  backend.rpc.mockReset();
  backend.from.mockReset();
  backend.bus.clear();
  backend.rpc.mockResolvedValue({
    data: statement([
      leg({ id: 'l2' }),
      leg({
        id: 'l1',
        at: '2026-10-06T11:00:00.000000+00:00',
        direction: 'out',
        amount: 25,
        category: 'tournament_buyin',
      }),
    ]),
    error: null,
  });
});
afterEach(cleanup);

it("reads the caller's own chip statement, never chip_transactions", async () => {
  render(<TransactionHistoryPage />);
  await screen.findByText('Tournament Prize');
  expect(backend.rpc).toHaveBeenCalledWith('fn_ca_chip_statement_page', {
    p_scope: 'player',
    p_club_id: null,
    p_cursor: null,
    p_limit: TRANSACTION_PAGE_SIZE,
  });
  expect(backend.from).not.toHaveBeenCalled();

  const source = readFileSync(
    join(__dirname, '..', '..', 'src', 'pages', 'TransactionHistoryPage.tsx'),
    'utf8'
  );
  expect(source).not.toMatch(/\.from\(\s*['"]chip_transactions['"]/);
  expect(source).not.toMatch(/table:\s*['"]chip_transactions['"]/);
  expect(source).toContain('<ChipStatement');
  expect(source).toMatch(/scope="player"/);
});

it('shows money in and money out with signs and plain-word labels', async () => {
  render(<TransactionHistoryPage />);
  expect(await screen.findByText('Tournament Prize')).toBeInTheDocument();
  expect(screen.getByText('Tournament Entry')).toBeInTheDocument();
  expect(screen.getByText('+40')).toBeInTheDocument();
  expect(screen.getByText('-25')).toBeInTheDocument();
});

it('reads the statement again when the tab returns and when the wallet changes', async () => {
  render(<TransactionHistoryPage />);
  await screen.findByText('Tournament Prize');
  expect(backend.rpc).toHaveBeenCalledTimes(1);

  await act(async () => backend.refresh());
  await waitFor(() => expect(backend.rpc).toHaveBeenCalledTimes(2));

  for (const event of ['WALLET_REFRESHED', 'BALANCE_UPDATED', 'CHIPS_ADDED']) {
    expect(backend.bus.has(event), event).toBe(true);
  }
  await act(async () => backend.bus.get('BALANCE_UPDATED')?.());
  await waitFor(() => expect(backend.rpc).toHaveBeenCalledTimes(3));
  expect(await screen.findByText('Tournament Prize')).toBeInTheDocument();
});
