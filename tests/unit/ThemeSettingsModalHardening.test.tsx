import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  themeResult: Promise.resolve({ data: [], error: null }) as Promise<{
    data: unknown[];
    error: unknown;
  }>,
  purchaseResult: Promise.resolve({ data: [], error: null }) as Promise<{
    data: unknown[];
    error: unknown;
  }>,
  unlockResult: Promise.resolve({ data: [], error: null }) as Promise<{
    data: unknown[];
    error: unknown;
  }>,
  pricingResult: Promise.resolve({ data: [], error: null }) as Promise<{
    data: unknown[];
    error: unknown;
  }>,
  rpc: vi.fn(),
  applyAppearance: vi.fn(),
  persistMode: vi.fn(),
  navigate: vi.fn(),
  themeListeners: new Set<(event: { payload: unknown }) => void>(),
  entitlementInsert: null as null | ((payload: { new: Record<string, unknown> }) => void),
  entitlementStatus: null as null | ((status: string) => void),
  autoEntitlementSubscribe: true,
  removeChannel: vi.fn(),
  loadDiamonds: vi.fn(),
  themeSelect: '',
  collections: {
    favorites: [] as string[],
    loadouts: [null, null, null] as Array<Record<string, string> | null>,
    recent: [] as string[],
    syncState: 'synced' as 'local' | 'loading' | 'synced' | 'error',
    realtimeState: 'live' as 'local' | 'connecting' | 'live' | 'error',
    toggleFavorite: vi.fn(),
    saveLoadout: vi.fn(),
    renameLoadout: vi.fn(),
    clearLoadout: vi.fn(),
    retrySync: vi.fn(),
    rememberRecent: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: vi.fn((type: string, listener: (event: { payload: unknown }) => void) => {
      if (type === 'UI_THEME_CHANGED') mocks.themeListeners.add(listener);
      return () => mocks.themeListeners.delete(listener);
    }),
    emit: vi.fn((type: string, payload: unknown) => {
      if (type !== 'UI_THEME_CHANGED') return;
      for (const listener of mocks.themeListeners) listener({ payload });
    }),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => mocks.toast,
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: vi.fn(),
}));

vi.mock('../../src/services/AvatarService', () => ({
  avatarService: {
    getAvatarLibraryResult: vi.fn().mockResolvedValue({ avatars: [] }),
  },
}));

vi.mock('../../src/hooks/useTableStudioCollections', () => ({
  useTableStudioCollections: () => mocks.collections,
}));

vi.mock('../../src/components/table/TableStudioGameplayPreview', () => ({
  default: ({
    selection,
  }: {
    selection: {
      table_id: string;
      background_id: string;
      button_id: string;
      cards_id: string;
    };
  }) => (
    <div
      data-testid="gameplay-preview"
      data-table-theme={selection.table_id}
      data-background-theme={selection.background_id}
      data-button-theme={selection.button_id}
      data-card-back={selection.cards_id}
    />
  ),
}));

vi.mock('../../src/components/vip/DiamondTopUpModal', () => ({
  DiamondTopUpModal: ({
    isOpen,
    onClose,
    returnParams,
  }: {
    isOpen: boolean;
    onClose: () => void;
    returnParams?: string;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label="Diamond Store" data-return-params={returnParams}>
        <button onClick={onClose}>Close Diamond Store</button>
      </div>
    ) : null,
}));

vi.mock('../../src/lib/applyTableAppearance', () => ({
  applyTableAppearance: mocks.applyAppearance,
}));

vi.mock('../../src/lib/persistInterfaceTheme', () => ({
  persistInterfaceTheme: mocks.persistMode,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      const result = () =>
        table === 'user_theme_settings'
          ? mocks.themeResult
          : table === 'feature_pricing'
            ? mocks.pricingResult
            : table === 'theme_asset_unlocks'
              ? mocks.unlockResult
              : mocks.purchaseResult;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = vi.fn((columns: string) => {
        if (table === 'user_theme_settings') mocks.themeSelect = columns;
        return builder;
      });
      for (const method of ['eq', 'like']) builder[method] = vi.fn(chain);
      builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        result().then(resolve, reject);
      return builder;
    }),
    rpc: mocks.rpc,
    channel: vi.fn((name: string) => {
      const isEntitlementChannel = name.startsWith('table-studio-entitlements:');
      const channel = {
        on: vi.fn(
          (
            _event: string,
            _filter: Record<string, unknown>,
            handler: (payload: { new: Record<string, unknown> }) => void
          ) => {
            if (isEntitlementChannel) mocks.entitlementInsert = handler;
            return channel;
          }
        ),
        subscribe: vi.fn((listener: (status: string) => void) => {
          if (isEntitlementChannel) mocks.entitlementStatus = listener;
          if (!isEntitlementChannel || mocks.autoEntitlementSubscribe) listener('SUBSCRIBED');
          return channel;
        }),
      };
      return channel;
    }),
    removeChannel: mocks.removeChannel,
  },
}));

import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { useWalletStore } from '../../src/stores/useWalletStore';
import { ThemeSettingsModal } from '../../src/components/table/ThemeSettingsModal';
import { masterBus } from '../../src/core/MasterBus';
import {
  readTableStudioCheckoutIntent,
  rememberTableStudioCheckoutIntent,
} from '../../src/lib/tableStudioCheckoutResume';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const savedTheme = {
  game_type: 'ALL',
  theme_id: 'default-dark',
  table_id: 'classic_green',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'classic_red',
};

function renderStudio(checkoutReturnResult: 'success' | 'canceled' | null = null) {
  return render(
    <ThemeSettingsModal
      isOpen
      onClose={vi.fn()}
      userId="user-1"
      isVip={false}
      checkoutReturnResult={checkoutReturnResult}
    />
  );
}

describe('ThemeSettingsModal hardening', () => {
  beforeEach(() => {
    mocks.themeResult = Promise.resolve({ data: [savedTheme], error: null });
    mocks.purchaseResult = Promise.resolve({ data: [], error: null });
    mocks.unlockResult = Promise.resolve({ data: [], error: null });
    mocks.pricingResult = Promise.resolve({
      data: [
        { feature: 'studio:table_id:neon_city', diamond_cost: 350 },
        { feature: 'card_back_gold', diamond_cost: 150 },
      ],
      error: null,
    });
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: { success: true, cost: 350 }, error: null });
    mocks.applyAppearance.mockReset();
    mocks.applyAppearance.mockResolvedValue({ ok: true });
    mocks.persistMode.mockReset();
    mocks.persistMode.mockResolvedValue({ ok: true });
    mocks.navigate.mockReset();
    mocks.entitlementInsert = null;
    mocks.entitlementStatus = null;
    mocks.autoEntitlementSubscribe = true;
    mocks.removeChannel.mockReset();
    mocks.loadDiamonds.mockReset();
    mocks.loadDiamonds.mockResolvedValue(undefined);
    mocks.themeSelect = '';
    mocks.collections.favorites = [];
    mocks.collections.loadouts = [null, null, null];
    mocks.collections.recent = [];
    mocks.collections.syncState = 'synced';
    mocks.collections.realtimeState = 'live';
    for (const method of [
      mocks.collections.toggleFavorite,
      mocks.collections.saveLoadout,
      mocks.collections.renameLoadout,
      mocks.collections.clearLoadout,
      mocks.collections.retrySync,
      mocks.collections.rememberRecent,
    ]) {
      method.mockReset();
    }
    for (const method of Object.values(mocks.toast)) method.mockReset();
    useSettingsStore.setState({ theme: 'dark' });
    useWalletStore.setState({
      diamonds: 1_000,
      loadDiamonds: mocks.loadDiamonds,
    });
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/table/test-table');
  });

  it('keeps customization choices disabled until the saved row is known', async () => {
    const pendingTheme = deferred<{ data: unknown[]; error: null }>();
    mocks.themeResult = pendingTheme.promise;
    renderStudio();

    expect(await screen.findByText('Loading Your Saved Design')).toBeVisible();
    expect(screen.getByRole('button', { name: 'House Classic' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Shuffle Look' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore Defaults' })).toBeDisabled();

    await act(async () => {
      pendingTheme.resolve({ data: [savedTheme], error: null });
      await pendingTheme.promise;
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    expect(screen.queryByText('Loading Your Saved Design')).not.toBeInTheDocument();
  });

  it('renders a named visual loadout and wires equip, rename, and guarded clear', async () => {
    mocks.collections.loadouts = [
      {
        theme_id: 'default-dark',
        table_id: 'classic_green',
        button_id: 'classic-white',
        background_id: 'midnight',
        cards_id: 'classic_red',
        name: 'Main Event',
        saved_at: '2026-08-29T22:00:00.000Z',
      },
      null,
      null,
    ];
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );

    const locker = screen.getByRole('region', { name: 'My Looks' });
    const firstLook = within(locker).getAllByRole('listitem')[0];
    const name = within(firstLook).getByRole('textbox', { name: 'Name For Look 1' });
    expect(name).toHaveValue('Main Event');

    fireEvent.click(within(firstLook).getByRole('button', { name: 'Equip' }));
    await waitFor(() =>
      expect(mocks.applyAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ table_id: 'classic_green', background_id: 'midnight' }),
        expect.objectContaining({ userId: 'user-1', gameType: 'ALL' })
      )
    );

    fireEvent.change(name, { target: { value: 'Sunday Final' } });
    fireEvent.blur(name);
    expect(mocks.collections.renameLoadout).toHaveBeenCalledWith(0, 'Sunday Final');

    fireEvent.click(within(firstLook).getByRole('button', { name: 'Clear' }));
    expect(within(firstLook).getByText('Clear This Look?')).toBeVisible();
    fireEvent.click(within(firstLook).getByRole('button', { name: 'Clear' }));
    expect(mocks.collections.clearLoadout).toHaveBeenCalledWith(0);
  });

  it('surfaces a failed collection channel and reconnects it from the locker', async () => {
    mocks.collections.realtimeState = 'error';
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );

    expect(screen.getByText('Review Sync')).toBeVisible();
    const retry = screen.getByRole('button', { name: 'Retry Sync' });
    fireEvent.click(retry);

    expect(mocks.collections.retrySync).toHaveBeenCalledTimes(1);
  });

  it('loads row timestamps so the editor matches last-write-wins gameplay precedence', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );

    expect(mocks.themeSelect).toContain('updated_at');
  });

  it('does not present a purchased card back as VIP-locked while ownership loads', async () => {
    const pendingOwnership = deferred<{ data: unknown[]; error: null }>();
    mocks.purchaseResult = pendingOwnership.promise;
    renderStudio();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Cards' }));

    expect(screen.getByRole('button', { name: 'Premium Gold, Checking Ownership' })).toBeDisabled();
    expect(screen.getByText('Checking Your Purchases And Rewards')).toBeVisible();

    await act(async () => {
      pendingOwnership.resolve({ data: [{ feature: 'card_back_gold' }], error: null });
      await pendingOwnership.promise;
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Premium Gold' })).toBeEnabled());
  });

  it('keeps premium card backs unavailable when ownership cannot be verified', async () => {
    mocks.purchaseResult = Promise.resolve({
      data: [],
      error: { code: '42501', message: 'ownership query failed' },
    });
    renderStudio();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Cards' }));

    expect(await screen.findByText('Purchases Could Not Be Verified')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Premium Gold, Ownership Unavailable' })
    ).toBeDisabled();
  });

  it('shows a retryable catalog failure instead of leaving paid prices silently unavailable', async () => {
    mocks.pricingResult = Promise.resolve({
      data: [],
      error: { code: '42501', message: 'pricing query failed' },
    });
    renderStudio();

    expect(await screen.findByText('Purchase Prices Could Not Be Loaded')).toBeVisible();
    mocks.pricingResult = Promise.resolve({
      data: [{ feature: 'studio:table_id:neon_city', diamond_cost: 350 }],
      error: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));

    await waitFor(() =>
      expect(screen.queryByText('Purchase Prices Could Not Be Loaded')).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }));
    expect(screen.getByText('350 ◆')).toBeVisible();
  });

  it('surfaces and reconnects a failed entitlement realtime channel', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );

    act(() => mocks.entitlementStatus?.('CHANNEL_ERROR'));
    expect(await screen.findByText('Live Unlock Updates Are Disconnected')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() => expect(mocks.removeChannel).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText('Live Unlock Updates Are Disconnected')).not.toBeInTheDocument()
    );
  });

  it('treats checkout as its own dialog and Escape closes only checkout', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }));

    const locked = screen
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-label')?.includes('Purchase Or VIP Required'));
    expect(locked).toBeDefined();
    fireEvent.click(locked!);

    const purchaseDialog = await screen.findByRole('dialog', { name: 'Unlock Neon City' });
    expect(purchaseDialog).toBeVisible();
    expect(screen.getByRole('button', { name: /Buy For 350/ })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Unlock Neon City' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('dialog', { name: 'Make The Table Yours' })).toBeVisible();
  });

  it('purchases and auto-applies a premium felt through its exact server SKU', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }));
    fireEvent.click(screen.getByRole('button', { name: 'Neon City, Purchase Or VIP Required' }));
    fireEvent.click(await screen.findByRole('button', { name: /Buy For 350/ }));

    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('fn_purchase_feature', {
        p_user_id: 'user-1',
        p_feature: 'studio:table_id:neon_city',
      })
    );
    await waitFor(() =>
      expect(mocks.applyAppearance).toHaveBeenCalledWith(
        { table_id: 'neon_city' },
        expect.objectContaining({ userId: 'user-1', gameType: 'ALL' })
      )
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Neon City Purchased And Applied');
  });

  it('turns a short diamond balance into a working store continuation', async () => {
    useWalletStore.setState({ diamonds: 100 });
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }));
    fireEvent.click(screen.getByRole('button', { name: 'Neon City, Purchase Or VIP Required' }));

    const addDiamonds = await screen.findByRole('button', { name: 'Add 250 Diamonds' });
    await waitFor(() => expect(addDiamonds).toBeEnabled());
    fireEvent.click(addDiamonds);

    const store = await screen.findByRole('dialog', { name: 'Diamond Store' });
    expect(store).toBeVisible();
    expect(store).toHaveAttribute('data-return-params', 'from=table-studio');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('restores the exact locked design after Stripe and waits for the credited balance', async () => {
    useWalletStore.setState({ diamonds: 0 });
    rememberTableStudioCheckoutIntent({
      userId: 'user-1',
      tab: 'table',
      assetId: 'neon_city',
    });
    window.history.replaceState(
      {},
      '',
      '/table/test-table?club=club-1&from=table-studio&purchase=success'
    );

    renderStudio('success');

    expect(await screen.findByRole('dialog', { name: 'Unlock Neon City' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Syncing Diamond Balance...' })).toBeDisabled();
    expect(mocks.loadDiamonds).toHaveBeenCalledWith('user-1', { force: true });
    expect(mocks.toast.success).toHaveBeenCalledWith('Payment Received. Restoring Neon City.');
    expect(window.location.search).toBe('?club=club-1');

    act(() => useWalletStore.setState({ diamonds: 500 }));
    expect(await screen.findByRole('button', { name: /Buy For 350/ })).toBeEnabled();
  });

  it('does not let a hidden duplicate modal consume the global Stripe return', async () => {
    rememberTableStudioCheckoutIntent({
      userId: 'user-1',
      tab: 'table',
      assetId: 'neon_city',
    });
    window.history.replaceState({}, '', '/settings?from=table-studio&purchase=success');

    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );

    expect(screen.queryByRole('dialog', { name: 'Unlock Neon City' })).not.toBeInTheDocument();
    expect(readTableStudioCheckoutIntent('user-1')).not.toBeNull();
  });

  it('keeps the Pending design available after a canceled Stripe checkout', async () => {
    rememberTableStudioCheckoutIntent({
      userId: 'user-1',
      tab: 'table',
      assetId: 'neon_city',
    });
    window.history.replaceState({}, '', '/table/test-table?from=table-studio&purchase=canceled');

    renderStudio('canceled');

    expect(await screen.findByRole('dialog', { name: 'Unlock Neon City' })).toBeVisible();
    expect(mocks.toast.info).toHaveBeenCalledWith(
      'Checkout Canceled. No Charge Was Made; Your Design Is Still Waiting.'
    );
    expect(mocks.loadDiamonds).not.toHaveBeenCalledWith('user-1', { force: true });
  });

  it('opens the Diamond Store if the server rejects a stale balance as insufficient', async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: false, error: 'insufficient_diamonds' },
      error: null,
    });
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }));
    fireEvent.click(screen.getByRole('button', { name: 'Neon City, Purchase Or VIP Required' }));
    fireEvent.click(await screen.findByRole('button', { name: /Buy For 350/ }));

    expect(await screen.findByRole('dialog', { name: 'Diamond Store' })).toBeVisible();
    expect(mocks.toast.info).toHaveBeenCalledWith('Add Diamonds To Finish Unlocking This Design.');
  });

  it('unlocks an already-open catalog when another device delivers an entitlement', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }));
    expect(
      screen.getByRole('button', { name: 'Neon City, Purchase Or VIP Required' })
    ).toBeEnabled();

    act(() => {
      mocks.entitlementInsert?.({
        new: { user_id: 'user-1', category: 'table_id', asset_id: 'neon_city' },
      });
    });

    expect(await screen.findByRole('button', { name: 'Neon City' })).toBeEnabled();
  });

  it('repairs a missed entitlement in the authoritative snapshot after realtime activity', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    expect(
      screen.getByRole('button', { name: 'Neon Ice, Purchase Or VIP Required' })
    ).toBeEnabled();

    // Simulate a burst where Postgres Changes delivers one component row but
    // the composite theme row itself is dropped. The event is only the wakeup;
    // the subsequent server snapshot is the durable ownership truth.
    mocks.unlockResult = Promise.resolve({
      data: [
        { category: 'table_id', asset_id: 'neon_city' },
        { category: 'theme_id', asset_id: 'neon-blue' },
      ],
      error: null,
    });
    act(() => {
      mocks.entitlementInsert?.({
        new: { user_id: 'user-1', category: 'table_id', asset_id: 'neon_city' },
      });
    });

    expect(
      await screen.findByRole('button', { name: 'Neon Ice' }, { timeout: 2_000 })
    ).toBeEnabled();
    expect(screen.getByText('Table Art Live')).toBeVisible();
  });

  it('repairs ownership when a sleeping tab missed the entire realtime burst', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    expect(
      screen.getByRole('button', { name: 'Neon Ice, Purchase Or VIP Required' })
    ).toBeEnabled();

    mocks.unlockResult = Promise.resolve({
      data: [{ category: 'theme_id', asset_id: 'neon-blue' }],
      error: null,
    });

    expect(
      await screen.findByRole('button', { name: 'Neon Ice' }, { timeout: 3_000 })
    ).toBeEnabled();
    expect(screen.getByText('Table Art Live')).toBeVisible();
  });

  it('never re-locks verified designs while a background reconciliation is in flight', async () => {
    mocks.unlockResult = Promise.resolve({
      data: [{ category: 'theme_id', asset_id: 'neon-blue' }],
      error: null,
    });
    renderStudio();
    expect(await screen.findByRole('button', { name: 'Neon Ice' })).toBeEnabled();

    const refresh = deferred<{ data: unknown[]; error: unknown }>();
    mocks.unlockResult = refresh.promise;
    act(() => {
      mocks.entitlementInsert?.({
        new: { user_id: 'user-1', category: 'table_id', asset_id: 'neon_city' },
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(screen.getByRole('button', { name: 'Neon Ice' })).toBeEnabled();
    expect(screen.getByText('Table Art Live')).toBeVisible();
    await act(async () => {
      refresh.resolve({
        data: [
          { category: 'theme_id', asset_id: 'neon-blue' },
          { category: 'table_id', asset_id: 'neon_city' },
        ],
        error: null,
      });
      await refresh.promise;
    });
  });

  it('reconciles ownership after subscription before declaring Table Art live', async () => {
    mocks.autoEntitlementSubscribe = false;
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );

    expect(screen.getByText('Linking...')).toBeVisible();
    expect(screen.queryByText('Table Art Live')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }));
    expect(
      screen.getByRole('button', { name: 'Neon City, Purchase Or VIP Required' })
    ).toBeEnabled();

    mocks.unlockResult = Promise.resolve({
      data: [{ category: 'table_id', asset_id: 'neon_city' }],
      error: null,
    });
    act(() => mocks.entitlementStatus?.('SUBSCRIBED'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Neon City' })).toBeEnabled());
    expect(await screen.findByText('Table Art Live')).toBeVisible();
  });

  it('clears ownership loading when a slow snapshot succeeds during a newer refresh', async () => {
    mocks.autoEntitlementSubscribe = false;
    renderStudio();
    const studio = await screen.findByRole('dialog', { name: 'Make The Table Yours' });
    const grid = studio.querySelector('.theme-modal__grid');
    expect(grid).not.toBeNull();
    await waitFor(() => expect(grid).toHaveAttribute('aria-busy', 'false'));

    const firstRefresh = deferred<{ data: unknown[]; error: null }>();
    mocks.unlockResult = firstRefresh.promise;
    act(() => mocks.entitlementStatus?.('SUBSCRIBED'));
    await waitFor(() => expect(grid).toHaveAttribute('aria-busy', 'true'));

    // Keep the next periodic reconciliation pending. The first valid snapshot
    // is no longer the newest request when it returns, but it still proves the
    // same user's monotonic ownership ledger is readable and must clear busy.
    const newerRefresh = deferred<{ data: unknown[]; error: null }>();
    await act(async () => {
      mocks.unlockResult = newerRefresh.promise;
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    });
    await act(async () => {
      firstRefresh.resolve({ data: [], error: null });
      await firstRefresh.promise;
    });

    await waitFor(() => expect(grid).toHaveAttribute('aria-busy', 'false'));

    await act(async () => {
      newerRefresh.resolve({ data: [], error: null });
      await newerRefresh.promise;
    });
  });

  it('does not claim a completed purchase was applied when the appearance save fails', async () => {
    mocks.applyAppearance.mockResolvedValue({ ok: false, error: new Error('save failed') });
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }));
    fireEvent.click(screen.getByRole('button', { name: 'Neon City, Purchase Or VIP Required' }));
    fireEvent.click(await screen.findByRole('button', { name: /Buy For 350/ }));

    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Neon City Purchased'));
    expect(mocks.toast.success).not.toHaveBeenCalledWith('Neon City Purchased And Applied');
    expect(mocks.toast.error).toHaveBeenCalledWith('Could Not Save Your Theme. Please Try Again.');
  });

  it('applies interface mode immediately and persists it to the signed-in account', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));

    expect(useSettingsStore.getState().theme).toBe('light');
    await waitFor(() => expect(mocks.persistMode).toHaveBeenCalledWith('user-1', 'light'));
  });

  it('rolls interface mode back when account persistence fails', async () => {
    mocks.persistMode.mockResolvedValue({ ok: false, error: new Error('write failed') });
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));

    await waitFor(() => expect(useSettingsStore.getState().theme).toBe('dark'));
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Could Not Save Interface Mode. Please Try Again.'
    );
  });

  it('keeps an open studio synchronized with live changes for the same account and bucket', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );

    act(() => {
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { button_id: 'blue-crystal', cards_id: 'classic_blue' },
        userId: 'user-1',
      });
    });

    expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
      'data-button-theme',
      'blue-crystal'
    );
    expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
      'data-card-back',
      'classic_blue'
    );

    act(() => {
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { button_id: 'red-d-gear' },
        userId: 'somebody-else',
      });
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'PLO',
        value: { button_id: 'gray-d-gear' },
        userId: 'user-1',
      });
    });

    expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
      'data-button-theme',
      'blue-crystal'
    );
  });

  it('repairs an open studio when the appearance realtime event was entirely missed', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );
    expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
      'data-table-theme',
      'classic_green'
    );

    mocks.themeResult = Promise.resolve({
      data: [
        {
          ...savedTheme,
          theme_id: 'ocean-suite',
          table_id: 'ocean_blue',
          background_id: 'royal_indigo',
          button_id: 'classic-white',
          cards_id: 'classic_blue',
          updated_at: '2026-08-31T13:30:00.000Z',
        },
      ],
      error: null,
    });

    await waitFor(
      () =>
        expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
          'data-table-theme',
          'ocean_blue'
        ),
      { timeout: 3_500 }
    );
    expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
      'data-background-theme',
      'royal_indigo'
    );
    expect(screen.getByText('Table Art Live')).toBeVisible();
  });

  it('keeps the authoritative repair active for an open studio on a hidden second device', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      renderStudio();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
      );
      expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
        'data-table-theme',
        'classic_green'
      );

      // Model a Postgres Changes frame that the backgrounded device never
      // received. The durable snapshot must still repair its open preview.
      mocks.themeResult = Promise.resolve({
        data: [
          {
            ...savedTheme,
            theme_id: 'ocean-suite',
            table_id: 'ocean_blue',
            background_id: 'royal_indigo',
            button_id: 'classic-white',
            cards_id: 'classic_blue',
            updated_at: '2026-08-31T13:30:00.000Z',
          },
        ],
        error: null,
      });

      await waitFor(
        () =>
          expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
            'data-table-theme',
            'ocean_blue'
          ),
        { timeout: 3_500 }
      );
      expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
        'data-background-theme',
        'royal_indigo'
      );
    } finally {
      visibility.mockRestore();
    }
  });

  it('does not let an in-flight appearance snapshot roll back a newer realtime change', async () => {
    renderStudio();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'House Classic' })).toBeEnabled()
    );

    const staleRefresh = deferred<{ data: unknown[]; error: null }>();
    mocks.themeResult = staleRefresh.promise;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    });

    act(() => {
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: {
          theme_id: 'ocean-suite',
          table_id: 'ocean_blue',
          background_id: 'royal_indigo',
          cards_id: 'classic_blue',
        },
        userId: 'user-1',
        updatedAt: '2026-08-31T13:31:00.000Z',
      });
    });
    expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
      'data-table-theme',
      'ocean_blue'
    );

    await act(async () => {
      staleRefresh.resolve({ data: [savedTheme], error: null });
      await staleRefresh.promise;
    });
    expect(screen.getByTestId('gameplay-preview')).toHaveAttribute(
      'data-table-theme',
      'ocean_blue'
    );
  });
});
