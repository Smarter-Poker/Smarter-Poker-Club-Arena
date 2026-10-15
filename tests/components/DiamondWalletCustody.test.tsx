import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  events: {} as Record<string, () => void>,
  bus: {} as Record<string, (...args: any[]) => void>,
  balance: vi.fn(),
  history: vi.fn(),
  order: vi.fn(),
  cursor: vi.fn(),
  user: { id: 'wallet-owner' },
}));
vi.mock('../../src/services/DiamondCustodyService', () => ({
  getDiamondCustodyBalance: mocks.balance,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: mocks.user }),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: (event: string, callback: (...args: any[]) => void) => {
    mocks.bus[event] = callback;
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (event: string, callback: () => void) => {
      mocks.events[event] = callback;
      return () => {
        delete mocks.events[event];
      };
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }) },
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        order: (...args: unknown[]) => {
          mocks.order(...args);
          return query;
        },
        or: (...args: unknown[]) => {
          mocks.cursor(...args);
          return query;
        },
        limit: mocks.history,
      };
      return query;
    },
  },
}));
import DiamondWalletModal from '../../src/components/wallet/DiamondWalletModal';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 'wallet-owner' };
  mocks.bus = {};
  mocks.balance.mockResolvedValue({ available: 125, inPlay: 75 });
  mocks.history.mockResolvedValue({ data: [], error: null });
});
afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});
describe('wallet custody integration', () => {
  it('refreshes an incoming transfer from profile updates without an old balance', async () => {
    render(<DiamondWalletModal isOpen onClose={() => {}} />);
    await screen.findByText('125');
    mocks.balance.mockResolvedValueOnce({ available: 150, inPlay: 75 });
    await act(async () => mocks.events.PROFILE_UPDATED());
    expect(await screen.findByText('150')).toBeTruthy();
  });
  it('shows spendable and held funds separately alongside the history', async () => {
    render(<DiamondWalletModal isOpen onClose={() => {}} />);
    await screen.findByText('125');
    expect(screen.getByText('75')).toBeTruthy();
    expect(screen.getByText('Available Diamonds')).toBeTruthy();
    expect(screen.getByText('Diamonds In Play')).toBeTruthy();
    expect(screen.queryByText('200')).toBeNull();
    expect(await screen.findByText('No Transactions Yet')).toBeTruthy();
  });
  it('keeps history usable on balance failure and retries without inventing zero', async () => {
    mocks.balance.mockRejectedValueOnce(new Error('balance unavailable'));
    render(<DiamondWalletModal isOpen onClose={() => {}} />);
    const retry = await screen.findByRole('button', { name: 'Retry Balance' });
    expect(await screen.findByText('No Transactions Yet')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByText('125')).toBeTruthy();
    expect(screen.getByText('75')).toBeTruthy();
  });
  it('contains keyboard focus, closes with Escape, and restores the opener and page scroll', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open Diamond Wallet';
    document.body.appendChild(opener);
    opener.focus();
    document.body.style.overflow = 'auto';
    const onClose = vi.fn();

    const view = render(<DiamondWalletModal isOpen onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Diamond Wallet' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.body.style.overflow).toBe('hidden');

    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    expect(controls.length).toBeGreaterThan(1);

    controls[controls.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(controls[0]).toHaveFocus();

    controls[0].focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(controls[controls.length - 1]).toHaveFocus();

    const replacementClose = vi.fn();
    view.rerender(<DiamondWalletModal isOpen onClose={replacementClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(replacementClose).toHaveBeenCalledTimes(1);
    view.rerender(<DiamondWalletModal isOpen={false} onClose={replacementClose} />);

    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body.style.overflow).toBe('auto');
    opener.remove();
  });
});

describe('wallet history request ownership', () => {
  /* `player_line` is what the read returns and what the modal prints since
     phase 6 (the ledger speaks to the player): the raw `description` is the
     operator's record and never reaches a player, so a fixture that omits
     the computed column is not the row production serves. */
  const row = (id: string) => ({
    id,
    type: 'purchase',
    amount: 10,
    description: id,
    player_line: id,
    created_at: '2026-09-09T12:00:00Z',
  });
  it('ignores a previous account response that arrives after the new account history', async () => {
    let finishOld!: (value: unknown) => void;
    mocks.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    const close = () => {};
    const view = render(<DiamondWalletModal isOpen onClose={close} />);
    mocks.user = { id: 'next-owner' };
    mocks.history.mockResolvedValueOnce({ data: [row('New Account Receipt')], error: null });
    view.rerender(<DiamondWalletModal isOpen onClose={close} />);
    await screen.findByText('New Account Receipt');
    await act(async () => finishOld({ data: [row('Old Account Receipt')], error: null }));
    expect(screen.queryByText('Old Account Receipt')).toBeNull();
    expect(screen.getByText('New Account Receipt')).toBeTruthy();
  });
  it('ignores an earlier open when it resolves after closing and reopening', async () => {
    let finishOld!: (value: unknown) => void;
    mocks.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    const close = () => {};
    const view = render(<DiamondWalletModal isOpen onClose={close} />);
    view.rerender(<DiamondWalletModal isOpen={false} onClose={close} />);
    mocks.history.mockResolvedValueOnce({ data: [row('Latest Receipt')], error: null });
    view.rerender(<DiamondWalletModal isOpen onClose={close} />);
    await screen.findByText('Latest Receipt');
    await act(async () => finishOld({ data: null, error: new Error('old request failed') }));
    expect(screen.queryByText('Could Not Load Your Diamond History')).toBeNull();
    expect(screen.getByText('Latest Receipt')).toBeTruthy();
  });
});

const receipts = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: '10000000-0000-0000-0000-' + ('000000000000' + (1000 - i).toString(16)).slice(-12),
    type: 'arena_deposit',
    transaction_type: 'arena_deposit',
    amount: -1,
    player_line: 'Receipt ' + i,
    balance_after: 999 - i,
    created_at: '2026-10-15T12:00:00.000Z',
  }));
describe('Diamond history continues beyond the first page', () => {
  it('loads older receipts using both timestamp and ID without dropping the first page', async () => {
    const page = receipts(50);
    mocks.history.mockResolvedValueOnce({ data: page, error: null });
    render(<DiamondWalletModal isOpen onClose={() => {}} />);
    const more = await screen.findByRole('button', { name: 'Show Earlier Transactions' });
    mocks.history.mockResolvedValueOnce({
      data: [
        {
          ...receipts(1)[0],
          id: '10000000-0000-0000-0000-000000000001',
          player_line: 'Older Receipt',
        },
      ],
      error: null,
    });
    fireEvent.click(more);
    expect(await screen.findByText('Older Receipt')).toBeTruthy();
    expect(screen.getByText('Receipt 0')).toBeTruthy();
    expect(mocks.order).toHaveBeenCalledWith('id', { ascending: false });
    expect(mocks.cursor).toHaveBeenCalledWith(
      'created_at.lt.2026-10-15T12:00:00.000Z,and(created_at.eq.2026-10-15T12:00:00.000Z,id.lt.' +
        page[49].id +
        ')'
    );
    expect(screen.queryByRole('button', { name: 'Show Earlier Transactions' })).toBeNull();
  });
  it('retains loaded receipts after an older-page error and retries the same cursor', async () => {
    mocks.history.mockResolvedValueOnce({ data: receipts(50), error: null });
    render(<DiamondWalletModal isOpen onClose={() => {}} />);
    const more = await screen.findByRole('button', { name: 'Show Earlier Transactions' });
    mocks.history.mockResolvedValueOnce({ data: null, error: { message: 'read unavailable' } });
    fireEvent.click(more);
    await screen.findByText('Could Not Load Earlier Transactions');
    expect(screen.getByText('Receipt 0')).toBeTruthy();
    expect(screen.queryByText('No Transactions Yet')).toBeNull();
    mocks.history.mockResolvedValueOnce({ data: [], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Show Earlier Transactions' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Show Earlier Transactions' })).toBeNull()
    );
    expect(mocks.cursor.mock.calls[0]).toEqual(mocks.cursor.mock.calls[1]);
    expect(screen.getByText('Receipt 0')).toBeTruthy();
  });
  it('does not let repeated clicks acquire two page requests', async () => {
    mocks.history.mockResolvedValueOnce({ data: receipts(50), error: null });
    render(<DiamondWalletModal isOpen onClose={() => {}} />);
    const more = await screen.findByRole('button', { name: 'Show Earlier Transactions' });
    let finish!: (value: unknown) => void;
    mocks.history.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    fireEvent.click(more);
    fireEvent.click(more);
    expect(mocks.history).toHaveBeenCalledTimes(2);
    await act(async () => finish({ data: [], error: null }));
  });
});

it('rejects a late older page after a balance refresh starts a newer history read', async () => {
  mocks.history.mockResolvedValueOnce({ data: receipts(50), error: null });
  render(<DiamondWalletModal isOpen onClose={() => {}} />);
  const more = await screen.findByRole('button', { name: 'Show Earlier Transactions' });
  let finish!: (value: unknown) => void;
  mocks.history.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  fireEvent.click(more);
  mocks.history.mockResolvedValueOnce({
    data: [{ ...receipts(1)[0], player_line: 'Newest Receipt' }],
    error: null,
  });
  await act(async () => mocks.bus.DIAMOND_BALANCE_CHANGED());
  await screen.findByText('Newest Receipt');
  await act(async () =>
    finish({ data: [{ ...receipts(1)[0], player_line: 'Stale Older Receipt' }], error: null })
  );
  expect(screen.queryByText('Stale Older Receipt')).toBeNull();
  expect(screen.getByText('Newest Receipt')).toBeTruthy();
});
it('never appends the previous identity history after the account changes', async () => {
  mocks.history.mockResolvedValueOnce({ data: receipts(50), error: null });
  const view = render(<DiamondWalletModal isOpen onClose={() => {}} />);
  const more = await screen.findByRole('button', { name: 'Show Earlier Transactions' });
  let finish!: (value: unknown) => void;
  mocks.history.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  fireEvent.click(more);
  mocks.user = { id: 'next-wallet-owner' };
  mocks.history.mockResolvedValueOnce({
    data: [{ ...receipts(1)[0], player_line: 'New Owner Receipt' }],
    error: null,
  });
  view.rerender(<DiamondWalletModal isOpen onClose={() => {}} />);
  await screen.findByText('New Owner Receipt');
  await act(async () =>
    finish({ data: [{ ...receipts(1)[0], player_line: 'Previous Owner Receipt' }], error: null })
  );
  expect(screen.queryByText('Previous Owner Receipt')).toBeNull();
  expect(screen.queryByText('Receipt 0')).toBeNull();
  expect(screen.getByText('New Owner Receipt')).toBeTruthy();
});
