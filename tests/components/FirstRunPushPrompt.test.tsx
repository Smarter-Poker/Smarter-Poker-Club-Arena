import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FirstRunPushPrompt from '../../src/components/notifications/FirstRunPushPrompt';

const pushMocks = vi.hoisted(() => ({
  enablePush: vi.fn(),
  hasLocalSubscription: vi.fn(),
  isIos: vi.fn(),
  isIosStandalonePwa: vi.fn(),
  isWebPushSupported: vi.fn(),
  notificationPermission: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-1' } }),
}));

vi.mock('../../src/lib/pushClient', () => pushMocks);

describe('FirstRunPushPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    pushMocks.enablePush.mockReset();
    pushMocks.hasLocalSubscription.mockReset().mockResolvedValue(false);
    pushMocks.isIos.mockReset().mockReturnValue(false);
    pushMocks.isIosStandalonePwa.mockReset().mockReturnValue(false);
    pushMocks.isWebPushSupported.mockReset().mockReturnValue(true);
    pushMocks.notificationPermission.mockReset().mockReturnValue('default');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not block the app when browser notifications are already denied', async () => {
    pushMocks.notificationPermission.mockReturnValue('denied');

    render(
      <MemoryRouter initialEntries={['/clubs/club-1']}>
        <FirstRunPushPrompt />
      </MemoryRouter>
    );

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(screen.queryByRole('dialog', { name: 'Enable Notifications' })).not.toBeInTheDocument();
    expect(localStorage.getItem('sp_firstrun_notif_v2_player-1')).toBeTruthy();
  });
});
