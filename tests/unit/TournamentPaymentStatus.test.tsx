import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TournamentPayment,
  TournamentPaymentPage,
} from '../../src/services/TournamentPaymentService';
const mocks = vi.hoisted(() => ({
  getPayments: vi.fn(),
  user: { id: 'player' } as { id: string } | null,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: mocks.user }) }));
vi.mock('../../src/services/TournamentPaymentService', () => ({
  getMyTournamentPayments: mocks.getPayments,
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import TournamentPaymentStatus from '../../src/components/tournament/TournamentPaymentStatus';

const payment = (
  id: string,
  state: TournamentPayment['state'],
  paid = 0,
  remaining = 12.5
): TournamentPayment => ({
  id,
  tournamentId: 'event',
  tournamentName: id,
  clubId: 'club',
  kind: 'place',
  amountOwed: paid + remaining,
  amountPaid: paid,
  remaining,
  state,
  createdAt: '2026-09-09T21:00:00.123456+00:00',
  updatedAt: '2026-09-09T21:00:00+00:00',
});
beforeEach(() => {
  mocks.getPayments.mockReset();
  mocks.user = { id: 'player' };
});
afterEach(cleanup);

describe('Tournament Payment Status', () => {
  it('renders actual paid, partial and owed amounts, including cents and satellite transfers', async () => {
    mocks.getPayments.mockResolvedValue({
      payments: [
        payment('Paid Final', 'paid', 12.5, 0),
        payment('Partial Final', 'partially_paid', 2.25, 10.25),
        payment('Owed Final', 'owed'),
        { ...payment('Satellite Final', 'paid', 50, 0), kind: 'seat' },
      ],
      next: null,
    });
    render(<TournamentPaymentStatus tournamentId="event" />);
    const partial = (await screen.findByText('Partial Final')).closest('li')!;
    expect(within(partial).getByText('Partially Paid')).toBeTruthy();
    expect(within(partial).getByText('Paid: 2.25')).toBeTruthy();
    expect(within(partial).getByText('Owed: 10.25')).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.getByText('Owed')).toBeTruthy();
    expect(screen.getByText('Transferred: 50')).toBeTruthy();
  });

  it('shows a failed read as an error and retries without claiming payment', async () => {
    mocks.getPayments
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ payments: [], next: null });
    render(<TournamentPaymentStatus />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Paid')).toBeNull();
    fireEvent.click(screen.getByText('Refresh'));
    expect(
      await screen.findByText('No Payment Records Available. Payment Status Is Unconfirmed.')
    ).toBeTruthy();
  });

  it('appends earlier records using the precise cursor and keeps the club scope', async () => {
    const cursor = { id: 'recent', createdAt: payment('recent', 'paid').createdAt };
    mocks.getPayments
      .mockResolvedValueOnce({ payments: [payment('recent', 'paid', 1, 0)], next: cursor })
      .mockResolvedValueOnce({ payments: [payment('earlier', 'owed')], next: null });
    render(<TournamentPaymentStatus clubId="club" />);
    fireEvent.click(await screen.findByText('Load Earlier Payment Records'));
    expect(await screen.findByText('earlier')).toBeTruthy();
    expect(screen.getByText('recent')).toBeTruthy();
    expect(mocks.getPayments).toHaveBeenLastCalledWith(
      'player',
      { tournamentId: undefined, clubId: 'club' },
      cursor
    );
    expect(screen.queryByText('Load Earlier Payment Records')).toBeNull();
  });

  it('removes the prior account immediately and ignores its late response', async () => {
    let resolveOld!: (value: TournamentPaymentPage) => void;
    mocks.getPayments
      .mockImplementationOnce(
        () =>
          new Promise<TournamentPaymentPage>((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce({ payments: [payment('New Account Record', 'owed')], next: null });
    const view = render(<TournamentPaymentStatus />);
    mocks.user = { id: 'new-player' };
    view.rerender(<TournamentPaymentStatus />);
    await screen.findByText('New Account Record');
    await act(async () =>
      resolveOld({ payments: [payment('Private Old Record', 'paid')], next: null })
    );
    expect(screen.queryByText('Private Old Record')).toBeNull();
    mocks.user = null;
    view.rerender(<TournamentPaymentStatus />);
    expect(screen.queryByText('New Account Record')).toBeNull();
  });
});
