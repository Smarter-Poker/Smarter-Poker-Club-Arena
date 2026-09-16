import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentUser: { id: 'account-a' } as { id: string } | null,
  checkFeatureAccess: vi.fn(),
  purchaseFeature: vi.fn(),
  emit: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: mocks.currentUser }),
}));

vi.mock('../../src/services/VIPService', () => ({
  VIP_MONTHLY_ALLOWANCES: {},
  FEATURE_PRICING: { emoji_pack: { cost: 250 } },
  vipService: {
    checkFeatureAccess: mocks.checkFeatureAccess,
    purchaseFeature: mocks.purchaseFeature,
  },
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ info: mocks.info, error: mocks.error }),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mocks.emit, subscribe: mocks.subscribe },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { EmojiPicker } from '../../src/components/table/EmojiPicker';

afterEach(() => {
  cleanup();
  mocks.currentUser = { id: 'account-a' };
  vi.clearAllMocks();
});

describe('Emoji Picker Account Isolation', () => {
  it('shows the precise Diamond shortfall message from the normalized refusal', async () => {
    mocks.checkFeatureAccess.mockResolvedValue({ hasAccess: false });
    mocks.purchaseFeature.mockResolvedValue({
      success: false,
      alreadyOwned: false,
      charged: 0,
      error: 'Insufficient Diamonds',
    });

    render(<EmojiPicker isOpen onSelect={vi.fn()} onClose={vi.fn()} />);
    const premium = await screen.findByRole('button', { name: '🤑' });
    fireEvent.click(premium);

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('Not Enough Diamonds For The Emoji Pack.')
    );
    expect(mocks.error).not.toHaveBeenCalledWith('Could Not Buy The Emoji Pack. Please Try Again.');
  });

  it('ignores an old purchase without releasing or completing the replacement request', async () => {
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    const requestA = new Promise((resolve) => {
      resolveA = resolve;
    });
    const requestB = new Promise((resolve) => {
      resolveB = resolve;
    });
    const onSelectA = vi.fn();
    const onCloseA = vi.fn();
    const onSelectB = vi.fn();
    const onCloseB = vi.fn();
    mocks.checkFeatureAccess.mockResolvedValue({ hasAccess: false });
    mocks.purchaseFeature.mockReturnValueOnce(requestA).mockReturnValueOnce(requestB);

    const { rerender } = render(<EmojiPicker isOpen onSelect={onSelectA} onClose={onCloseA} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '🤑' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '🤑' }));
    expect(mocks.purchaseFeature).toHaveBeenCalledWith('account-a', 'emoji_pack');

    mocks.currentUser = { id: 'account-b' };
    rerender(<EmojiPicker isOpen onSelect={onSelectB} onClose={onCloseB} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '🤑' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '🤑' }));
    expect(mocks.purchaseFeature).toHaveBeenLastCalledWith('account-b', 'emoji_pack');

    await act(async () => {
      resolveA({ success: true, alreadyOwned: false, charged: 250 });
      await requestA;
    });

    expect(onSelectA).not.toHaveBeenCalled();
    expect(onCloseA).not.toHaveBeenCalled();
    expect(onSelectB).not.toHaveBeenCalled();
    expect(onCloseB).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '🤑' })).toBeDisabled();

    await act(async () => {
      resolveB({ success: true, alreadyOwned: false, charged: 250 });
      await requestB;
    });

    await waitFor(() => expect(onSelectB).toHaveBeenCalledWith('🤑'));
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(mocks.info).toHaveBeenCalledWith('250 Diamonds Charged For The Emoji Pack.');
    expect(mocks.emit).toHaveBeenCalledWith('ENTITLEMENTS_CHANGED', {
      userId: 'account-b',
      category: 'emote_pack',
      quantity: 1,
      source: 'diamond-purchase',
    });
  });

  it('locks free selection and backdrop close until the paid request is authoritative', async () => {
    let resolvePurchase!: (value: unknown) => void;
    const purchase = new Promise((resolve) => {
      resolvePurchase = resolve;
    });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    mocks.checkFeatureAccess.mockResolvedValue({ hasAccess: false });
    mocks.purchaseFeature.mockReturnValueOnce(purchase);

    const { container } = render(<EmojiPicker isOpen onSelect={onSelect} onClose={onClose} />);
    const premium = await screen.findByRole('button', { name: '🤑' });
    fireEvent.click(premium);

    const free = screen.getByRole('button', { name: '😀' });
    await waitFor(() => {
      expect(premium).toBeDisabled();
      expect(free).toBeDisabled();
    });

    fireEvent.click(free);
    const overlay = container.querySelector('.emoji-picker-overlay');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay!);

    expect(mocks.purchaseFeature).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolvePurchase({ success: true, alreadyOwned: false, charged: 250 });
      await purchase;
    });

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('🤑'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not restore an abandoned lock or stale completion after A To B To A', async () => {
    let resolveOriginalA!: (value: unknown) => void;
    const originalARequest = new Promise((resolve) => {
      resolveOriginalA = resolve;
    });
    const onSelectOriginalA = vi.fn();
    const onCloseOriginalA = vi.fn();
    const onSelectReturnedA = vi.fn();
    const onCloseReturnedA = vi.fn();
    mocks.checkFeatureAccess.mockResolvedValue({ hasAccess: false });
    mocks.purchaseFeature.mockReturnValueOnce(originalARequest);

    const { container, rerender } = render(
      <EmojiPicker isOpen onSelect={onSelectOriginalA} onClose={onCloseOriginalA} />
    );
    const premium = await screen.findByRole('button', { name: '🤑' });
    fireEvent.click(premium);
    await waitFor(() => expect(premium).toBeDisabled());

    mocks.currentUser = { id: 'account-b' };
    rerender(<EmojiPicker isOpen onSelect={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '🤑' })).not.toBeDisabled());

    mocks.currentUser = { id: 'account-a' };
    rerender(<EmojiPicker isOpen onSelect={onSelectReturnedA} onClose={onCloseReturnedA} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '🤑' })).not.toBeDisabled());

    const overlay = container.querySelector('.emoji-picker-overlay');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay!);
    expect(onCloseReturnedA).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOriginalA({ success: true, alreadyOwned: false, charged: 250 });
      await originalARequest;
    });

    expect(onSelectOriginalA).not.toHaveBeenCalled();
    expect(onCloseOriginalA).not.toHaveBeenCalled();
    expect(onSelectReturnedA).not.toHaveBeenCalled();
    expect(onCloseReturnedA).toHaveBeenCalledTimes(1);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('suppresses paid completion callbacks after an external close', async () => {
    let resolvePurchase!: (value: unknown) => void;
    const purchase = new Promise((resolve) => {
      resolvePurchase = resolve;
    });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    mocks.checkFeatureAccess.mockResolvedValue({ hasAccess: false });
    mocks.purchaseFeature.mockReturnValueOnce(purchase);

    const { rerender } = render(<EmojiPicker isOpen onSelect={onSelect} onClose={onClose} />);
    const premium = await screen.findByRole('button', { name: '🤑' });
    fireEvent.click(premium);
    await waitFor(() => expect(premium).toBeDisabled());

    rerender(<EmojiPicker isOpen={false} onSelect={onSelect} onClose={onClose} />);
    expect(screen.queryByRole('button', { name: '🤑' })).not.toBeInTheDocument();

    await act(async () => {
      resolvePurchase({ success: true, alreadyOwned: false, charged: 250 });
      await purchase;
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
