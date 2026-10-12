import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  persistAccountSettings: vi.fn(),
  writeSettingsPageCache: vi.fn(() => true),
  updateTableSettings: vi.fn(),
  emit: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  settingsStoreState: {
    interfaceThemeScopeReady: true,
    interfaceThemeUserId: 'account-a' as string | null,
    themePreference: 'dark' as 'dark' | 'light' | 'auto',
    bindInterfaceThemeScope: vi.fn(),
    setTheme: vi.fn(),
  },
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'account-a' } }),
}));

vi.mock('../../src/lib/authUtils', () => ({
  readLocalSession: () => ({ userId: 'account-a' }),
}));

vi.mock('../../src/hooks/useTableSettings', () => ({
  useTableSettings: () => ({
    settings: {
      isSoundEnabled: true,
      soundVolume: 70,
      animationSpeed: 1,
      cardBack: 'classic_blue',
      fourColorDeck: false,
      showPotOdds: false,
      showTicker: true,
      confirmAllIn: true,
    },
    updateSettings: mocks.updateTableSettings,
  }),
}));

vi.mock('../../src/stores/useSettingsStore', () => ({
  effectiveInterfaceTheme: (theme: string) => (theme === 'auto' ? 'dark' : theme),
  useSettingsStore: {
    getState: () => mocks.settingsStoreState,
  },
}));

vi.mock('../../src/lib/persistAccountSettings', () => ({
  persistAccountSettings: mocks.persistAccountSettings,
}));

vi.mock('../../src/lib/settingsPageCache', () => ({
  readSettingsPageCache: vi.fn(() => null),
  removeSettingsPageCache: vi.fn(),
  retireLegacyGlobalSettingsPageCache: vi.fn(),
  writeSettingsPageCache: mocks.writeSettingsPageCache,
}));

vi.mock('../../src/lib/supabase', () => {
  const from = (table: string) => {
    let selected = '';
    const builder: Record<string, any> = {};
    builder.select = (columns: string) => {
      selected = columns;
      return builder;
    };
    builder.eq = () => builder;
    builder.maybeSingle = () => {
      if (table === 'profiles' && selected.includes('is_vip')) {
        return Promise.resolve({ data: { is_vip: false, tier: null }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    builder.upsert = () => Promise.resolve({ data: null, error: null });
    return builder;
  };

  return {
    getAuthUser: () =>
      Promise.resolve({ data: { user: { id: 'account-a', email: 'a@test.dev' } } }),
    supabase: {
      from,
      auth: {
        getSession: () =>
          Promise.resolve({
            data: { session: { user: { id: 'account-a', email: 'a@test.dev' } } },
            error: null,
          }),
        mfa: {
          listFactors: () => Promise.resolve({ data: { totp: [] }, error: null }),
        },
      },
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: mocks.emit,
    subscribeDebounced: () => () => {},
  },
}));

vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/lib/pushClient', () => ({
  disablePush: vi.fn(),
  enablePush: vi.fn(),
  hasLocalSubscription: () => Promise.resolve(false),
  isIos: () => false,
  isIosStandalonePwa: () => false,
  isWebPushSupported: () => true,
  notificationPermission: () => 'default',
  sendTestPush: vi.fn(),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../src/components/account/AccountSurfaceHeader', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <header>{children}</header>,
}));
vi.mock('../../src/components/common/ConfirmModal', () => ({
  default: () => null,
}));
vi.mock('../../src/components/table/ThemeSettingsModal', () => ({
  ThemeSettingsModal: () => null,
}));

import SettingsPage from '../../src/pages/SettingsPage';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsStoreState.interfaceThemeScopeReady = true;
  mocks.settingsStoreState.interfaceThemeUserId = 'account-a';
  mocks.settingsStoreState.themePreference = 'dark';
  mocks.settingsStoreState.setTheme.mockImplementation((theme: 'dark' | 'light' | 'auto') => {
    mocks.settingsStoreState.themePreference = theme;
  });
});

describe('Settings Page Save Revision', () => {
  it('keeps a newer form edit dirty when an older save resolves', async () => {
    const save = deferred<{ ok: true }>();
    mocks.persistAccountSettings.mockReturnValueOnce(save.promise);

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsPage />
      </MemoryRouter>
    );

    const volume = await screen.findByRole('slider', { name: 'Sound Volume' });
    fireEvent.change(volume, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mocks.persistAccountSettings).toHaveBeenCalledTimes(1));
    expect(mocks.persistAccountSettings.mock.calls[0][1]).toMatchObject({ soundVolume: 25 });

    fireEvent.change(volume, { target: { value: '35' } });
    expect(volume).toHaveValue('35');

    await act(async () => {
      save.resolve({ ok: true });
      await save.promise;
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled());
    expect(screen.getByText('Unsaved Controls Are Staged Locally.')).toBeInTheDocument();
    expect(volume).toHaveValue('35');
    expect(mocks.writeSettingsPageCache).not.toHaveBeenCalled();
    expect(mocks.updateTableSettings).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalledWith('SETTINGS_UPDATED', expect.anything());
    expect(mocks.toast.success).not.toHaveBeenCalledWith('Settings saved!');
  });
});
