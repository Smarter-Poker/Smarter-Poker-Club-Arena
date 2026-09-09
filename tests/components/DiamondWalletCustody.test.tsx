import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
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
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { subscribe: () => () => {} } }));
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
describe('wallet custody integration', () => {
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
