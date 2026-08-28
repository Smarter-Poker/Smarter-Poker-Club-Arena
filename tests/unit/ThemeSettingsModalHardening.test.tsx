import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  applyAppearance: vi.fn(),
  persistMode: vi.fn(),
  navigate: vi.fn(),
  themeListeners: new Set<(event: { payload: unknown }) => void>(),
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

vi.mock('../../src/components/table/TableStudioGameplayPreview', () => ({
  default: ({ selection }: { selection: { button_id: string; cards_id: string } }) => (
    <div
      data-testid="gameplay-preview"
      data-button-theme={selection.button_id}
      data-card-back={selection.cards_id}
    />
  ),
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
        table === 'user_theme_settings' ? mocks.themeResult : mocks.purchaseResult;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const method of ['select', 'eq', 'like']) builder[method] = vi.fn(chain);
      builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        result().then(resolve, reject);
      return builder;
    }),
  },
}));

import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { ThemeSettingsModal } from '../../src/components/table/ThemeSettingsModal';
import { masterBus } from '../../src/core/MasterBus';

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

function renderStudio() {
  return render(<ThemeSettingsModal isOpen onClose={vi.fn()} userId="user-1" isVip={false} />);
}

describe('ThemeSettingsModal hardening', () => {
  beforeEach(() => {
    mocks.themeResult = Promise.resolve({ data: [savedTheme], error: null });
    mocks.purchaseResult = Promise.resolve({ data: [], error: null });
    mocks.applyAppearance.mockReset();
    mocks.applyAppearance.mockResolvedValue({ ok: true });
    mocks.persistMode.mockReset();
    mocks.persistMode.mockResolvedValue({ ok: true });
    mocks.navigate.mockReset();
    for (const method of Object.values(mocks.toast)) method.mockReset();
    useSettingsStore.setState({ theme: 'dark' });
  });

  it('keeps customization choices disabled until the saved row is known', async () => {
    const pendingTheme = deferred<{ data: unknown[]; error: null }>();
    mocks.themeResult = pendingTheme.promise;
    renderStudio();

    expect(await screen.findByText('Loading Your Saved Design')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Default Dark' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Shuffle Look' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore Defaults' })).toBeDisabled();

    await act(async () => {
      pendingTheme.resolve({ data: [savedTheme], error: null });
      await pendingTheme.promise;
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Default Dark' })).toBeEnabled());
    expect(screen.queryByText('Loading Your Saved Design')).not.toBeInTheDocument();
  });

  it('does not present a purchased card back as VIP-locked while ownership loads', async () => {
    const pendingOwnership = deferred<{ data: unknown[]; error: null }>();
    mocks.purchaseResult = pendingOwnership.promise;
    renderStudio();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Default Dark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('tab', { name: 'Cards' }));

    expect(screen.getByRole('button', { name: 'Premium Gold, checking ownership' })).toBeDisabled();
    expect(screen.getByText('Checking Your Card Back Purchases')).toBeVisible();

    await act(async () => {
      pendingOwnership.resolve({ data: [{ feature: 'card_back_gold' }], error: null });
      await pendingOwnership.promise;
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Premium Gold' })).toBeEnabled());
  });

  it('keeps premium card backs unavailable when ownership cannot be verified', async () => {
    mocks.purchaseResult = Promise.resolve({
      data: [],
      error: { message: 'ownership query failed' },
    });
    renderStudio();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Default Dark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('tab', { name: 'Cards' }));

    expect(await screen.findByText('Purchases Could Not Be Verified')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Premium Gold, ownership unavailable' })
    ).toBeDisabled();
  });

  it('treats the VIP prompt as its own dialog and Escape closes only that prompt', async () => {
    renderStudio();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Default Dark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));

    const locked = screen
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-label')?.includes('VIP required'));
    expect(locked).toBeDefined();
    fireEvent.click(locked!);

    const vipDialog = await screen.findByRole('dialog', { name: 'VIP Design' });
    expect(vipDialog).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upgrade To VIP' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'VIP Design' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('dialog', { name: 'Make The Table Yours' })).toBeVisible();
  });

  it('applies interface mode immediately and persists it to the signed-in account', async () => {
    renderStudio();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Default Dark' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));

    expect(useSettingsStore.getState().theme).toBe('light');
    await waitFor(() => expect(mocks.persistMode).toHaveBeenCalledWith('user-1', 'light'));
  });

  it('rolls interface mode back when account persistence fails', async () => {
    mocks.persistMode.mockResolvedValue({ ok: false, error: new Error('write failed') });
    renderStudio();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Default Dark' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));

    await waitFor(() => expect(useSettingsStore.getState().theme).toBe('dark'));
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Could Not Save Interface Mode. Please Try Again.'
    );
  });

  it('keeps an open studio synchronized with live changes for the same account and bucket', async () => {
    renderStudio();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Default Dark' })).toBeEnabled());

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
});
