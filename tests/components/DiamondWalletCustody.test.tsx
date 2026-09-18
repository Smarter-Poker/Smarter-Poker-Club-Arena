import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  events: {} as Record<string, () => void>,
  balance: vi.fn(),
  history: vi.fn(),
  user: { id: 'wallet-owner' },
}));
vi.mock('../../src/services/DiamondCustodyService', () => ({
  getDiamondCustodyBalance: mocks.balance,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: mocks.user }),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscription: vi.fn() }));
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
    from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: mocks.history }) }) }) }),
  },
}));
import DiamondWalletModal from '../../src/components/wallet/DiamondWalletModal';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 'wallet-owner' };
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
  const row = (id: string) => ({
    id,
    type: 'purchase',
    amount: 10,
    description: id,
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
