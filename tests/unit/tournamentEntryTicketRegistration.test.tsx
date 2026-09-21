import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  findTicket: vi.fn(),
  navigate: vi.fn(),
  readBalance: vi.fn(),
  registerPlayer: vi.fn(),
  reportError: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: {
    findTournamentEntryTicket: mocks.findTicket,
    registerPlayer: mocks.registerPlayer,
  },
}));

vi.mock('../../src/context/InTabLobbyContext', () => ({
  useAppNavigate: () => mocks.navigate,
}));

vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'user-1', username: 'Player' } }),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: { readPlayerBalance: mocks.readBalance },
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  }),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mocks.emit },
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));

import { SignUpHost } from '../../src/components/tournament/signUpDialog';
import { useTournamentRegistration } from '../../src/hooks/useTournamentRegistration';

const tournament = {
  id: 'tournament-1',
  name: 'Sunday Major',
  buy_in_amount: 100,
  buy_in_fee: 10,
  start_time: '2030-01-01T20:00:00.000Z',
  status: 'REGISTERING',
  club_id: 'club-1',
};

describe('human tournament registration with entry-only tickets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findTicket.mockResolvedValue(null);
    mocks.readBalance.mockResolvedValue({ balance: 500 });
    mocks.registerPlayer.mockResolvedValue({ id: 'registration-1', table_id: 'table-1' });
  });

  it('waits for the selector, shows Tournament Ticket, and passes its exact id', async () => {
    let resolveTicket!: (ticket: { id: string; value: number }) => void;
    mocks.findTicket.mockReturnValue(
      new Promise((resolve) => {
        resolveTicket = resolve;
      })
    );
    render(<SignUpHost />);
    const hook = renderHook(() => useTournamentRegistration());

    let registration!: Promise<void>;
    act(() => {
      registration = hook.result.current.register(tournament);
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => {
      resolveTicket({ id: 'ticket-exact-1', value: 110 });
    });

    expect(await screen.findByText('Tournament Ticket')).toBeInTheDocument();
    // The console prints the row label without a colon: label left, value right.
    expect(screen.queryByText('Your Balance')).not.toBeInTheDocument();
    expect(mocks.readBalance).not.toHaveBeenCalled();
    expect(
      screen.getByText('You Can Unregister Any Time Before The Tournament Starts')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await act(async () => registration);

    expect(mocks.registerPlayer).toHaveBeenCalledWith(
      'tournament-1',
      'user-1',
      'Player',
      'ticket-exact-1'
    );
    expect(mocks.emit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
    expect(mocks.navigate).toHaveBeenCalledWith('/table/table-1');
  });

  it('fails closed before confirmation when the ticket selector errors', async () => {
    mocks.findTicket.mockRejectedValue(
      new Error('Could Not Check For A Tournament Ticket. No Chips Were Charged.')
    );
    render(<SignUpHost />);
    const hook = renderHook(() => useTournamentRegistration());

    await act(async () => {
      await hook.result.current.register(tournament);
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.registerPlayer).not.toHaveBeenCalled();
    expect(mocks.readBalance).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Could Not Check For A Tournament Ticket. No Chips Were Charged.'
    );
  });

  it('keeps a no-ticket registration on the ordinary wallet path', async () => {
    render(<SignUpHost />);
    const hook = renderHook(() => useTournamentRegistration());

    let registration!: Promise<void>;
    act(() => {
      registration = hook.result.current.register(tournament);
    });

    expect(await screen.findByText('Entry Fee')).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.readBalance).toHaveBeenCalledWith('user-1', { clubId: 'club-1' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await act(async () => registration);

    expect(mocks.registerPlayer).toHaveBeenCalledWith('tournament-1', 'user-1', 'Player', null);
    expect(mocks.emit).toHaveBeenCalledWith('BALANCE_UPDATED', {
      source: 'tournament_buy_in',
      userId: 'user-1',
      tournamentId: 'tournament-1',
    });
  });
});
