import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { holdInAppNavigation } from '../../src/lib/navigationGuard';

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  onPayload: null as null | ((payload: unknown) => void),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'fixture-account' } }),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success }),
}));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({
  useMasterBusChannel: (options: { onPayload: (payload: unknown) => void }) => {
    mocks.onPayload = options.onPayload;
  },
}));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => {} }));
vi.mock('../../src/hooks/useProfilePresence', () => ({ useProfilePresence: () => new Map() }));
vi.mock('../../src/utils/fetchAllRows', () => ({ fetchAllRows: async () => [] }));
vi.mock('../../src/utils/retryFetch', () => ({
  retryFetch: async (read: () => unknown) => read(),
}));
vi.mock('../../src/components/community/CommunitySurfaceHeader', () => ({ default: () => null }));
vi.mock('../../src/components/social/FriendActivityFeed', () => ({ default: () => null }));
vi.mock('../../src/components/social/FriendChallengeModal', () => ({ default: () => null }));
vi.mock('../../src/components/social/FriendChallengesPanel', () => ({ default: () => null }));
vi.mock('../../src/components/social/FriendSuggestions', () => ({ default: () => null }));
import FriendsPage from '../../src/pages/FriendsPage';

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
async function mount() {
  render(
    <MemoryRouter initialEntries={['/friends?tab=activity']}>
      <FriendsPage />
      <Location />
    </MemoryRouter>
  );
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
  );
}
async function receive(status = 'pending') {
  await act(async () => {
    mocks.onPayload?.({ eventType: 'INSERT', new: { status } });
  });
}
beforeEach(() => {
  mocks.success.mockReset();
  mocks.onPayload = null;
  sessionStorage.clear();
});

describe('friend-request attention destination', () => {
  it('waits for a click then opens the Requests tab', async () => {
    await mount();
    await receive();
    expect(screen.getByTestId('location')).toHaveTextContent('/friends?tab=activity');
    expect(mocks.success).toHaveBeenCalledTimes(1);
    act(() => mocks.success.mock.calls[0][2]());
    expect(screen.getByTestId('location')).toHaveTextContent('/friends?tab=requests');
    expect(screen.getByRole('tab', { name: /^Requests/ })).toHaveAttribute('aria-selected', 'true');
  });
  it('respects an active draft navigation hold', async () => {
    await mount();
    await receive();
    const release = holdInAppNavigation(() => false);
    try {
      act(() => mocks.success.mock.calls[0][2]());
      expect(screen.getByTestId('location')).toHaveTextContent('/friends?tab=activity');
    } finally {
      release();
    }
  });
  it('does not announce accepted friendship inserts as requests', async () => {
    await mount();
    await receive('accepted');
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
