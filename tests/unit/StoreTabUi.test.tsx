import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import StoreTab from '../../src/pages/marketplace/StoreTab';
import type { MarketplaceItem } from '../../src/pages/marketplace/marketplaceShared';

const item: MarketplaceItem = {
  id: 'premium-table-1',
  club_id: 'club-1',
  name: 'Broadcast Table',
  description: 'A Premium Tournament Table Finish.',
  category: 'Table Skins',
  price: 1200,
  stock: 8,
  grant_spec: { type: 'table_skin', theme_id: 'broadcast-table' },
};

function renderStore() {
  return render(
    <StoreTab
      clubId="club-1"
      userId="user-1"
      items={[item]}
      ownedItemIds={new Set()}
      balance={5000}
      onGoDiamonds={vi.fn()}
      isAdmin={false}
      loading={false}
      categories={[]}
      onGoManage={vi.fn()}
      onPurchased={vi.fn()}
    />
  );
}

function renderStoreWithBalance(balance: number) {
  return render(
    <StoreTab
      clubId="club-1"
      userId="user-1"
      items={[item]}
      ownedItemIds={new Set()}
      balance={balance}
      onGoDiamonds={vi.fn()}
      isAdmin={false}
      loading={false}
      categories={[]}
      onGoManage={vi.fn()}
      onPurchased={vi.fn()}
    />
  );
}

describe('StoreTab purchase experience', () => {
  it('opens an accessible purchase dialog with the complete item description', async () => {
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));

    const dialog = screen.getByRole('dialog', { name: 'Confirm Purchase' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('A Premium Tournament Table Finish.');
    expect(screen.getByText('Instant Account Delivery')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm Purchase' })).toHaveFocus()
    );
  });

  it('contains keyboard focus inside the purchase sheet and restores it after closing', async () => {
    renderStore();
    const buy = screen.getByRole('button', { name: 'Buy' });
    buy.focus();
    fireEvent.click(buy);

    const confirm = screen.getByRole('button', { name: 'Confirm Purchase' });
    const close = screen.getByRole('button', { name: 'Close Purchase' });
    await waitFor(() => expect(confirm).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();

    fireEvent.click(close);
    expect(buy).toHaveFocus();
  });

  it('focuses the close control when the unaffordable confirm action is disabled', async () => {
    renderStoreWithBalance(0);
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));

    expect(screen.getByRole('button', { name: 'Confirm Purchase' })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close Purchase' })).toHaveFocus()
    );
  });
});
