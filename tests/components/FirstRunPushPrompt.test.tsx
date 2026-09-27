import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FirstRunPushPrompt from '../../src/components/notifications/FirstRunPushPrompt';
import { requestPushNudge } from '../../src/lib/pushNudgePolicy';

const auth = vi.hoisted(() => ({ id: 'player-1' }));

const pushMocks = vi.hoisted(() => ({
  enablePush: vi.fn(),
  hasLocalSubscription: vi.fn(),
  isIos: vi.fn(),
  isIosStandalonePwa: vi.fn(),
  isOptedOut: vi.fn(),
  isWebPushSupported: vi.fn(),
  notificationPermission: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: auth.id } }),
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
    pushMocks.isOptedOut.mockReset().mockReturnValue(false);
    auth.id = 'player-1';
    // happy-dom reports navigator.webdriver = true, i.e. an automated browser,
    // which the prompt never asks. These tests model a person's browser.
    Object.defineProperty(window.navigator, 'webdriver', { configurable: true, get: () => false });
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

    expect(screen.queryByRole('dialog', { name: 'Enable notifications' })).not.toBeInTheDocument();
    expect(localStorage.getItem('sp_firstrun_notif_v2_player-1')).toBeTruthy();
  });

  it('asks at a meaningful moment with a card that does not block the page', async () => {
    // The first-visit ask was already answered long ago.
    localStorage.setItem('sp_firstrun_notif_v2_player-1', String(Date.now() - 30 * 86_400_000));
    renderPrompt('/clubs/club-1');
    await settle(0);
    expect(dialog()).not.toBeInTheDocument();

    act(() => requestPushNudge('club_joined'));
    await settle(2_600);

    const card = dialog();
    expect(card).toBeInTheDocument();
    expect(card).toHaveAttribute('aria-modal', 'false');
    expect(card).toHaveAttribute('data-push-nudge', 'club_joined');
    expect(screen.getByText('Stay In Touch With Your Club')).toBeInTheDocument();
  });

  it('Not Now starts a cool-down instead of asking again at the next moment', async () => {
    renderPrompt('/clubs/club-1');
    await settle(0);
    act(() => requestPushNudge('club_joined'));
    await settle(2_600);
    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    expect(dialog()).not.toBeInTheDocument();
    const ledger = JSON.parse(localStorage.getItem('sp_push_nudge_v1_player-1') || '{}');
    expect(ledger.dismissals).toBe(1);

    act(() => requestPushNudge('rakeback_receipt'));
    await settle(25_000);
    expect(dialog()).not.toBeInTheDocument();
    expect(pushMocks.enablePush).not.toHaveBeenCalled();
  });

  it('the permission dialog is only raised by the player tapping Enable', async () => {
    pushMocks.enablePush.mockResolvedValue({ ok: true, permission: 'granted' });
    renderPrompt('/clubs/club-1');
    await settle(0);
    act(() => requestPushNudge('club_joined'));
    await settle(2_600);
    expect(pushMocks.enablePush).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
      await Promise.resolve();
    });
    expect(pushMocks.enablePush).toHaveBeenCalledTimes(1);
    expect(pushMocks.enablePush.mock.calls[0]).toEqual([]);
    expect(screen.getByText('Notifications Are On For This Device.')).toBeInTheDocument();
  });

  it('never nudges the owner to enroll for receipts; another player is asked', async () => {
    const owner = '47965354-0e56-43ef-931c-ddaab82af765';
    auth.id = owner;
    // The first-visit ask was answered long ago; only the receipt moment is in play.
    localStorage.setItem(`sp_firstrun_notif_v2_${owner}`, String(Date.now() - 30 * 86_400_000));
    const view = renderPrompt('/rakeback');
    await settle(0);
    act(() => requestPushNudge('rakeback_receipt'));
    await settle(25_000);
    expect(dialog()).not.toBeInTheDocument();
    view.unmount();

    auth.id = 'player-2';
    localStorage.setItem('sp_firstrun_notif_v2_player-2', String(Date.now() - 30 * 86_400_000));
    renderPrompt('/rakeback');
    await settle(0);
    act(() => requestPushNudge('rakeback_receipt'));
    await settle(2_600);
    expect(dialog()).toHaveAttribute('data-push-nudge', 'rakeback_receipt');
  });

  it('does not ask while the player is on the felt', async () => {
    const view = renderPrompt('/table/abc');
    await settle(0);
    act(() => requestPushNudge('club_joined'));
    await settle(30_000);
    expect(dialog()).not.toBeInTheDocument();
    view.unmount();
  });

  it('asks nothing of an automated browser', async () => {
    Object.defineProperty(window.navigator, 'webdriver', { configurable: true, get: () => true });
    try {
      renderPrompt('/clubs/club-1');
      await settle(0);
      act(() => requestPushNudge('club_joined'));
      await settle(25_000);
      expect(dialog()).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window.navigator, 'webdriver', {
        configurable: true,
        get: () => false,
      });
    }
  });
});

function renderPrompt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FirstRunPushPrompt />
    </MemoryRouter>
  );
}

async function settle(ms: number) {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function dialog() {
  return screen.queryByRole('dialog', { name: 'Enable notifications' });
}
