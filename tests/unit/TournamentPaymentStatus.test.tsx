import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TournamentPayment,
  TournamentPaymentPage,
} from '../../src/services/TournamentPaymentService';
const mocks = vi.hoisted(() => ({
  getPayments: vi.fn(),
  user: { id: 'player' } as { id: string } | null,
  generation: 0,
  guards: new Map<string, () => boolean>(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: mocks.user }) }));
vi.mock('../../src/hooks/useCashoutScope', () => ({
  useCashoutScope: (accountId: string | undefined) => {
    const generation = mocks.generation;
    const key = `${accountId ?? 'none'}:${generation}`;
    const guard =
      mocks.guards.get(key) ??
      (() => mocks.generation === generation && mocks.user?.id === accountId);
    mocks.guards.set(key, guard);
    return guard;
  },
  useCashoutScopeKey: (accountId: string | undefined, view: string) =>
    JSON.stringify([accountId, view, mocks.generation]),
}));
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
  mocks.generation = 0;
  mocks.guards.clear();
});
afterEach(cleanup);

describe('Tournament Payment Status', () => {
  it('renders actual paid, partial and owed amounts in compact chips with satellite transfers', async () => {
    mocks.getPayments.mockResolvedValue({
      payments: [
        {
          ...payment('Paid Final', 'paid', 12.5, 0),
          createdAt: '2026-09-09T21:04:00.123456+00:00',
        },
        {
          ...payment('Partial Final', 'partially_paid', 2.25, 10.25),
          createdAt: '2026-09-09T21:03:00.123456+00:00',
        },
        {
          ...payment('Owed Final', 'owed'),
          createdAt: '2026-09-09T21:02:00.123456+00:00',
        },
        {
          ...payment('Satellite Final', 'paid', 50, 0),
          kind: 'seat',
          createdAt: '2026-09-09T21:01:00.123456+00:00',
        },
      ],
      next: null,
    });
    render(<TournamentPaymentStatus tournamentId="event" />);
    const partial = (await screen.findByText('Partial Final')).closest('li')!;
    expect(within(partial).getByText('Partially Paid')).toBeTruthy();
    expect(within(partial).getByText('Paid: 2')).toBeTruthy();
    expect(within(partial).getByText('Owed: 10')).toBeTruthy();
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
    expect(await screen.findByText('Earlier')).toBeTruthy();
    expect(screen.getByText('Recent')).toBeTruthy();
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
    mocks.generation += 1;
    view.rerender(<TournamentPaymentStatus />);
    await screen.findByText('New Account Record');
    await act(async () =>
      resolveOld({ payments: [payment('Private Old Record', 'paid')], next: null })
    );
    expect(screen.queryByText('Private Old Record')).toBeNull();
    mocks.user = null;
    mocks.generation += 1;
    view.rerender(<TournamentPaymentStatus />);
    expect(screen.queryByText('New Account Record')).toBeNull();
  });

  it('retires a late load-more page across an A to B to A account generation', async () => {
    const cursor = { id: 'recent', createdAt: payment('recent', 'paid').createdAt };
    let resolveEarlier!: (value: TournamentPaymentPage) => void;
    mocks.getPayments
      .mockResolvedValueOnce({ payments: [payment('recent', 'paid', 1, 0)], next: cursor })
      .mockImplementationOnce(
        () =>
          new Promise<TournamentPaymentPage>((resolve) => {
            resolveEarlier = resolve;
          })
      )
      .mockResolvedValueOnce({ payments: [payment('Other Account', 'owed')], next: null })
      .mockResolvedValueOnce({ payments: [payment('Current Account', 'owed')], next: null });
    const view = render(<TournamentPaymentStatus />);
    fireEvent.click(await screen.findByText('Load Earlier Payment Records'));
    await waitFor(() => expect(mocks.getPayments).toHaveBeenCalledTimes(2));

    mocks.user = { id: 'other-player' };
    mocks.generation += 1;
    view.rerender(<TournamentPaymentStatus />);
    mocks.user = { id: 'player' };
    mocks.generation += 1;
    view.rerender(<TournamentPaymentStatus />);
    expect(await screen.findByText('Current Account')).toBeTruthy();
    await act(async () => {
      resolveEarlier({ payments: [payment('Private Earlier', 'owed')], next: null });
    });
    expect(screen.queryByText('Private Earlier')).toBeNull();
    expect(screen.getByText('Current Account')).toBeTruthy();
  });

  it('rejects malformed and duplicated success pages instead of claiming no payments', async () => {
    mocks.getPayments.mockResolvedValueOnce({
      payments: [payment('Duplicate', 'owed'), payment('Duplicate', 'owed')],
      next: null,
    });
    render(<TournamentPaymentStatus />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Payment Status Could Not Be Loaded'
    );
    expect(
      screen.queryByText('No Payment Records Available. Payment Status Is Unconfirmed.')
    ).toBeNull();
  });

  it('keeps sub-chip truth and compact whole-chip display on the painted console', async () => {
    mocks.getPayments.mockResolvedValueOnce({
      payments: [payment('Micro Final', 'partially_paid', 1200.5, 0.5)],
      next: null,
    });
    render(<TournamentPaymentStatus />);
    const row = (await screen.findByText('Micro Final')).closest('li')!;
    expect(within(row).getByText('Paid: 1.2K')).toBeTruthy();
    expect(within(row).getByText('Owed: Under 1 Chip')).toBeTruthy();
    expect(document.querySelector('.sc--family-shark')).toBeTruthy();
  });
});
