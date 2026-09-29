import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DiamondSpinStatements from '../../src/components/club/DiamondSpinStatements';
import type {
  DiamondStatement,
  DiamondStatements,
} from '../../src/services/DiamondStatementService';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  report: vi.fn(),
  user: { id: 'owner-a' } as { id: string } | null,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: mocks.user }) }));
vi.mock('../../src/services/DiamondStatementService', () => ({
  loadDiamondStatements: mocks.load,
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));

function statement(day: string, hostName = 'Example Union'): DiamondStatement {
  return {
    day,
    status: 'settled',
    entry_diamonds: 1000,
    bonus_diamonds: 100,
    mint_entry_diamonds: 100,
    diamond_prizes: 50,
    throwables: 25,
    time_banks: 10,
    rabbit_hunts: 10,
    other_expenses: 5,
    net_diamonds: 1100,
    profit_burn_bps: 2000,
    profit_burn: 220,
    credited_net: 880,
    settled_at: '2026-09-19T05:05:00Z',
    wallet_transaction_id: '11111111-1111-4111-8111-111111111111',
    hosts: [
      {
        host_id: '22222222-2222-4222-8222-222222222222',
        host_kind: 'union',
        host_name: hostName,
        entries: 1200,
        expenses: 100,
        net_diamonds: 1100,
      },
    ],
  };
}
const page = (days: DiamondStatement[], next: string | null = null): DiamondStatements => ({
  timezone: 'America/Chicago',
  profit_burn_bps: 2000,
  days,
  next_before_day: next,
});
function deferred() {
  let resolve!: (value: DiamondStatements) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DiamondStatements>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const click = async (name: string) => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name })));
};

beforeEach(() => {
  mocks.user = { id: 'owner-a' };
  mocks.load.mockReset();
  mocks.report.mockReset();
});
afterEach(cleanup);

describe('daily owner statement screen', () => {
  it('shows the three settlement lines: net, platform burn and the wallet credit (owner ruling 2026-09-21, R14)', async () => {
    const open: DiamondStatement = {
      ...statement('2026-09-19', 'Open Union'),
      status: 'open',
      settled_at: null,
      wallet_transaction_id: null,
      profit_burn_bps: null,
      profit_burn: null,
      credited_net: null,
    };
    mocks.load.mockResolvedValueOnce(page([open, statement('2026-09-18', 'Settled Union')]));
    const view = render(<DiamondSpinStatements />);
    await screen.findByText('Settled Union');
    const [openDay, settledDay] = Array.from(view.container.querySelectorAll('details'));
    expect(settledDay).toHaveTextContent('Net Diamonds Earned1,100');
    expect(settledDay).toHaveTextContent('Platform Burn (20%)−220');
    expect(settledDay).toHaveTextContent('Credited To Your Wallet880');
    expect(settledDay).toHaveTextContent(
      'One Transfer Of 880 Diamonds Is Recorded In Your Diamond Wallet.'
    );
    expect(openDay).toHaveTextContent('Net Diamonds Earned1,100');
    expect(openDay).toHaveTextContent('Platform Burn (20%)Settles After Midnight');
    expect(openDay).toHaveTextContent('Credited To Your WalletSettles After Midnight');
    expect(view.container.textContent).not.toContain('—');
    expect(screen.getByText(/The Platform Burns 20% Of A Profitable Day/)).toBeInTheDocument();
  });

  it('shows pending and failed reads, prevents duplicate loads, and retries an empty first page', async () => {
    const pending = deferred();
    mocks.load.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page([]));
    render(<DiamondSpinStatements />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading Statements');
    const refresh = screen.getByRole('button', { name: 'Refresh Statements' });
    expect(refresh).toBeDisabled();
    fireEvent.click(refresh);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(null);
    await act(async () => pending.reject(new Error('Statements Unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Statements Unavailable');
    expect(
      screen.queryByText('Your First Diamond Spins Statement Will Appear Here.')
    ).not.toBeInTheDocument();
    await click('Try Again');
    expect(mocks.load).toHaveBeenNthCalledWith(2, null);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByText('Your First Diamond Spins Statement Will Appear Here.')
    ).toBeInTheDocument();
    expect(refresh).toBeEnabled();
  });

  it('retains the current days and exact older cursor through a failed page and retry', async () => {
    mocks.load
      .mockResolvedValueOnce(page([statement('2026-09-18', 'Current Union')], '2026-09-18'))
      .mockRejectedValueOnce(new Error('Older Statements Unavailable'))
      .mockResolvedValueOnce(page([statement('2026-09-17', 'Previous Club')]));
    const view = render(<DiamondSpinStatements />);
    await screen.findByText('Current Union');
    await click('Older Statements');
    expect(screen.getByRole('alert')).toHaveTextContent('Older Statements Unavailable');
    expect(screen.getByText('Current Union')).toBeInTheDocument();
    await click('Try Again');
    expect(mocks.load).toHaveBeenNthCalledWith(2, '2026-09-18');
    expect(mocks.load).toHaveBeenNthCalledWith(3, '2026-09-18');
    expect(view.container.querySelectorAll('details')).toHaveLength(2);
    expect(screen.getByText('Previous Club')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Older Statements' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('removes prior owner rows and ignores their late response after an account switch', async () => {
    const oldRefresh = deferred();
    mocks.load
      .mockResolvedValueOnce(page([statement('2026-09-18', 'Owner A Union')]))
      .mockReturnValueOnce(oldRefresh.promise)
      .mockResolvedValueOnce(page([statement('2026-09-17', 'Owner B Club')]));
    const view = render(<DiamondSpinStatements />);
    await screen.findByText('Owner A Union');
    await click('Refresh Statements');
    mocks.user = { id: 'owner-b' };
    view.rerender(<DiamondSpinStatements />);
    expect(screen.queryByText('Owner A Union')).not.toBeInTheDocument();
    await screen.findByText('Owner B Club');
    await act(async () =>
      oldRefresh.resolve(page([statement('2026-09-18', 'Stale Owner A Union')]))
    );
    expect(screen.queryByText('Stale Owner A Union')).not.toBeInTheDocument();
    expect(screen.getByText('Owner B Club')).toBeInTheDocument();
    expect(view.container.querySelectorAll('details')).toHaveLength(1);
    expect(mocks.load).toHaveBeenNthCalledWith(3, null);
  });

  it('does not load signed-out statements or reattach an old request after sign-out', async () => {
    mocks.user = null;
    const view = render(<DiamondSpinStatements />);
    expect(view.container).toBeEmptyDOMElement();
    expect(mocks.load).not.toHaveBeenCalled();
    const oldRequest = deferred();
    mocks.load.mockReturnValueOnce(oldRequest.promise);
    mocks.user = { id: 'owner-a' };
    view.rerender(<DiamondSpinStatements />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    mocks.user = null;
    view.rerender(<DiamondSpinStatements />);
    await act(async () => oldRequest.resolve(page([statement('2026-09-18')])));
    expect(view.container).toBeEmptyDOMElement();
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });
});
