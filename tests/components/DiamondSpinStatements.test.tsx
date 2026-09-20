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
