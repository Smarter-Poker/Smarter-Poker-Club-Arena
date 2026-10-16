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
import ClubAdVisibilityControl from '../../src/components/club/ClubAdVisibilityControl';
import HouseAdRotator from '../../src/components/ads/HouseAdRotator';
const club = {
  id: 'club',
  name: 'Union Club',
  owner_id: 'owner',
  union_id: 'union',
  banner_url: null,
  settings: { other: 1 },
};
const ad = {
  adId: 'house',
  adKey: 'house',
  headline: 'Smarter Promotion',
  imageUrl: '/house.png',
  posterUrl: '/poster.png',
  targetUrl: '/clubs/test',
  advertiserKind: 'house',
};
function query(result: unknown) {
  const q: any = {};
  for (const method of ['update', 'eq', 'is', 'select']) q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  return q;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue([ad]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('defaults to shown and gives union owners only a visibility control, with no creative editor', async () => {
  render(<ClubAdVisibilityControl club={club} ownerId="owner" onSaved={vi.fn()} />);
  expect(screen.getByRole('switch', { name: 'Show Smarter.Poker Rotating Ads' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'Save Ad Visibility' })).toBeDisabled();
  expect(screen.queryByLabelText('Add Rotating Banner Image')).toBeNull();
  expect(screen.queryByLabelText(/Banner Title/)).toBeNull();
  expect(document.querySelector('input[type="file"]')).toBeNull();
});
it('persists hide then reloads the authoritative saved switch, preserving other club settings', async () => {
  const saved = { ...club, settings: { ...club.settings, show_smarter_poker_ads: false } };
  const q = query({ data: saved, error: null });
  mocks.from.mockReturnValue(q);
  const onSaved = vi.fn();
  const { rerender } = render(
    <ClubAdVisibilityControl club={club} ownerId="owner" onSaved={onSaved} />
  );
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Ad Visibility' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  expect(q.update).toHaveBeenCalledWith({ settings: saved.settings });
  rerender(<ClubAdVisibilityControl club={saved} ownerId="owner" onSaved={onSaved} />);
  expect(screen.getByRole('switch')).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Save Ad Visibility' })).toBeDisabled();
});
it('reports a refused save and retains the unsaved choice for recovery', async () => {
  mocks.from.mockReturnValue(query({ data: null, error: new Error('denied') }));
  const onSaved = vi.fn();
  render(<ClubAdVisibilityControl club={club} ownerId="owner" onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Ad Visibility' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('switch')).not.toBeChecked();
  expect(onSaved).not.toHaveBeenCalled();
  expect(mocks.success).not.toHaveBeenCalled();
});
it('does not resolve, render, bill or open a popup while hidden', async () => {
  render(<HouseAdRotator slot="lobby_strip" clubId="club" visible={false} />);
  await Promise.resolve();
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.impression).not.toHaveBeenCalled();
  expect(mocks.viewable).not.toHaveBeenCalled();
  expect(mocks.click).not.toHaveBeenCalled();
  expect(mocks.dismiss).not.toHaveBeenCalled();
  expect(document.querySelector('.ad-rotator')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('drops a delayed resolver result when visibility turns off and resolves again when shown', async () => {
  let finish!: (ads: unknown[]) => void;
  mocks.resolve.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const { rerender } = render(<HouseAdRotator slot="lobby_strip" clubId="club" />);
  rerender(<HouseAdRotator slot="lobby_strip" clubId="club" visible={false} />);
  finish([ad]);
  await Promise.resolve();
  expect(document.querySelector('.ad-rotator')).toBeNull();
  expect(mocks.impression).not.toHaveBeenCalled();
  rerender(<HouseAdRotator slot="lobby_strip" clubId="club" visible />);
  await screen.findByAltText('Smarter Promotion');
  expect(mocks.resolve).toHaveBeenCalledTimes(2);
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
