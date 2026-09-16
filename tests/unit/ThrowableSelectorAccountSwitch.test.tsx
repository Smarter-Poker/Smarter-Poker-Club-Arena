import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllowance: vi.fn(),
  useThrowable: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));

vi.mock('../../src/services/ThrowableService', () => ({
  throwableService: {
    getThrowablesByCategory: () => ({
      reactions: [],
      throws: [],
      sports: [],
      cheers: [],
      premium: [{ id: 'tomato', name: 'Tomato' }],
    }),
    getThrowAllowance: mocks.getAllowance,
    useThrowable: mocks.useThrowable,
  },
}));

vi.mock('../../src/components/table/ThrowableImage', () => ({
  ThrowableImage: () => null,
  preloadThrowableImages: vi.fn(),
}));

vi.mock('../../src/throwables/artwork', () => ({
  prepareThrowableArtwork: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn() }),
}));

vi.mock('../../src/components/common/DiamondTopUpToast', () => ({
  showDiamondTopUp: vi.fn(),
}));

vi.mock('../../src/services/SoundService', () => ({
  haptic: { light: vi.fn() },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { subscribe: mocks.subscribe },
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-router-dom')>();
  return { ...original, useNavigate: () => vi.fn() };
});

import { ThrowableSelector } from '../../src/components/table/ThrowableSelector';

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe('Throwable Selector Account Isolation', () => {
  it('ignores a late Lifetime allowance from the previous account', async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const ordinary = {
      isVip: false,
      unlimited: false,
      freeThrowsRemaining: 0,
      packThrowsRemaining: 0,
      diamondCost: 1,
    };
    const lifetime = {
      isVip: true,
      unlimited: true,
      freeThrowsRemaining: 0,
      packThrowsRemaining: 0,
      diamondCost: 0,
    };

    mocks.getAllowance.mockImplementationOnce(() => first).mockResolvedValueOnce(ordinary);

    const { rerender } = render(
      <ThrowableSelector userId="account-a" onSelect={vi.fn()} onClose={vi.fn()} />
    );
    rerender(<ThrowableSelector userId="account-b" onSelect={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('1 Each')).toBeTruthy());
    expect(screen.getByText('Get More Throwables')).toBeTruthy();

    await act(async () => {
      resolveFirst(lifetime);
      await first;
    });

    expect(screen.queryByText(/Lifetime VIP/)).toBeNull();
    expect(screen.getByText('1 Each')).toBeTruthy();
    expect(screen.getByText('Get More Throwables')).toBeTruthy();
  });

  it('does not deliver an in-flight throw to the callbacks for a replacement account', async () => {
    let resolveUse!: (value: unknown) => void;
    const pendingUse = new Promise((resolve) => {
      resolveUse = resolve;
    });
    const allowance = {
      isVip: false,
      unlimited: false,
      freeThrowsRemaining: 0,
      packThrowsRemaining: 0,
      diamondCost: 1,
    };
    const accountASelect = vi.fn();
    const accountAClose = vi.fn();
    const accountBSelect = vi.fn();
    const accountBClose = vi.fn();
    mocks.getAllowance.mockResolvedValue(allowance);
    mocks.useThrowable.mockReturnValueOnce(pendingUse);

    const { rerender } = render(
      <ThrowableSelector userId="account-a" onSelect={accountASelect} onClose={accountAClose} />
    );
    await waitFor(() => expect(screen.getByTitle('Tomato')).toBeTruthy());
    fireEvent.click(screen.getByTitle('Tomato'));
    await waitFor(() => expect(mocks.useThrowable).toHaveBeenCalledWith('account-a', 'tomato'));

    rerender(
      <ThrowableSelector userId="account-b" onSelect={accountBSelect} onClose={accountBClose} />
    );
    await waitFor(() => expect(screen.getByText('1 Each')).toBeTruthy());

    await act(async () => {
      resolveUse({ success: true, source: 'diamonds', diamondsSpent: 1 });
      await pendingUse;
    });

    expect(accountASelect).not.toHaveBeenCalled();
    expect(accountAClose).not.toHaveBeenCalled();
    expect(accountBSelect).not.toHaveBeenCalled();
    expect(accountBClose).not.toHaveBeenCalled();
    expect(mocks.getAllowance).toHaveBeenCalledTimes(2);
    expect(screen.getByText('1 Each')).toBeTruthy();
  });

  it('delivers only the authoritative receipt returned by the service after a retry', async () => {
    const allowance = {
      isVip: false,
      unlimited: false,
      freeThrowsRemaining: 0,
      packThrowsRemaining: 0,
      diamondCost: 1,
    };
    const onSelect = vi.fn();
    const onClose = vi.fn();
    mocks.getAllowance.mockResolvedValue(allowance);
    mocks.useThrowable
      .mockResolvedValueOnce({
        success: false,
        error: 'Could Not Send Reaction',
        retrySameRequest: true,
      })
      .mockResolvedValueOnce({ success: true, idempotent: true, requestId: 'receipt-a' });

    render(<ThrowableSelector userId="account-a" onSelect={onSelect} onClose={onClose} />);
    const tomato = await screen.findByTitle('Tomato');
    fireEvent.click(tomato);
    await waitFor(() => expect(mocks.useThrowable).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(tomato).not.toBeDisabled());

    fireEvent.click(tomato);
    await waitFor(() => expect(mocks.useThrowable).toHaveBeenCalledTimes(2));

    expect(mocks.useThrowable.mock.calls).toEqual([
      ['account-a', 'tomato'],
      ['account-a', 'tomato'],
    ]);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'tomato' }), 'receipt-a');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the selector mounted while a throw result is unresolved', async () => {
    let resolveUse!: (value: unknown) => void;
    const pendingUse = new Promise((resolve) => {
      resolveUse = resolve;
    });
    const allowance = {
      isVip: false,
      unlimited: false,
      freeThrowsRemaining: 0,
      packThrowsRemaining: 0,
      diamondCost: 1,
    };
    const onClose = vi.fn();
    mocks.getAllowance.mockResolvedValue(allowance);
    mocks.useThrowable.mockReturnValueOnce(pendingUse);

    render(<ThrowableSelector userId="account-a" onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.click(await screen.findByTitle('Tomato'));
    const close = screen.getByRole('button', { name: 'Close Throwable Selector' });
    const topUp = screen.getByRole('button', { name: 'Get More Throwables' });
    expect(close).toBeDisabled();
    expect(topUp).toBeDisabled();
    fireEvent.click(close);
    fireEvent.click(topUp);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveUse({ success: false, error: 'Try Again', retrySameRequest: true });
      await pendingUse;
    });
    await waitFor(() => expect(close).not.toBeDisabled());
  });

  it('forwards a recovered service receipt after the selector unmounts and reopens', async () => {
    const allowance = {
      isVip: false,
      unlimited: false,
      freeThrowsRemaining: 0,
      packThrowsRemaining: 0,
      diamondCost: 1,
    };
    mocks.getAllowance.mockResolvedValue(allowance);
    mocks.useThrowable
      .mockResolvedValueOnce({
        success: false,
        error: 'Could Not Confirm Reaction',
        retrySameRequest: true,
      })
      .mockResolvedValueOnce({ success: true, idempotent: true, requestId: 'receipt-reopen' });

    const first = render(
      <ThrowableSelector userId="account-a" onSelect={vi.fn()} onClose={vi.fn()} />
    );
    fireEvent.click(await screen.findByTitle('Tomato'));
    await waitFor(() => expect(mocks.useThrowable).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTitle('Tomato')).not.toBeDisabled());
    first.unmount();

    const onSelect = vi.fn();
    render(<ThrowableSelector userId="account-a" onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTitle('Tomato'));
    await waitFor(() => expect(mocks.useThrowable).toHaveBeenCalledTimes(2));

    expect(mocks.useThrowable.mock.calls).toEqual([
      ['account-a', 'tomato'],
      ['account-a', 'tomato'],
    ]);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tomato' }),
      'receipt-reopen'
    );
  });
});
