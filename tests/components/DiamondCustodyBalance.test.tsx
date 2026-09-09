import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  balance: vi.fn(),
  auth: vi.fn(),
  unsubscribe: vi.fn(),
  subscribe: vi.fn(),
  off: vi.fn(),
}));
vi.mock('../../src/services/DiamondCustodyService', () => ({
  getDiamondCustodyBalance: mocks.balance,
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { onAuthStateChange: mocks.auth } },
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { subscribe: mocks.subscribe } }));
import DiamondCustodyBalance from '../../src/components/arena/DiamondCustodyBalance';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockReturnValue({ data: { subscription: { unsubscribe: mocks.unsubscribe } } });
  mocks.subscribe.mockReturnValue(mocks.off);
  mocks.balance.mockResolvedValue({ available: 900, inPlay: 100 });
});
describe('Diamond custody balances', () => {
  it('renders available and held amounts from the authoritative response', async () => {
    render(<DiamondCustodyBalance />);
    expect(await screen.findByText('900')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
  });
  it('clears stale balances on failure and retries', async () => {
    const page = render(<DiamondCustodyBalance />);
    await screen.findByText('900');
    mocks.balance.mockRejectedValueOnce(new Error('offline'));
    fireEvent.focus(window);
    const retry = await screen.findByRole('button', { name: 'Retry Balance' });
    expect(screen.queryByText('900')).toBeNull();
    fireEvent.click(retry);
    await screen.findByText('900');
    page.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalled();
    expect(mocks.off).toHaveBeenCalled();
  });
  it('refreshes on a diamond mutation without trusting the event amount', async () => {
    render(<DiamondCustodyBalance />);
    await screen.findByText('900');
    mocks.balance.mockResolvedValue({ available: 800, inPlay: 200 });
    const listener = mocks.subscribe.mock.calls.find((c) => c[0] === 'DIAMOND_BALANCE_CHANGED')![1];
    act(() => listener({ payload: { newBalance: 99999 } }));
    await screen.findByText('800');
    expect(screen.getByText('200')).toBeTruthy();
  });
  it('rejects an old-account response after sign-out', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.balance.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveOld = r;
        })
    );
    render(<DiamondCustodyBalance />);
    act(() => mocks.auth.mock.calls[0][0]('SIGNED_OUT'));
    await act(async () => resolveOld({ available: 999, inPlay: 1 }));
    expect(screen.queryByText('999')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry Balance' })).toBeTruthy();
  });
  it('clears the previous identity immediately and reads after the auth callback', async () => {
    let resolveNew!: (value: unknown) => void;
    render(<DiamondCustodyBalance />);
    await screen.findByText('900');
    mocks.balance.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveNew = r;
        })
    );
    act(() => mocks.auth.mock.calls[0][0]('SIGNED_IN'));
    expect(screen.queryByText('900')).toBeNull();
    await waitFor(() => expect(mocks.balance).toHaveBeenCalledTimes(2));
    await act(async () => resolveNew({ available: 25, inPlay: 0 }));
    await screen.findByText('25');
  });
});
