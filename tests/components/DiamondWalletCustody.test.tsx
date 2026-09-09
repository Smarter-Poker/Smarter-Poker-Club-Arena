import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ balance: vi.fn(), history: vi.fn() }));
vi.mock('../../src/services/DiamondCustodyService', () => ({
  getDiamondCustodyBalance: mocks.balance,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'wallet-owner' } }),
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
