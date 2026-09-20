import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const callClubArenaApiMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/clubArenaApi', () => ({
  callClubArenaApi: callClubArenaApiMock,
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: toastSuccessMock, error: toastErrorMock }),
}));

import StoreTab, { verifiedMarketplacePurchaseReceipt } from '../../src/pages/marketplace/StoreTab';
import type { MarketplaceItem } from '../../src/pages/marketplace/marketplaceShared';
import { clearSessionPurchaseRequestId } from '../../src/utils/sessionPurchaseRequest';

const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const PURCHASE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const PURCHASE_SCOPE = `club-shop:${USER_ID}:club-1:${ITEM_ID}:qty=1`;
const BUY_BUTTON = /Buy Broadcast Table With Diamonds/;
const CONFIRM_BUTTON = /Confirm Broadcast Table Purchase With Diamonds/;
const VERIFY_BUTTON = /Verify Broadcast Table Purchase With Diamonds/;

const item: MarketplaceItem = {
  id: ITEM_ID,
  club_id: 'club-1',
  name: 'Broadcast Table',
  description: 'A Premium Tournament Table Finish.',
  category: 'Table Skins',
  item_type: 'table_skin',
  price: 1200,
  stock: 8,
  grant_spec: { type: 'table_skin', theme_id: 'broadcast-table' },
};

const validReceipt = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  purchaseId: PURCHASE_ID,
  requestId: REQUEST_ID,
  accountId: USER_ID,
  clubId: 'club-1',
  itemId: ITEM_ID,
  newBalance: 3800,
  currency: 'diamonds',
  pricePaid: 1200,
  duplicate: false,
  item: { name: item.name, type: item.item_type },
  ...overrides,
});

const exactReceiptForCall = (
  options: { idempotencyKey: string },
  overrides: Record<string, unknown> = {}
) => validReceipt({ ...overrides, requestId: options.idempotencyKey });

describe('Marketplace purchase receipt verification', () => {
  const expected = {
    accountId: USER_ID,
    requestId: REQUEST_ID,
    clubId: 'club-1',
    itemId: ITEM_ID,
    name: item.name,
    itemType: item.item_type || '',
    price: 1200,
  };

  it('accepts only the exact safe server receipt', () => {
    expect(verifiedMarketplacePurchaseReceipt(validReceipt(), expected)).toEqual(validReceipt());
  });

  it.each([
    { purchaseId: 'not-a-uuid' },
    { requestId: '66666666-6666-4666-8666-666666666666' },
    { accountId: '44444444-4444-4444-8444-444444444444' },
    { clubId: 'another-club' },
    { itemId: '33333333-3333-4333-8333-333333333333' },
    { newBalance: -1 },
    { newBalance: 1.5 },
    { currency: 'chips' },
    { pricePaid: 1199 },
    { duplicate: 'false' },
    { item: { name: 'Another Item', type: item.item_type } },
    { item: { name: item.name, type: 'throwable' } },
  ])('rejects an invalid successful receipt %#', (override) => {
    expect(verifiedMarketplacePurchaseReceipt(validReceipt(override), expected)).toBeNull();
  });
});

function renderStore() {
  return render(
    <StoreTab
      clubId="club-1"
      userId={USER_ID}
      items={[item]}
      ownedItemIds={new Set()}
      balance={5000}
      onGoDiamonds={vi.fn()}
      isAdmin={false}
      loading={false}
      categories={[]}
      onGoManage={vi.fn()}
      onCatalogStale={vi.fn()}
      onPurchased={vi.fn()}
    />
  );
}

function renderStoreWithBalance(balance: number) {
  return render(
    <StoreTab
      clubId="club-1"
      userId={USER_ID}
      items={[item]}
      ownedItemIds={new Set()}
      balance={balance}
      onGoDiamonds={vi.fn()}
      isAdmin={false}
      loading={false}
      categories={[]}
      onGoManage={vi.fn()}
      onCatalogStale={vi.fn()}
      onPurchased={vi.fn()}
    />
  );
}

describe('StoreTab purchase experience', () => {
  beforeEach(() => {
    callClubArenaApiMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    sessionStorage.clear();
    clearSessionPurchaseRequestId(PURCHASE_SCOPE);
  });

  it('opens an accessible purchase dialog with the complete item description', async () => {
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));

    const dialog = screen.getByRole('dialog', { name: 'Confirm Purchase' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('A Premium Tournament Table Finish.');
    expect(screen.getByText('Instant Account Delivery')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: CONFIRM_BUTTON })).toHaveFocus());
  });

  it('contains keyboard focus inside the purchase sheet and restores it after closing', async () => {
    renderStore();
    const buy = screen.getByRole('button', { name: BUY_BUTTON });
    buy.focus();
    fireEvent.click(buy);

    const confirm = screen.getByRole('button', { name: CONFIRM_BUTTON });
    const close = screen.getByRole('button', { name: 'Close Purchase' });
    await waitFor(() => expect(confirm).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();

    fireEvent.click(close);
    expect(buy).toHaveFocus();
  });

  it('aborts an old account request and suppresses all of its replacement-account UI effects', async () => {
    let resolvePurchase!: (receipt: ReturnType<typeof validReceipt>) => void;
    callClubArenaApiMock.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof validReceipt>>((resolve) => {
          resolvePurchase = resolve;
        })
    );
    const onPurchased = vi.fn();
    const view = render(
      <StoreTab
        clubId="club-1"
        userId={USER_ID}
        items={[item]}
        ownedItemIds={new Set()}
        balance={5000}
        onGoDiamonds={vi.fn()}
        isAdmin={false}
        loading={false}
        categories={[]}
        onGoManage={vi.fn()}
        onCatalogStale={vi.fn()}
        onPurchased={onPurchased}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(1));
    const requestOptions = callClubArenaApiMock.mock.calls[0][2];
    expect(requestOptions.expectedUserId).toBe(USER_ID);

    view.rerender(
      <StoreTab
        clubId="club-1"
        userId="44444444-4444-4444-8444-444444444444"
        items={[item]}
        ownedItemIds={new Set()}
        balance={9000}
        onGoDiamonds={vi.fn()}
        isAdmin={false}
        loading={false}
        categories={[]}
        onGoManage={vi.fn()}
        onCatalogStale={vi.fn()}
        onPurchased={onPurchased}
      />
    );
    expect(requestOptions.signal.aborted).toBe(true);

    resolvePurchase(validReceipt({ requestId: requestOptions.idempotencyKey }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Confirm Purchase' })).not.toBeInTheDocument()
    );
    expect(onPurchased).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it('focuses the close control when the unaffordable confirm action is disabled', async () => {
    renderStoreWithBalance(0);
    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));

    expect(screen.getByRole('button', { name: CONFIRM_BUTTON })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close Purchase' })).toHaveFocus()
    );
  });

  it('binds the confirmed price and refreshes after a stale-price rejection', async () => {
    const stale = Object.assign(new Error('The price changed'), {
      status: 409,
      data: { reason: 'price_changed', currentPrice: 1300, expectedPrice: 1200 },
    });
    callClubArenaApiMock.mockRejectedValueOnce(stale);
    const onCatalogStale = vi.fn();

    render(
      <StoreTab
        clubId="club-1"
        userId={USER_ID}
        items={[item]}
        ownedItemIds={new Set()}
        balance={5000}
        onGoDiamonds={vi.fn()}
        isAdmin={false}
        loading={false}
        categories={[]}
        onGoManage={vi.fn()}
        onCatalogStale={onCatalogStale}
        onPurchased={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_BUTTON }));

    await waitFor(() =>
      expect(callClubArenaApiMock).toHaveBeenCalledWith(
        'marketplace-purchase',
        { clubId: 'club-1', itemId: item.id, expectedPrice: 1200 },
        expect.objectContaining({ idempotencyKey: expect.any(String) })
      )
    );
    await waitFor(() => expect(onCatalogStale).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'Confirm Purchase' })).not.toBeInTheDocument();
  });

  it('replays one protected key after an ambiguous result, close, and reopen', async () => {
    callClubArenaApiMock
      .mockRejectedValueOnce(Object.assign(new Error('Network Lost'), { status: 503 }))
      .mockImplementationOnce((_route, _body, options) =>
        Promise.resolve(exactReceiptForCall(options))
      );
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_BUTTON }));
    await waitFor(() => expect(screen.getByRole('button', { name: VERIFY_BUTTON })).toBeEnabled());
    const firstKey = callClubArenaApiMock.mock.calls[0][2].idempotencyKey;

    fireEvent.click(screen.getByRole('button', { name: 'Close Purchase' }));
    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: VERIFY_BUTTON }));

    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(2));
    expect(callClubArenaApiMock.mock.calls[1][2].idempotencyKey).toBe(firstKey);
    expect(callClubArenaApiMock.mock.calls[1][1]).toEqual({
      clubId: 'club-1',
      itemId: item.id,
      expectedPrice: 1200,
    });
  });

  it('recovers the same protected key after an ambiguous result and remount', async () => {
    callClubArenaApiMock.mockRejectedValueOnce(
      Object.assign(new Error('Response Lost'), { status: 503 })
    );
    const firstRender = renderStore();
    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_BUTTON }));
    await waitFor(() => expect(screen.getByRole('button', { name: VERIFY_BUTTON })).toBeEnabled());
    const firstKey = callClubArenaApiMock.mock.calls[0][2].idempotencyKey;
    firstRender.unmount();

    callClubArenaApiMock.mockImplementationOnce((_route, _body, options) =>
      Promise.resolve(exactReceiptForCall(options, { duplicate: true }))
    );
    renderStore();
    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: VERIFY_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(2));
    expect(callClubArenaApiMock.mock.calls[1][2].idempotencyKey).toBe(firstKey);
  });

  it('retires a definitive refusal before the next attempt', async () => {
    callClubArenaApiMock
      .mockRejectedValueOnce(
        Object.assign(new Error('Insufficient Diamonds'), {
          status: 400,
          definitive: true,
        })
      )
      .mockImplementationOnce((_route, _body, options) =>
        Promise.resolve(exactReceiptForCall(options))
      );
    renderStore();
    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: CONFIRM_BUTTON })).toBeEnabled());
    const firstKey = callClubArenaApiMock.mock.calls[0][2].idempotencyKey;

    fireEvent.click(screen.getByRole('button', { name: CONFIRM_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(2));
    expect(callClubArenaApiMock.mock.calls[1][2].idempotencyKey).not.toBe(firstKey);
  });

  it('retains a resumed key after a definitive refusal until exact success is verified', async () => {
    callClubArenaApiMock
      .mockRejectedValueOnce(Object.assign(new Error('Response Lost'), { status: 503 }))
      .mockRejectedValueOnce(
        Object.assign(new Error('Insufficient Diamonds'), {
          status: 400,
          definitive: true,
        })
      )
      .mockImplementationOnce((_route, _body, options) =>
        Promise.resolve(exactReceiptForCall(options, { duplicate: true }))
      );
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_BUTTON }));
    await waitFor(() => expect(screen.getByRole('button', { name: VERIFY_BUTTON })).toBeEnabled());
    const protectedKey = callClubArenaApiMock.mock.calls[0][2].idempotencyKey;

    fireEvent.click(screen.getByRole('button', { name: VERIFY_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: VERIFY_BUTTON })).toBeEnabled());
    expect(callClubArenaApiMock.mock.calls[1][2].idempotencyKey).toBe(protectedKey);

    fireEvent.click(screen.getByRole('button', { name: VERIFY_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(3));
    expect(callClubArenaApiMock.mock.calls[2][2].idempotencyKey).toBe(protectedKey);
  });

  it('retains a resumed key after a price change until exact success is verified', async () => {
    callClubArenaApiMock
      .mockRejectedValueOnce(Object.assign(new Error('Response Lost'), { status: 503 }))
      .mockRejectedValueOnce(
        Object.assign(new Error('The Price Changed'), {
          status: 409,
          data: { reason: 'price_changed', currentPrice: 1300, expectedPrice: 1200 },
        })
      )
      .mockImplementationOnce((_route, _body, options) =>
        Promise.resolve(exactReceiptForCall(options, { duplicate: true }))
      );
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_BUTTON }));
    await waitFor(() => expect(screen.getByRole('button', { name: VERIFY_BUTTON })).toBeEnabled());
    const protectedKey = callClubArenaApiMock.mock.calls[0][2].idempotencyKey;

    fireEvent.click(screen.getByRole('button', { name: VERIFY_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: VERIFY_BUTTON })).toBeEnabled());
    expect(callClubArenaApiMock.mock.calls[1][2].idempotencyKey).toBe(protectedKey);

    fireEvent.click(screen.getByRole('button', { name: VERIFY_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(3));
    expect(callClubArenaApiMock.mock.calls[2][2].idempotencyKey).toBe(protectedKey);
  });

  it('keeps the protected key when a nominal success body has an invalid receipt', async () => {
    callClubArenaApiMock
      .mockImplementationOnce((_route, _body, options) =>
        Promise.resolve(exactReceiptForCall(options, { pricePaid: 1199 }))
      )
      .mockImplementationOnce((_route, _body, options) =>
        Promise.resolve(exactReceiptForCall(options))
      );
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_BUTTON }));
    await waitFor(() => expect(screen.getByRole('button', { name: VERIFY_BUTTON })).toBeEnabled());
    const firstKey = callClubArenaApiMock.mock.calls[0][2].idempotencyKey;
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: VERIFY_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(2));
    expect(callClubArenaApiMock.mock.calls[1][2].idempotencyKey).toBe(firstKey);
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith(`Purchased ${item.name}`));
    expect(sessionStorage.length).toBe(0);
  });

  it('retains the protected key when a reference conflict does not prove no write', async () => {
    callClubArenaApiMock
      .mockRejectedValueOnce(
        Object.assign(new Error('Purchase Reference Conflict'), {
          status: 409,
          data: { reason: 'reference_conflict', code: 'IDEMPOTENCY_CONFLICT' },
        })
      )
      .mockImplementationOnce((_route, _body, options) =>
        Promise.resolve(exactReceiptForCall(options))
      );
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: VERIFY_BUTTON })).toBeEnabled());
    const firstKey = callClubArenaApiMock.mock.calls[0][2].idempotencyKey;

    fireEvent.click(screen.getByRole('button', { name: VERIFY_BUTTON }));
    await waitFor(() => expect(callClubArenaApiMock).toHaveBeenCalledTimes(2));
    expect(callClubArenaApiMock.mock.calls[1][2].idempotencyKey).toBe(firstKey);
  });

  it('does not create a purchase intent when a fresh confirmation is cancelled', () => {
    renderStore();
    fireEvent.click(screen.getByRole('button', { name: BUY_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(callClubArenaApiMock).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });
});
