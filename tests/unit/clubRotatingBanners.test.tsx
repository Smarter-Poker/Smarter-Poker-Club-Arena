// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  resolve: vi.fn(),
  impression: vi.fn(),
  viewable: vi.fn(),
  click: vi.fn(),
  dismiss: vi.fn(),
  success: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success }),
}));
vi.mock('../../src/services/AdService', async (original) => ({
  ...(await original<typeof import('../../src/services/AdService')>()),
  AdService: {
    resolve: mocks.resolve,
    logImpression: mocks.impression,
    logViewable: mocks.viewable,
    logClick: mocks.click,
    logDismiss: mocks.dismiss,
  },
}));
import HouseAdRotator from '../../src/components/ads/HouseAdRotator';
const ad = {
  adId: 'house',
  adKey: 'house',
  headline: 'Smarter Promotion',
  imageUrl: '/house.png',
  posterUrl: '/poster.png',
  targetUrl: '/clubs/test',
  advertiserKind: 'house',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue([ad]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('always resolves platform ads even if legacy club flags and creative props are supplied', async () => {
  const retiredOptions = {
    visible: false,
    clubSettings: {
      show_smarter_poker_ads: false,
      rotating_banners: [
        { id: 'legacy', title: 'Owner Replacement', imageUrl: '/owner.png', enabled: true },
      ],
    },
  };
  render(<HouseAdRotator slot="lobby_strip" clubId="club" {...retiredOptions} />);
  await screen.findByAltText('Smarter Promotion');
  expect(mocks.resolve).toHaveBeenCalledWith('lobby_strip', 'club', 6);
  expect(screen.queryByAltText('Owner Replacement')).toBeNull();
  // The impression is a passive effect after the image commits; under a loaded
  // CI shard it can flush after findByAltText resolves (PR #7266 shard 4).
  await waitFor(() =>
    expect(mocks.impression).toHaveBeenCalledWith({ adId: 'house' }, 'lobby_strip', 'club')
  );
});
it('renders only resolver-selected same-origin images and keeps paid impression/click/dismiss semantics', async () => {
  mocks.resolve.mockResolvedValue([
    ad,
    { ...ad, adId: 'external-image', imageUrl: 'https://evil.example/pixel.png' },
  ]);
  const navigate = vi.fn();
  render(<HouseAdRotator slot="lobby_strip" clubId="club" onNavigate={navigate} />);
  await screen.findByAltText('Smarter Promotion');
  expect(screen.queryByRole('tab')).toBeNull();
  expect(mocks.impression).toHaveBeenCalledWith({ adId: 'house' }, 'lobby_strip', 'club');
  fireEvent.click(screen.getByRole('button', { name: 'Smarter Promotion', exact: true }));
  await screen.findByRole('dialog', { name: 'Smarter Promotion' });
  expect(mocks.click).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
  expect(mocks.dismiss).toHaveBeenCalledWith({ adId: 'house' }, 'lobby_strip', 'club');
});
it('keeps other ad surfaces visible by default', async () => {
  render(<HouseAdRotator slot="session_summary" onNavigate={vi.fn()} />);
  await screen.findByAltText('Smarter Promotion');
  expect(mocks.resolve).toHaveBeenCalledWith('session_summary', null, 6);
});
