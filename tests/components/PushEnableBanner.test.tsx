import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const push = vi.hoisted(() => ({
  enablePush: vi.fn(),
  hasLocalSubscription: vi.fn(),
  isIos: () => false,
  isIosStandalonePwa: () => false,
  isOptedOut: () => false,
  isWebPushSupported: () => true,
  notificationPermission: () => 'default',
}));
vi.mock('../../src/lib/pushClient', () => push);
import PushEnableBanner from '../../src/components/notifications/PushEnableBanner';
beforeEach(() => {
  push.enablePush.mockReset();
  push.hasLocalSubscription.mockReset().mockResolvedValue(false);
});
afterEach(() => {
  cleanup();
});
describe('the device alert door retains failed enrollment truth', () => {
  it('a rejected device status read stays visible and permits an explicit attempt', async () => {
    push.hasLocalSubscription.mockRejectedValue(new Error('native plugin unavailable'));
    render(<PushEnableBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Device Alert Status Could Not Be Confirmed.'
    );
    expect(screen.getByRole('button', { name: 'Turn On' })).toBeEnabled();
  });
  it('a rejected enrollment clears busy and a second deliberate tap can succeed', async () => {
    push.enablePush.mockRejectedValueOnce(new Error('native module load failed'));
    push.enablePush.mockResolvedValueOnce({ ok: true });
    render(<PushEnableBanner />);
    await screen.findByRole('button', { name: 'Turn On' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn On' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could Not Enable Notifications. Please Try Again.'
    );
    expect(screen.getByRole('button', { name: 'Turn On' })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn On' }));
    });
    expect(push.enablePush).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Turn On' })).toBeNull();
  });
});
