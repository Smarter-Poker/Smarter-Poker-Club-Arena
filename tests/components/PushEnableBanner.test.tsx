import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PushEnableBanner from '../../src/components/notifications/PushEnableBanner';

const pushMocks = vi.hoisted(() => ({
  enablePush: vi.fn(),
  hasLocalSubscription: vi.fn(),
  isIos: vi.fn(),
  isIosStandalonePwa: vi.fn(),
  isOptedOut: vi.fn(),
  isWebPushSupported: vi.fn(),
  notificationPermission: vi.fn(),
}));
const telemetry = vi.hoisted(() => ({ recordPushPromptEvent: vi.fn() }));

vi.mock('../../src/lib/pushClient', () => pushMocks);
vi.mock('../../src/lib/pushPromptTelemetry', () => telemetry);

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('PushEnableBanner in context', () => {
  beforeEach(() => {
    localStorage.clear();
    telemetry.recordPushPromptEvent.mockReset();
    pushMocks.enablePush.mockReset().mockResolvedValue({ ok: true, permission: 'granted' });
    pushMocks.hasLocalSubscription.mockReset().mockResolvedValue(false);
    pushMocks.isIos.mockReset().mockReturnValue(false);
    pushMocks.isIosStandalonePwa.mockReset().mockReturnValue(false);
    pushMocks.isOptedOut.mockReset().mockReturnValue(false);
    pushMocks.isWebPushSupported.mockReset().mockReturnValue(true);
    pushMocks.notificationPermission.mockReset().mockReturnValue('default');
  });

  it('asks on the cashier receipt, records the showing and starts the cooldown', async () => {
    render(<PushEnableBanner surface="cashier_receipt" userId="u1" />);
    await flush();
    expect(screen.getByText('Get Receipts On Your Phone')).toBeInTheDocument();
    expect(telemetry.recordPushPromptEvent).toHaveBeenCalledWith('cashier_receipt', 'shown', null);
    expect(localStorage.getItem('sp_push_ctx_cashier_receipt_u1')).toBeTruthy();
  });

  it('stays hidden inside its cooldown', async () => {
    localStorage.setItem('sp_push_ctx_cashier_u1', String(Date.now()));
    const { container } = render(<PushEnableBanner surface="cashier" userId="u1" />);
    await flush();
    expect(container).toBeEmptyDOMElement();
    expect(pushMocks.hasLocalSubscription).not.toHaveBeenCalled();
    expect(telemetry.recordPushPromptEvent).not.toHaveBeenCalled();
  });

  it('shows nothing to a device that is already subscribed', async () => {
    pushMocks.hasLocalSubscription.mockResolvedValue(true);
    const { container } = render(
      <PushEnableBanner surface="tournament_registration" userId="u1" />
    );
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it('never shows the blocked instruction in context', async () => {
    pushMocks.notificationPermission.mockReturnValue('denied');
    const { container } = render(<PushEnableBanner surface="cashier" userId="u1" />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it('an iPhone in Safari gets Add To Home Screen instead of an ask', async () => {
    pushMocks.isWebPushSupported.mockReturnValue(false);
    pushMocks.isIos.mockReturnValue(true);
    render(<PushEnableBanner surface="tournament_registration" userId="u1" />);
    await flush();
    expect(screen.getByText('Add Smarter Poker To Your Home Screen')).toBeInTheDocument();
    expect(screen.queryByText('Turn On')).not.toBeInTheDocument();
    expect(telemetry.recordPushPromptEvent).toHaveBeenCalledWith(
      'tournament_registration',
      'unsupported',
      'ios_install_shown'
    );
  });

  it('Turn On enables push for this surface and hides on success', async () => {
    render(<PushEnableBanner surface="cashier" userId="u1" />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText('Turn On'));
    });
    expect(pushMocks.enablePush).toHaveBeenCalledWith({ surface: 'cashier' });
    expect(screen.queryByText('Get Cashier Alerts')).not.toBeInTheDocument();
  });

  it('Not Now hides it and records a decline', async () => {
    render(<PushEnableBanner surface="cashier" userId="u1" />);
    await flush();
    fireEvent.click(screen.getByText('Not Now'));
    expect(screen.queryByText('Get Cashier Alerts')).not.toBeInTheDocument();
    expect(telemetry.recordPushPromptEvent).toHaveBeenCalledWith('cashier', 'declined', 'not_now');
  });

  it('a contextual surface without an account shows nothing', async () => {
    const { container } = render(<PushEnableBanner surface="cashier" userId={null} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it('the Notifications page door keeps its copy, has no Not Now and no cooldown', async () => {
    render(<PushEnableBanner />);
    await flush();
    expect(screen.getByText('Never Miss A Seat')).toBeInTheDocument();
    expect(screen.queryByText('Not Now')).not.toBeInTheDocument();
    expect(telemetry.recordPushPromptEvent).toHaveBeenCalledWith(
      'notifications_page',
      'shown',
      null
    );
    expect(localStorage.length).toBe(0);
  });

  it('the Notifications page still shows the blocked instruction', async () => {
    pushMocks.notificationPermission.mockReturnValue('denied');
    render(<PushEnableBanner />);
    await flush();
    expect(screen.getByText('Notifications Are Blocked')).toBeInTheDocument();
  });
});
