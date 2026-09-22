/**
 * THE SIGN UP CARD SPEAKS THE UNIT THE ENTRY IS PRICED IN (2026-09-21).
 *
 * Every registration path funnels through one card, and none of its six
 * callers hands it the tournament's arena. So a Diamond bounty event offered a
 * "Chips" head, and - because `fn_player_spendable_balance` falls back to the
 * player's home chip club when the arena has no member row - it printed a chip
 * balance, gated Confirm on it and offered the chip cashier.
 *
 * The hook now reads the unit off the tournament's own arena, beside the
 * ticket lookup, and the card:
 *   - at a chip event, reads exactly as it did (head, balance, gate, note);
 *   - at a Diamond event, names the head in Diamonds and reads no chip wallet;
 *   - when the unit could not be read, shows its own unknown mark for the head,
 *     reads no wallet and leaves the gate to the server (R7).
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  findTicket: vi.fn(),
  navigate: vi.fn(),
  readBalance: vi.fn(),
  readUnit: vi.fn(),
  registerPlayer: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: {
    findTournamentEntryTicket: mocks.findTicket,
    readTournamentUnitCents: mocks.readUnit,
    registerPlayer: mocks.registerPlayer,
  },
}));
vi.mock('../../src/context/InTabLobbyContext', () => ({ useAppNavigate: () => mocks.navigate }));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'user-1', username: 'Player' } }),
}));
vi.mock('../../src/services/WalletService', () => ({
  WalletService: { readPlayerBalance: mocks.readBalance },
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));

import { SignUpHost } from '../../src/components/tournament/signUpDialog';
import { useTournamentRegistration } from '../../src/hooks/useTournamentRegistration';
import { CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

const bountyEvent = {
  id: 'tournament-1',
  name: 'Bounty Builder',
  buy_in_amount: 100,
  buy_in_fee: 10,
  bounty_amount: 5,
  start_time: '2030-01-01T20:00:00.000Z',
  status: 'REGISTERING',
  club_id: 'club-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findTicket.mockResolvedValue(null);
  mocks.readBalance.mockResolvedValue({ balance: 500, source: 'rpc' });
  mocks.registerPlayer.mockResolvedValue({ id: 'registration-1', table_id: 'table-1' });
});

afterEach(cleanup);

/** Open the card through the one path every surface uses, and return it. */
async function openCard(unit: number | null) {
  mocks.readUnit.mockResolvedValue(unit);
  render(<SignUpHost />);
  const hook = renderHook(() => useTournamentRegistration());
  act(() => {
    void hook.result.current.register(bountyEvent);
  });
  const dialog = await screen.findByRole('dialog');
  expect(mocks.readUnit).toHaveBeenCalledWith('tournament-1');
  return dialog;
}

const head = (dialog: HTMLElement) =>
  dialog.querySelector('.signup-value--bounty')?.textContent ?? null;

describe('the sign up card speaks the unit the entry is priced in', () => {
  it('a chip event reads exactly as before: head, balance and the chip wallet', async () => {
    const dialog = await openCard(CHIP_UNIT_CENTS);
    expect(head(dialog)).toBe('5 Chips');
    await waitFor(() =>
      expect(mocks.readBalance).toHaveBeenCalledWith('user-1', { clubId: 'club-1' })
    );
    await waitFor(() => expect(dialog.textContent).toContain('500 Chips'));
    expect(screen.getByText('Your Balance')).toBeInTheDocument();
  });

  it('a chip event that cannot afford the entry is still gated on the chip wallet', async () => {
    mocks.readBalance.mockResolvedValue({ balance: 50, source: 'rpc' });
    const dialog = await openCard(CHIP_UNIT_CENTS);
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        'Insufficient Balance. Please Add Chips Via Your Cashier.'
      )
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('a Diamond event names the head in Diamonds and reads no chip wallet', async () => {
    mocks.readBalance.mockResolvedValue({ balance: 0, source: 'rpc' });
    const dialog = await openCard(DIAMOND_UNIT_CENTS);
    expect(head(dialog)).toBe('5 Diamonds');
    // Give a wallet read every chance to have started, then prove it did not.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.readBalance).not.toHaveBeenCalled();
    expect(screen.queryByText('Your Balance')).toBeNull();
    expect(dialog.textContent).not.toMatch(/Chips/);
    expect(dialog.textContent).not.toContain('Insufficient Balance');
    // The Diamond door is the gate, and it answers in Diamonds.
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.registerPlayer).toHaveBeenCalledWith('tournament-1', 'user-1', 'Player', null)
    );
  });

  it('an unread unit shows the unknown mark and leaves the gate to the server', async () => {
    const dialog = await openCard(null);
    expect(head(dialog)).toBe('--');
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.readBalance).not.toHaveBeenCalled();
    expect(dialog.textContent).not.toMatch(/Chips|Diamonds/);
    expect(screen.getByRole('button', { name: 'Confirm' })).not.toBeDisabled();
  });

  it('the unit is read beside the ticket lookup, never after the card is on screen', async () => {
    let resolveTicket!: (ticket: null) => void;
    mocks.findTicket.mockReturnValue(
      new Promise((resolve) => {
        resolveTicket = resolve;
      })
    );
    mocks.readUnit.mockResolvedValue(DIAMOND_UNIT_CENTS);
    render(<SignUpHost />);
    const hook = renderHook(() => useTournamentRegistration());
    act(() => {
      void hook.result.current.register(bountyEvent);
    });
    await waitFor(() => expect(mocks.readUnit).toHaveBeenCalledWith('tournament-1'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => resolveTicket(null));
    const dialog = await screen.findByRole('dialog');
    expect(head(dialog)).toBe('5 Diamonds');
  });
});
